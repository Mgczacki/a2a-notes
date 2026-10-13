// The Slack transport adapter. It signs in one Slack member with a user token (OAuth with PKCE), sends direct
// messages, uploads and downloads files, and scans direct message history. Addresses are slack:<team ID>:<member ID>.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { DesktopDeliveries } from './slack-desktop-delivery.ts';
import { DesktopUnavailableError, type SlackDesktopHook } from './slack-desktop.ts';
import { savePrivate } from './store.ts';
import { TransportError, type Identity, type Person, type Received, type SendInput, type Transport } from './transport.ts';
import { checkProjectLink, slackBlocks, slackText, readSlackText, MAX_SLACK_TEXT } from './slack-format.ts';

export const REQUIRED_SCOPES = ['chat:write', 'im:write', 'im:read', 'im:history', 'users:read'];
export const OPTIONAL_SCOPES = ['users:read.email', 'files:read', 'files:write'];
// A scan reads at most 40 conversations. Slack applies each method quota to the app and workspace.
const MAX_CONVERSATIONS_PER_SCAN = 40;
const READS = new Set(['auth.test', 'conversations.history', 'conversations.replies', 'conversations.list', 'files.info', 'users.info', 'users.list', 'users.lookupByEmail']);

export interface SlackConfig {
  clientId: string; teamId: string;
  // the redirect that the Slack app lists, for example http://localhost:4460/slack/callback
  redirectUri: string;
  apiBase?: string; authorizeUrl?: string;
  // test only: allow a message to the signed-in member's own direct message conversation
  allowSelf?: boolean;
  // do not renew the access token (for a copied token that another program renews)
  noRefresh?: boolean;
  // how many days of history the first scan of a conversation reads (default 14)
  firstScanDays?: number;
  // the "Get A2A Notes" link in the message footer (default: the A2A Notes repository); an empty value hides it
  projectLink?: string;
}
interface Credentials { user: string; team: string; name: string; scopes: string[]; access: string; refresh?: string; expires?: number }

export const slackAddress = (team: string, user: string) => `slack:${team}:${user}`;
export function isLoopbackPage(value: string) {
  try { const u = new URL(value); return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password; }
  catch { return false; }
}
export function parseSlackAddress(address: string) {
  const match = /^slack:([A-Z0-9]{2,20}):([UW][A-Z0-9]{2,20})$/.exec(address);
  if (!match) throw new TransportError('The address is not a Slack address (slack:<team ID>:<member ID>).', true);
  return { team: match[1], user: match[2] };
}

export class SlackTransport implements Transport {
  desktopSender?: Pick<SlackDesktopHook, 'canSend' | 'post'>;
  readonly name = 'slack';
  readonly fileField = 'Slack';
  private generation = 0;
  private refreshing?: Promise<void>;
  private limits: Record<string, number>;
  private readonly now: () => number;
  private pending?: { state: string; verifier: string; expires: number; returnTo?: string };
  private names = new Map<string, { name: string; at: number }>();
  private readonly apiBase: string;
  private readonly projectLink: string | undefined;
  constructor(readonly file: string, readonly config: SlackConfig, private fetcher: typeof fetch = fetch, options: { now?: () => number } = {}) {
    this.now = options.now || Date.now;
    this.limits = existsSync(file + '.limits.json') ? JSON.parse(readFileSync(file + '.limits.json', 'utf8')) : {};
    this.apiBase = (config.apiBase || 'https://slack.com/api').replace(/\/$/, '');
    this.projectLink = checkProjectLink(config.projectLink);
  }

  private credentials(): Credentials | undefined { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : undefined; }
  identity(): Identity | null {
    const c = this.credentials();
    if (!c) return null;
    return { transport: 'slack', address: slackAddress(c.team, c.user), name: c.name, scopes: c.scopes,
      missingScopes: REQUIRED_SCOPES.filter(s => !c.scopes.includes(s)), optionalMissing: OPTIONAL_SCOPES.filter(s => !c.scopes.includes(s)) };
  }
  disconnect() { this.generation++; this.pending = undefined; if (existsSync(this.file)) unlinkSync(this.file); }

  // Slack serves files from its own hosts. A test server serves them from its API host.
  private allowedHost(url: URL) {
    const api = new URL(this.apiBase);
    if (api.hostname === 'slack.com') return url.protocol === 'https:' && (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'));
    return url.host === api.host;
  }

  // returnTo: where the browser goes after sign-in. Only a loopback http(s) page is allowed, for example a local
  // client dashboard, so the sign-in cannot send the browser to another site.
  beginSignIn(returnTo?: string) {
    if (returnTo !== undefined && !isLoopbackPage(returnTo)) throw new TransportError('return_to must be a page on this computer (127.0.0.1 or localhost).', true);
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
    this.pending = { verifier, state, expires: Date.now() + 10 * 60_000, ...(returnTo ? { returnTo } : {}) };
    const params = new URLSearchParams({ client_id: this.config.clientId, user_scope: [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES].join(','), team: this.config.teamId,
      state, redirect_uri: this.config.redirectUri, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return `${this.config.authorizeUrl || 'https://slack.com/oauth/v2/authorize'}?${params}`;
  }

  // Returns the returnTo page from beginSignIn, if one was given.
  async finishSignIn(state: string, code: string): Promise<string | undefined> {
    const generation = this.generation, p = this.pending;
    if (!p || p.expires < Date.now() || state !== p.state) throw new TransportError('Sign-in expired or did not start here.', true);
    this.pending = undefined;
    const result = await this.request('oauth.v2.access', { client_id: this.config.clientId, code, code_verifier: p.verifier, redirect_uri: this.config.redirectUri });
    const c = result.authed_user;
    if (result.team?.id !== this.config.teamId || !c?.id || !c.access_token) throw new TransportError('Slack did not return a user token for the expected workspace.', true);
    const scopes = String(c.scope || '').split(',').filter(Boolean);
    let name = c.id;
    try {
      const info = await this.request('users.info', { user: c.id }, c.access_token);
      name = info.user?.profile?.real_name || info.user?.real_name || info.user?.profile?.display_name || info.user?.name || name;
    } catch { /* the member ID is enough to sign in */ }
    const previous = this.credentials();
    if (previous && previous.user !== c.id) throw new TransportError('Disconnect the current Slack member before you connect a different one.', true);
    if (generation !== this.generation) throw new TransportError('Sign-in was cancelled.', true);
    savePrivate(this.file, { user: c.id, team: result.team.id, name, scopes, access: c.access_token, refresh: c.refresh_token,
      expires: c.expires_in ? Date.now() + Number(c.expires_in) * 1000 : undefined } satisfies Credentials);
    return p.returnTo;
  }

  // A workspace member with name and picture, cached for one hour like nameOf. A failed lookup gives undefined.
  private people = new Map<string, { person: Person; at: number }>();
  async personOf(address: string) {
    const cached = this.people.get(address);
    if (cached && Date.now() - cached.at < 3600_000) return cached.person;
    try {
      const c = this.self();
      const { team, user } = parseSlackAddress(address);
      if (team !== c.team) return undefined;
      const info = await this.call('users.info', { user });
      if (!info.user) return undefined;
      const person = this.person(info.user, c.team);
      this.people.set(address, { person, at: Date.now() });
      return person;
    } catch { return undefined; }
  }

  // The display name of a workspace member, cached for one hour. A failed lookup gives undefined.
  async nameOf(address: string) {
    const cached = this.names.get(address);
    if (cached && Date.now() - cached.at < 3600_000) return cached.name;
    try {
      const c = this.self();
      const { team, user } = parseSlackAddress(address);
      if (team !== c.team) return undefined;
      const info = await this.call('users.info', { user });
      const name = info.user ? this.person(info.user, c.team).name : undefined;
      if (name) this.names.set(address, { name, at: Date.now() });
      return name;
    } catch { return undefined; }
  }

  private async request(method: string, params: Record<string, string>, token?: string): Promise<any> {
    const key = `${this.config.clientId}:${this.config.teamId}:${method}`;
    const channelKey = `${key}:${params.channel || ''}`;
    const until = Math.max(this.limits[key] || 0, method === 'chat.postMessage' ? this.limits[channelKey] || 0 : 0);
    if (this.now() < until) throw new TransportError(`Slack rate limit for ${method}.`, true, Math.ceil((until - this.now()) / 1000), method, 0);
    if (method === 'chat.postMessage') {
      this.limits[channelKey] = this.now() + 1000;
      savePrivate(this.file + '.limits.json', this.limits);
    }
    let res: Response | undefined;
    // a read can run again after a network error; a post or upload never runs twice
    for (let attempt = 0; !res; attempt++) {
      try {
        res = await this.fetcher(`${this.apiBase}/${method}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) });
      } catch {
        if (attempt >= 1 || !READS.has(method)) throw new TransportError(`Slack did not answer ${method}.`, false, 0, method);
      }
    }
    if (res.status === 429) {
      const seconds = Number(res.headers.get('retry-after'));
      const retry = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
      this.limits[key] = this.now() + retry * 1000;
      savePrivate(this.file + '.limits.json', this.limits);
      throw new TransportError(`Slack rate limit for ${method}.`, true, retry, method, 429, res.headers.get('x-slack-req-id') || undefined);
    }
    if (!res.ok) throw new TransportError(`Slack returned HTTP ${res.status} for ${method}.`, res.status < 500, 0, method, res.status);
    let data: any;
    try { data = await res.json(); } catch { throw new TransportError(`Slack returned a reply to ${method} that is not JSON.`, false, 0, method, res.status); }
    if (!data.ok) throw new TransportError(`Slack: ${String(data.error || 'request failed').replace(/[^a-z_.]/g, '').slice(0, 80)}`, !['internal_error', 'fatal_error', 'request_timeout'].includes(data.error), 0, method, res.status);
    return data;
  }
  get rateLimitedUntil() {
    const until = Math.max(0, ...Object.values(this.limits));
    return until > this.now() ? new Date(until).toISOString() : undefined;
  }

  async call(method: string, params: Record<string, string> = {}) {
    const generation = this.generation;
    let c = this.credentials();
    if (!c) throw new TransportError('Connect Slack first.', true);
    if (c.expires && c.refresh && !this.config.noRefresh && c.expires < Date.now() + 120_000) {
      const current = c;
      this.refreshing ||= this.request('oauth.v2.access', { grant_type: 'refresh_token', refresh_token: current.refresh!, client_id: this.config.clientId }).then(result => {
        const token = result.authed_user || result;
        if (!token.access_token || !token.refresh_token) throw new TransportError('Reconnect Slack to renew access.', true);
        if (generation !== this.generation) throw new TransportError('Slack was disconnected.', true);
        savePrivate(this.file, { ...current, access: token.access_token, refresh: token.refresh_token, expires: Date.now() + Number(token.expires_in || 43200) * 1000 });
      }).finally(() => { this.refreshing = undefined; });
      await this.refreshing;
      c = this.credentials();
    }
    if (!c || generation !== this.generation) throw new TransportError('Slack was disconnected.', true);
    return this.request(method, params, c.access);
  }

  private self() {
    const c = this.credentials();
    if (!c) throw new TransportError('Connect Slack first.', true);
    return c;
  }

  private person(member: any, team: string): Person {
    return { address: slackAddress(team, String(member.id)), name: String(member.profile?.display_name || member.real_name || member.name || member.id),
      realName: String(member.real_name || member.profile?.real_name || ''), title: String(member.profile?.title || ''),
      active: !member.deleted && !member.is_bot && !member.is_app_user, ...(member.profile?.email ? { email: String(member.profile.email) } : {}),
      // the profile picture address that Slack gives; a client downloads it without the Slack token
      ...(/^https:\/\//.test(String(member.profile?.image_192 || member.profile?.image_72 || '')) ? { image: String(member.profile.image_192 || member.profile.image_72) } : {}) };
  }

  async findPeople(query: string, limit: number, cursor?: string) {
    const c = this.self();
    const term = query.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(term)) {
      if (!c.scopes.includes('users:read.email')) throw new TransportError('Email search needs the optional Slack scope users:read.email.', true);
      try {
        const found = await this.call('users.lookupByEmail', { email: term });
        return { people: found.user && (found.user.team_id === c.team || found.user.teams?.includes(c.team)) ? [this.person(found.user, c.team)] : [] };
      } catch (error) { if (/users_not_found/.test((error as Error).message)) return { people: [] }; throw error; }
    }
    // Slack has no name search for user tokens: read pages of the member list and filter them here
    const people: Person[] = [];
    let next = cursor || '';
    for (let pages = 0; pages < 20 && people.length < limit; pages++) {
      const page = await this.call('users.list', { limit: '200', ...(next ? { cursor: next } : {}) });
      for (const member of page.members || []) {
        if (!member.id || member.team_id !== c.team && !member.teams?.includes(c.team)) continue;
        const p = this.person(member, c.team);
        if ([p.name, p.realName, String(member.name || '')].some(v => v.toLowerCase().includes(term))) people.push(p);
      }
      next = page.response_metadata?.next_cursor || '';
      if (!next) break;
    }
    return { people: people.slice(0, limit), ...(next ? { next } : {}) };
  }

  async checkRecipient(address: string) {
    const c = this.self();
    const { team, user } = parseSlackAddress(address);
    if (team !== c.team) throw new TransportError('This release sends only inside the signed-in Slack workspace.', true);
    if (user === c.user && !this.config.allowSelf) throw new TransportError('Choose another member of the workspace.', true);
    const info = await this.call('users.info', { user });
    const p = info.user && info.user.id === user && (info.user.team_id === c.team || info.user.teams?.includes(c.team)) ? this.person(info.user, c.team) : undefined;
    if (!p || !p.active) throw new TransportError('Choose an active person in this workspace.', true);
    return p;
  }

  private async openConversation(address: string) {
    const { user } = parseSlackAddress(address);
    const opened = await this.call('conversations.open', { users: user });
    const channel = String(opened.channel?.id || '');
    if (!/^D[A-Z0-9]+$/.test(channel)) throw new TransportError('Slack did not return a direct message conversation.', true);
    return channel;
  }

  async send(input: SendInput) {
    const c = this.self();
    await this.checkRecipient(input.to);
    const checkpoint = input.checkpoint || { uploads: {} };
    const save = () => input.saveCheckpoint?.(checkpoint);
    const channel = checkpoint.channel || await this.openConversation(input.to);
    checkpoint.channel = channel; save();
    const files: Record<string, string> = {};
    if (input.files.length && (!c.scopes.includes('files:write'))) throw new TransportError('Sending files needs the optional Slack scope files:write.', true);
    if (slackText(input.wire({}), input.display).length + input.files.length * 60 > MAX_SLACK_TEXT) throw new TransportError('The message is too long for Slack. Move detail to the agent file.', true);
    for (const f of input.files) {
      let upload = checkpoint.uploads[f.id];
      if (!upload) {
        const ticket = await this.call('files.getUploadURLExternal', { filename: f.name, length: String(f.bytes.length) });
        const target = new URL(String(ticket.upload_url || ''));
        if (!this.allowedHost(target) || !/^F[A-Z0-9]+$/.test(String(ticket.file_id))) throw new TransportError('Slack returned an invalid upload ticket.', true);
        upload = checkpoint.uploads[f.id] = { fileId: String(ticket.file_id), url: target.href, phase: 'allocated' }; save();
      }
      if (upload.phase === 'allocated') {
        if (!this.allowedHost(new URL(upload.url))) throw new TransportError('The saved upload address is not allowed.', true);
        let response: Response;
        try { response = await this.fetcher(upload.url, { method: 'POST', body: new Uint8Array(f.bytes), signal: AbortSignal.timeout(120_000) }); }
        catch { throw new TransportError('Slack did not accept the file bytes.', true, 0, 'file_upload'); }
        if (response.status === 429) throw new TransportError('Slack rate limit for file_upload.', true, Math.max(1, Number(response.headers.get('retry-after')) || 60), 'file_upload', 429);
        if (!response.ok) throw new TransportError('Slack did not accept the file bytes.', true, 0, 'file_upload', response.status);
        upload.phase = 'uploaded'; save();
      }
      if (upload.phase === 'completing') {
        let info;
        try { info = await this.call('files.info', { file: upload.fileId }); }
        catch (error) {
          if (error instanceof TransportError && error.message === 'Slack: file_not_found')
            throw new TransportError('Slack has not confirmed the file share. No second share was attempted.', false, 0, 'files.info');
          throw error;
        }
        if (!info.file?.ims?.includes(channel) && !info.file?.shares?.im?.[channel]) throw new TransportError('Slack has not confirmed the file share. No second share was attempted.', false, 0, 'files.completeUploadExternal');
        upload.phase = 'complete'; save();
      }
      if (upload.phase === 'uploaded') {
        upload.phase = 'completing'; save();
        try { await this.call('files.completeUploadExternal', { files: JSON.stringify([{ id: upload.fileId, title: f.name }]), channel_id: channel }); }
        catch (error) {
          if (error instanceof TransportError && error.definite) { upload.phase = 'uploaded'; save(); }
          throw error;
        }
        upload.phase = 'complete'; save();
      }
      files[f.id] = upload.fileId;
    }
    // people read the blocks; `text` carries the exact A2ANotes/1 text as a JSON string (src/slack-format.ts)
    const startPost = () => {
      if (this.identity()?.address !== slackAddress(c.team,c.user)) throw new TransportError('The Slack account changed before posting.', true);
      checkpoint.postStarted = true; save();
    };
    const text = slackText(input.wire(files), input.display);
    const blocks = JSON.stringify(slackBlocks(input.display, { projectLink: this.projectLink }));
    let result;
    if (this.desktopSender?.canSend()) {
      checkpoint.postTransport = 'desktop';
      try {
        result = await this.desktopSender.post({team:c.team,owner:c.user,to:input.to,channel,messageId:input.messageId,text,blocks,
          ...(input.threadTs ? {threadTs:input.threadTs} : {})},startPost);
        return {channel,ts:result.ts,files};
      } catch (error) {
        if (error instanceof TransportError && error.definite) {checkpoint.postStarted = false;save();}
        if (!(error instanceof DesktopUnavailableError)) throw error;
      }
    }
    checkpoint.postTransport = 'web-api'; startPost();
    try { result = await this.call('chat.postMessage', { channel, text, blocks, mrkdwn: 'false',
      unfurl_links: 'false', unfurl_media: 'false', parse: 'none', client_msg_id: input.messageId,
      ...(input.threadTs ? { thread_ts: input.threadTs, reply_broadcast: 'true' } : {}) }); }
    catch (error) {
      if (error instanceof TransportError && error.definite) { checkpoint.postStarted = false; save(); }
      throw error;
    }
    if (!result.ts) throw new TransportError('Slack did not confirm delivery.', false);
    return { channel, ts: String(result.ts), files };
  }

  async findSent(to: string, messageId: string, since?: string, progress?: { cursor?: string; save: (cursor?: string) => void }) {
    const c = this.self();
    const native = new DesktopDeliveries(dirname(this.file)).receipt(c.team,c.user,to,messageId);
    if (native) return native;
    const channel = await this.openConversation(to);
    let cursor = progress?.cursor || '';
    for (let pages = 0; pages < 1000; pages++) {
      const oldest = since ? String(Math.max(0, Math.floor(Date.parse(since) / 1000) - 86400)) : undefined;
      const page = await this.call('conversations.history', { channel, limit: '100', ...(oldest ? { oldest } : {}), ...(cursor ? { cursor } : {}) });
      const hit = (page.messages || []).find((m: any) => {
        if (m.user !== c.user || typeof m.text !== 'string') return false;
        if (m.client_msg_id === messageId) return true;
        const read = readSlackText(m.text);
        return 'text' in read && read.text.split('\n', 2)[1] === `ID: ${messageId}`;
      });
      if (hit) { progress?.save(); return { channel, ts: String(hit.ts) }; }
      cursor = page.response_metadata?.next_cursor || '';
      progress?.save(cursor || undefined);
      if (!cursor) return null;
    }
    throw new TransportError('Slack history is incomplete. Delivery remains uncertain.', false, 0, 'conversations.history');
  }

  async verifyDesktopChannel(channel: string): Promise<boolean> {
    if (!/^D[A-Z0-9]{2,20}$/.test(channel)) throw new TransportError('The desktop message is not in a Slack DM.', true);
    const c = this.self();
    const result = await this.call('conversations.info', { channel });
    if (!result.channel?.is_im || result.channel.id !== channel || typeof result.channel.user !== 'string')
      throw new TransportError('Slack did not verify the desktop DM channel.', true);
    return result.channel.user === c.user;
  }

  async scan(cursors: Record<string, string>, handle: (m: Received) => Promise<void>, save: (conversation: string, ts: string) => void, threads: { channel: string; ts: string }[] = []) {
    const c = this.self();
    const conversations: any[] = [];
    let listCursor = '';
    do {
      const list = await this.call('conversations.list', { types: 'im', limit: '200', ...(listCursor ? { cursor: listCursor } : {}) });
      conversations.push(...(list.channels || []));
      listCursor = list.response_metadata?.next_cursor || '';
    } while (listCursor);
    const ownerChannels = new Set(conversations.filter(x => x.user === c.user).map(x => x.id));
    const explicitHuman = (text: string) => text.startsWith('A2A Reply/1 ') || /^A2A [#@]/.test(text);
    const roots = [...new Map(threads.map(t => [`${t.channel}:${t.ts}`, t])).values()];
    const threadKey = (t: { channel: string; ts: string }) => `slack:${c.team}:${t.channel}:thread:${t.ts}${ownerChannels.has(t.channel) ? ':owner' : ''}`;
    roots.sort((a, b) => Number(cursors[threadKey(a)] || 0) - Number(cursors[threadKey(b)] || 0));
    for (const root of roots.slice(0, MAX_CONVERSATIONS_PER_SCAN)) {
      const selfChannel = ownerChannels.has(root.channel);
      // A separate cursor reads owner replies that older versions skipped.
      const key = threadKey(root), scanAt = (Date.now() / 1000).toFixed(6);
      try {
        let cursor = '';
        do {
          const page = await this.call('conversations.replies', { channel: root.channel, ts: root.ts, oldest: cursors[key] || root.ts, latest: scanAt, limit: '100', ...(cursor ? { cursor } : {}) });
          for (const event of (page.messages || []).sort((a: any, b: any) => Number(a.ts) - Number(b.ts))) {
            if (Number(event.ts) <= Number(cursors[key] || root.ts) || event.ts === root.ts || (event.user === c.user && !selfChannel) || !event.user || typeof event.text !== 'string' || event.subtype && event.subtype !== 'thread_broadcast') continue;
            const read = readSlackText(event.text);
            if (selfChannel && (event.user !== c.user || event.app_id || event.bot_id || !('text' in read) || !explicitHuman(read.text))) continue;
            await handle({ conversation: `slack:${c.team}:${root.channel}`, ref: `slack:${c.team}:${root.channel}:${event.ts}`,
              ts: String(event.ts), channel: root.channel, sender: slackAddress(c.team, String(event.user)), automated: !!(event.app_id || event.bot_id), ownerConversation: selfChannel,
              text: 'text' in read ? read.text : event.text, ...('error' in read ? { error: read.error } : {}), threadTs: root.ts });
            save(key, String(event.ts));
          }
          cursor = page.response_metadata?.next_cursor || '';
        } while (cursor);
        save(key, scanAt);
      } catch (error) {
        if (error instanceof TransportError && /^Slack: (thread_not_found|channel_not_found|not_in_channel|access_denied)$/.test(error.message)) continue;
        throw error;
      }
    }
    let messages = 0, scanned = 0;
    let failure: TransportError | undefined;
    const now = Date.now() / 1000;
    const key = (conversation: any) => `slack:${c.team}:${conversation.id}${conversation.user === c.user ? ':owner' : ''}`;
    // Slack's `updated` field does not change when a message arrives, so it cannot skip a conversation.
    // Each scan reads the conversations with the oldest cursor first: new conversations, then the longest unread.
    const candidates = conversations.filter(conversation => conversation.id && conversation.user && !conversation.is_user_deleted)
      .sort((a, b) => Number(cursors[key(a)] || 0) - Number(cursors[key(b)] || 0)).slice(0, MAX_CONVERSATIONS_PER_SCAN);
    for (const conversation of candidates) {
      try {
        const selfChannel = conversation.user === c.user;
        // Keep self-message controls separate from the old wire-message cursor.
        const k = key(conversation);
        // the first scan of a conversation reads only the recent days, not the whole history
        let from = Number(cursors[k] || now - (this.config.firstScanDays ?? 14) * 86_400);
        while (from < now) {
          // read the window (from, to]. A window with more than 2000 messages is cut in half and read again.
          let to = now, found: any[] | null = null;
          for (let halvings = 0; !found; halvings++) {
            found = await this.window(conversation.id, from, to);
            if (!found) { if (halvings >= 30) throw new TransportError('Slack history is too dense to read.', false); to = from + (to - from) / 2; }
          }
          for (const event of found.sort((a, b) => Number(a.ts) - Number(b.ts))) {
            if (Number(event.ts) <= from) continue;
            const ordinary = !event.subtype || event.subtype === 'thread_broadcast';
            // this account's own posts in a conversation with another member are sent messages, not received ones
            const own = event.user === c.user && conversation.user !== c.user;
            // a post with a user token through an app has bot_id and app_id; the member in `user` is the sender
            if (ordinary && !own && event.user && typeof event.text === 'string') {
              const read = readSlackText(event.text);
              if (selfChannel && (event.user !== c.user || event.app_id || event.bot_id || !('text' in read) || !explicitHuman(read.text))) continue;
              if ('text' in read && !read.text.startsWith('A2ANotes') && !explicitHuman(read.text)) continue;
              await handle({ conversation: k, ref: `slack:${c.team}:${conversation.id}:${event.ts}`, ts: String(event.ts), channel: conversation.id,
                sender: slackAddress(c.team, String(event.user)), automated: !!(event.app_id || event.bot_id), ownerConversation: selfChannel, text: 'text' in read ? read.text : event.text, ...('error' in read ? { error: read.error } : {}),
                ...(event.thread_ts ? { threadTs: String(event.thread_ts) } : {}) });
              messages++;
              save(k, String(event.ts));
            }
          }
          // the whole window is stored and checked: the next read starts after it
          save(k, to.toFixed(6));
          from = to;
        }
        scanned++;
      } catch (error) {
        // a rate limit stops the scan; another failure skips this conversation until the next scan
        if (error instanceof TransportError && error.retryAfter) throw error;
        // Slack lists some conversations that this token cannot read: move the cursor past them
        if (error instanceof TransportError && /^Slack: (channel_not_found|not_in_channel|access_denied)$/.test(error.message)) { save(key(conversation), now.toFixed(6)); continue; }
        failure ||= error instanceof TransportError ? error : new TransportError((error as Error).message, false);
      }
    }
    if (failure) throw failure;
    return { conversations: scanned, messages };
  }

  // All messages with a time in [from, to], or null when there are more than 2000. Slack returns pages from new to old.
  private async window(channel: string, from: number, to: number): Promise<any[] | null> {
    const found: any[] = [];
    let cursor = '';
    for (let pages = 0; pages < 20; pages++) {
      const page = await this.call('conversations.history', { channel, oldest: from.toFixed(6), latest: to.toFixed(6), inclusive: 'true', limit: '100', ...(cursor ? { cursor } : {}) });
      found.push(...(page.messages || []));
      cursor = page.response_metadata?.next_cursor || '';
      if (page.has_more && !cursor) throw new TransportError('Slack returned incomplete history.', false);
      if (!cursor) return found;
    }
    return null;
  }

  async download(fileRef: string, received: Received, maxBytes: number) {
    const c = this.self();
    if (!c.scopes.includes('files:read')) throw new TransportError('Reading files needs the optional Slack scope files:read.', true);
    const { user } = parseSlackAddress(received.sender);
    const info = await this.call('files.info', { file: fileRef });
    const file = info.file;
    if (!file || file.user !== user || file.size > maxBytes || file.size < 1 || file.is_external) throw new TransportError('The Slack file owner or size does not match the message.', true);
    const shared = file.shares?.private?.[received.channel] || file.shares?.im?.[received.channel] || (file.ims || []).includes(received.channel);
    if (!shared) throw new TransportError('The Slack file is not shared in this conversation.', true);
    const target = new URL(String(file.url_private || ''));
    if (!this.allowedHost(target)) throw new TransportError('Slack returned a file address that is not allowed.', true);
    let response: Response;
    try { response = await this.fetcher(target, { headers: { authorization: `Bearer ${c.access}` }, signal: AbortSignal.timeout(120_000) }); }
    catch { throw new TransportError('The Slack file download failed.', false); }
    if (!response.ok || !response.body) throw new TransportError('The Slack file download failed.', false);
    const chunks: Uint8Array[] = []; let count = 0;
    for await (const chunk of response.body) { count += chunk.length; if (count > maxBytes) throw new TransportError('The Slack file is larger than the limit.', true); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
}

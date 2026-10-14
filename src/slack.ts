// Slack transport through the signed-in desktop app. It never reads OAuth credentials.
import { createHash } from 'node:crypto';
import { unescapeMarkup } from './protocol.ts';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { DesktopDeliveries } from './slack-desktop-delivery.ts';
import { DesktopUnavailableError, type SlackDesktopHook } from './slack-desktop.ts';
import { type AgentDeliveryStatus, type SendCheckpoint, savePrivate } from './store.ts';
import { TransportError, type Identity, type Person, type Received, type SendInput, type Transport } from './transport.ts';
import { readSlackText, slackBlocks, DATA_MARKER, MAX_SLACK_TEXT } from './slack-format.ts';
import { BackgroundConnection, SlackAppConnection, type AppConnection, type AppSnapshot, type BackgroundCache } from './slack-app.ts';

export const REQUIRED_SCOPES: string[] = [];
// Each recovery scan reads at most this many direct conversations.
const MAX_SCAN_CONVERSATIONS = 20;
export const OPTIONAL_SCOPES: string[] = [];
export interface SlackConfig {
  teamId: string; desktopUrl?: string; acknowledgementEmoji?: string; allowSelf?: boolean; projectLink?: string;
  // Old settings remain readable for rollback. The app transport ignores them.
  clientId?: string; redirectUri?: string; apiBase?: string; authorizeUrl?: string; noRefresh?: boolean; firstScanDays?: number;
}
export const slackAddress = (team: string, user: string) => `slack:${team}:${user}`;
export function isLoopbackPage(value: string) {
  try {const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password;} catch {return false;}
}
export function parseSlackAddress(address: string) {
  const match = /^slack:(T[A-Z0-9]{2,20}):([UW][A-Z0-9]{2,20})$/.exec(address);
  if (!match) throw new TransportError('Use a Slack address with a workspace ID and member ID.', true);
  return {team: match[1], user: match[2]};
}
interface Binding {team: string; user: string; name: string}
export class SlackTransport implements Transport {
  desktopSender?: Pick<SlackDesktopHook, 'canSend' | 'post'> & Partial<Pick<SlackDesktopHook, 'status' | 'react' | 'notice' | 'read' | 'canRead'>>;
  readonly name = 'slack'; readonly fileField = 'Slack';
  private binding?: Binding;
  private verified = false;
  private disabled = false;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private cache?: AppSnapshot;
  private background: BackgroundCache = {peers: new Map(), people: new Map()};
  private readonly connection: (user?: string) => Promise<AppConnection>;
  private readonly waitTimeoutMs: number;
  constructor(readonly file: string, readonly config: SlackConfig, fetcher?: typeof fetch,
    options: {open?: (user?: string) => Promise<AppConnection>; now?: () => number; waitTimeoutMs?: number} = {}) {
    this.waitTimeoutMs = options.waitTimeoutMs ?? 20_000;
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
    if (saved?.disabled === true) this.disabled = true;
    else if (saved) {
      if (!/^T[A-Z0-9]+$/.test(saved.team) || !/^[UW][A-Z0-9]+$/.test(saved.user) || typeof saved.name !== 'string' || saved.access)
        throw new Error('The app account file is invalid. Use a separate file from Slack credentials.');
      this.binding = saved;
    }
    this.connection = options.open || (async user => new BackgroundConnection(
      await SlackAppConnection.open(config.desktopUrl || 'http://127.0.0.1:19322', config.teamId, user, {fetcher}), (method, args) => this.nativeRead(method, args), this.background));
  }
  private notReady(action: string) {
    return new TransportError(`Slack Desktop background access is not ready. ${action}`, true, 10, 'slack.desktop');
  }
  // Waits briefly for the desktop hook after start or a Slack restart. A2A Notes never falls back to window controls.
  private async ready(check: () => boolean, action: string) {
    for (const until = Date.now() + this.waitTimeoutMs; !check(); await new Promise(r => setTimeout(r, 100)))
      if (Date.now() >= until) throw this.notReady(action);
  }
  private async nativeRead(method: string, args: Record<string, unknown>) {
    const binding = this.binding, sender = this.desktopSender;
    if (!binding || !sender?.read || !sender.canRead) throw this.notReady('No action was taken.');
    await this.ready(() => sender.canRead!(), 'No action was taken.');
    return sender.read({team: binding.team, owner: binding.user, method, args});
  }
  identity(): Identity | null {
    const c = this.binding;
    return c && c.team === this.config.teamId && !this.disabled ? {transport: 'slack', address: slackAddress(c.team, c.user), name: c.name, scopes: [], missingScopes: [], optionalMissing: [], available:this.verified} : null;
  }
  private run<T>(action: (app: AppConnection, snapshot: AppSnapshot) => Promise<T>): Promise<T> {
    const generation = this.generation;
    const result = this.tail.then(async () => {
      if (this.disabled || generation !== this.generation) throw new TransportError('The Slack app connector is disconnected.', true);
      let app: AppConnection | undefined;
      let checked = false;
      try {
        app = await this.connection(this.binding?.user);
        const s = await app.snapshot();
        if (s.team !== this.config.teamId || !/^[UW][A-Z0-9]+$/.test(s.user) || this.binding && (s.user !== this.binding.user || s.team !== this.binding.team))
          throw new TransportError('The Slack app account differs from the saved account.', true);
        if (generation !== this.generation) throw new TransportError('The Slack app connector was disconnected.', true);
        if (!this.binding) {
          const c = {team: s.team, user: s.user, name: s.people.find(p => p.id === s.user)?.name || s.user};
          savePrivate(this.file, c); this.binding = c;
        }
        const name = s.people.find(p => p.id === s.user && p.active)?.name;
        if (name && name !== this.binding.name) {this.binding.name=name;savePrivate(this.file,this.binding);}
        this.verified = true; checked = true; this.cache = s;
        return await action(app, s);
      } catch (error) {
        if (!checked) {
          this.verified = false;
          if (!(error instanceof TransportError)) throw new TransportError('Open Slack Desktop with its loopback debugging port to continue.', true, 10, 'slack.desktop');
        }
        throw error;
      } finally {await app?.close();}
    });
    this.tail = result.catch(() => {}); return result;
  }
  viewStatus() {return this.cache ? {people:this.cache.people.length, conversations:this.cache.peers.length, messages:this.cache.messages.length} : null;}
  async connect() {this.disabled = false; await this.run(async () => {});}
  async refresh() {if (!this.disabled) await this.run(async () => {});}
  disconnect() {this.generation++; this.disabled = true; this.verified = false; this.binding = undefined; this.cache = undefined; savePrivate(this.file, {disabled:true});}
  private async wait(app: AppConnection, check: (s: AppSnapshot) => boolean) {
    for (const until = Date.now() + this.waitTimeoutMs; Date.now() < until; await new Promise(r => setTimeout(r, 100))) {
      let s: AppSnapshot;
      try {s=await app.snapshot();} catch(error) {
        if(error instanceof TransportError && !error.definite && error.method === 'slack.desktop') continue;
        throw error;
      }
      if (s.team !== this.binding?.team || s.user !== this.binding?.user || this.disabled) throw new TransportError('The Slack app account changed.', true);
      this.cache = s; if (check(s)) return s;
    }
    throw new TransportError('The Slack app did not confirm the expected message view.', false);
  }
  // Selects the conversation inside A2A Notes only. The Slack window keeps its current conversation.
  private async view(app: AppConnection, id: string) {
    await app.navigate(id);
    return this.wait(app, s => !!s.channel && s.peers.some(p => p.id === s.channel && (p.id === id || p.user === id)));
  }
  private person(s: AppSnapshot, user: string): Person {
    const p = s.people.find(p => p.id === user);
    if (!p || !p.active) throw new TransportError('Open the active recipient in Slack so the app can verify that person.', true);
    return {address: slackAddress(s.team, p.id), name: p.name, realName: p.realName, title: p.title, active: p.active};
  }
  async findPeople(query: string, limit: number) {
    return this.run(async app => ({people: (await app.directory()).filter(p => p.active && [p.id, p.name, p.realName].some(v => v.toLowerCase().includes(query.toLowerCase())))
      .slice(0, limit).map(p => ({address: slackAddress(this.binding!.team, p.id), name: p.name, realName: p.realName, title: p.title, active: p.active}))}));
  }
  async personOf(address: string) {
    try {const {team, user} = parseSlackAddress(address); if (this.cache?.team === team) return this.person(this.cache, user);} catch {}
    return undefined;
  }
  async nameOf(address: string) {return (await this.personOf(address))?.name;}
  async checkRecipient(address: string) {
    const {team, user} = parseSlackAddress(address);
    if (team !== this.config.teamId) throw new TransportError('Choose a person in the configured workspace.', true);
    return this.run(async (app, s) => {
      if (user === s.user && !this.config.allowSelf) throw new TransportError('Choose another workspace member.', true);
      return this.person(await this.view(app, user), user);
    });
  }
  async verifyDesktopChannel(channel: string) {
    return this.run(async (app, s) => {const view = await this.view(app, channel); return view.peers.some(p => p.id === channel && p.user === s.user);});
  }
  async verifyRetry(to: string, messageId: string, checkpoint: SendCheckpoint) {
    const {team} = parseSlackAddress(to);
    if (team !== this.config.teamId || checkpoint.postStarted || !/^D[A-Z0-9]+$/.test(checkpoint.channel || '') ||
        Object.values(checkpoint.uploads).some(u => u.phase !== 'complete' || !/^APP[a-f0-9]{64}$/.test(u.fileId)))
      throw new TransportError('Saved post or file progress does not permit this retry.', true);
    await this.run(async (_app, s) => {
      new DesktopDeliveries(dirname(this.file)).verifyRetry(s.team, s.user, to, messageId, checkpoint.channel!);
    });
  }
  async send(input: SendInput) {
    if (Object.values(input.checkpoint?.uploads || {}).some(upload => !/^APP[a-f0-9]{64}$/.test(upload.fileId)))
      throw new TransportError('Saved file progress requires the earlier Slack adapter. No new message was posted.', true);
    if (input.files.reduce((size, f) => size + f.bytes.length, 0) > 26_000) throw new TransportError('The encoded attachments exceed the app text limit. No message was posted.', true);
    const files = Object.fromEntries(input.files.map(f => [f.id, 'APP' + createHash('sha256').update(f.bytes).digest('hex')]));
    const attachments = input.files.map(f => ({ref:files[f.id], name:f.name, base64:f.bytes.toString('base64')}));
    const {team, user} = parseSlackAddress(input.to);
    if (team !== this.config.teamId) throw new TransportError('Choose a recipient in the configured workspace.', true);
    // JSON escapes preserve the exact wire text without creating active mention text.
    const literal = (value: string) => value.replace(/@/g, '@\u200b');
    const data = JSON.stringify(input.wire(files)).replace(/@/g, '\\u0040').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    const attachmentText = attachments.length ? `A2A Notes attachments: ${JSON.stringify(attachments).replace(/@/g, '\\u0040').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')}\n` : '';
    const text = `A2A Notes: ${literal(input.display.subject)}\nFrom ${literal(input.display.senderName)}\n\n${literal(input.display.body)}\n\nReply with A2A Reply/1 ${input.messageId} on the first line.\nA reply does not approve actions. ✅ means received.\n${attachmentText}${DATA_MARKER}${data}`;
    if (Buffer.byteLength(text) > MAX_SLACK_TEXT) throw new TransportError('The message and encoded attachments exceed the app text limit. No message was posted.', true);
    return this.run(async (app, s) => {
      if (user === s.user && !this.config.allowSelf) throw new TransportError('Choose another workspace member.', true);
      const notReady = () => new TransportError('Slack native sending is not ready. No post was started.', true, 0, 'slack.desktop', undefined, undefined, 'app_control_unavailable');
      const checkpoint = input.checkpoint || {uploads: {}};
      // A saved checkpoint lets a lost read before posting return to the queue instead of becoming uncertain.
      input.saveCheckpoint?.(checkpoint);
      const view = await this.view(app, user); this.person(view, user);
      const generation = this.generation;
      const channel = view.channel!;
      if (checkpoint.channel && checkpoint.channel !== channel) throw new TransportError('The saved DM differs from the app DM.', true);
      checkpoint.channel = channel;
      for (const f of input.files) checkpoint.uploads[f.id] = {fileId:files[f.id], url:'slack-app:inline', phase:'complete'};
      input.saveCheckpoint?.(checkpoint);
      // The saved conversation lets a2anotes_retry_send queue the same note after the setting changes.
      if (!this.desktopSender || this.desktopSender.status?.().sendEnabled === false)
        throw new TransportError('Slack Desktop native sending is turned off. Run a2a-notes desktop enable with --send. No post was started.', true,
          0, 'slack.desktop', undefined, undefined, 'app_control_unavailable');
      const sender = this.desktopSender;
      try { await this.wait(app, s => s.channel === channel && sender.canSend()); }
      catch (error) {
        if (error instanceof TransportError && !error.definite) throw notReady();
        throw error;
      }
      if (sender.canSend() !== true) throw notReady();
      {
        checkpoint.postTransport = 'desktop';
        try {
          const receipt = await sender.post({team:s.team, owner:s.user, to:input.to, channel,
            messageId:input.messageId, text, blocks:JSON.stringify(slackBlocks(input.display, {projectLink:this.config.projectLink})),
            ...(input.threadTs ? {threadTs:input.threadTs} : {})}, () => {
              if (this.disabled || this.generation !== generation || this.binding?.team !== s.team || this.binding?.user !== s.user)
                throw new TransportError('The Slack app account changed before posting.', true);
              checkpoint.postStarted = true; input.saveCheckpoint?.(checkpoint);
            });
          return {...receipt,files};
        } catch (error) {
          if (error instanceof TransportError && error.definite && checkpoint.postStarted) {checkpoint.postStarted=false;input.saveCheckpoint?.(checkpoint);}
          if (error instanceof DesktopUnavailableError) throw notReady();
          throw error;
        }
      }
    });
  }
  private messageId(text: string) {const read = readSlackText(text); return 'text' in read ? /^ID: (.+)$/m.exec(read.text)?.[1] : undefined;}
  async findSent(to: string, id: string) {
    const {team, user} = parseSlackAddress(to);
    if (team !== this.config.teamId) throw new TransportError('The saved recipient belongs to another workspace.', true);
    return this.run(async (app, snapshot) => {
      const receipt = new DesktopDeliveries(dirname(this.file)).receipt(snapshot.team,snapshot.user,to,id);
      if (receipt) return receipt;
      const s = await this.view(app, user), m = s.messages.find(m => m.channel === s.channel && m.user === s.user && (m.client_msg_id === id || this.messageId(m.text) === id));
      if (!m) throw new TransportError('The app has not shown the earlier message. No duplicate was posted.', false);
      return {channel: m.channel, ts: m.ts};
    });
  }
  async acknowledge(reference: Record<string, string>) {
    const emoji = this.config.acknowledgementEmoji || 'white_check_mark';
    if (!/^[a-z0-9_+-]{1,64}$/.test(emoji)) throw new TransportError('The acknowledgement emoji name is invalid.', true);
    if (!/^D[A-Z0-9]+$/.test(reference.channel) || !/^\d+\.\d+$/.test(reference.ts)) throw new TransportError('The saved app message reference is invalid.', true);
    return this.run(async app => {
      await this.view(app, reference.channel); await app.message(reference.channel, reference.ts);
      const s = await app.snapshot();
      const m = s.messages.find(m => m.channel === reference.channel && m.ts === reference.ts);
      if (!m) throw new TransportError('Slack did not return the original message. No receipt was added.', true);
      if (m.reactions.some(r => r.name === emoji && r.users.includes(s.user))) return;
      const sender = this.desktopSender;
      if (!sender?.react || !sender.canRead) throw this.notReady('The receipt will retry.');
      await this.ready(() => sender.canRead!(), 'The receipt will retry.');
      try { await sender.react({team:s.team,owner:s.user,channel:reference.channel,ts:reference.ts,name:emoji}); }
      catch (error) { if (error instanceof DesktopUnavailableError) throw this.notReady('The receipt will retry.'); throw error; }
    });
  }
  async notifyDelivery(reference: Record<string, string>, status: AgentDeliveryStatus) {
    if (!/^D[A-Z0-9]+$/.test(reference.channel) || !/^[a-f0-9-]{36}$/.test(reference.operation_id)) throw new TransportError('The delivery notice reference is invalid.', true);
    const body = status === 'unassigned' ? 'Message received. No agent was selected. The recipient must choose an agent in Taskboard.'
      : status === 'notified' ? 'The agent received your message. This does not mean completed work.'
      : 'Message received. Agent notification is pending. The recipient can check delivery in Taskboard.';
    const text = `${body}\nReceipt ID: ${reference.operation_id}`;
    return this.run(async app => {
      const s = await this.view(app, reference.channel);
      if (s.messages.some(m => m.channel === reference.channel && m.user === s.user && (m.text === text || m.client_msg_id === reference.operation_id))) return;
      if (reference.reconcile === 'true') throw new TransportError('The app has not shown the earlier delivery notice. No duplicate was posted.', false);
      const sender = this.desktopSender;
      if (!sender?.notice || sender.status?.().sendEnabled === false) throw new TransportError('Slack Desktop native sending is turned off. No delivery notice was posted.', true);
      await this.ready(() => sender.canSend(), 'The delivery notice will retry.');
      try { await sender.notice({team:s.team, owner:s.user, channel:reference.channel, operationId:reference.operation_id, text}); }
      catch (error) { if (error instanceof DesktopUnavailableError) throw this.notReady('The delivery notice will retry.'); throw error; }
    });
  }
  async scan(cursors: Record<string, string>, handle: (m: Received) => Promise<void>, save: (key: string, ts: string) => void, threads: {channel: string; ts: string}[] = []) {
    const s = await this.run(async (app, s) => {
      // Recovery reads the self-conversation, conversations of sent notes, and conversations with saved cursors.
      const known = Object.entries(cursors).map(([key, ts]) => ({ts, m: /^slack:(T[A-Z0-9]+):(D[A-Z0-9]+)(?::owner)?$/.exec(key)}))
        .filter(x => x.m?.[1] === s.team).sort((a, b) => Number(b.ts) - Number(a.ts)).map(x => x.m![2]);
      const ids = [...new Set([s.user, ...threads.map(t => t.channel).filter(c => /^D[A-Z0-9]+$/.test(c)), ...known])].slice(0, MAX_SCAN_CONVERSATIONS);
      await app.load(ids);
      return app.snapshot();
    });
      let messages = 0;
      for (const m of [...s.messages].sort((a, b) => Number(a.ts) - Number(b.ts))) {
        const peer = s.peers.find(p => p.id === m.channel); if (!peer) continue;
        const owner = peer.user === s.user;
        if (m.user === s.user && !owner || m.subtype && m.subtype !== 'thread_broadcast') continue;
        const read = readSlackText(m.text), text = 'text' in read ? read.text : m.text;
        if (!text.startsWith('A2ANotes') && !text.startsWith('A2A Reply/1 ') && !/^A2A [#@]/.test(text)) continue;
        if (owner && (m.user !== s.user || m.bot_id || m.app_id || text.startsWith('A2ANotes'))) continue;
        const key = `slack:${s.team}:${m.channel}${owner ? ':owner' : ''}`;
        // Inspect every displayed record. Older records can load after newer records.
        await handle({conversation: key, ref: `slack:${s.team}:${m.channel}:${m.ts}`, channel: m.channel, ts: m.ts,
          sender: slackAddress(s.team, m.user), text, ownerConversation: owner, automated: !!(m.bot_id || m.app_id),
          ...(m.thread_ts ? {threadTs: m.thread_ts} : {}), ...('error' in read ? {error: read.error} : {})});
        if (Number(m.ts) > Number(cursors[key] || 0)) save(key, m.ts); messages++;
      }
      return {conversations: s.peers.length, messages};
  }
  async download(fileRef: string, received: Received, maxBytes: number): Promise<Buffer> {
    if (!/^APP[a-f0-9]{64}$/.test(fileRef)) throw new TransportError('This attachment requires an older Slack API transport. No API request was made.', true);
    const {team, user} = parseSlackAddress(received.sender);
    if (team !== this.config.teamId || received.ref !== `slack:${team}:${received.channel}:${received.ts}`)
      throw new TransportError('The attachment message reference is invalid.', true);
    return this.run(async app => {
      await this.view(app, received.channel); await app.message(received.channel, received.ts);
      const s = await app.snapshot();
      const m = s.messages.find(m => m.channel === received.channel && m.ts === received.ts && m.user === user);
      if (!m) throw new TransportError('Open the original attachment message in Slack before retrying.', true);
      const text = unescapeMarkup(m.text);
      const lines = text.split('\n').filter(line => line.startsWith('A2A Notes attachments: '));
      for (const line of lines.reverse()) {
        let records: any; try {records = JSON.parse(line.slice('A2A Notes attachments: '.length));} catch {continue;}
        if (!Array.isArray(records) || records.length > 20) continue;
        const item = records.find(f => f.ref === fileRef);
        if (!item || typeof item.base64 !== 'string' || item.base64.length > Math.ceil(maxBytes / 3) * 4) continue;
        const bytes = Buffer.from(item.base64, 'base64');
        if (bytes.length < 1 || bytes.length > maxBytes || bytes.toString('base64') !== item.base64 ||
          'APP' + createHash('sha256').update(bytes).digest('hex') !== fileRef) continue;
        return bytes;
      }
      throw new TransportError('The attachment bytes do not match the saved message reference.', true);
    });
  }
}

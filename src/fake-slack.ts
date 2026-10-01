// A fake Slack Web API for tests and sandboxes. It keeps one workspace in memory and implements the methods that
// src/slack.ts calls, with Slack's reply shapes: OAuth, users, direct message conversations, history, posts, and
// the external file upload flow. Control routes under /_fake/ inject raw text and make a method fail.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface FakeUser { id: string; name: string; real_name?: string; email?: string; is_bot?: boolean; deleted?: boolean }
interface Msg { ts: string; user: string; text: string; bot_id?: string; app_id?: string; blocks?: unknown; thread_ts?: string; subtype?: string; files?: { id: string }[]; client_msg_id?: string }
interface Channel { id: string; members: [string, string]; messages: Msg[]; replies: Msg[]; updated: number }
interface File { id: string; user: string; name: string; size: number; bytes?: Buffer; channels: string[] }
type Failure = { mode: 'error' | 'lost' | 'ratelimit' | 'timeout'; count: number; error?: string; retryAfter?: number };

export interface FakeSlack {
  url: string; server: Server; team: string;
  channels: Map<string, Channel>;
  tokenFor(user: string): string;
  // writes credentials in the form that src/slack.ts reads
  credentials(user: string, scopes?: string[]): { user: string; team: string; name: string; scopes: string[]; access: string };
  inject(from: string, to: string, text: string): string;
  fail(method: string, failure: Failure): void;
  close(): Promise<void>;
}

const ALL_SCOPES = ['chat:write', 'im:write', 'im:read', 'im:history', 'users:read', 'users:read.email', 'files:read', 'files:write'];

async function body(req: IncomingMessage): Promise<{ raw: Buffer; params: Record<string, string> }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  const type = req.headers['content-type'] || '';
  let params: Record<string, string> = {};
  if (type.includes('application/x-www-form-urlencoded')) params = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  else if (type.includes('application/json') && raw.length) params = JSON.parse(raw.toString('utf8'));
  return { raw, params };
}

export async function startFakeSlack(options: { port?: number; team?: string; users: FakeUser[] }): Promise<FakeSlack> {
  const team = options.team || 'TFAKE01';
  const users = new Map(options.users.map(u => [u.id, u]));
  const tokens = new Map<string, string>(); // token -> user
  const refresh = new Map<string, string>(); // refresh token -> user
  const codes = new Map<string, string>();   // oauth code -> user
  const channels = new Map<string, Channel>();
  const files = new Map<string, File>();
  const failures = new Map<string, Failure>();
  let clock = Math.floor(Date.now() / 1000) * 1_000_000;
  const nextTs = () => { clock = Math.max(clock + 1, Date.now() * 1000); return `${Math.floor(clock / 1_000_000)}.${String(clock % 1_000_000).padStart(6, '0')}`; };
  const tokenFor = (user: string) => { const t = `xoxp-fake-${user}`; tokens.set(t, user); return t; };
  const channelFor = (a: string, b: string) => {
    const pair = [a, b].sort() as [string, string];
    const id = `D${pair.join('').replace(/[^A-Z0-9]/g, '').slice(0, 18)}`;
    if (!channels.has(id)) channels.set(id, { id, members: pair, messages: [], replies: [], updated: Date.now() });
    return channels.get(id)!;
  };
  const member = (u: FakeUser) => ({ id: u.id, team_id: team, name: u.name.toLowerCase().replace(/\s+/g, '.'), real_name: u.real_name || u.name, deleted: !!u.deleted, is_bot: !!u.is_bot,
    profile: { display_name: u.name, real_name: u.real_name || u.name, title: '', ...(u.email ? { email: u.email } : {}) } });
  let base = '';

  const methods: Record<string, (p: Record<string, string>, user: string | undefined, raw: Buffer) => unknown> = {
    'auth.test': (_p, user) => ({ user_id: user, team_id: team }),
    'oauth.v2.access': p => {
      let user: string | undefined;
      if (p.grant_type === 'refresh_token') { user = refresh.get(p.refresh_token); refresh.delete(p.refresh_token); }
      else { user = codes.get(p.code); codes.delete(p.code); }
      if (!user) throw new Error('invalid_code');
      const rt = `xoxe-fake-${randomBytes(6).toString('hex')}`; refresh.set(rt, user);
      const token = { id: user, scope: ALL_SCOPES.join(','), access_token: tokenFor(user), refresh_token: rt, expires_in: 43200, token_type: 'user' };
      return p.grant_type === 'refresh_token' ? { ...token, authed_user: token, team: { id: team } } : { authed_user: token, team: { id: team } };
    },
    'users.info': p => { const u = users.get(p.user); if (!u) throw new Error('user_not_found'); return { user: member(u) }; },
    'users.list': p => {
      const all = [...users.values()], start = Number(p.cursor || 0), size = Math.min(Number(p.limit || 200), 200);
      const next = start + size < all.length ? String(start + size) : '';
      return { members: all.slice(start, start + size).map(member), response_metadata: { next_cursor: next } };
    },
    'users.lookupByEmail': p => { const u = [...users.values()].find(x => x.email?.toLowerCase() === String(p.email).toLowerCase()); if (!u) throw new Error('users_not_found'); return { user: member(u) }; },
    'conversations.open': (p, user) => { const other = String(p.users); if (!users.has(other)) throw new Error('user_not_found'); return { channel: { id: channelFor(user!, other).id } }; },
    'conversations.list': (_p, user) => ({ channels: [...channels.values()].filter(c => c.members.includes(user!)).map(c => ({ id: c.id, is_im: true, user: c.members[0] === user ? c.members[1] : c.members[0], updated: c.updated })), response_metadata: { next_cursor: '' } }),
    'conversations.history': (p, user) => {
      const c = channels.get(p.channel); if (!c || !c.members.includes(user!)) throw new Error('channel_not_found');
      const oldest = Number(p.oldest || 0), latest = p.latest ? Number(p.latest) : Infinity, inclusive = p.inclusive === 'true';
      const matching = c.messages.filter(m => (inclusive ? Number(m.ts) >= oldest : Number(m.ts) > oldest) && Number(m.ts) <= latest).sort((a, b) => Number(b.ts) - Number(a.ts));
      const start = Number(p.cursor || 0), size = Math.min(Number(p.limit || 100), 200);
      const slice = matching.slice(start, start + size), more = start + size < matching.length;
      return { messages: slice, has_more: more, response_metadata: { next_cursor: more ? String(start + size) : '' } };
    },
    'chat.postMessage': (p, user) => {
      const c = channels.get(p.channel); if (!c || !c.members.includes(user!)) throw new Error('channel_not_found');
      // as in Slack: a user-token post through an app carries the app's bot_id and app_id, and a post with blocks has
      // each newline in its text replaced by a space (observed in a real workspace on 2026-09-30)
      const text = String(p.text || '');
      const msg: Msg = { ts: nextTs(), user: user!, text: p.blocks ? text.replace(/\n/g, ' ') : text, bot_id: 'BFAKEAPP', app_id: 'AFAKEAPP',
        ...(p.blocks ? { blocks: JSON.parse(p.blocks) } : {}), ...(p.client_msg_id ? { client_msg_id: p.client_msg_id } : {}) };
      if (p.thread_ts) {
        msg.thread_ts = p.thread_ts;
        c.replies.push(msg);
        // a reply that is also sent to the conversation appears in history as a thread_broadcast
        if (p.reply_broadcast === 'true') c.messages.push({ ...msg, subtype: 'thread_broadcast' });
      } else c.messages.push(msg);
      c.updated = Date.now();
      return { channel: c.id, ts: msg.ts, message: msg };
    },
    'files.getUploadURLExternal': (p, user) => {
      const id = `F${randomBytes(5).toString('hex').toUpperCase()}`;
      files.set(id, { id, user: user!, name: p.filename, size: Number(p.length), channels: [] });
      return { upload_url: `${base}/_upload/${id}`, file_id: id };
    },
    'files.completeUploadExternal': (p, user) => {
      const list = JSON.parse(p.files || '[]') as { id: string }[];
      const c = channels.get(p.channel_id); if (!c || !c.members.includes(user!)) throw new Error('channel_not_found');
      for (const item of list) {
        const f = files.get(item.id); if (!f || f.user !== user || !f.bytes) throw new Error('file_not_found');
        f.channels.push(c.id);
        c.messages.push({ ts: nextTs(), user: user!, text: '', files: [{ id: f.id }] });
      }
      return { files: list };
    },
    'files.info': (p, user) => {
      const f = files.get(p.file); if (!f || !f.channels.some(ch => channels.get(ch)?.members.includes(user!))) throw new Error('file_not_found');
      return { file: { id: f.id, user: f.user, name: f.name, size: f.size, is_external: false, url_private: `${base}/_files/${f.id}`, shares: { im: Object.fromEntries(f.channels.map(ch => [ch, [{ ts: '0' }]])) }, ims: f.channels } };
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', base);
    const reply = (status: number, value: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value));
    try {
      if (url.pathname === '/oauth/v2/authorize') {
        const redirect = url.searchParams.get('redirect_uri') || '', state = url.searchParams.get('state') || '';
        const links = [...users.values()].filter(u => !u.is_bot && !u.deleted).map(u => {
          const code = `code-${randomBytes(8).toString('hex')}`; codes.set(code, u.id);
          const target = `${redirect}?${new URLSearchParams({ code, state })}`;
          return `<li><a href="${target.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Sign in as ${u.name.replace(/[<&]/g, '')}</a></li>`;
        }).join('');
        return res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Fake Slack sign-in</title><h1>Fake Slack workspace ${team}</h1><ul>${links}</ul>`);
      }
      if (url.pathname.startsWith('/_upload/')) {
        const f = files.get(url.pathname.slice(9)); const { raw } = await body(req);
        if (!f || raw.length !== f.size) return res.writeHead(400).end('bad upload');
        f.bytes = raw; return res.writeHead(200).end('OK');
      }
      if (url.pathname.startsWith('/_files/')) {
        const f = files.get(url.pathname.slice(8)), user = tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
        if (!f?.bytes || !user || !f.channels.some(ch => channels.get(ch)?.members.includes(user))) return res.writeHead(404).end();
        return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(f.bytes);
      }
      if (url.pathname === '/_fake/inject') { const { params } = await body(req); return reply(200, { ts: inject(params.from, params.to, params.text) }); }
      if (url.pathname === '/_fake/fail') { const { params } = await body(req); failures.set(params.method, { mode: params.mode as Failure['mode'], count: Number(params.count || 1), error: params.error, retryAfter: Number(params.retryAfter || 1) }); return reply(200, { ok: true }); }
      if (url.pathname === '/_fake/state') return reply(200, { team, channels: [...channels.values()].map(c => ({ ...c })), files: [...files.values()].map(({ bytes: _b, ...f }) => f) });
      const method = url.pathname.replace(/^\/api\//, '');
      const handler = methods[method];
      if (!handler) return reply(404, { ok: false, error: 'unknown_method' });
      const { raw, params } = await body(req);
      const user = tokens.get((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!user && method !== 'oauth.v2.access') return reply(200, { ok: false, error: 'invalid_auth' });
      const failure = failures.get(method);
      if (failure && failure.count > 0) {
        failure.count--;
        if (failure.mode === 'ratelimit') return reply(429, { ok: false, error: 'ratelimited' }, { 'retry-after': String(failure.retryAfter || 1) });
        if (failure.mode === 'error') return reply(200, { ok: false, error: failure.error || 'fake_failure' });
        if (failure.mode === 'timeout') { setTimeout(() => res.destroy(), 50); return; }
        // lost: Slack does the work, but the reply never arrives
        handler(params, user, raw); res.destroy(); return;
      }
      return reply(200, { ok: true, ...(handler(params, user, raw) as object) });
    } catch (error) { return reply(200, { ok: false, error: (error as Error).message.replace(/[^a-z_]/g, '') || 'fake_error' }); }
  });

  function inject(from: string, to: string, text: string) {
    const c = channelFor(from, to);
    const msg: Msg = { ts: nextTs(), user: from, text };
    c.messages.push(msg); c.updated = Date.now();
    return msg.ts;
  }

  server.keepAliveTimeout = 65_000;
  await new Promise<void>(resolve => server.listen(options.port || 0, '127.0.0.1', () => resolve()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : options.port}`;
  return {
    url: base, server, team, channels, tokenFor, inject,
    credentials: (user, scopes = ALL_SCOPES) => ({ user, team, name: users.get(user)?.real_name || users.get(user)?.name || user, scopes, access: tokenFor(user) }),
    fail: (method, failure) => failures.set(method, failure),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

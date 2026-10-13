// Reads Slack Desktop events and optionally sends approved notes. It does not return credential values.
import WebSocket, { type RawData } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readSlackText, DATA_MARKER } from './slack-format.ts';
import { savePrivate } from './store.ts';
import { TransportError, type Identity, type Received } from './transport.ts';
import { DesktopDeliveries } from './slack-desktop-delivery.ts';
import { NATIVE_FUNCTIONS, type DesktopPost, type NativeResult } from './slack-desktop-native.ts';
import { decode } from './protocol.ts';

export interface DesktopConfig { url: string; send?: boolean }
export interface DesktopStatus {
  enabled: boolean; connected: boolean; accountVerified: boolean; listening: boolean; lastEventAt?: string;
  pending: number; error?: string;
  sendEnabled?: boolean; canSend?: boolean;
}
export class DesktopUnavailableError extends TransportError {
  constructor() { super('Slack Desktop sending is unavailable before posting.', true); }
}
interface Event { type: 'message'; channel: string; user: string; text: string; ts: string; thread_ts?: string; bot_id?: string; app_id?: string; client_msg_id?: string }
interface Pending { event: Event; team: string; owner: string; attempts: number; nextAt: number }
interface Target { id: string; type: string; url: string; webSocketDebuggerUrl: string }

// Only these identifiers leave the renderer. No object containing credentials is returned.
export const DESKTOP_IDENTITY = `(() => {
  const t = globalThis.TS;
  const team = t?.boot_data?.team_id || t?.model?.team?.id || /^\\/client\\/(T[A-Z0-9]+)(?:\\/|$)/.exec(location.pathname)?.[1];
  let user = t?.boot_data?.user_id || t?.model?.user?.id;
  if (!user) {
    const button = document.querySelector('[data-qa="user-button"]');
    const key = button && Object.keys(button).find(k => k.startsWith('__reactFiber'));
    let component = key && button[key];
    for (let i = 0; component && i < 50; i++, component = component.return) {
      if ((component.type?.displayName || component.type?.name) === 'User') {
        user = component.memoizedProps?.currentUserId;
        break;
      }
    }
  }
  return {team: typeof team === 'string' ? team : null, user: typeof user === 'string' ? user : null};
})()`;

export function desktopURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use an HTTP debugging endpoint on 127.0.0.1 with a port and no path or credentials.');
  return url;
}
export async function verifySlackDesktopEndpoint(endpoint: URL): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Slack Desktop verification currently supports macOS.');
  const run = promisify(execFile);
  const { stdout } = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${endpoint.port}`, '-sTCP:LISTEN', '-Fpn'], { timeout: 3000 });
  let pid = '';
  const owners = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    if (line.startsWith('n')) {
      if (line.slice(1) !== `127.0.0.1:${endpoint.port}`) throw new Error('The debugging port is not restricted to IPv4 loopback.');
      owners.add(pid);
    }
  }
  if (!owners.size) throw new Error('Slack Desktop does not own this debugging port.');
  for (const owner of owners) {
    if (!/^\d+$/.test(owner)) throw new Error('The debugging process could not be checked.');
    const found = await run('/bin/ps', ['-p', owner, '-o', 'comm='], { timeout: 3000 });
    if (found.stdout.trim() !== '/Applications/Slack.app/Contents/MacOS/Slack') throw new Error('Slack Desktop does not own this debugging port.');
  }
}

function slackSocket(value: unknown): boolean {
  try { const u = new URL(String(value)); return u.protocol === 'wss:' && !u.username && !u.password && (!u.port || u.port === '443') && (u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com')); }
  catch { return false; }
}
export function desktopEvent(value: unknown): Event | undefined {
  const v = value as any;
  if (!v || v.type !== 'message' || !/^D[A-Z0-9]+$/.test(v.channel) || !/^[UW][A-Z0-9]+$/.test(v.user) ||
    typeof v.text !== 'string' || Buffer.byteLength(v.text) > 64_000 || !/^\d+\.\d+$/.test(v.ts) ||
    v.subtype && v.subtype !== 'thread_broadcast' || v.thread_ts && !/^\d+\.\d+$/.test(v.thread_ts)) return;
  if (!v.text.startsWith('A2ANotes') && !v.text.includes(DATA_MARKER) && !v.text.startsWith('A2A Reply/1 ') && !/^A2A [#@]/.test(v.text)) return;
  // Copy only message fields. Never retain an arbitrary frame or authentication response.
  return { type: 'message', channel: v.channel, user: v.user, text: v.text, ts: v.ts,
    ...(v.thread_ts ? { thread_ts: v.thread_ts } : {}), ...(v.bot_id ? { bot_id: String(v.bot_id) } : {}), ...(v.app_id ? { app_id: String(v.app_id) } : {}),
    ...(typeof v.client_msg_id === 'string' && /^[a-f0-9-]{36}$/i.test(v.client_msg_id) ? {client_msg_id:v.client_msg_id} : {}) };
}

export class SlackDesktopHook {
  private endpoint: URL;
  private queue: Pending[];
  private file: string;
  private statusValue: DesktopStatus = { enabled: true, connected: false, accountVerified: false, listening: false, pending: 0 };
  private sockets = new Map<string, WebSocket>();
  private verifiedTargets = new Set<string>();
  private nativeSockets = new Map<string, Set<string>>();
  private connecting = false;
  private draining = false;
  private stopped = true;
  private timer?: ReturnType<typeof setInterval>;
  private sequence = 0;
  private channels = new Map<string, boolean>();
  private nativeTargets = new Map<string, string>();
  private nativeChecking = new Map<string, WebSocket>();
  private rendererGlobals = new Map<string, string>();
  private nativeLimits: Record<string, number>;
  private nativeLimitsFile: string;
  private deliveries: DesktopDeliveries;
  private requests = new Map<number, {socket:WebSocket; resolve:(value:any)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout>}>();
  constructor(private options: {
    config: DesktopConfig; dir: string; identity: () => Identity | null;
    verifyChannel: (channel: string) => Promise<boolean>;
    receive: (event: Received) => Promise<void>;
    connection?: (connected: boolean) => void;
    fetcher?: typeof fetch;
    verifyEndpoint?: (endpoint: URL) => Promise<void>;
  }) {
    this.endpoint = desktopURL(options.config.url);
    this.deliveries = new DesktopDeliveries(options.dir);
    this.nativeLimitsFile = join(options.dir, 'desktop-limits.json');
    this.nativeLimits = existsSync(this.nativeLimitsFile) ? JSON.parse(readFileSync(this.nativeLimitsFile, 'utf8')) : {};
    if (!this.nativeLimits || Array.isArray(this.nativeLimits) || Object.entries(this.nativeLimits).some(([team, at]) => !/^T[A-Z0-9]+$/.test(team) || !Number.isFinite(at) || at < 0))
      throw new Error('The saved native rate limits could not be checked.');
    this.statusValue.sendEnabled = options.config.send === true;
    this.file = join(options.dir, 'desktop-events.json');
    const saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
    if (!Array.isArray(saved) || saved.length > 1000 || saved.some(x => !desktopEvent(x.event) || !/^T[A-Z0-9]+$/.test(x.team) || !/^[UW][A-Z0-9]+$/.test(x.owner) || !Number.isFinite(x.nextAt) || x.nextAt < 0 || !Number.isInteger(x.attempts) || x.attempts < 0))
      throw new Error('The saved desktop events could not be checked.');
    this.queue = saved;
  }
  status(): DesktopStatus { return { ...this.statusValue, pending: this.queue.length, ...(this.options.config.send ? {canSend:this.canSend()} : {}) }; }
  canSend() { return !this.stopped && this.options.config.send === true && [...this.nativeTargets.keys()].some(id => this.verifiedTargets.has(id) && this.sockets.get(id)?.readyState === WebSocket.OPEN); }
  private request(socket: WebSocket, method: string, params: object, timeout = 5000): Promise<any> {
    if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new TransportError('The desktop connection is closed.', false));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.requests.delete(id); reject(new TransportError('Slack Desktop did not confirm the operation.', false));}, timeout);
      this.requests.set(id, {socket,resolve,reject,timer});
      socket.send(JSON.stringify({id,method,params}), error => {if (error) {clearTimeout(timer);this.requests.delete(id);reject(new TransportError('The desktop connection is closed.', false));}});
    });
  }
  private async checkNative(id: string, socket: WebSocket, team: string, owner: string) {
    if (!this.options.config.send || this.nativeChecking.has(id)) return;
    this.nativeChecking.set(id, socket);
    try {
      let objectId = this.rendererGlobals.get(id);
      if (!objectId) {
        const global = await this.request(socket, 'Runtime.evaluate', {expression:'globalThis',objectGroup:'a2anotes-desktop'});
        objectId = global.result?.objectId;
        if (!objectId) throw new Error('No renderer object.');
        if (this.sockets.get(id) !== socket) return;
        this.rendererGlobals.set(id, objectId);
      }
      const found = await this.request(socket, 'Runtime.callFunctionOn', {objectId,functionDeclaration:NATIVE_FUNCTIONS.capability,
        arguments:[{value:{team,owner}}],returnByValue:true,awaitPromise:true});
      if (this.sockets.get(id) === socket) {
        if (found.result?.value?.ready === true && !this.stopped && this.verifiedTargets.has(id)) this.nativeTargets.set(id, objectId);
        else this.nativeTargets.delete(id);
      }
    } catch { if (this.sockets.get(id) === socket) this.nativeTargets.delete(id); }
    finally { if (this.nativeChecking.get(id) === socket) this.nativeChecking.delete(id); }
  }
  async post(input: DesktopPost, beforeDispatch: () => void) {
    if (this.options.identity()?.address !== `slack:${input.team}:${input.owner}`) throw new TransportError('The native account changed.', true);
    try {
      const read = readSlackText(input.text);
      if (!('text' in read)) throw new Error('No wire text.');
      const wire = decode(read.text);
      if (!wire.ok || wire.message.id !== input.messageId || wire.message.from !== `slack:${input.team}:${input.owner}` || wire.message.to !== input.to) throw new Error('Wrong native identity.');
    } catch { throw new TransportError('The native send payload does not match its note and sender.', true); }
    try { await (this.options.verifyEndpoint || verifySlackDesktopEndpoint)(this.endpoint); } catch { throw new DesktopUnavailableError(); }
    if (this.options.identity()?.address !== `slack:${input.team}:${input.owner}`) throw new TransportError('The native account changed before posting.', true);
    const target = [...this.nativeTargets.keys()].find(id => this.verifiedTargets.has(id) && this.sockets.get(id)?.readyState === WebSocket.OPEN);
    if (this.stopped || !target) throw new DesktopUnavailableError();
    const limited = this.nativeLimits[input.team] || 0;
    if (limited > Date.now()) throw new TransportError('Slack Desktop is waiting after a chat.postMessage rate limit.', true, Math.ceil((limited-Date.now())/1000), 'chat.postMessage', 0);
    beforeDispatch();
    const previous = this.deliveries.begin(input); if (previous) return previous;
    try {
      const reply = await this.request(this.sockets.get(target)!, 'Runtime.callFunctionOn', {objectId:this.nativeTargets.get(target),functionDeclaration:NATIVE_FUNCTIONS.post,
        arguments:[{value:input}],returnByValue:true,awaitPromise:true}, 25_000);
      const result = reply.result?.value as NativeResult | undefined;
      const receipt = this.deliveries.receipt(input.team,input.owner,input.to,input.messageId);
      if (receipt) return receipt;
      if (result?.ok && result.channel === input.channel && result.ts) return this.deliveries.confirmed(input.messageId,result.channel,result.ts);
      const code = typeof result?.error === 'string' && /^[a-z_]{1,80}$/.test(result.error) ? result.error : 'send_failed';
      if (result?.definite && code === 'native_interface_changed') throw new DesktopUnavailableError();
      const retryAfter = Number.isFinite(result?.retryAfter) && result!.retryAfter! > 0 ? result!.retryAfter! : 0;
      if (result?.status === 429 || code === 'ratelimited') {this.nativeLimits[input.team] = Date.now() + Math.max(1, retryAfter || 60)*1000;savePrivate(this.nativeLimitsFile,this.nativeLimits);}
      throw new TransportError(result?.definite ? `Slack Desktop: ${code}` : 'Slack Desktop delivery is uncertain.', result?.definite === true,
        retryAfter, 'chat.postMessage', result?.status, result?.requestId);
    } catch (error) {
      this.deliveries.failed(input.messageId,error instanceof TransportError && error.definite);
      throw error;
    }
  }
  private save() { savePrivate(this.file, this.queue); }
  private state() {
    this.statusValue.connected = !this.stopped && [...this.sockets.values()].some(x => x.readyState === WebSocket.OPEN);
    this.statusValue.accountVerified = !this.stopped && this.verifiedTargets.size > 0;
    this.statusValue.listening = !this.stopped && [...this.verifiedTargets].some(id => this.nativeSockets.get(id)?.size);
    this.options.connection?.(this.statusValue.connected && this.statusValue.listening);
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.connect(); void this.drain(); }, 1000); this.timer.unref();
    void this.connect(); void this.drain();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const s of this.sockets.values()) s.terminate();
    for (const [id, pending] of this.requests) {clearTimeout(pending.timer);this.requests.delete(id);pending.reject(new TransportError('The desktop connection closed.', false));}
    this.nativeTargets.clear(); this.nativeChecking.clear(); this.rendererGlobals.clear();
    this.sockets.clear(); this.verifiedTargets.clear(); this.nativeSockets.clear(); this.state();
    while (this.connecting || this.draining) await new Promise(resolve => setTimeout(resolve, 20));
  }
  private async targets(): Promise<Target[]> {
    const r = await (this.options.fetcher || fetch)(new URL('json/list', this.endpoint), { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error('Slack Desktop debugging is not reachable.');
    const text = await r.text();
    if (Buffer.byteLength(text) > 128_000) throw new Error('The debugging target list is too large.');
    const targets = JSON.parse(text);
    if (!Array.isArray(targets)) throw new Error('The debugging target list is invalid.');
    return targets;
  }
  private target(t: Target, team: string): boolean {
    try {
      const url = new URL(t.url), socket = new URL(t.webSocketDebuggerUrl);
      return typeof t.id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(t.id) && t.type === 'page' && url.protocol === 'https:' && url.hostname === 'app.slack.com' && url.pathname.split('/')[2] === team &&
        socket.protocol === 'ws:' && socket.hostname === '127.0.0.1' && socket.port === this.endpoint.port && !socket.username && !socket.password && !socket.search && !socket.hash && socket.pathname.startsWith('/devtools/');
    } catch { return false; }
  }
  private async connect() {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    try {
      const identity = this.options.identity();
      const match = /^slack:(T[A-Z0-9]+):([UW][A-Z0-9]+)$/.exec(identity?.address || '');
      if (!match) throw new Error('Connect the A2A Slack account before the desktop hook.');
      if (!this.sockets.size) await (this.options.verifyEndpoint || verifySlackDesktopEndpoint)(this.endpoint);
      const targets = (await this.targets()).filter(t => this.target(t, match[1])).slice(0, 4);
      if (this.stopped) return;
      const active = new Set(targets.map(t => t.id));
      for (const [id, socket] of this.sockets) if (!active.has(id)) socket.close();
      for (const target of targets) if (!this.stopped && !this.sockets.has(target.id)) await this.attach(target, match[1], match[2]);
      if (!targets.length) this.statusValue.error = 'Open the connected workspace in Slack Desktop.';
    } catch { this.statusValue.error = 'Slack Desktop debugging is not reachable. App message recovery remains available.'; }
    finally { this.connecting = false; this.state(); }
  }
  private async attach(target: Target, team: string, owner: string) {
    // A listener can change while an older debugger connection remains open.
    await (this.options.verifyEndpoint || verifySlackDesktopEndpoint)(this.endpoint);
    if (this.stopped) return;
    const socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 3000 });
    this.sockets.set(target.id, socket);
    const trusted = new Set<string>(); this.nativeSockets.set(target.id, trusted);
    let verified = false;
    let identityRequest = 0;
    const identityCheck = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      identityRequest = ++this.sequence;
      socket.send(JSON.stringify({ id: identityRequest, method: 'Runtime.evaluate', params: { expression: DESKTOP_IDENTITY, returnByValue: true } }));
    };
    const verify = (foundTeam: unknown, foundOwner: unknown) => {
      verified = foundTeam === team && foundOwner === owner && this.options.identity()?.address === `slack:${team}:${owner}`;
      if (verified) this.verifiedTargets.add(target.id); else this.verifiedTargets.delete(target.id);
      if (verified) void this.checkNative(target.id,socket,team,owner); else this.nativeTargets.delete(target.id);
      this.statusValue.error = verified ? undefined : 'The desktop account could not be verified against the A2A account.';
      this.state();
    };
    socket.on('message', (raw: RawData) => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
      const pending = this.requests.get(m.id);
      if (pending?.socket === socket) {
        clearTimeout(pending.timer);this.requests.delete(m.id);
        if (m.error) pending.reject(new TransportError('The desktop operation failed.', false)); else pending.resolve(m.result);
        return;
      }
      if (m.id === identityRequest) { const found = m.result?.result?.value; verify(found?.team, found?.user); return; }
      if (m.method === 'Network.webSocketCreated' && slackSocket(m.params?.url)) { trusted.add(m.params.requestId); this.state(); }
      if (m.method === 'Network.webSocketClosed') { trusted.delete(m.params?.requestId); this.state(); }
      if (m.method !== 'Network.webSocketFrameReceived' || !trusted.has(m.params?.requestId) || m.params?.response?.opcode !== 1) return;
      let frame: any; try { frame = JSON.parse(m.params.response.payloadData); } catch { return; }
      if (frame?.type === 'hello' && frame.self?.id && frame.team?.id) { verify(frame.team.id, frame.self.id); return; }
      if (!verified || this.stopped || this.options.identity()?.address !== `slack:${team}:${owner}` || frame.team && frame.team !== team) return;
      const event = desktopEvent(frame);
      if (event) {
        try {this.deliveries.echo(team,owner,event);} catch {this.statusValue.error = 'The native receipt did not match its saved delivery.';}
        if (event.user === owner && (event.text.startsWith('A2ANotes') || event.text.includes(DATA_MARKER))) return;
      }
      if (!event || this.queue.some(x => x.team === team && x.event.channel === event.channel && x.event.ts === event.ts)) return;
      if (this.queue.length >= 1000) { this.statusValue.error = 'The desktop event queue is full. App message recovery remains available.'; return; }
      // The existing service checks channel membership before this event receives owner acceptance.
      this.queue.push({ event, team, owner, attempts: 0, nextAt: 0 }); this.save();
      this.statusValue.lastEventAt = new Date().toISOString(); void this.drain();
    });
    const check = setInterval(identityCheck, 10_000); check.unref();
    const cleanup = () => {
      clearInterval(check);
      for (const [id, pending] of this.requests) if (pending.socket === socket) {clearTimeout(pending.timer);this.requests.delete(id);pending.reject(new TransportError('The desktop connection closed.', false));}
      if (this.sockets.get(target.id) === socket) { this.nativeTargets.delete(target.id); this.rendererGlobals.delete(target.id);this.sockets.delete(target.id); this.verifiedTargets.delete(target.id); this.nativeSockets.delete(target.id); }
      this.state();
    };
    socket.once('close', cleanup); socket.once('error', () => { this.statusValue.error = 'The Slack Desktop connection closed.'; socket.close(); });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('Desktop connection closed.'))); });
    if (this.stopped) { socket.terminate(); return; }
    socket.send(JSON.stringify({ id: ++this.sequence, method: 'Network.enable', params: {} }));
    identityCheck();
  }
  private async drain() {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      for (const item of [...this.queue]) {
        if (item.nextAt > Date.now()) continue;
        if (this.options.identity()?.address !== `slack:${item.team}:${item.owner}`) { this.statusValue.error = 'The saved event belongs to another A2A account.'; continue; }
        try {
          const key = `${item.team}:${item.owner}:${item.event.channel}`;
          if (!this.channels.has(key)) this.channels.set(key, await this.options.verifyChannel(item.event.channel));
          const self = this.channels.get(key)!;
          const e = item.event;
          if (e.user === item.owner && (!self || e.text.startsWith('A2ANotes') || e.text.includes(DATA_MARKER)) || self && (e.user !== item.owner || e.app_id || e.bot_id)) { this.queue = this.queue.filter(x => x !== item); this.save(); continue; }
          const read = readSlackText(e.text);
          await this.options.receive({ conversation: `slack:${item.team}:${e.channel}`, ref: `slack:${item.team}:${e.channel}:${e.ts}`, ts: e.ts,
            channel: e.channel, sender: `slack:${item.team}:${e.user}`, text: 'text' in read ? read.text : e.text, ...('error' in read ? {error: read.error} : {}), ownerConversation: self,
            automated: !!(e.app_id || e.bot_id), ...(e.thread_ts ? { threadTs: e.thread_ts } : {}) });
          this.queue = this.queue.filter(x => x !== item); this.save();
        } catch (error) {
          const transport = error instanceof TransportError ? error : undefined;
          if (transport?.definite && !transport.rateLimited || ++item.attempts >= 8) {
            this.queue = this.queue.filter(x => x !== item); this.statusValue.error = 'A desktop event could not be checked. App message recovery remains available.';
          } else {
            item.nextAt = Date.now() + Math.max(transport?.retryAfter || 0, Math.min(300, 2 ** item.attempts * (0.5 + Math.random()))) * 1000;
            this.statusValue.error = 'A desktop event is waiting for its next check.';
          }
          this.save();
        }
      }
    } finally { this.draining = false; }
  }
}

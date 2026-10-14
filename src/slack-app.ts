// Reads Slack through the signed-in app without changing its window.
// SlackAppConnection reads the account IDs. BackgroundConnection reads Slack records through the app's own API client.
import WebSocket from 'ws';
import { desktopURL, verifySlackDesktopEndpoint, DESKTOP_IDENTITY } from './slack-desktop.ts';
import { TransportError } from './transport.ts';

export interface AppMessage { channel: string; user: string; text: string; ts: string; thread_ts?: string; bot_id?: string; app_id?: string; subtype?: string; client_msg_id?: string; reactions: {name: string; users: string[]}[]; files?: {id:string;name:string;size:number}[] }
export interface AppPerson { id: string; name: string; realName: string; title: string; active: boolean }
export interface AppSnapshot { team: string; user: string; channel?: string; peers: {id: string; user: string}[]; people: AppPerson[]; messages: AppMessage[] }
// None of these operations focus, navigate, type in, or click the Slack window.
export interface AppConnection {
  snapshot(): Promise<AppSnapshot>;
  // Selects a direct conversation for later checks and loads its recent records.
  navigate(channelOrUser: string): Promise<void>;
  // Loads one exact message record into the snapshot.
  message(channel: string, ts: string): Promise<void>;
  // Loads recent records of more direct conversations. The selected conversation does not change.
  load(channelsOrUsers: string[]): Promise<void>;
  directory(): Promise<AppPerson[]>;
  downloadFile?(url: string, size: number, maxBytes: number): Promise<Buffer>;
  close(): Promise<void>;
}
export type NativeRead = (method: string, args: Record<string, unknown>) => Promise<any>;
// Direct conversation IDs do not change. Profiles expire after PROFILE_TTL_MS.
export interface BackgroundCache { peers: Map<string, {id: string; user: string}>; people: Map<string, {person: AppPerson; at: number}>; directory?: {people: AppPerson[]; at: number} }
export const PROFILE_TTL_MS = 10 * 60_000;
const DIRECTORY_PAGES = 10;

export class BackgroundConnection implements AppConnection {
  private channel?: string;
  private messages = new Map<string, AppMessage>();
  constructor(private account: {identity(): Promise<{team: string; user: string}>; close(): Promise<void>;
    downloadFile?(url: string, size: number, maxBytes: number): Promise<Buffer>}, private read: NativeRead,
    private cache: BackgroundCache, private now: () => number = Date.now) {}
  async snapshot(): Promise<AppSnapshot> {
    const {team, user} = await this.account.identity();
    // The name is optional. Background access can start after the account is bound.
    await this.person(user).catch(() => {});
    return {team, user, ...(this.channel ? {channel: this.channel} : {}), peers: [...this.cache.peers.values()],
      people: [...this.cache.people.values()].map(p => p.person), messages: [...this.messages.values()]};
  }
  private async peer(id: string) {
    if (/^D[A-Z0-9]+$/.test(id)) {
      const known = this.cache.peers.get(id); if (known) return known;
      const found = (await this.read('conversations.info', {channel: id}))?.channel;
      if (found?.id !== id || found.is_im !== true || !/^[UW][A-Z0-9]+$/.test(found.user)) throw new TransportError('The Slack conversation is not a direct message.', true);
      const peer = {id, user: found.user as string}; this.cache.peers.set(id, peer); return peer;
    }
    if (!/^[UW][A-Z0-9]+$/.test(id)) throw new TransportError('The Slack destination ID is invalid.', true);
    const known = [...this.cache.peers.values()].find(p => p.user === id); if (known) return known;
    const found = (await this.read('conversations.open', {users: id, return_im: true}))?.channel;
    if (!/^D[A-Z0-9]+$/.test(found?.id) || found.user && found.user !== id) throw new TransportError('Slack did not return the direct conversation for this member.', true);
    const peer = {id: found.id as string, user: id}; this.cache.peers.set(peer.id, peer); return peer;
  }
  private async person(user: string) {
    const known = this.cache.people.get(user);
    if (known && this.now() - known.at < PROFILE_TTL_MS) return known.person;
    const person = (await this.read('users.info', {user}))?.user as AppPerson | undefined;
    if (person?.id !== user) throw new TransportError('Slack did not return this member profile.', true);
    this.cache.people.set(user, {person, at: this.now()}); return person;
  }
  private async history(channel: string, args: Record<string, unknown>) {
    const found = (await this.read('conversations.history', {channel, ...args}))?.messages;
    if (!Array.isArray(found)) throw new TransportError('Slack did not return the conversation records.', false, 0, 'conversations.history');
    for (const m of found) this.messages.set(channel + ':' + m.ts, {...m, channel});
  }
  async navigate(id: string) {
    const peer = await this.peer(id);
    await this.person(peer.user);
    await this.history(peer.id, {limit: 50});
    this.channel = peer.id;
  }
  async message(channel: string, ts: string) {
    if (!/^\d+\.\d+$/.test(ts)) throw new TransportError('The Slack message timestamp is invalid.', true);
    await this.peer(channel);
    await this.history(channel, {limit: 1, latest: ts, oldest: ts, inclusive: true});
  }
  async load(ids: string[]) {
    for (const id of ids) {
      try { await this.history((await this.peer(id)).id, {limit: 50}); }
      catch (error) {
        // One closed or removed conversation does not stop the others. Limits and lost replies stop the scan.
        if (!(error instanceof TransportError) || !error.definite || error.rateLimited) throw error;
      }
    }
  }
  async directory() {
    if (this.cache.directory && this.now() - this.cache.directory.at < PROFILE_TTL_MS) return this.cache.directory.people;
    const people: AppPerson[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < DIRECTORY_PAGES; page++) {
      const found = await this.read('users.list', {limit: 200, ...(cursor ? {cursor} : {})});
      for (const p of Array.isArray(found?.members) ? found.members : []) {people.push(p); this.cache.people.set(p.id, {person: p, at: this.now()});}
      cursor = found?.next; if (!cursor) break;
    }
    this.cache.directory = {people, at: this.now()}; return people;
  }
  async downloadFile(url: string, size: number, maxBytes: number) {
    if (!this.account.downloadFile) throw new TransportError('The signed-in Slack file download is unavailable.', true);
    return this.account.downloadFile(url,size,maxBytes);
  }
  async close() { await this.account.close(); }
}

// Reads the account IDs through a verified loopback CDP connection.
export class SlackAppConnection {
  private sequence = 0;
  private pending = new Map<number, {resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private constructor(private socket: WebSocket, private team: string, private user?: string) {
    socket.on('message', raw => {
      let m: any; try {m = JSON.parse(raw.toString());} catch {return;}
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error || m.result?.exceptionDetails) p.reject(new TransportError('The Slack app operation failed.', false));
      else p.resolve(m.result);
    });
    socket.on('close', () => { for (const p of this.pending.values()) {clearTimeout(p.timer); p.reject(new TransportError('The Slack app connection closed.', false));} this.pending.clear(); });
  }
  static async open(url: string, team: string, user?: string, options: {fetcher?: typeof fetch; verifyEndpoint?: typeof verifySlackDesktopEndpoint} = {}) {
    const endpoint = desktopURL(url);
    await (options.verifyEndpoint || verifySlackDesktopEndpoint)(endpoint);
    const response = await (options.fetcher || fetch)(new URL('json/list', endpoint), {redirect: 'error', signal: AbortSignal.timeout(3000)});
    if (!response.ok) throw new TransportError('Open Slack Desktop with its local debugging port.', true);
    const raw = await response.text();
    if (raw.length > 128_000) throw new TransportError('The app target list is too large.', true);
    const all = JSON.parse(raw);
    if (!Array.isArray(all)) throw new TransportError('The app target list is invalid.', true);
    const targets = all.filter(t => {
      try {
        const page = new URL(t.url), socket = new URL(t.webSocketDebuggerUrl);
        return t.type === 'page' && page.protocol === 'https:' && page.hostname === 'app.slack.com' && page.pathname.split('/')[2] === team &&
          socket.protocol === 'ws:' && socket.hostname === '127.0.0.1' && socket.port === endpoint.port && !socket.username && !socket.password && !socket.search && !socket.hash && socket.pathname.startsWith('/devtools/');
      } catch {return false;}
    });
    if (targets.length !== 1) throw new TransportError('Open exactly one Slack app page for the configured workspace.', true);
    await (options.verifyEndpoint || verifySlackDesktopEndpoint)(endpoint);
    const socket = new WebSocket(targets[0].webSocketDebuggerUrl, {maxPayload: 4 * 1024 * 1024, handshakeTimeout: 3000});
    const connection = new SlackAppConnection(socket, team, user);
    try {
      await new Promise<void>((resolve, reject) => {socket.once('open', resolve); socket.once('error', reject);});
      await connection.identity(); return connection;
    } catch (error) {socket.terminate(); throw error;}
  }
  private request(method: string, params: Record<string, unknown>, timeoutMs = 5000) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new TransportError('The Slack app connection is closed.', false);
    const id = ++this.sequence;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); reject(new TransportError('The Slack app did not confirm the operation.', false));}, timeoutMs);
      this.pending.set(id, {resolve, reject, timer}); this.socket.send(JSON.stringify({id, method, params}));
    });
  }
  private async evaluate(expression: string) {return (await this.request('Runtime.evaluate', {expression, returnByValue: true})).result?.value;}
  // Reads only the workspace and member IDs. It does not read or change the open conversation.
  async identity() {
    const found = await this.evaluate(DESKTOP_IDENTITY);
    if (found?.team && found.team !== this.team || /^[UW][A-Z0-9]+$/.test(found?.user) && this.user && found.user !== this.user)
      throw new TransportError('The Slack app account differs from the saved account. No action was taken.', true);
    if (found?.team !== this.team || !/^[UW][A-Z0-9]+$/.test(found?.user))
      throw new TransportError('The Slack app account is still loading.', false, 1, 'slack.desktop');
    this.user ||= found.user;
    return {team: found.team as string, user: found.user as string};
  }
  async downloadFile(value: string, expectedSize: number, maxBytes: number) {
    if (!Number.isInteger(expectedSize) || expectedSize < 1 || expectedSize > maxBytes || maxBytes > 2 * 1024 * 1024)
      throw new TransportError('The Slack file size is invalid.', true);
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' ||
        url.username || url.password || url.hash)
      throw new TransportError('The Slack app file URL is invalid.', true);
    await this.identity();
    const tree = await this.request('Page.getFrameTree', {});
    const frame = tree.frameTree?.frame;
    if (!frame?.id || !frame.url?.startsWith(`https://app.slack.com/client/${this.team}/`))
      throw new TransportError('The Slack app workspace changed before download.', true);
    const loaded = await this.request('Network.loadNetworkResource', {frameId:frame.id,url:url.href,
      options:{disableCache:true,includeCredentials:true}}, 20_000);
    const resource = loaded.resource;
    if (!resource?.success || resource.httpStatusCode !== 200 || typeof resource.stream !== 'string')
      throw new TransportError('The signed-in Slack app could not download the file.', false);
    const parts: Buffer[] = []; let size = 0;
    try {
      for (;;) {
        const read = await this.request('IO.read', {handle:resource.stream,size:32768}, 10_000);
        if (typeof read.data !== 'string') throw new TransportError('The Slack app file stream is invalid.', true);
        const part = Buffer.from(read.data, read.base64Encoded ? 'base64' : 'utf8');
        if (!part.length && !read.eof) throw new TransportError('The Slack app file stream ended early.', false);
        size += part.length;
        if (size > maxBytes) throw new TransportError('The Slack app file exceeds the allowed size.', true);
        parts.push(part);
        if (read.eof) break;
      }
    } finally {await this.request('IO.close', {handle:resource.stream}).catch(() => {});}
    await this.identity();
    if (size !== expectedSize) throw new TransportError('The Slack app file size differs from its record.', true);
    return Buffer.concat(parts,size);
  }
  async close() {this.socket.close();}
}

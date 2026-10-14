// Operates the signed-in app through a verified loopback CDP connection.
import WebSocket from 'ws';
import { desktopURL, verifySlackDesktopEndpoint, DESKTOP_IDENTITY } from './slack-desktop.ts';
import { TransportError } from './transport.ts';

export interface AppMessage { channel: string; user: string; text: string; ts: string; thread_ts?: string; bot_id?: string; app_id?: string; subtype?: string; reactions: {name: string; users: string[]}[] }
export interface AppPerson { id: string; name: string; realName: string; title: string; active: boolean }
export interface AppSnapshot { team: string; user: string; channel?: string; threadTs?: string; peers: {id: string; user: string}[]; people: AppPerson[]; messages: AppMessage[]; editor: boolean; draft: string }
export interface AppConnection {
  snapshot(): Promise<AppSnapshot>;
  navigate(channelOrUser: string): Promise<void>;
  compose(text: string, threadTs?: string): Promise<void>;
  submit(): Promise<void>;
  react(ts: string, emoji: string): Promise<void>;
  close(): Promise<void>;
}

// Copy known fields only. Never return application state or credential objects.
export function rendererSnapshot() {
  const rows = [...document.querySelectorAll('[data-qa="message_container"], [data-qa="virtual-list-item"]')];
  const people = new Map<string, any>(), peers = new Map<string, any>(), messages = new Map<string, any>();
  const channel = /^\/client\/T[A-Z0-9]+\/(D[A-Z0-9]+)(?:\/|$)/.exec(location.pathname)?.[1];
  function person(u: any) {
    if (!u || !/^[UW][A-Z0-9]+$/.test(u.id)) return;
    const p = u.profile || {};
    people.set(u.id, {id: u.id, name: String(p.display_name || u.real_name || u.name || u.id),
      realName: String(u.real_name || p.real_name || ''), title: String(p.title || ''), active: !u.deleted && !u.is_bot && !u.is_app_user});
  }
  function props(element: any, visit: (p: any, component?: string) => void) {
    let f = element[Object.keys(element).find(k => k.startsWith('__reactFiber')) || ''];
    for (let i = 0; f && i < 30; i++, f = f.return) if (f.memoizedProps) visit(f.memoizedProps, f.type?.displayName || f.type?.name);
  }
  for (const element of [...document.querySelectorAll('[data-qa], [data-user-id]')].slice(0, 5000)) props(element, (p, component) => {
    person(p.user); person(p.member); person(p.currentUser); person(p.recipient);
    if (component === 'BaseAvatar' && /^[UW][A-Z0-9]+$/.test(p.userId) && typeof p.memberOrBotName === 'string' &&
        typeof p.isDeleted === 'boolean' && typeof p.userType === 'string') {
      people.set(p.userId, {id:p.userId, name:p.memberOrBotName, realName:p.memberOrBotName, title:'',
        active:p.userType === 'member' && !p.isDeleted && !p.botId && p.hasNoAccess !== true});
    }
    const c = p.channel || p.conversation;
    if (c && /^D[A-Z0-9]+$/.test(c.id) && c.is_im === true && /^[UW][A-Z0-9]+$/.test(c.user)) peers.set(c.id, {id: c.id, user: c.user});
  });
  for (const row of rows) props(row, (p, component) => {
    const m = p.message || (component === 'Message' ? p.msg : undefined);
    if (!m || !/^\d+\.\d+$/.test(m.ts) || !/^[UW][A-Z0-9]+$/.test(m.user) || typeof m.text !== 'string') return;
    const c = typeof m.channel === 'string' ? m.channel : p.channel?.id || p.channelId || channel;
    if (!/^D[A-Z0-9]+$/.test(c)) return;
    messages.set(c + ':' + m.ts, {channel: c, user: m.user, text: m.text, ts: m.ts,
      ...(m.thread_ts ? {thread_ts: m.thread_ts} : {}), ...(m.bot_id ? {bot_id: m.bot_id} : {}),
      ...(m.app_id ? {app_id: m.app_id} : {}), ...(m.subtype ? {subtype: m.subtype} : {}),
      reactions: (Array.isArray(m.reactions) ? m.reactions : []).map((r: any) => ({name: String(r.name), users: Array.isArray(r.users) ? r.users.filter((u: any) => typeof u === 'string') : []}))});
  });
  let threadTs: string | undefined;
  const thread = document.querySelector('[data-qa="thread_view"]');
  if (thread) props(thread, p => {const ts = p.threadTs || p.parentMessage?.ts || p.rootMessage?.ts; if (typeof ts === 'string' && /^\d+\.\d+$/.test(ts)) threadTs = ts;});
  const editors = [...document.querySelectorAll<HTMLElement>('[data-qa="message_input"] [contenteditable="true"], [data-qa="message_input"][contenteditable="true"], [data-qa="msg_input"] [contenteditable="true"], .p-message_input_field[contenteditable="true"]')];
  const visible = editors.filter(e => !!e.getClientRects().length);
  const editor = visible.find(e => e === document.activeElement || e.contains(document.activeElement)) || (visible.length === 1 ? visible[0] : undefined);
  return {channel, threadTs, people: [...people.values()], peers: [...peers.values()], messages: [...messages.values()], editor: !!editor, draft: editor?.innerText || ''};
}

// All input enters as JSON data. It cannot become executable source.
export function rendererAction(action: string, value: string, threadTs?: string, expectedChannel?: string, expectedDraft?: string) {
  const channel = /^\/client\/T[A-Z0-9]+\/(D[A-Z0-9]+)(?:\/|$)/.exec(location.pathname)?.[1];
  if (expectedChannel && channel !== expectedChannel) return false;
  const rowFor = (ts: string) => [...document.querySelectorAll<HTMLElement>('[data-qa="message_container"], [data-qa="virtual-list-item"]')].find(row => {
    let f = (row as any)[Object.keys(row).find(k => k.startsWith('__reactFiber')) || ''];
    for (let i = 0; f && i < 30; i++, f = f.return) {
      const component = f.type?.displayName || f.type?.name;
      if (f.memoizedProps?.message?.ts === ts || component === 'Message' && f.memoizedProps?.msg?.ts === ts) return true;
    }
    return false;
  });
  if (action === 'focus') {
    const region = threadTs ? document.querySelector('[data-qa="thread_view"]') : document;
    const editors = region && [...region.querySelectorAll<HTMLElement>('[data-qa="message_input"] [contenteditable="true"], [data-qa="message_input"][contenteditable="true"], [data-qa="msg_input"] [contenteditable="true"], .p-message_input_field[contenteditable="true"]')].filter(e => !!e.getClientRects().length && (threadTs ? !!e.closest('[data-qa="thread_view"]') : !e.closest('[data-qa="thread_view"]')));
    const editor = editors?.length === 1 ? editors[0] : undefined;
    if (!editor || editor.innerText.trim()) return false;
    editor.focus(); return true;
  }
  if (action === 'thread') {
    const row = rowFor(value);
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
    const button = row.querySelector<HTMLElement>('[data-qa="message_reply_to_thread"], [data-qa="reply_to_thread"]');
    if (!button) return false;
    button.click(); return true;
  }
  if (action === 'reaction') {
    const row = rowFor(value);
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
    const button = row.querySelector<HTMLElement>('[data-qa="message_add_reaction"], [data-qa="add_reaction"]');
    if (!button) return false;
    button.click(); return true;
  }
  if (action === 'emoji') {
    const picker = document.querySelector('[data-qa="emoji_picker"], [data-qa="emoji-picker"], .p-emoji_picker');
    if (!picker) return false;
    let f = (picker as any)[Object.keys(picker).find(k => k.startsWith('__reactFiber')) || ''];
    let matched = false;
    for (let i = 0; f && i < 30; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p?.message?.ts === threadTs || p?.messageTs === threadTs || p?.timestamp === threadTs) matched = true;
    }
    if (!matched) return false;
    const button = [...picker.querySelectorAll<HTMLElement>('button, [role="button"]')].find(e => e.getAttribute('data-emoji-name') === value || e.getAttribute('aria-label') === value || e.getAttribute('aria-label') === ':' + value + ':');
    if (!button) return false;
    button.click(); return true;
  }
  if (action === 'submit') {
    const region = threadTs ? document.querySelector('[data-qa="thread_view"]') : document;
    const editor = document.activeElement as HTMLElement | null;
    if (!editor?.isContentEditable || editor.innerText !== expectedDraft || (threadTs ? !editor.closest('[data-qa="thread_view"]') : editor.closest('[data-qa="thread_view"]'))) return false;
    const buttons = [...(region?.querySelectorAll<HTMLButtonElement>('[data-qa="texty_send_button"], [data-qa="send_button"]') || [])].filter(e => !!e.getClientRects().length && (threadTs ? !!e.closest('[data-qa="thread_view"]') : !e.closest('[data-qa="thread_view"]')));
    const button = buttons.length === 1 ? buttons[0] : undefined;
    if (!button || button.disabled || !button.getClientRects().length) return false;
    button.click(); return true;
  }
  return false;
}

export class SlackAppConnection implements AppConnection {
  private sequence = 0;
  private pending = new Map<number, {resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private threadTs?: string;
  private expectedChannel?: string;
  private expectedDraft?: string;
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
      await connection.snapshot(); return connection;
    } catch (error) {socket.terminate(); throw error;}
  }
  private request(method: string, params: Record<string, unknown>) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new TransportError('The Slack app connection is closed.', false);
    const id = ++this.sequence;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id); reject(new TransportError('The Slack app did not confirm the operation.', false));}, 5000);
      this.pending.set(id, {resolve, reject, timer}); this.socket.send(JSON.stringify({id, method, params}));
    });
  }
  private async evaluate(expression: string) {return (await this.request('Runtime.evaluate', {expression, returnByValue: true})).result?.value;}
  private async account() {
    const found = await this.evaluate(DESKTOP_IDENTITY);
    if (found?.team && found.team !== this.team || /^[UW][A-Z0-9]+$/.test(found?.user) && this.user && found.user !== this.user)
      throw new TransportError('The Slack app account differs from the saved account. No action was taken.', true);
    if (found?.team !== this.team || !/^[UW][A-Z0-9]+$/.test(found?.user))
      throw new TransportError('The Slack app account is still loading.', false, 1, 'slack.desktop');
    this.user ||= found.user;
    return found;
  }
  async snapshot(): Promise<AppSnapshot> {
    const found = await this.account();
    const value = await this.evaluate(`(() => { const __name = f => f; return (${rendererSnapshot.toString()})(); })()`);
    await this.account();
    if (!value || !Array.isArray(value.messages) || value.messages.length > 2000 || !Array.isArray(value.peers) || !Array.isArray(value.people)) throw new TransportError('The Slack app message view could not be checked.', true);
    return {...value, ...found};
  }
  async navigate(id: string) {
    if (!/^[DUW][A-Z0-9]+$/.test(id)) throw new TransportError('The Slack destination ID is invalid.', true);
    await this.account();
    await this.request('Page.navigate', {url: `https://app.slack.com/client/${this.team}/${id}`});
  }
  private async action(action: string, value: string, thread?: string) {
    await this.account();
    const expression = `(() => { const __name = f => f; return (${rendererAction.toString()})(${JSON.stringify(action)},${JSON.stringify(value)},${JSON.stringify(thread)},${JSON.stringify(this.expectedChannel)},${JSON.stringify(this.expectedDraft)}); })()`;
    if (!await this.evaluate(expression)) throw new TransportError('The Slack app control is unavailable. No action was confirmed.', true,
      0, 'slack.desktop', undefined, undefined, 'app_control_unavailable');
  }
  async compose(text: string, threadTs?: string) {
    this.expectedChannel = (await this.snapshot()).channel;
    this.expectedDraft = text;
    this.threadTs = threadTs;
    if (threadTs) {
      await this.action('thread', threadTs);
      let matched = false;
      for (let i = 0; i < 30; i++) {if ((await this.snapshot()).threadTs === threadTs) {matched = true; break;} await new Promise(r => setTimeout(r, 100));}
      if (!matched) throw new TransportError('The Slack app did not show the requested thread.', true);
    }
    await this.action('focus', '', threadTs);
    await this.account(); await this.request('Input.insertText', {text});
  }
  async submit() {await this.action('submit', '', this.threadTs);}
  async react(ts: string, emoji: string) {this.expectedChannel = (await this.snapshot()).channel; await this.action('reaction', ts); await this.action('emoji', emoji, ts);}
  async close() {this.socket.close();}
}

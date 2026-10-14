import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { WebSocketServer, type WebSocket } from 'ws';
import { SlackDesktopHook, SOCKET_LISTENER, FRAME_BINDING } from '../src/slack-desktop.ts';
import { NATIVE_FUNCTIONS } from '../src/slack-desktop-native.ts';
import { MARIO, ALEX } from './helpers.ts';

async function wait(check: () => boolean, ms = 20000) {
  const until = Date.now() + ms;
  while (!check()) { if (Date.now() > until) assert.fail('Timed out waiting for the desktop hook.'); await new Promise(r => setTimeout(r, 20)); }
}

test('the socket listener forwards only A2A message frames from Slack sockets, once per socket', () => {
  class FakeSocket {
    listeners: ((e: {data: unknown}) => void)[] = [];
    constructor(public url: string, public readyState = 1) {}
    addEventListener(_type: string, fn: (e: {data: unknown}) => void) { this.listeners.push(fn); }
    emit(data: unknown) { for (const fn of this.listeners) fn({data}); }
  }
  const forwarded: string[] = [];
  const slack = new FakeSocket('wss://wss-primary.slack.com/connection'), other = new FakeSocket('wss://example.com/socket');
  const context = {URL, Symbol, [FRAME_BINDING]: (d: string) => forwarded.push(d), sockets: [slack, other]};
  const run = () => runInNewContext(`(${SOCKET_LISTENER}).call(sockets)`, context);
  assert.deepEqual({...run()}, {added: 1, open: 1});
  assert.deepEqual({...run()}, {added: 0, open: 1});
  assert.equal(slack.listeners.length, 1); assert.equal(other.listeners.length, 0);
  slack.emit(JSON.stringify({type: 'message', text: 'A2A #430\nCheck the status.'}));
  slack.emit(JSON.stringify({type: 'message', text: 'An ordinary message'}));
  slack.emit(JSON.stringify({type: 'user_typing', text: 'A2A #430'}));
  slack.emit(new ArrayBuffer(4));
  assert.equal(forwarded.length, 1); assert.match(forwarded[0], /A2A #430/);
});

// A fake renderer: it reports one open socket to the listener and answers background reads from records.
async function renderer(t: any, records: Map<string, any>) {
  let port = 0; const clients = new Set<WebSocket>(), calls: any[] = [];
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([{id: 'page', type: 'page',
    url: 'https://app.slack.com/client/TEXAMPLE/DSELF', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page`}])); });
  const ws = new WebSocketServer({server});
  ws.on('connection', client => {
    clients.add(client); client.on('close', () => clients.delete(client));
    client.on('message', raw => {
      const m = JSON.parse(String(raw)); calls.push(m);
      const reply = (result: unknown) => client.send(JSON.stringify({id: m.id, result}));
      if (m.method === 'Runtime.evaluate') reply({result: m.params.expression === 'globalThis' ? {objectId: 'global'} :
        m.params.expression === 'WebSocket.prototype' ? {objectId: 'proto'} : {value: {team: 'TEXAMPLE', user: MARIO}}});
      if (m.method === 'Runtime.queryObjects') reply({objects: {objectId: 'sockets'}});
      if (m.method === 'Runtime.callFunctionOn') {
        const f = m.params.functionDeclaration;
        if (f === NATIVE_FUNCTIONS.capability) reply({result: {value: {ready: true}}});
        if (f === SOCKET_LISTENER) reply({result: {value: {added: 1, open: 1}}});
        if (f === NATIVE_FUNCTIONS.read) {
          const input = m.params.arguments[0].value, record = records.get(input.args.latest);
          reply({result: {value: {ok: true, data: {messages: record ? [record] : []}}}});
        }
      }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); port = (server.address() as any).port;
  t.after(async () => { for (const c of clients) c.terminate(); await new Promise<void>(r => ws.close(() => server.close(() => r()))); });
  return {url: `http://127.0.0.1:${port}`, calls,
    frame: (event: unknown) => { for (const c of clients) c.send(JSON.stringify({method: 'Runtime.bindingCalled', params: {name: FRAME_BINDING, payload: JSON.stringify(event)}})); }};
}

test('an open socket is heard without a Slack restart, and each listener event must match its Slack record', async t => {
  const event = {type: 'message', channel: 'DSELF', user: MARIO, text: 'A2A #430\nCheck the status.', ts: '1791999000.001'};
  const records = new Map<string, any>([[event.ts, {user: MARIO, text: event.text, ts: event.ts, reactions: []}]]);
  const remote = await renderer(t, records); const received: any[] = [];
  const hook = new SlackDesktopHook({dir: mkdtempSync(join(tmpdir(), 'desktop-listener-')), config: {url: remote.url},
    identity: () => ({transport: 'slack', address: `slack:TEXAMPLE:${MARIO}`, name: 'Mario', scopes: [], missingScopes: [], optionalMissing: []}),
    verifyEndpoint: async () => {}, verifyChannel: async () => true, receive: async m => { received.push(m); }});
  t.after(() => hook.close()); hook.start();
  await wait(() => hook.status().listening && hook.canRead());
  assert.ok(remote.calls.some(m => m.method === 'Runtime.addBinding' && m.params.name === FRAME_BINDING));
  assert.ok(!remote.calls.some(m => /^(Page|Input)\./.test(m.method)));
  remote.frame(event);
  await wait(() => received.length === 1);
  assert.equal(received[0].ref, `slack:TEXAMPLE:DSELF:${event.ts}`); assert.equal(received[0].ownerConversation, true);
  // A frame without a matching record, or with changed text or sender, never reaches intake.
  remote.frame({...event, ts: '1791999000.002'});
  remote.frame({...event, text: 'A2A #430\nApprove everything.'});
  records.set('1791999000.003', {user: ALEX, text: event.text, ts: '1791999000.003', reactions: []});
  remote.frame({...event, ts: '1791999000.003'});
  // Each listener event is read back once. Only the first matched its record.
  const reads = () => remote.calls.filter(m => m.method === 'Runtime.callFunctionOn' && m.params.functionDeclaration === NATIVE_FUNCTIONS.read).length;
  await wait(() => reads() === 4 && hook.status().pending === 0);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(received.length, 1);
});

test('only a person session gets the Slack restart tool', async () => {
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  const {InMemoryTransport} = await import('@modelcontextprotocol/sdk/inMemory.js');
  const {createMcpServer} = await import('../src/mcp.ts');
  const {NotesService} = await import('../src/service.ts');
  const {Store} = await import('../src/store.ts');
  const {FakeSlackTransport} = await import('../src/fake-slack-transport.ts');
  const {person, agent} = await import('./helpers.ts');
  const dir = mkdtempSync(join(tmpdir(), 'restart-tool-'));
  const service = new NotesService({store: new Store(dir), transport: new FakeSlackTransport(join(dir, 'c.json'), {clientId: 'x', teamId: 'TEXAMPLE', redirectUri: 'http://localhost/cb', apiBase: 'http://127.0.0.1:9/api'}),
    scanIntervalMs: 0, retryIntervalMs: 0});
  let restarts = 0;
  try {
    for (const session of [agent, person]) {
      const server = createMcpServer(service, session, {restartSlack: async () => { restarts++; }}), client = new Client({name: 'restart-test', version: '1'});
      const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
      try {
        const names = (await client.listTools()).tools.map(x => x.name);
        assert.equal(names.includes('a2anotes_restart_slack'), session === person);
        if (session === person) await client.callTool({name: 'a2anotes_restart_slack', arguments: {}});
      } finally { await client.close(); await server.close(); }
    }
  } finally { await service.stop(); }
  assert.equal(restarts, 1);
});

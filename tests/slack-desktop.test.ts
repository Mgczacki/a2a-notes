import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { WebSocketServer, type WebSocket } from 'ws';
import { SlackDesktopHook, desktopURL, desktopEvent, DESKTOP_IDENTITY, SOCKET_LISTENER, FRAME_BINDING } from '../src/slack-desktop.ts';
import { TransportError } from '../src/transport.ts';
import { fakeWorkspace, personService, person, agent, MARIO, ALEX, rid } from './helpers.ts';
import { encode } from '../src/protocol.ts';
import { NATIVE_FUNCTIONS } from '../src/slack-desktop-native.ts';
import { slackText } from '../src/slack-format.ts';

test('the renderer identity reads the account button and returns only account IDs', () => {
  const component = { type: { displayName: 'User' }, memoizedProps: { currentUserId: MARIO, access: 'private' } };
  const context = { location: { pathname: '/client/TEXAMPLE/DSELF' }, document: { querySelector: () => ({__reactFiberTest: {return: component}}) } };
  assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(DESKTOP_IDENTITY, context))), { team: 'TEXAMPLE', user: MARIO });
  const other = { ...context, document: { querySelector: () => ({ __reactFiberTest: {type: {name: 'Message'}, memoizedProps: {currentUserId: ALEX}} }) } };
  assert.equal(runInNewContext(DESKTOP_IDENTITY, other).user, null);
});

async function wait(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) { if (Date.now() > until) assert.fail('Timed out waiting for the desktop hook.'); await new Promise(r => setTimeout(r, 20)); }
}
async function cdp(t: any, team = 'TEXAMPLE', owner = MARIO) {
  const clients = new Set<WebSocket>(); const calls: any[] = [];
  let targetId = 'slack-page';
  let port = 0;
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([{ id: targetId, type: 'page', url: `https://app.slack.com/client/${team}/DSELF`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetId}` }])); });
  const ws = new WebSocketServer({ server });
  ws.on('connection', client => {
    clients.add(client); client.on('close', () => clients.delete(client));
    client.on('message', data => {
      const m = JSON.parse(data.toString()); calls.push(m);
      if (m.method === 'Network.enable') client.send(JSON.stringify({ method: 'Network.webSocketCreated', params: { requestId: 'native', url: 'wss://wss-primary.slack.com/connection?ticket=private' } }));
      if (m.method === 'Runtime.evaluate') client.send(JSON.stringify({ id: m.id, result: { result: { value: { team, user: owner } } } }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); port = (server.address() as any).port;
  t.after(async () => { for (const c of clients) c.terminate(); await new Promise<void>(r => ws.close(() => server.close(() => r()))); });
  return { url: `http://127.0.0.1:${port}`, calls, clients, changeTarget: () => {targetId = 'new-page';},
    event: (event: unknown, requestId = 'native', method = 'Network.webSocketFrameReceived') => {
      for (const c of clients) c.send(JSON.stringify({ method, params: { requestId, response: { opcode: 1, payloadData: JSON.stringify(event) } } }));
    },
  };
}
const identity = { transport: 'slack', address: `slack:TEXAMPLE:${MARIO}`, name: 'Mario', scopes: [], missingScopes: [], optionalMissing: [] };
const event = { type: 'message', channel: 'DSELF', user: MARIO, text: 'A2A #430\nPlease check the status.', ts: '1791899900.001' };

for (const endpoint of ['https://127.0.0.1:9222', 'http://localhost:9222', 'http://192.168.1.2:9222', 'http://127.0.0.1:9222/secret', 'http://user:secret@127.0.0.1:9222', 'http://127.0.0.1:9222/?token=secret']) {
  test(`the desktop endpoint rejects ${endpoint}`, () => assert.throws(() => desktopURL(endpoint)));
}
test('the decoder ignores ordinary text, nested frames, edits, and non-DM events', () => {
  assert.deepEqual(desktopEvent(event), event);
  for (const e of [{ ...event, text: 'approve' }, { ...event, channel: 'COTHER' }, { type: 'notification', event },
    { ...event, subtype: 'message_changed' }, { ...event, ts: 'now' }, { ...event, user: undefined }]) assert.equal(desktopEvent(e), undefined);
  assert.equal(desktopEvent({ ...event, token: 'private' })?.text, event.text);
  assert.equal('token' in desktopEvent({ ...event, token: 'private' })!, false);
});

test('native owner events use the current service checks and deduplicate with polling and restart', async t => {
  const fake = await fakeWorkspace(); let owner = personService(fake, MARIO);
  const remote = await cdp(t);
  const dir = mkdtempSync(join(tmpdir(), 'desktop-events-'));
  let hook!: SlackDesktopHook;
  const start = () => {
    hook = new SlackDesktopHook({ dir, config: { url: remote.url }, identity: () => owner.transport.identity(),
      verifyEndpoint: async () => {}, verifyChannel: channel => owner.transport.verifyDesktopChannel(channel), receive: m => owner.service.receive(m) });
    hook.start(); return hook;
  };
  t.after(async () => { await hook.close(); owner.service.stop(); await fake.close(); });
  start(); await wait(() => hook.status().listening);
  const ts = fake.inject(MARIO, MARIO, event.text);
  const channel = [...fake.channels.values()][0].id;
  remote.event({ ...event, channel, ts });
  await wait(() => owner.service.list(person, { direction: 'incoming' }).messages.length === 1);
  const m = owner.service.list(agent, { direction: 'incoming' }).messages[0];
  assert.equal(m.owner_message, true); assert.equal(m.state, 'approved'); assert.equal(m.direct_target, '#430');
  await owner.service.scanNow();
  assert.equal(owner.service.list(person, { direction: 'incoming' }).messages.length, 1);
  await hook.close(); owner.service.stop(); owner = personService(fake, MARIO, owner.dir); start();
  await wait(() => hook.status().listening); remote.event({ ...event, channel, ts });
  await wait(() => hook.status().pending === 0); await owner.service.scanNow();
  assert.equal(owner.service.list(person, { direction: 'incoming' }).messages.length, 1);
  // Without sending, the hook listens, checks the account, and checks background read readiness only.
  assert.ok(remote.calls.every(m => ['Network.enable', 'Runtime.enable', 'Runtime.addBinding', 'Runtime.evaluate', 'Runtime.queryObjects',
    'Runtime.callFunctionOn', 'Runtime.releaseObjectGroup'].includes(m.method)));
  assert.ok(remote.calls.filter(m => m.method === 'Runtime.evaluate').every(m => [DESKTOP_IDENTITY, 'globalThis', 'WebSocket.prototype'].includes(m.params.expression)));
  assert.ok(remote.calls.filter(m => m.method === 'Runtime.callFunctionOn').every(m => [NATIVE_FUNCTIONS.capability, SOCKET_LISTENER].includes(m.params.functionDeclaration)));
  assert.ok(!readFileSync(join(dir, 'desktop-events.json'), 'utf8').includes('private'));
});

test('unknown sockets, another account, outbound frames, and automated owner posts cannot create owner requests', async t => {
  const remote = await cdp(t); const received: any[] = [];
  const hook = new SlackDesktopHook({ config: { url: remote.url }, dir: mkdtempSync(join(tmpdir(), 'desktop-filter-')),
    identity: () => identity, verifyEndpoint: async () => {}, verifyChannel: async () => true, receive: async m => { received.push(m); } });
  t.after(() => hook.close()); hook.start(); await wait(() => hook.status().listening);
  remote.event(event, 'unknown'); remote.event(event, 'native', 'Network.webSocketFrameSent');
  remote.event({ ...event, app_id: 'AAPP' }); remote.event({ ...event, bot_id: 'BBOT' }); remote.event({ ...event, user: ALEX });
  remote.event({ ...event, text: 'approve' });
  await new Promise(r => setTimeout(r, 100)); assert.equal(received.length, 0);
  const wrong = await cdp(t, 'TEXAMPLE', ALEX);
  const second = new SlackDesktopHook({ config: { url: wrong.url }, dir: mkdtempSync(join(tmpdir(), 'desktop-account-')),
    identity: () => identity, verifyEndpoint: async () => {}, verifyChannel: async () => true, receive: async m => { received.push(m); } });
  t.after(() => second.close()); second.start(); await wait(() => second.status().connected);
  wrong.event(event); await new Promise(r => setTimeout(r, 100));
  assert.equal(second.status().accountVerified, false); assert.equal(received.length, 0);
});

test('a queued desktop event survives a 429 and service restart', async t => {
  const remote = await cdp(t); const dir = mkdtempSync(join(tmpdir(), 'desktop-retry-')); let attempts = 0, received = 0;
  const opts = { config: { url: remote.url }, dir, identity: () => identity, verifyEndpoint: async () => {}, verifyChannel: async () => true,
    receive: async () => { attempts++; if (attempts === 1) throw new TransportError('Slack rate limit.', true, 60, 'conversations.info', 429); received++; } };
  let hook = new SlackDesktopHook(opts); t.after(() => hook.close()); hook.start(); await wait(() => hook.status().listening);
  remote.event(event); await wait(() => attempts === 1);
  await hook.close();
  const saved = JSON.parse(readFileSync(join(dir, 'desktop-events.json'), 'utf8'));
  assert.equal(saved.length, 1); assert.ok(saved[0].nextAt >= Date.now() + 55_000);
  saved[0].nextAt = 0; writeFileSync(join(dir, 'desktop-events.json'), JSON.stringify(saved));
  hook = new SlackDesktopHook(opts); hook.start(); await wait(() => received === 1);
  assert.equal(hook.status().pending, 0); assert.equal(attempts, 2);
});

test('an invalid credential error does not retry the desktop event', async t => {
  const remote = await cdp(t); let calls = 0;
  const hook = new SlackDesktopHook({ config: { url: remote.url }, dir: mkdtempSync(join(tmpdir(), 'desktop-auth-')),
    identity: () => identity, verifyEndpoint: async () => {}, verifyChannel: async () => { calls++; throw new TransportError('Slack: invalid_auth', true); }, receive: async () => assert.fail() });
  t.after(() => hook.close()); hook.start(); await wait(() => hook.status().listening);
  remote.event(event); await wait(() => calls === 1); await new Promise(r => setTimeout(r, 100));
  assert.equal(hook.status().pending, 0); assert.equal(calls, 1);
});

test('the connector verifies endpoint ownership before reading any debugging targets', async t => {
  const remote = await cdp(t);
  const hook = new SlackDesktopHook({ config: { url: remote.url }, dir: mkdtempSync(join(tmpdir(), 'desktop-endpoint-')),
    identity: () => identity, verifyEndpoint: async () => { throw new Error('Another process owns the port.'); }, verifyChannel: async () => assert.fail(), receive: async () => assert.fail() });
  t.after(() => hook.close()); hook.start(); await new Promise(r => setTimeout(r, 100));
  assert.equal(hook.status().connected, false); assert.equal(remote.calls.length, 0);
});

test('a disconnected debugger reconnects and restores verified listening', async t => {
  const remote = await cdp(t); const states: boolean[] = []; let received = 0;
  const hook = new SlackDesktopHook({ config: {url: remote.url}, dir: mkdtempSync(join(tmpdir(), 'desktop-reconnect-')),
    identity: () => identity, verifyEndpoint: async () => {}, verifyChannel: async () => true,
    connection: active => states.push(active), receive: async () => {received++;} });
  t.after(() => hook.close()); hook.start(); await wait(() => hook.status().listening);
  for (const client of remote.clients) client.terminate();
  await wait(() => !hook.status().connected); await wait(() => hook.status().listening);
  remote.event(event); await wait(() => received === 1);
  assert.ok(states.includes(false)); assert.equal(states.at(-1), true);
});

test('a replacement target rechecks port ownership while the previous socket remains open', async t => {
  const remote = await cdp(t); let verified = 0;
  const hook = new SlackDesktopHook({ config: {url: remote.url}, dir: mkdtempSync(join(tmpdir(), 'desktop-owner-change-')),
    identity: () => identity, verifyEndpoint: async () => { if (++verified > 2) throw new Error('The listener changed.'); },
    verifyChannel: async () => true, receive: async () => assert.fail() });
  t.after(() => hook.close()); hook.start(); await wait(() => hook.status().listening);
  const calls = remote.calls.length; remote.changeTarget();
  await wait(() => verified > 2); await new Promise(r => setTimeout(r, 100));
  assert.equal(remote.calls.length, calls); assert.equal(hook.status().listening, false);
});

test('closing during target discovery does not open a new socket', async t => {
  const remote = await cdp(t); let release!: () => void, requested = false;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const hook = new SlackDesktopHook({ config: {url: remote.url}, dir: mkdtempSync(join(tmpdir(), 'desktop-close-')),
    identity: () => identity, verifyEndpoint: async () => {}, verifyChannel: async () => true, receive: async () => {},
    fetcher: async (input, init) => {requested = true; await gate; return fetch(input, init);} });
  hook.start(); await wait(() => requested);
  const closing = hook.close(); release(); await closing;
  assert.equal(remote.calls.length, 0); assert.equal(hook.status().connected, false);
});

test('native human replies keep the original audience, note, sender, and acceptance rule', async t => {
  const fake = await fakeWorkspace(), owner = personService(fake, MARIO);
  const remote = await cdp(t);
  const hook = new SlackDesktopHook({ config: {url: remote.url}, dir: mkdtempSync(join(tmpdir(), 'desktop-reply-')),
    identity: () => owner.transport.identity(), verifyEndpoint: async () => {},
    verifyChannel: channel => owner.transport.verifyDesktopChannel(channel), receive: m => owner.service.receive(m) });
  t.after(async () => {await hook.close(); await owner.service.stop(); await fake.close();});
  const draft = await owner.service.createDraft(agent, {to_address: `slack:TEXAMPLE:${ALEX}`, subject: 'Check', body: 'Please check this note.',
    audience: 'person', request_id: rid(), metadata: {'taskboard.task_id': 'origin'}});
  owner.service.approve(person, {id: draft.id, expected_hash: draft.hash, decision: 'approve'});
  await owner.service.send(person, {id: draft.id, expected_hash: draft.hash, request_id: rid()});
  const sent = owner.service.get(person, draft.id);
  hook.start(); await wait(() => hook.status().listening);
  remote.event({...event, channel: sent.transport!.channel, user: ALEX, text: `A2A Reply/1 ${draft.message_id}\nYes.`, thread_ts: sent.transport!.ts});
  await wait(() => owner.service.list(person, {direction: 'incoming'}).messages.length === 1);
  const note = owner.service.list(person, {direction: 'incoming'}).messages[0];
  assert.equal(note.from, `slack:TEXAMPLE:${ALEX}`); assert.equal(note.audience, 'person'); assert.equal(note.state, 'held');
  assert.equal(note.reply_to_local!.metadata!['taskboard.task_id'], 'origin'); assert.equal(note.owner_message, false);
  owner.service.approve(person, {id: note.id, expected_hash: note.hash, decision: 'approve'});
  assert.equal(owner.service.get(agent, note.id).body, '');
});

test('native incoming notes read the current Slack wrapper and retain person privacy', async t=>{
  const fake=await fakeWorkspace(),owner=personService(fake,MARIO),remote=await cdp(t),id=crypto.randomUUID();
  const text=slackText(encode({id,from:`slack:TEXAMPLE:${ALEX}`,to:`slack:TEXAMPLE:${MARIO}`,subject:'Wrapper check',audience:'person',threadId:id,replyTo:null,
    body:'Please check this note.',files:[],transportFiles:{}}),{subject:'Wrapper check',senderName:'Alex',body:'Please check this note.',audience:'person',files:[]});
  assert.ok(!text.startsWith('A2ANotes'));const ts=fake.inject(ALEX,MARIO,text),channel=[...fake.channels.values()][0].id;
  const hook=new SlackDesktopHook({config:{url:remote.url},dir:owner.dir,identity:()=>owner.transport.identity(),verifyEndpoint:async()=>{},
    verifyChannel:c=>owner.transport.verifyDesktopChannel(c),receive:m=>owner.service.receive(m)});
  t.after(async()=>{await hook.close();await owner.service.stop();await fake.close();});hook.start();await wait(()=>hook.status().listening);
  remote.event({type:'message',channel,user:ALEX,text,ts});await wait(()=>owner.service.list(person,{direction:'incoming'}).messages.length===1);
  const note=owner.service.list(person,{direction:'incoming'}).messages[0];assert.equal(note.message_id,id);assert.equal(note.state,'held');
  assert.equal(note.audience,'person');assert.equal(owner.service.get(agent,note.id).body,'');
});

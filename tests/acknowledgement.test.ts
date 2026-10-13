import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { NotesService } from '../src/service.ts';
import { Store, savePrivate, noteHash } from '../src/store.ts';
import { encode } from '../src/protocol.ts';
import { fakeWorkspace, personService, person, agent, reviewer, MARIO, ALEX } from './helpers.ts';

async function fixture(t: any, native = false) {
  const fake = await fakeWorkspace();
  let now = Date.now();
  const f = personService(fake, MARIO, undefined, { now: () => now });
  t.after(async () => { await f.service.stop(); await fake.close(); });
  const messageId = randomUUID();
  const text = native ? 'A2A @research\nPlease check the plan.' : encode({ id: messageId, from: `slack:${fake.team}:${ALEX}`, to: f.address,
    subject: 'Plan', audience: 'person', threadId: messageId, replyTo: null, body: 'Please check the plan.', files: [], transportFiles: {} });
  const ts = fake.inject(native ? MARIO : ALEX, MARIO, text);
  const channel = [...fake.channels.values()].find(c => c.messages.some(m => m.ts === ts))!;
  const receive = () => f.service.receive({ conversation: channel.id, ref: `slack:${fake.team}:${channel.id}:${ts}`, channel: channel.id, ts,
    sender: native ? f.address : `slack:${fake.team}:${ALEX}`, text, ...(native ? { ownerConversation: true } : {}) });
  return { fake, f, channel, ts, receive, advance: (ms: number) => { now += ms; }, time: () => now, note: () => f.service.store.read().notes.find(n => n.direction === 'in')! };
}

test('acknowledgement adds one reaction without approving, routing, or changing content', async t => {
  const x = await fixture(t); await x.receive();
  const n = x.note(), hash = n.hash, count = x.f.service.store.read().notes.length;
  assert.equal(n.state, 'held'); assert.equal(n.acknowledgement, undefined);
  assert.equal(x.f.service.get(person, n.id).allowed_actions.includes('ack'), true);
  await assert.rejects(x.f.service.acknowledge(agent, { id: n.id, expected_hash: hash }), /cannot acknowledge/);
  await assert.rejects(x.f.service.acknowledge(person, { id: n.id, expected_hash: 'bad' }), /current message/);
  const results = await Promise.all(Array.from({ length: 4 }, () => x.f.service.acknowledge(person, { id: n.id, expected_hash: hash })));
  assert.ok(results.every(r => r.acknowledgement?.status === 'confirmed'));
  assert.equal(x.fake.calls.get('reactions.add'), 1);
  assert.equal(x.note().hash, hash); assert.equal(x.note().state, 'held'); assert.equal(x.note().approval, undefined);
  assert.equal(x.f.service.store.read().notes.length, count);
  assert.deepEqual(x.channel.messages[0].reactions, [{ name: 'white_check_mark', users: [MARIO], count: 1 }]);
});

test('native intake persists acknowledgement and retries after a rate limit and restart', async t => {
  const x = await fixture(t, true);
  x.fake.fail('reactions.add', { mode: 'ratelimit', count: 1, retryAfter: 90 });
  await x.receive();
  assert.equal(x.note().acknowledgement?.status, 'pending');
  const approval = x.note().approval;
  await x.receive(); assert.equal(x.f.service.store.read().notes.length, 1);
  await x.f.service.stop(); x.advance(90_000);
  const restarted = new NotesService({ store: new Store(x.f.dir), transport: x.f.transport, scanIntervalMs: 0, retryIntervalMs: 0,
    now: x.time });
  restarted.start(); t.after(() => restarted.stop());
  await restarted.processQueue();
  assert.equal(x.note().acknowledgement?.status, 'confirmed');
  assert.deepEqual(x.note().approval, approval);
  await restarted.processQueue(); assert.equal(x.fake.calls.get('reactions.add'), 2);
});

test('a lost reaction response retries the same reaction and treats already_reacted as success', async t => {
  const x = await fixture(t); await x.receive();
  x.fake.fail('reactions.add', { mode: 'lost', count: 1 });
  await x.f.service.acknowledge(person, { id: x.note().id, expected_hash: x.note().hash });
  assert.equal(x.note().acknowledgement?.status, 'pending');
  x.advance(60_000); await x.f.service.processQueue();
  assert.equal(x.note().acknowledgement?.status, 'confirmed');
  assert.equal(x.channel.messages[0].reactions?.[0].count, 1);
});

test('changed recipient and changed content stop pending acknowledgements', async t => {
  for (const change of ['recipient', 'content']) {
    const x = await fixture(t); await x.receive();
    x.fake.fail('reactions.add', { mode: 'ratelimit', count: 1, retryAfter: 1 });
    await x.f.service.acknowledge(person, { id: x.note().id, expected_hash: x.note().hash });
    if (change === 'recipient') savePrivate(join(x.f.dir, 'slack-credentials.json'), x.fake.credentials(ALEX));
    else x.f.service.store.update(x.note().id, n => { n.body = 'changed'; });
    x.advance(60_000); await x.f.service.processQueue();
    assert.equal(x.note().acknowledgement?.status, 'failed');
    assert.equal(x.fake.calls.get('reactions.add'), 1);
  }
});

test('missing scope fails visibly without accepting the note, and unsupported transports keep the operation optional', async t => {
  const x = await fixture(t); await x.receive();
  savePrivate(join(x.f.dir, 'slack-credentials.json'), x.fake.credentials(MARIO, ['chat:write']));
  const result = await x.f.service.acknowledge(person, { id: x.note().id, expected_hash: x.note().hash });
  assert.equal(result.acknowledgement?.status, 'failed'); assert.match(result.acknowledgement!.error!, /reactions:write/);
  assert.equal(result.state, 'held'); assert.equal(x.fake.calls.get('reactions.add'), undefined);
  const transport = Object.create(x.f.transport); transport.acknowledge = undefined;
  const service = new NotesService({ store: x.f.service.store, transport, scanIntervalMs: 0 });
  assert.equal(service.get(person, x.note().id).allowed_actions.includes('ack'), false);
});

test('quarantined native input never creates an acknowledgement', async t => {
  const fake = await fakeWorkspace();
  const f = personService(fake, MARIO, undefined, { reviewer: async () => ({ verdict: 'quarantine', reason: 'Blocked in test.', reviewer: 'test' }) });
  t.after(async () => { await f.service.stop(); await fake.close(); });
  const ts = fake.inject(MARIO, MARIO, 'A2A @research\nBlocked content.');
  const channel = [...fake.channels.values()][0];
  await f.service.receive({ conversation: channel.id, ref: 'bad-input', channel: channel.id, ts,
    sender: f.address, ownerConversation: true, text: 'A2A @research\nBlocked content.' });
  const stored = f.service.store.read().notes[0];
  assert.equal(stored.state, 'quarantined'); assert.equal(stored.acknowledgement, undefined);
  assert.equal(fake.calls.get('reactions.add'), undefined);
  await assert.rejects(f.service.acknowledge(person, { id: stored.id, expected_hash: stored.hash }), /cannot acknowledge/);
});

test('the owner can retry a failed acknowledgement after reconnecting with the missing scope', async t => {
  const x = await fixture(t); await x.receive();
  savePrivate(join(x.f.dir, 'slack-credentials.json'), x.fake.credentials(MARIO, ['chat:write']));
  await x.f.service.acknowledge(person, { id: x.note().id, expected_hash: x.note().hash });
  assert.equal(x.note().acknowledgement?.status, 'failed');
  savePrivate(join(x.f.dir, 'slack-credentials.json'), x.fake.credentials(MARIO));
  await x.f.service.acknowledge(person, { id: x.note().id, expected_hash: x.note().hash });
  assert.equal(x.note().acknowledgement?.status, 'confirmed'); assert.equal(x.note().approval, undefined);
});

test('automatic acknowledgement retries stop after eight rate-limited attempts', async t => {
  const x = await fixture(t); await x.receive();
  x.fake.fail('reactions.add', { mode: 'ratelimit', count: 20, retryAfter: 1 });
  await x.f.service.acknowledge(person, { id: x.note().id, expected_hash: x.note().hash });
  for (let i = 0; i < 10; i++) { x.advance(3_600_000); await x.f.service.processQueue(); }
  assert.equal(x.note().acknowledgement?.status, 'failed');
  assert.equal(x.note().acknowledgement?.failureCode, 'retry_exhausted');
  assert.equal(x.fake.calls.get('reactions.add'), 8); assert.equal(x.note().state, 'held');
});

test('a non-Slack adapter can acknowledge its own saved reference', async t => {
  const x = await fixture(t); await x.receive();
  const transport = Object.create(x.f.transport);
  transport.name = 'mail';
  transport.identity = () => ({ transport: 'mail', address: 'mail:mario', name: 'Mario', scopes: [], missingScopes: [], optionalMissing: [] });
  const references: Record<string, string>[] = [];
  transport.acknowledge = async (reference: Record<string, string>) => { references.push(reference); };
  x.f.service.store.update(x.note().id, n => {
    n.from = 'mail:alex'; n.to = 'mail:mario'; n.transport = { name: 'mail', channel: 'inbox', ts: 'mail-record-1' };
    n.hash = noteHash(n, []);
  });
  const service = new NotesService({ store: x.f.service.store, transport, scanIntervalMs: 0, retryIntervalMs: 0 });
  await service.acknowledge(person, { id: x.note().id, expected_hash: x.note().hash });
  assert.deepEqual(references, [{ channel: 'inbox', ts: 'mail-record-1' }]);
  assert.equal(x.note().acknowledgement?.status, 'confirmed'); assert.equal(x.fake.calls.get('reactions.add'), undefined);
});


test('a fixed delivery failure notice does not become agent input or change approval', async t => {
  const x = await fixture(t, true); await x.receive();
  const n = x.note(), approval = n.approval;
  await assert.rejects(x.f.service.reportAgentDelivery(agent, { id: n.id, expected_hash: n.hash, status: 'unassigned' }), /Only the person/);
  await x.f.service.reportAgentDelivery(reviewer, { id: n.id, expected_hash: n.hash, status: 'unassigned' });
  assert.equal(x.note().deliveryNotice?.status, 'confirmed');
  const posted = x.channel.messages.filter(m => m.app_id);
  assert.equal(posted.length, 1); assert.match(posted[0].text, /No agent was selected/);
  await x.f.service.reportAgentDelivery(reviewer, { id: n.id, expected_hash: n.hash, status: 'unassigned' });
  assert.equal(x.fake.calls.get('chat.postMessage'), 1);
  await x.f.service.scanNow(); assert.equal(x.f.service.store.read().notes.length, 1);
  assert.deepEqual(x.note().approval, approval);
});

test('a lost delivery notice response reconciles without posting another notice', async t => {
  const x = await fixture(t, true); await x.receive();
  x.fake.fail('chat.postMessage', { mode: 'lost', count: 1 });
  await x.f.service.reportAgentDelivery(reviewer, { id: x.note().id, expected_hash: x.note().hash, status: 'notification_pending' });
  assert.equal(x.note().deliveryNotice?.status, 'pending'); assert.equal(x.note().deliveryNotice?.uncertain, true);
  x.advance(60_000); await x.f.service.processQueue();
  assert.equal(x.note().deliveryNotice?.status, 'confirmed');
  assert.equal(x.fake.calls.get('chat.postMessage'), 1);
});


test('a notice interrupted after posting reconciles on restart, then reports recovery once', async t => {
  const x = await fixture(t, true); await x.receive();
  await x.f.service.reportAgentDelivery(reviewer, { id: x.note().id, expected_hash: x.note().hash, status: 'unassigned' });
  x.f.service.store.update(x.note().id, n => { n.deliveryNotice!.status = 'pending'; n.deliveryNotice!.nextAttemptAt = new Date(x.time()).toISOString(); });
  await x.f.service.stop();
  const restarted = new NotesService({ store: new Store(x.f.dir), transport: x.f.transport, scanIntervalMs: 0, retryIntervalMs: 0, now: x.time });
  restarted.start(); t.after(() => restarted.stop()); await restarted.processQueue();
  assert.equal(x.fake.calls.get('chat.postMessage'), 1);
  await restarted.reportAgentDelivery(reviewer, { id: x.note().id, expected_hash: x.note().hash, status: 'notified' });
  assert.equal(x.note().agentDelivery?.status, 'notified');
  x.advance(60_000); await restarted.processQueue();
  assert.equal(x.fake.calls.get('chat.postMessage'), 2, JSON.stringify(x.note().deliveryNotice));
  assert.match(x.channel.messages.at(-1)!.text, /does not mean completed work/);
});

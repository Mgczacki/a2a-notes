import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { encode, escapeMarkup, sha256, writeAgentFile, agentFileName } from '../src/protocol.ts';
import { ServiceError } from '../src/store.ts';
import { TransportError } from '../src/transport.ts';
import { commandBodyChecker, fileTextForChecks } from '../src/checks.ts';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkProjectLink, readSlackText, slackBlocks, slackText } from '../src/slack-format.ts';
import { ALEX, EVE, MARIO, agent, agentRequest, fakeWorkspace, person, personService, reviewer, rid, stageAgentFile } from './helpers.ts';

const fake = await fakeWorkspace();
after(() => fake.close());
const code = async (p: Promise<unknown> | (() => unknown), expected: string) => {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { assert.equal((e as ServiceError).code, expected, (e as Error).message); return; }
  assert.fail(`expected ${expected}`);
};

test('a person message goes from Mario to Alex, and the approval rules apply on both sides', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  const draft = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Report ready', body: 'Hi Alex, the report is ready. Please read it by Friday.', audience: 'person', request_id: rid() });
  assert.equal(draft.state, 'draft');
  assert.equal(draft.approver, 'person', 'Alex is not a trusted sender yet');
  await code(() => mario.service.approve(agent, { id: draft.id, expected_hash: draft.hash, decision: 'approve' }), 'forbidden');
  await code(() => mario.service.approve(reviewer, { id: draft.id, expected_hash: draft.hash, decision: 'approve' }), 'needs_person');
  mario.service.setTrusted(person, { address: alex.address, name: 'Alex B', trusted: true });
  await code(() => mario.service.approve(reviewer, { id: draft.id, expected_hash: 'x', decision: 'approve' }), 'hash_changed');
  const approved = mario.service.approve(reviewer, { id: draft.id, expected_hash: draft.hash, decision: 'approve' });
  assert.equal(approved.approval?.by, 'reviewer');
  await code(mario.service.send(agent, { id: draft.id, expected_hash: draft.hash, request_id: rid() }), 'forbidden');
  const sent = await mario.service.send(reviewer, { id: draft.id, expected_hash: draft.hash, request_id: rid() });
  assert.equal(sent.state, 'sent');

  await alex.service.scanNow();
  const inbox = alex.service.list(person, { direction: 'incoming' }).messages;
  assert.equal(inbox.length, 1);
  const held = inbox[0];
  assert.equal(held.state, 'held');
  assert.equal(held.from, mario.address);
  assert.equal(alex.service.get(agent, held.id).body, '', 'an agent cannot read a held message');
  assert.equal(alex.service.get(agent, held.id).subject, '(held for review)');
  await code(() => alex.service.approve(reviewer, { id: held.id, expected_hash: alex.service.get(person, held.id).hash, decision: 'approve' }), 'needs_person');
  alex.service.approve(person, { id: held.id, expected_hash: alex.service.get(person, held.id).hash, decision: 'approve' });
  assert.equal(alex.service.get(agent, held.id).body, '', 'a person message never goes to an agent');
  assert.equal(alex.service.get(person, held.id).body, 'Hi Alex, the report is ready. Please read it by Friday.');
  // a second scan and a Slack page read twice do not duplicate the message
  alex.service.store.change(d => { d.cursors = {}; });
  await alex.service.scanNow();
  assert.equal(alex.service.list(person, { direction: 'incoming' }).messages.length, 1);
});

test('a both message carries a verified agent file, and the agent gets the file only after approval', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  const id = randomUUID(), subject = 'Please confirm the Stage hosting settings';
  const staged = stageAgentFile(mario.service, agent, agentRequest(id, subject));
  assert.equal(staged.name, agentFileName(id));
  const first = await mario.service.createDraft(agent, { to_address: alex.address, subject, audience: 'both', agent_file_id: staged.file_id, request_id: rid(),
    body: 'Hi Alex, please confirm the exact release keys for files.example.test before the hosting change.', instruction: 'Ask Alex to confirm the exact setting names.' });
  assert.equal(first.id, id, 'the draft uses the agent file message_id');
  assert.ok(first.body_check!.flags.some(f => f.code === 'agent_detail'));
  assert.ok(first.body_check!.flags.some(f => f.code === 'ask_changed'));
  mario.service.setTrusted(person, { address: alex.address, trusted: true });
  assert.equal(first.approver, 'person', 'a flagged body needs the person');
  const revised = await mario.service.reviseDraft(agent, { id, expected_hash: first.hash, subject, audience: 'both', agent_file_id: staged.file_id,
    body: 'Hi Alex, thanks for confirming the hosting request for files.example.test. Please have your agent confirm the exact setting names for that hosting change before we make it.' });
  assert.notEqual(revised.hash, first.hash);
  assert.equal(revised.body_flags, 0);
  assert.equal(revised.approver, 'reviewer');
  mario.service.approve(reviewer, { id, expected_hash: revised.hash, decision: 'approve' });
  await mario.service.send(reviewer, { id, expected_hash: revised.hash, request_id: rid() });
  const posted = [...fake.channels.values()].flatMap(c => c.messages).find(m => m.text.includes(`ID: ${id}`))!;
  // people read the blocks: subject, sender, body, the agent file, and no wire lines
  const shown = JSON.stringify(posted.blocks);
  assert.match(shown, /"type":"header","text":\{"type":"plain_text","text":"Please confirm the Stage hosting settings"/);
  assert.match(shown, /For you and your agent · Sent by Mario G with A2A Notes/);
  assert.match(shown, /Hi Alex, thanks for confirming/);
  assert.match(shown, new RegExp(`Agent request for the reader's agent: a2anotes-request-${id}\\.json`));
  assert.ok(!shown.includes('A2ANotes/1') && !shown.includes('Body-Bytes'), 'no wire lines in the blocks');
  assert.match(shown, /"type":"mrkdwn","text":"<https:\/\/github\.com\/Mgczacki\/a2a-notes\|Get A2A Notes>"/, 'the footer links to A2A Notes');
  // Slack flattened the newlines in text (the fake does what Slack does), and the JSON string still holds the exact wire text
  assert.ok(!posted.text.includes('\n'));
  const read = readSlackText(posted.text);
  assert.ok('text' in read);
  assert.match(read.text, /^A2ANotes\/1\n/);
  assert.match(read.text, /\nTransport-File-Slack: [0-9a-f-]{36} \| F[0-9A-F]+\n/);
  assert.match(read.text, /\nSent by Mario G with A2A Notes\.$/);

  await alex.service.scanNow();
  const note = alex.service.list(person, { direction: 'incoming' }).messages.find(m => m.message_id === id)!;
  assert.equal(note.state, 'held');
  const hidden = alex.service.get(agent, note.id);
  assert.equal(hidden.agent_file?.status, 'held');
  assert.equal((hidden.agent_file as any).data, undefined);
  alex.service.setTrusted(person, { address: mario.address, trusted: true });
  const view = alex.service.get(reviewer, note.id);
  assert.equal(view.approver, 'reviewer');
  assert.ok(view.body, 'the review agent can read a message that it may approve');
  alex.service.approve(reviewer, { id: note.id, expected_hash: view.hash, decision: 'approve' });
  const released = alex.service.get(agent, note.id);
  assert.equal(released.agent_file?.status, 'released');
  assert.equal((released.agent_file as any).data.agent_request.ask, 'Confirm the exact setting names.');
  // a level change ends the review agent's approval at the next release
  alex.service.setPolicy(person, { incoming: 1 });
  assert.equal(alex.service.get(agent, note.id).agent_file?.status, 'held');
  assert.equal(alex.service.get(agent, note.id).body, '');
});

test('an approval ends when the draft changes or the level changes before send', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  mario.service.setTrusted(person, { address: alex.address, trusted: true });
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Hi', body: 'Hi Alex, the notes are ready.', audience: 'person', request_id: rid() });
  mario.service.approve(reviewer, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  mario.service.setPolicy(person, { outgoing: 1 });
  await code(mario.service.send(reviewer, { id: d.id, expected_hash: d.hash, request_id: rid() }), 'approval_invalid');
  const r = await mario.service.reviseDraft(agent, { id: d.id, expected_hash: d.hash, subject: 'Hi', body: 'Hi Alex, the new notes are ready.', audience: 'person' });
  assert.equal(r.approval, null);
  assert.equal(r.state, 'draft');
  await code(mario.service.send(person, { id: d.id, expected_hash: r.hash, request_id: rid() }), 'not_approved');
  // retried create with the same request_id returns the same draft
  const request = rid();
  const a = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Once', body: 'Hi Alex, one draft only.', audience: 'person', request_id: request });
  const b = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Once', body: 'Hi Alex, one draft only.', audience: 'person', request_id: request });
  assert.equal(a.id, b.id);
});

test('an empty body, a missing agent file, a bot, and an untrusted agent action are refused', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  await code(mario.service.createDraft(agent, { to_address: alex.address, subject: 'Hi', body: ' ', audience: 'person', request_id: rid() }), 'invalid_input');
  await code(mario.service.createDraft(agent, { to_address: alex.address, subject: 'Hi', body: 'Hello.', audience: 'agent', request_id: rid() }), 'agent_file_missing');
  await code(mario.service.createDraft(agent, { to_address: `slack:${fake.team}:UBOT01`, subject: 'Hi', body: 'Hello.', audience: 'person', request_id: rid() }), 'transport_error');
  await code(() => mario.service.setTrusted(agent, { address: alex.address, trusted: true }), 'forbidden');
  await code(() => mario.service.setPolicy(reviewer, { incoming: 3 }), 'forbidden');
  const other = stageAgentFile(mario.service, agent, agentRequest(randomUUID(), 'Other subject'));
  await code(mario.service.createDraft(agent, { to_address: alex.address, subject: 'Hi', body: 'Hello.', audience: 'both', agent_file_id: other.file_id, request_id: rid() }), 'agent_file_invalid');
  await code(() => mario.service.stageFile(agent, { kind: 'support', name: 'a.txt', text: 'abc', sha256: '0'.repeat(64), request_id: rid() }), 'hash_mismatch');
  await code(() => mario.service.stageFile(agent, { kind: 'support', name: 'a.txt', path: '/etc/hosts', sha256: '0'.repeat(64), request_id: rid() }), 'invalid_input');
});

test('version failures, bad counts, identity mismatches, and plain chat stay away from agents', async () => {
  const alex = personService(fake, ALEX), eve = personService(fake, EVE);
  const wire = (extra = {}) => ({ id: randomUUID(), from: eve.address, to: alex.address, subject: 'From Eve', audience: 'person' as const, replyTo: null, body: 'Hi Alex, a note from Eve.', files: [], transportFiles: {}, ...extra });
  const post = (text: string) => fake.inject(EVE, ALEX, escapeMarkup(text));
  const m1 = wire(); post(encode({ ...m1, threadId: m1.id }).replace(/^A2ANotes\/1/, 'A2ANotes/2'));
  const m2 = wire(); post(encode({ ...m2, threadId: m2.id }).replace(/Body-Bytes: \d+/, 'Body-Bytes: 3'));
  const m3 = wire({ from: `slack:${fake.team}:${MARIO}` }); post(encode({ ...m3, threadId: m3.id }));
  post('Hi Alex, lunch at noon?');
  // an agent file with an unknown version: send it through Eve's Slack account with a matching header
  const id = randomUUID();
  const bytes = Buffer.from(writeAgentFile(agentRequest(id, 'From Eve')).toString('utf8').replace('a2anotes.request/1', 'a2anotes.request/2'));
  const fileId = randomUUID();
  await eve.transport.send({ to: alex.address, messageId: id, files: [{ id: fileId, name: agentFileName(id), bytes }],
    display: { subject: 'From Eve', body: 'Hi Alex, a note from Eve.', audience: 'both', senderName: 'Eve', files: [] },
    wire: map => encode({ ...wire({ audience: 'both', agentFile: { id: fileId, name: agentFileName(id), size: bytes.length, sha256: sha256(bytes) }, transportFiles: { Slack: map } }), id, threadId: id }) });

  await alex.service.scanNow();
  const all = alex.service.list(person, { direction: 'incoming' }).messages.filter(m => m.from === eve.address);
  const codes = all.map(m => m.failure_code).sort();
  assert.deepEqual(codes, ['body_bytes_mismatch', 'identity_mismatch', 'unsupported_version', 'unsupported_version']);
  assert.ok(all.every(m => m.state === 'failed' && m.approver === 'nobody'));
  const v2 = all.find(m => m.failure_code === 'unsupported_version' && !m.message_id.startsWith(id))!;
  const detail = alex.service.get(person, v2.id) as any;
  assert.match(detail.failure.reason, /A2ANotes\/2/);
  assert.match(detail.failure.raw, /^A2ANotes\/2\n/);
  assert.equal(alex.service.list(agent, { direction: 'incoming' }).messages.filter(m => m.from === eve.address).length, 0, 'agents never see failed text');
  await code(() => alex.service.get(agent, v2.id), 'not_found');
});

test('a lost Slack reply queues a check that finds the posted message instead of posting twice', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Once', body: 'Hi Alex, this goes once.', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  fake.fail('chat.postMessage', { mode: 'lost', count: 1 });
  assert.equal((await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() })).state, 'queued');
  mario.service.store.update(d.id, n => { n.nextRetryAt = new Date(0).toISOString(); });
  await mario.service.processQueue();
  const again = mario.service.get(person, d.id);
  assert.equal(again.state, 'sent');
  const copies = [...fake.channels.values()].flatMap(c => c.messages).filter(m => m.text.includes(`ID: ${d.id}`));
  assert.equal(copies.length, 1);

  // a reply that never reached Slack: the retry checks, finds nothing, and sends once
  const e = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Twice', body: 'Hi Alex, this also goes once.', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: e.id, expected_hash: e.hash, decision: 'approve' });
  fake.fail('chat.postMessage', { mode: 'timeout', count: 1 });
  assert.equal((await mario.service.send(person, { id: e.id, expected_hash: e.hash, request_id: rid() })).state, 'queued');
  mario.service.store.update(e.id, n => { n.nextRetryAt = new Date(0).toISOString(); });
  await mario.service.processQueue();
  assert.equal(mario.service.get(person, e.id).state, 'sent');
  assert.equal([...fake.channels.values()].flatMap(c => c.messages).filter(m => m.text.includes(`ID: ${e.id}`)).length, 1);

  // Slack refuses the post: the failure stays visible until the draft is revised
  const f = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Refused', body: 'Hi Alex, Slack refuses this one.', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: f.id, expected_hash: f.hash, decision: 'approve' });
  fake.fail('chat.postMessage', { mode: 'error', count: 1, error: 'msg_too_long' });
  await code(mario.service.send(person, { id: f.id, expected_hash: f.hash, request_id: rid() }), 'send_failed');
  assert.equal(mario.service.get(person, f.id).state, 'permanent_failure');
});

test('after a restart the service reads saved cursors, receives what arrived while it was stopped, and marks interrupted sends', async () => {
  const mario = personService(fake, MARIO);
  let alex = personService(fake, ALEX);
  await alex.service.scanNow();
  const before = alex.service.list(person, { direction: 'incoming' }).messages.length;
  alex.service.stop(); // Alex's service is stopped
  for (const text of ['one', 'two']) {
    const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: `While stopped ${text}`, body: `Hi Alex, message ${text}.`, audience: 'person', request_id: rid() });
    mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
    await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() });
  }
  // an interrupted send in Alex's store: the process stopped between "sending" and Slack's answer
  alex.service.store.change(data => { data.notes.push({ id: 'out-x', messageId: randomUUID(), direction: 'out', state: 'sending', from: alex.address, to: mario.address, subject: 'x', body: 'x', audience: 'person', threadId: randomUUID(), replyTo: null, fileIds: [], hash: 'h', created: new Date().toISOString(), updated: new Date().toISOString() }); });
  alex = personService(fake, ALEX, alex.dir); // restart with the same data folder
  assert.equal(alex.service.store.note('out-x')?.state, 'queued');
  await alex.service.scanNow();
  assert.equal(alex.service.list(person, { direction: 'incoming' }).messages.length, before + 2);
  await alex.service.scanNow();
  assert.equal(alex.service.list(person, { direction: 'incoming' }).messages.length, before + 2, 'the cursor prevents duplicates');
  const status = alex.service.connectionStatus();
  assert.ok(status.last_success_at);
  assert.equal(status.stale, false);
});

test('a rate limit delays the next scan and shows in the status', async () => {
  const alex = personService(fake, ALEX);
  fake.fail('conversations.list', { mode: 'ratelimit', count: 1, retryAfter: 30 });
  await assert.rejects(alex.service.scanNow(), /rate limit/);
  const status = alex.service.connectionStatus();
  assert.ok(status.rate_limited_until);
  assert.match(String(status.last_error), /rate limit/);
  await alex.service.scanNow(); // skipped while limited: no Slack call, no error
  assert.equal(alex.service.connectionStatus().last_error, status.last_error);
});

test('a Slack rate limit queues the approved message, honors Retry-After, and sends once after restart', async () => {
  let mario = personService(fake, MARIO);
  const alex = personService(fake, ALEX);
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Rate limit', body: 'Hi Alex, this is the approved text.', audience: 'person', request_id: rid() });
  await code(mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() }), 'not_approved');
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  fake.fail('chat.postMessage', { mode: 'ratelimit', count: 1, retryAfter: 7 });
  const queued = await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() });
  assert.equal(queued.state, 'queued');
  assert.ok(Date.parse(queued.next_retry_at!) - Date.now() > 6000);
  assert.equal(queued.hash, d.hash);
  assert.equal(queued.to, alex.address);
  assert.equal((await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() })).state, 'queued');
  mario.service.stop();
  mario = personService(fake, MARIO, mario.dir);
  assert.equal(mario.service.get(person, d.id).state, 'queued');
  (mario.transport as any).blockedUntil = 0;
  mario.service.store.update(d.id, n => { n.nextRetryAt = new Date(0).toISOString(); });
  await mario.service.processQueue();
  assert.equal(mario.service.get(person, d.id).state, 'sent');
  await mario.service.processQueue();
  assert.equal([...fake.channels.values()].flatMap(c => c.messages).filter(m => m.text.includes(`ID: ${d.id}`)).length, 1);
});

test('a permanent Slack error stops retries and leaves the draft available to revise', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Permanent error', body: 'Hi Alex, please read this.', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  fake.fail('chat.postMessage', { mode: 'error', count: 1, error: 'msg_too_long' });
  await code(mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() }), 'send_failed');
  const failed = mario.service.get(person, d.id);
  assert.equal(failed.state, 'permanent_failure');
  assert.equal(failed.next_retry_at, null);
  assert.ok(failed.allowed_actions.includes('revise'));
  await mario.service.processQueue();
  assert.equal(mario.service.get(person, d.id).state, 'permanent_failure');
});

test('a rate limit without Retry-After uses bounded backoff', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Backoff', body: 'Hi Alex, please read this.', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  (mario.transport as any).send = async () => { throw new TransportError('Slack rate limit.', true, 0, true); };
  const first = await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() });
  assert.ok(Date.parse(first.next_retry_at!) - Date.now() >= 59_000);
  mario.service.store.update(d.id, n => { n.nextRetryAt = new Date(0).toISOString(); });
  await mario.service.processQueue();
  const second = mario.service.get(person, d.id);
  assert.equal(second.state, 'queued');
  assert.ok(Date.parse(second.next_retry_at!) - Date.now() >= 119_000);
  assert.ok((mario.service as any).retryDelay(new TransportError('rate limit', true, 0, true), 30) <= 60 * 60_000);
});

test('a queued message with an invalid approval never posts', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Approval changed', body: 'Hi Alex, please read this.', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  mario.service.store.update(d.id, n => { n.state = 'queued'; n.nextRetryAt = new Date(0).toISOString(); n.approval!.hash = 'old'; });
  await mario.service.processQueue();
  assert.equal(mario.service.get(person, d.id).state, 'permanent_failure');
  assert.equal([...fake.channels.values()].flatMap(c => c.messages).filter(m => m.text.includes(`ID: ${d.id}`)).length, 0);
});

test('a lost Slack reply is found after restart without a second post', async () => {
  let mario = personService(fake, MARIO);
  const alex = personService(fake, ALEX);
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Restart duplicate', body: 'Hi Alex, please read this.', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  fake.fail('chat.postMessage', { mode: 'lost', count: 1 });
  assert.equal((await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() })).state, 'queued');
  mario.service.stop();
  mario = personService(fake, MARIO, mario.dir);
  mario.service.store.update(d.id, n => { n.nextRetryAt = new Date(0).toISOString(); });
  await mario.service.processQueue();
  assert.equal(mario.service.get(person, d.id).state, 'sent');
  assert.equal([...fake.channels.values()].flatMap(c => c.messages).filter(m => m.text.includes(`ID: ${d.id}`)).length, 1);
});

test('a reply keeps the thread and uses the Slack thread', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Thread start', body: 'Hi Alex, can we talk about the report?', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() });
  await alex.service.scanNow();
  const got = alex.service.list(person, { direction: 'incoming' }).messages.find(m => m.message_id === d.id)!;
  alex.service.approve(person, { id: got.id, expected_hash: alex.service.get(person, got.id).hash, decision: 'approve' });
  const reply = await alex.service.createDraft(person, { to_address: mario.address, subject: 'Re: Thread start', body: 'Hi Mario, yes, Friday works.', audience: 'person', reply_to: d.id, request_id: rid() });
  assert.equal(reply.thread_id, d.id);
  assert.equal(reply.reply_to, d.id);
  alex.service.approve(person, { id: reply.id, expected_hash: reply.hash, decision: 'approve' });
  await alex.service.send(person, { id: reply.id, expected_hash: reply.hash, request_id: rid() });
  const channel = [...fake.channels.values()].find(c => c.replies.some(r => r.text.includes(`ID: ${reply.id}`)))!;
  assert.equal(channel.replies.find(r => r.text.includes(`ID: ${reply.id}`))!.thread_ts, mario.service.get(person, d.id).transport!.ts);
  await mario.service.scanNow();
  const back = mario.service.list(person, { direction: 'incoming' }).messages.find(m => m.message_id === reply.id)!;
  assert.equal(back.thread_id, d.id);
  assert.equal(mario.service.list(person, { direction: 'incoming' }).messages.filter(m => m.from === mario.address).length, 0, 'own posts are not received messages');

});

test('a first scan of a conversation with more than 2000 new messages finishes and finds the message', async () => {
  const eve = personService(fake, EVE), alex = personService(fake, ALEX);
  for (let i = 0; i < 1300; i++) fake.inject(EVE, ALEX, `chat ${i}`);
  const m = { id: randomUUID(), from: eve.address, to: alex.address, subject: 'In the middle', audience: 'person' as const, replyTo: null, body: 'Hi Alex, this is between many chat lines.', files: [], transportFiles: {} };
  fake.inject(EVE, ALEX, escapeMarkup(encode({ ...m, threadId: m.id })));
  for (let i = 0; i < 1300; i++) fake.inject(EVE, ALEX, `more chat ${i}`);
  // a conversation that Slack lists but the token cannot read is skipped, not a scan error
  fake.fail('conversations.history', { mode: 'error', count: 1, error: 'channel_not_found' });
  await alex.service.scanNow();
  assert.equal(alex.service.connectionStatus().last_error, null);
  alex.service.store.change(d => { d.cursors = {}; });
  await alex.service.scanNow();
  const found = alex.service.list(person, { direction: 'incoming' }).messages.filter(x => x.message_id === m.id);
  assert.equal(found.length, 1);
  assert.equal(found[0].state, 'held');
  void eve;
});

test('the Slack text reader finds the data after a subject that contains the marker, and reports broken data', () => {
  const wire = 'A2ANotes/1\nID: x';
  const text = slackText(wire, { subject: 'About A2A Notes data: "quoted"', body: 'b', audience: 'person', senderName: 'Mario <@U1>', files: [] });
  assert.ok(!text.includes('<@U1>'), 'markup in the summary is escaped');
  assert.deepEqual(readSlackText(text.replace(/\n/g, ' ')), { text: wire });
  assert.ok('error' in readSlackText('Subject · from x with A2A Notes A2A Notes data: "A2ANotes/1 cut'));
  assert.deepEqual(readSlackText('hello'), { text: 'hello' });
});

test('a Slack message with broken A2A Notes data stays with the person as malformed', async () => {
  const alex = personService(fake, ALEX);
  fake.inject(EVE, ALEX, 'Hi · from Eve with A2A Notes A2A Notes data: "A2ANotes/1 cut off');
  await alex.service.scanNow();
  const m = alex.service.list(person, { direction: 'incoming' }).messages.find(x => x.from === `slack:${fake.team}:${EVE}` && x.failure_code === 'malformed' && alex.service.get(person, x.id).failure?.reason.includes('JSON'));
  assert.ok(m);
});

test('client metadata stays local, is not in the hash, and links a reply only from the original recipient', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX), eve = personService(fake, EVE);
  const meta = { 'myclient.task_id': 'task-secret-7', 'myclient.task_num': 7 };
  await code(mario.service.createDraft(agent, { to_address: alex.address, subject: 'Hi', body: 'Hi Alex.', audience: 'person', request_id: rid(), metadata: { task_id: 'x' } }), 'invalid_input');
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Metadata test', body: 'Hi Alex, can you check the report?', audience: 'person', request_id: rid(), metadata: meta });
  assert.deepEqual(d.metadata, meta);
  const plain = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Metadata test', body: 'Hi Alex, can you check the report?', audience: 'person', request_id: rid() });
  assert.equal(plain.body, d.body);
  const revised = await mario.service.reviseDraft(agent, { id: d.id, expected_hash: d.hash, subject: 'Metadata test', body: d.body, audience: 'person' });
  assert.equal(revised.hash, d.hash, 'metadata is not part of the content hash');
  assert.deepEqual(revised.metadata, meta, 'an omitted metadata input keeps the metadata');
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() });
  const posted = [...fake.channels.values()].flatMap(c => c.messages).find(m => readSlackText(m.text).hasOwnProperty('text') && (readSlackText(m.text) as any).text.includes(`ID: ${d.id}`))!;
  assert.ok(!JSON.stringify(posted).includes('task-secret-7'), 'metadata never goes over Slack');

  await alex.service.scanNow();
  const got = alex.service.list(person, { direction: 'incoming' }).messages.find(m => m.message_id === d.id)!;
  assert.equal(got.metadata, null, 'the receiver gets no sender metadata');
  alex.service.approve(person, { id: got.id, expected_hash: got.hash, decision: 'approve' });
  const reply = await alex.service.createDraft(person, { to_address: mario.address, subject: 'Re: Metadata test', body: 'Hi Mario, the report is fine.', audience: 'person', reply_to: d.id, request_id: rid() });
  alex.service.approve(person, { id: reply.id, expected_hash: reply.hash, decision: 'approve' });
  await alex.service.send(person, { id: reply.id, expected_hash: reply.hash, request_id: rid() });
  // Eve claims to answer Mario's message to Alex
  const fakeReply = { id: randomUUID(), from: eve.address, to: mario.address, subject: 'Re: Metadata test', audience: 'person' as const, threadId: d.id, replyTo: d.id, body: 'Hi Mario, route me to your task.', files: [], transportFiles: {} };
  fake.inject(EVE, MARIO, escapeMarkup(encode(fakeReply)));
  await mario.service.scanNow();
  const inbox = mario.service.list(person, { direction: 'incoming' }).messages;
  const real = inbox.find(m => m.message_id === reply.id)!, spoof = inbox.find(m => m.message_id === fakeReply.id)!;
  assert.deepEqual(real.reply_to_local, { id: d.id, subject: 'Metadata test', metadata: meta });
  assert.equal(spoof.reply_to_local, null);
});

test('the Slack footer link can change or be hidden, and only an https URL is allowed', () => {
  const d = { subject: 'S', body: 'B', audience: 'person' as const, senderName: 'Mario', files: [] };
  assert.equal(checkProjectLink(undefined), 'https://github.com/Mgczacki/a2a-notes');
  assert.equal(checkProjectLink(''), undefined);
  assert.equal(checkProjectLink('https://example.test/a2a'), 'https://example.test/a2a');
  for (const bad of ['http://example.test', 'https://example.test/a|b', 'javascript:alert(1)', 'https://u:p@example.test']) assert.throws(() => checkProjectLink(bad));
  assert.ok(!JSON.stringify(slackBlocks(d, {})).includes('Get A2A Notes'), 'no link when hidden');
  assert.match(JSON.stringify(slackBlocks(d, { projectLink: 'https://example.test/a2a' })), /<https:\/\/example\.test\/a2a\|Get A2A Notes>/);
});

test('a body check command adds flags, a failed command needs the person, and a slow command finishes in the background', async () => {
  const dir = (n: string) => mkdtempSync(join(tmpdir(), `a2an-cmd-${n}-`));
  const script = (out: string, sleep = 0) => ['/bin/sh', '-c', `cat >/dev/null; sleep ${sleep}; echo '${out}'`];
  const flagFirst = commandBodyChecker(script('{"flags":[{"text":"I will check it later.","reason":"A note about the sender"}]}'));
  const mario = personService(fake, MARIO, dir('flag'), { bodyChecker: flagFirst });
  const alex = personService(fake, ALEX);
  mario.service.setTrusted(person, { address: alex.address, trusted: true });
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Report', body: 'Hi Alex, the report is ready. I will check it later.', audience: 'person', request_id: rid() });
  assert.equal(d.body_check!.state, 'done');
  assert.deepEqual(d.body_check!.flags.map(f => f.code).sort(), ['sender_note'], 'a command flag on the same sentence as a rule flag is not repeated');
  const d2 = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Report', body: 'Hi Alex, the report is ready. Please read it.', audience: 'person', request_id: rid() });
  assert.equal(d2.body_flags, 0, 'the command flags only its exact sentences');

  const broken = personService(fake, MARIO, dir('broken'), { bodyChecker: commandBodyChecker(script('not json')) });
  broken.service.setTrusted(person, { address: alex.address, trusted: true });
  const b = await broken.service.createDraft(agent, { to_address: alex.address, subject: 'Report', body: 'Hi Alex, the report is ready.', audience: 'person', request_id: rid() });
  assert.equal(b.body_check!.state, 'failed');
  assert.equal(b.approver, 'person', 'a failed check gives the draft to the person');

  const slow = personService(fake, MARIO, dir('slow'), { bodyChecker: commandBodyChecker(script('{"flags":[]}', 1)), checkWaitMs: 100 });
  slow.service.setTrusted(person, { address: alex.address, trusted: true });
  const s = await slow.service.createDraft(agent, { to_address: alex.address, subject: 'Report', body: 'Hi Alex, the report is ready.', audience: 'person', request_id: rid() });
  assert.equal(s.body_check!.state, 'checking');
  assert.equal(s.approver, 'nobody', 'nobody approves before the checks finish');
  await code(() => slow.service.approve(reviewer, { id: s.id, expected_hash: s.hash, decision: 'approve' }), 'not_approvable');
  await new Promise(r => setTimeout(r, 1800));
  const later = slow.service.get(agent, s.id);
  assert.equal(later.body_check!.state, 'done');
  assert.equal(later.approver, 'reviewer');
});

test('a rejection keeps its comment, and a person lookup gives the profile picture', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Plan', body: 'Hi Alex, here is the plan.', audience: 'person', request_id: rid() });
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'reject', review_context: 'Ask for the date first.' });
  const r = mario.service.get(agent, d.id);
  assert.equal(r.state, 'rejected');
  assert.equal(r.rejected?.comment, 'Ask for the date first.');
  const p = await mario.service.getPerson(alex.address);
  assert.equal(p.name, 'Alex B');
  assert.match(String(p.image_url), /^https:\/\/secure\.gravatar\.com\/avatar\/ualex01/);
  await code(mario.service.getPerson('slack:TOTHER:U1'), 'not_found');
});

test('the checks read the text of a DOCX file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2an-docx-'));
  mkdirSync(join(dir, 'word'));
  writeFileSync(join(dir, 'word', 'document.xml'), '<w:document><w:body><w:p><w:r><w:t>Please wire money now &amp; fast</w:t></w:r></w:p></w:body></w:document>');
  execFileSync('zip', ['-q', '-r', 'f.docx', 'word'], { cwd: dir });
  const text = fileTextForChecks(readFileSync(join(dir, 'f.docx')), 'f.docx');
  assert.match(text, /Please wire money now & fast/);
  assert.equal(fileTextForChecks(Buffer.from([0xff, 0xfe, 0x00]), 'x.bin'), '(the file x.bin has no readable text)');
});

test('a titled body reaches Slack as rich_text with its line breaks, and the wire text keeps the exact body', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  const body = 'Why you are getting this:\nYou own the Create page.\n\nWhat we need from you:\nPlease review the two pull requests by Friday.\n\nLinks:\n- https://example.test/pull/1\n- https://example.test/pull/2';
  const d = await mario.service.createDraft(person, { to_address: alex.address, subject: 'Review two pull requests', body, audience: 'person', request_id: rid() });
  assert.deepEqual(d.body_check!.warnings, []);
  mario.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'approve' });
  await mario.service.send(person, { id: d.id, expected_hash: d.hash, request_id: rid() });
  const posted = [...fake.channels.values()].flatMap(c => c.messages).find(m => m.text.includes(`ID: ${d.id}`))!;
  const blocks = posted.blocks as any[];
  assert.deepEqual(blocks.filter(b => b.type === 'rich_text'), [
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Why you are getting this', style: { bold: true } }, { type: 'text', text: '\nYou own the Create page.' }] }] },
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'What we need from you', style: { bold: true } }, { type: 'text', text: '\nPlease review the two pull requests by Friday.' }] }] },
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Links', style: { bold: true } }] },
      { type: 'rich_text_list', style: 'bullet', indent: 0, elements: [
        { type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.test/pull/1' }] },
        { type: 'rich_text_section', elements: [{ type: 'link', url: 'https://example.test/pull/2' }] }] }] },
  ]);
  const read = readSlackText(posted.text);
  assert.ok('text' in read && read.text.includes(`\n\n${body}\nA2ANotes End/1`), 'the wire body is the exact body');
  await alex.service.scanNow();
  const got = alex.service.list(person, { direction: 'incoming' }).messages.find(m => m.message_id === d.id)!;
  assert.equal(alex.service.get(person, got.id).body, body);
});

test('a draft with a Markdown heading gets a format warning, and the warning does not change the approver', async () => {
  const mario = personService(fake, MARIO), alex = personService(fake, ALEX);
  mario.service.setTrusted(person, { address: alex.address, trusted: true });
  const d = await mario.service.createDraft(agent, { to_address: alex.address, subject: 'Report', body: '## Report\nHi Alex, the report is ready. Please read it.', audience: 'person', request_id: rid() });
  assert.equal(d.body_flags, 0);
  assert.equal(d.format_warnings, 1);
  assert.equal(d.body_check!.warnings![0].code, 'heading');
  assert.equal(d.approver, 'reviewer');
  assert.equal(mario.service.reviewMessage(agent, d.id).format_warnings[0].code, 'heading');
});

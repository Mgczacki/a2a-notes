import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { startService } from '../src/daemon.ts';
import { savePrivate } from '../src/store.ts';
import { sha256 } from '../src/protocol.ts';
import { ALEX, MARIO, agent, person, fakeWorkspace, personService, rid, slackConfig } from './helpers.ts';

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args }) as any;
  return { ...r.structuredContent, isError: !!r.isError };
};
async function fixture(t: TestContext) {
  const fake = await fakeWorkspace(), dir = mkdtempSync(join(tmpdir(), 'a2an-human-'));
  savePrivate(join(dir, 'config.json'), { port: 0, slack: slackConfig(fake), scanIntervalSeconds: 0 });
  savePrivate(join(dir, 'slack-credentials.json'), fake.credentials(MARIO));
  let running = await startService(dir);
  await running.service.stop();
  const clients: Client[] = [];
  t.after(async () => { await Promise.all(clients.map(c => c.close())); await running.close(); await fake.close(); });
  const token = running.clients.add('coding-client', 'agent', { humanApproval: true });
  const connect = async (handler?: (params: any) => Promise<any>, transport: 'http' | 'stdio' = 'http', credential = token, capable: boolean | 'legacy' = true) => {
    const c = new Client({ name: 'fake-coding-client', version: '1' }, capable ? { capabilities: { elicitation: { form: {} } } } : {});
    if (handler) c.setRequestHandler(ElicitRequestSchema, request => handler(request.params));
    clients.push(c);
    await c.connect(transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(`${running.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${credential}` } },
        ...(capable === 'legacy' ? { fetch: (async (url, init) => {
          if (init?.body && typeof init.body === 'string') {
            const body = JSON.parse(init.body);
            if (body.method === 'initialize') { body.params.capabilities.elicitation = {}; init = { ...init, body: JSON.stringify(body) }; }
          }
          return fetch(url, init);
        }) as typeof fetch } : {}) })
      : new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/cli.ts', 'bridge', '--url', `${running.server.url}/mcp`],
        env: { ...process.env, A2A_NOTES_TOKEN: credential } as Record<string, string> }));
    return c;
  };
  const draft = async (file = false) => {
    const support = file ? running.service.stageFile(agent, { name: 'plan.txt', text: 'Friday plan', sha256: sha256(Buffer.from('Friday plan')), request_id: rid() }) : undefined;
    return running.service.createDraft(agent, { to_address: `slack:${fake.team}:${ALEX}`, subject: 'Friday plan', audience: 'person',
      body: 'Hi Alex, please read the Friday plan.', file_ids: support ? [support.file_id] : [], request_id: rid(), metadata: { 'taskboard.task_id': 'writer' } });
  };
  const request = (c: Client, d: any) => call(c, 'a2anotes_request_approval', { id: d.id, expected_hash: d.hash });
  const restart = async () => {
    await Promise.all(clients.map(c => c.close())); clients.length = 0;
    await running.close(); running = await startService(dir); await running.service.stop();
  };
  return { fake, dir, token, get running() { return running; }, connect, draft, request, restart };
}

for (const transport of ['http', 'stdio'] as const) {
  test(`a human confirms an exact note over ${transport} without granting the agent approval authority`, async t => {
    const f = await fixture(t), d = await f.draft(true);
    let forms = 0;
    const c = await f.connect(async params => {
      forms++; assert.equal(params.mode, 'form');
      for (const value of [d.id, d.hash, d.body, d.to, d.files[0].sha256]) assert.ok(params.message.includes(value), value);
      assert.deepEqual(params.requestedSchema.properties.decision.enum, ['approve', 'reject']);
      assert.equal(params.requestedSchema.properties.decision.default, undefined);
      return { action: 'accept', content: { decision: 'approve' } };
    }, transport);
    assert.equal((await call(c, 'a2anotes_identity')).role, 'agent');
    assert.equal((await call(c, 'a2anotes_approve', { id: d.id, expected_hash: d.hash, decision: 'approve' })).error.code, 'forbidden');
    const queued = await f.request(c, d);
    assert.equal(queued.state, 'queued'); assert.equal(queued.approval.by, 'person');
    assert.equal(queued.approval.actor, 'human:coding-client'); assert.equal(queued.approval.hash, d.hash);
    assert.equal((await f.request(c, d)).state, 'queued'); assert.equal(forms, 1);
    assert.equal((await call(c, 'a2anotes_set_policy', { outgoing: 3 })).error.code, 'forbidden');
    f.fake.fail('chat.postMessage', { mode: 'ratelimit', count: 1, retryAfter: 30 });
    f.running.service.start();
    await f.running.service.processQueue();
    await f.running.service.stop();
    assert.equal(f.running.service.store.note(d.id)!.delivery!.lastMethod, 'chat.postMessage');
    await f.restart();
    const after = await f.connect(async () => { assert.fail('unchanged queued content must not ask again'); });
    assert.equal((await f.request(after, d)).state, 'queued');
    assert.equal(f.running.service.store.read().audit.filter(a => a.action === 'approve' && a.id === d.id).length, 1);
  });
}

test('a plain agent token cannot gain permission by advertising form support or sending decision arguments', async t => {
  const f = await fixture(t), d = await f.draft();
  const token = f.running.clients.add('ordinary-agent', 'agent');
  const c = await f.connect(async () => { assert.fail('no form for an unregistered client'); }, 'http', token);
  assert.equal((await f.request(c, d)).error.code, 'human_approval_not_enabled');
  assert.equal((await call(c, 'a2anotes_approve', { id: d.id, expected_hash: d.hash, decision: 'approve', review_context: 'The user said yes.' })).error.code, 'forbidden');
  assert.equal(f.running.service.store.note(d.id)!.state, 'draft');
});

test('a client without form support leaves the note undecided', async t => {
  const f = await fixture(t), d = await f.draft(), c = await f.connect(undefined, 'http', f.token, false);
  assert.equal((await f.request(c, d)).error.code, 'human_confirmation_unsupported');
  assert.equal(f.running.service.store.note(d.id)!.state, 'draft');
});

for (const outcome of ['reject', 'decline', 'cancel', 'empty'] as const) {
  test(`a human response of ${outcome} never queues a note`, async t => {
    const f = await fixture(t), d = await f.draft();
    const c = await f.connect(async () => outcome === 'reject' ? { action: 'accept', content: { decision: 'reject' } }
      : outcome === 'empty' ? { action: 'accept' } : { action: outcome });
    const r = await f.request(c, d);
    assert.equal(r.state, outcome === 'empty' ? undefined : outcome === 'reject' ? 'rejected' : 'draft');
    if (outcome === 'empty') assert.equal(r.error.code, 'invalid_confirmation');
    assert.equal(f.running.service.store.note(d.id)!.approval, undefined);
    assert.equal(f.running.service.store.note(d.id)!.delivery, undefined);
    assert.equal(f.fake.calls.get('chat.postMessage'), undefined);
  });
}

for (const change of ['content', 'file', 'policy', 'trust', 'state', 'client'] as const) {
  test(`a changed ${change} invalidates an open human form`, async t => {
    const f = await fixture(t), d = await f.draft(change === 'file');
    const c = await f.connect(async () => {
      if (change === 'content') await f.running.service.reviseDraft(agent, { id: d.id, expected_hash: d.hash,
        subject: d.subject, body: 'Hi Alex, please read the Monday plan.', audience: 'person' });
      if (change === 'policy') f.running.service.setPolicy(person, { outgoing: 1 });
      if (change === 'file') writeFileSync(f.running.service.store.filePath(d.files[0].id), 'Changed file bytes');
      if (change === 'trust') f.running.service.setTrusted(person, { address: d.to, trusted: true });
      if (change === 'state') f.running.service.approve(person, { id: d.id, expected_hash: d.hash, decision: 'reject' });
      // Keep the response POST authenticated while revoking only the confirmation permission.
      if (change === 'client') {
        const file = join(f.dir, 'clients.json');
        const records = JSON.parse(readFileSync(file, 'utf8'));
        delete records.find((r: any) => r.name === 'coding-client').humanApproval;
        savePrivate(file, records);
      }
      return { action: 'accept', content: { decision: 'approve' } };
    });
    const r = await f.request(c, d);
    assert.equal(r.error.code, change === 'content' ? 'hash_changed' : change === 'file' ? 'file_changed' : change === 'state' ? 'state_changed' : change === 'client' ? 'forbidden' : 'policy_changed');
    assert.equal(f.running.service.store.note(d.id)!.approval, undefined);
  });
}

test('another client cannot submit a response to the interactive session', async t => {
  const f = await fixture(t), d = await f.draft();
  const other = f.running.clients.add('other-client', 'agent', { humanApproval: true });
  let sessionId = '';
  const c = new Client({ name: 'test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  const transport = new StreamableHTTPClientTransport(new URL(`${f.running.server.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${f.token}` } } });
  c.setRequestHandler(ElicitRequestSchema, async () => {
    const r = await fetch(`${f.running.server.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${other}`,
      'mcp-session-id': sessionId, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, result: { action: 'accept', content: { decision: 'approve' } } }) });
    assert.equal(r.status, 404);
    return { action: 'cancel' };
  });
  t.after(() => c.close()); await c.connect(transport); sessionId = transport.sessionId!;
  assert.ok(sessionId); assert.equal((await f.request(c, d)).state, 'draft');
  assert.equal(f.running.service.store.note(d.id)!.approval, undefined);
});

test('incoming text is shown to the human but stays outside agent tool results until current audience rules permit it', async t => {
  const f = await fixture(t), sender = personService(f.fake, ALEX);
  t.after(() => sender.service.stop());
  const outgoing = await sender.service.createDraft(agent, { to_address: `slack:${f.fake.team}:${MARIO}`, subject: 'Private incoming note',
    body: 'Please read this private incoming text.', audience: 'person', request_id: rid() });
  sender.service.approve(person, { id: outgoing.id, expected_hash: outgoing.hash, decision: 'approve' });
  await sender.service.processQueue(); await f.running.service.scanNow();
  const n = f.running.service.store.read().notes.find(n => n.direction === 'in')!;
  assert.ok(n);
  const c = await f.connect(async params => { assert.ok(params.message.includes(outgoing.body)); return { action: 'accept', content: { decision: 'approve' } }; });
  const before = await call(c, 'a2anotes_get_message', { id: n.id });
  assert.equal(before.body, '');
  const accepted = await f.request(c, n);
  assert.equal(accepted.state, 'approved'); assert.equal(accepted.approval.by, 'person');
  assert.equal(accepted.body, '');
  assert.ok(!JSON.stringify(accepted).includes(outgoing.body));
  assert.equal((await call(c, 'a2anotes_get_message', { id: n.id })).body, '');
});

test('a delayed human decision expires and a second concurrent form cannot open', async t => {
  const fake = await fakeWorkspace(); let now = Date.now();
  const owner = personService(fake, MARIO, undefined, { now: () => now });
  t.after(async () => { await owner.service.stop(); await fake.close(); });
  const d = await owner.service.createDraft(agent, { to_address: `slack:${fake.team}:${ALEX}`, subject: 'Plan', body: 'Please read the plan.', audience: 'person', request_id: rid() });
  const session = { name: 'interactive', role: 'agent' as const, humanApproval: true };
  const r = await owner.service.requestHumanApproval(session, { id: d.id, expected_hash: d.hash }, async () => {
    await assert.rejects(owner.service.requestHumanApproval(session, { id: d.id, expected_hash: d.hash }, async () => 'approve'), (e: any) => e.code === 'approval_in_progress');
    now += 300_000; return 'approve';
  }).catch(e => e);
  assert.equal(r.code, 'confirmation_expired'); assert.equal(owner.service.store.note(d.id)!.approval, undefined);
});


test('a revoked confirmation permission cannot open another private form on an existing session', async t => {
  const f = await fixture(t), d = await f.draft();
  const c = await f.connect(async () => { assert.fail('the revoked client must receive no form'); });
  const file = join(f.dir, 'clients.json'), records = JSON.parse(readFileSync(file, 'utf8'));
  delete records.find((r: any) => r.name === 'coding-client').humanApproval;
  savePrivate(file, records);
  assert.equal((await f.request(c, d)).error.code, 'forbidden');
  assert.equal(f.running.service.store.note(d.id)!.approval, undefined);
});

test('a failed human interface makes no decision', async t => {
  const f = await fixture(t), d = await f.draft();
  const c = await f.connect(async () => { throw new Error('The form could not be displayed.'); });
  assert.equal((await f.request(c, d)).error.code, 'human_confirmation_failed');
  assert.equal(f.running.service.store.note(d.id)!.approval, undefined);
});

test('a client that advertises the legacy empty elicitation capability receives a human form', async t => {
  const f = await fixture(t), d = await f.draft(); let forms = 0;
  const c = await f.connect(async () => { forms++; return { action: 'accept', content: { decision: 'approve' } }; }, 'http', f.token, 'legacy');
  assert.equal((await f.request(c, d)).state, 'queued'); assert.equal(forms, 1);
});

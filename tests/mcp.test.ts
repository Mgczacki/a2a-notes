import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startService } from '../src/daemon.ts';
import { savePrivate } from '../src/store.ts';
import { sha256, writeAgentFile } from '../src/protocol.ts';
import { ALEX, MARIO, agentRequest, fakeWorkspace, slackConfig } from './helpers.ts';

const fake = await fakeWorkspace();
async function service(user: string) {
  const dir = mkdtempSync(join(tmpdir(), `a2an-mcp-${user}-`));
  savePrivate(join(dir, 'config.json'), { port: 0, slack: slackConfig(fake), scanIntervalSeconds: 0 });
  savePrivate(join(dir, 'slack-credentials.json'), fake.credentials(user));
  const running = await startService(dir);
  return { dir, running, url: `${running.server.url}/mcp`, address: `slack:${fake.team}:${user}`,
    token: (name: string, role: 'person' | 'reviewer' | 'agent') => running.clients.add(name, role) };
}
const mario = await service(MARIO), alex = await service(ALEX);
after(async () => { await mario.running.close(); await alex.running.close(); await fake.close(); });

async function connect(url: string, token: string) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const resource = async (client: Client, uri: string) => JSON.parse(((await client.readResource({ uri })).contents[0] as { text: string }).text);
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args }) as any;
  return { ...result.structuredContent, isError: !!result.isError, text: result.content?.[0]?.text };
};

test('the endpoint refuses requests without a client token and from another host', async () => {
  const res = await fetch(mario.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  const bad = await fetch(mario.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer a2an_wrongwrongwrongwrongwrong' }, body: '{}' });
  assert.equal(bad.status, 401);
  const origin = await fetch(mario.url, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
  assert.equal(origin.status, 403);
  const page = await fetch(`${mario.running.server.url}/api/state`);
  assert.equal(page.status, 401);
});

test('tools and resources follow the session role, and two clients share one store', async () => {
  const agentA = await connect(mario.url, mario.token('agent-a', 'agent'));
  const agentB = await connect(mario.url, mario.token('agent-b', 'agent'));
  const controller = await connect(mario.url, mario.token('controller', 'reviewer'));
  const human = await connect(mario.url, mario.token('dashboard', 'person'));
  const tools = (await agentA.listTools()).tools.map(t => t.name);
  for (const name of ['a2anotes_identity', 'a2anotes_find_people', 'a2anotes_list_messages', 'a2anotes_get_message', 'a2anotes_create_draft', 'a2anotes_revise_draft', 'a2anotes_stage_file',
    'a2anotes_review_message', 'a2anotes_approve', 'a2anotes_send', 'a2anotes_mark_seen', 'a2anotes_set_trusted_sender', 'a2anotes_connection_status']) assert.ok(tools.includes(name), name);
  assert.ok(!tools.includes('a2anotes_review_page_link'), 'only a person session gets a page link tool');
  const me = await call(agentA, 'a2anotes_identity');
  assert.equal(me.address, mario.address);
  assert.equal(me.role, 'agent');
  assert.ok(!JSON.stringify(me).includes('xoxp'), 'no token in results');
  const people = await call(agentA, 'a2anotes_find_people', { query: 'alex' });
  assert.equal(people.people[0].address, alex.address);

  const id = randomUUID(), subject = 'Stage settings';
  const bytes = writeAgentFile(agentRequest(id, subject));
  const file = await call(agentA, 'a2anotes_stage_file', { kind: 'agent', text: bytes.toString('utf8'), sha256: sha256(bytes), request_id: `r-${randomUUID()}` });
  assert.equal(file.message_id, id);
  const draft = await call(agentA, 'a2anotes_create_draft', { to_address: alex.address, subject, audience: 'both', agent_file_id: file.file_id, request_id: `r-${randomUUID()}`,
    body: 'Hi Alex, please have your agent confirm the setting names before the hosting change.' });
  assert.equal(draft.isError, false, draft.text);
  // the second agent sees the draft that the first agent wrote: one store for all clients
  const listed = await call(agentB, 'a2anotes_list_messages', { direction: 'outgoing' });
  assert.ok(listed.messages.some((m: any) => m.id === id));
  const denied = await call(agentA, 'a2anotes_approve', { id, expected_hash: draft.hash, decision: 'approve' });
  assert.equal(denied.isError, true);
  assert.equal(denied.error.code, 'forbidden');
  assert.ok(denied.error.next);
  const trust = await call(agentA, 'a2anotes_set_trusted_sender', { address: alex.address, trusted: true });
  assert.equal(trust.error.code, 'forbidden');
  assert.equal((await call(human, 'a2anotes_set_trusted_sender', { address: alex.address, name: 'Alex', trusted: true })).trusted, true);
  const review = await call(controller, 'a2anotes_review_message', { id });
  assert.equal(review.approver, 'reviewer');
  assert.equal((await call(controller, 'a2anotes_approve', { id, expected_hash: draft.hash, decision: 'approve' })).state, 'approved');
  assert.equal((await call(agentA, 'a2anotes_send', { id, expected_hash: draft.hash, request_id: `r-${randomUUID()}` })).error.code, 'forbidden');
  assert.equal((await call(controller, 'a2anotes_send', { id, expected_hash: draft.hash, request_id: `r-${randomUUID()}` })).state, 'sent');

  const policy = await resource(agentA, 'a2anotes://policy');
  assert.equal(policy.incoming, 2);
  const format = await resource(agentA, 'a2anotes://format/1');
  assert.equal(format.wire_version, 'A2ANotes/1');
  const health = await resource(agentA, 'a2anotes://health');
  assert.equal(health.signed_in, true);
  const message = await resource(agentA, `a2anotes://messages/${id}`);
  assert.equal(message.state, 'sent');

  // Alex's side: an agent that does not use Taskboard reads the message after Alex approves it on the review page
  const alexAgent = await connect(alex.url, alex.token('cli-agent', 'agent'));
  await call(alexAgent, 'a2anotes_sync');
  const inbox = await call(alexAgent, 'a2anotes_list_messages', { direction: 'incoming' });
  const held = inbox.messages.find((m: any) => m.message_id === id);
  assert.equal(held.subject, '(held for review)');
  const alexHuman = await connect(alex.url, alex.token('alex-person', 'person'));
  const link = await call(alexHuman, 'a2anotes_review_page_link');
  const login = await fetch(link.url, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(link.url, { redirect: 'manual' })).status, 403, 'a link works once');
  const state = await (await fetch(`${alex.running.server.url}/api/state`, { headers: { cookie } })).json();
  const onPage = state.messages.find((m: any) => m.message_id === id);
  assert.equal(onPage.agent_file.name, `a2anotes-request-${id}.json`);
  const noHeader = await fetch(`${alex.running.server.url}/api/messages/${onPage.id}/decide`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ hash: onPage.hash, decision: 'approve' }) });
  assert.equal(noHeader.status, 403);
  const decided = await fetch(`${alex.running.server.url}/api/messages/${onPage.id}/decide`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-a2a-page': '1' }, body: JSON.stringify({ hash: onPage.hash, decision: 'approve' }) });
  assert.equal(decided.status, 200);
  const released = await call(alexAgent, 'a2anotes_get_message', { id: held.id });
  assert.equal(released.agent_file.status, 'released');
  assert.equal(released.agent_file.data.message_id, id);
  for (const c of [agentA, agentB, controller, human, alexAgent, alexHuman]) await c.close();
});

test('the stdio bridge connects a command-line agent to the running service', async () => {
  const token = mario.token('bridge-agent', 'agent');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'cli.ts'), 'bridge', '--dir', mario.dir],
    env: { ...process.env as Record<string, string>, A2A_NOTES_TOKEN: token }, stderr: 'pipe' });
  const client = new Client({ name: 'bridge-test', version: '1' });
  await client.connect(transport);
  const me = await call(client, 'a2anotes_identity');
  assert.equal(me.address, mario.address);
  assert.equal(me.session, 'bridge-agent');
  const status = await call(client, 'a2anotes_connection_status');
  assert.equal(status.signed_in, true);
  await client.close();
});

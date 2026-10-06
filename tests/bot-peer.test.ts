import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackTransport } from '../src/slack.ts';
import { savePrivate, Store } from '../src/store.ts';
import { NotesService } from '../src/service.ts';
import { fakeWorkspace, slackConfig, MARIO, agent, reviewer, rid } from './helpers.ts';

const address = 'slack:TEXAMPLE:UBOT01';
async function setup(allow = false) {
  const fake = await fakeWorkspace();
  const file = join(mkdtempSync(join(tmpdir(), 'a2an-bot-peer-')), 'credentials.json');
  savePrivate(file, fake.credentials(MARIO));
  const transport = new SlackTransport(file, slackConfig(fake, allow ? { botPeers: [address] } : {}));
  return { fake, transport };
}
test('a bot recipient is disabled by default and explicitly enabled by address', async () => {
  const disabled = await setup(), enabled = await setup(true);
  try {
    await assert.rejects(disabled.transport.checkRecipient(address), /active person/);
    assert.equal((await enabled.transport.checkRecipient(address)).active, true);
  } finally { await disabled.fake.close(); await enabled.fake.close(); }
});
test('an explicitly enabled modern bot message is scanned with its Slack author', async () => {
  const { fake, transport } = await setup(true);
  try {
    const ts = fake.inject('UBOT01', MARIO, 'hello');
    const channel = [...fake.channels.values()][0];
    Object.assign(channel.messages.find(m => m.ts === ts)!, { subtype: 'bot_message', bot_id: 'BBOT01' });
    const received: any[] = [];
    await transport.scan({}, async m => { received.push(m); }, () => {});
    assert.equal(received.length, 1);
    assert.equal(received[0].sender, address);
  } finally { await fake.close(); }
});
test('bot subtypes are excluded without explicit enablement', async () => {
  const { fake, transport } = await setup();
  try {
    const ts = fake.inject('UBOT01', MARIO, 'hello');
    Object.assign([...fake.channels.values()][0].messages.find(m => m.ts === ts)!, { subtype: 'bot_message', bot_id: 'BBOT01' });
    const received: any[] = [];
    await transport.scan({}, async m => { received.push(m); }, () => {});
    assert.equal(received.length, 0);
  } finally { await fake.close(); }
});
test('enabled bot configuration rejects addresses outside this workspace', async () => {
  const { fake } = await setup();
  try {
    assert.throws(() => new SlackTransport('/unused', slackConfig(fake, { botPeers: ['slack:TOTHER:UBOT01'] })), /this workspace/);
    assert.throws(() => new SlackTransport('/unused', slackConfig(fake, { botPeers: ['not-an-address'] })), /this workspace/);
  } finally { await fake.close(); }
});
test('an enabled bot cannot replace the DM peer or omit its authenticated user', async () => {
  for (const changed of [{ user: 'UEVE01' }, { user: undefined }]) {
    const { fake, transport } = await setup(true);
    try {
      const ts = fake.inject('UBOT01', MARIO, 'hello');
      Object.assign([...fake.channels.values()][0].messages.find(m => m.ts === ts)!, { subtype: 'bot_message', bot_id: 'BBOT01', ...changed });
      const received: any[] = [];
      await transport.scan({}, async m => { received.push(m); }, () => {});
      assert.equal(received.length, 0);
    } finally { await fake.close(); }
  }
});

test('enabling transport does not trust the bot or let an agent approve', async () => {
  const { fake, transport } = await setup(true);
  const service = new NotesService({ store: new Store(mkdtempSync(join(tmpdir(), 'a2an-bot-policy-'))), transport, scanIntervalMs: 0 });
  try {
    const draft = await service.createDraft(agent, { to_address: address, subject: 'Report ready', body: 'Hello Guy, please read the report.', audience: 'person', request_id: rid() });
    assert.equal(draft.approver, 'person');
    assert.throws(() => service.approve(agent, { id: draft.id, expected_hash: draft.hash, decision: 'approve' }), (e: any) => e.code === 'forbidden');
    assert.throws(() => service.approve(reviewer, { id: draft.id, expected_hash: draft.hash, decision: 'approve' }), (e: any) => e.code === 'needs_person');
  } finally { service.stop(); await fake.close(); }
});

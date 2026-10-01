import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decode, encode, escapeMarkup, parseAgentFile, readAgentFile, sha256, unescapeMarkup, ProtocolError, type WireMessage,
} from '../src/protocol.ts';
import { formatDescription } from '../src/mcp.ts';
import { fixture } from './helpers.ts';

const ID = '8a5f74c0-5c03-4d97-b4e6-3e72842cfa11';
const base = (extra: Partial<WireMessage> = {}): WireMessage => ({ id: ID, from: 'slack:TEXAMPLE:UMARIO01', to: 'slack:TEXAMPLE:UALEX01', subject: 'Status', audience: 'person',
  threadId: ID, replyTo: null, body: 'Hi Alex, the report is ready.', files: [], transportFiles: {}, ...extra });

test('the Stage example decodes with its body count, agent file, and Slack file field', () => {
  const text = fixture('stage-message.txt').toString('utf8').replace(/\n$/, '');
  const result = decode(text);
  assert.ok(result.ok, JSON.stringify(result));
  const m = result.message;
  assert.equal(Buffer.byteLength(m.body), 172);
  assert.equal(m.audience, 'both');
  assert.equal(m.agentFile?.size, 1130);
  assert.equal(m.transportFiles.Slack[m.agentFile!.id], 'FSTAGE01');
  assert.equal(m.footer, 'Sent by Mario G with A2A Notes.');
  assert.equal(encode(m), text, 'encode gives the same bytes as the design example');
  const file = fixture('stage-request.json');
  assert.equal(sha256(file), m.agentFile!.sha256);
  const request = readAgentFile(file, m.agentFile!, m);
  assert.equal(request.agent_request.details.length, 2);
});

test('encode and decode keep UTF-8 bodies, newlines, and markup characters', () => {
  const m = base({ subject: 'Café <@U123> & more', body: 'Line one with <!channel> and ünïcode.\nLine two ends here.\n\nA2ANotes End/1 inside the body is counted.' });
  const text = escapeMarkup(encode(m));
  assert.ok(!text.includes('<!channel>'), 'no active Slack markup is sent');
  const back = decode(unescapeMarkup(text));
  assert.ok(back.ok);
  assert.equal(back.message.body, m.body);
  assert.equal(back.message.subject, m.subject);
});

test('an unknown major version is held with unsupported_version and is never parsed as version 1', () => {
  const v2 = encode(base()).replace(/^A2ANotes\/1/, 'A2ANotes/2');
  const result = decode(v2);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, 'unsupported_version');
  assert.equal(!result.ok && result.version, 'A2ANotes/2');
  assert.equal((decode('A2ANotes/x\nID: 1') as any).code, 'malformed');
});

test('bad byte counts, a missing end marker, extra fields, and plain chat give distinct codes', () => {
  const good = encode(base());
  assert.equal((decode(good.replace('Body-Bytes: 29', 'Body-Bytes: 20')) as any).code, 'body_bytes_mismatch');
  assert.equal((decode(good.replace('\nA2ANotes End/1', '')) as any).code, 'missing_end_marker');
  assert.equal((decode(good.replace('Body-Bytes: 29', 'Body-Bytes: 29\nPriority: high')) as any).code, 'malformed');
  assert.equal((decode(good.replace('Subject: Status\nAudience: person', 'Audience: person\nSubject: Status')) as any).code, 'malformed', 'header order is fixed');
  assert.equal((decode('hey, are you around?') as any).code, 'not_a2anotes');
  assert.equal((decode(`${good}\nextra line`) as any).code, 'malformed');
  assert.equal((decode('A2ANotes/1\n' + 'x'.repeat(40_001)) as any).code, 'too_large');
});

test('audience rules: person has no agent file, agent and both need one, and the body cannot be empty', () => {
  const file = { id: '41aa8d61-72ee-43a9-860e-f51ec749de02', name: `a2anotes-request-${ID}.json`, size: 10, sha256: 'a'.repeat(64) };
  assert.throws(() => encode(base({ agentFile: file })), /person message cannot have an agent file/);
  assert.throws(() => encode(base({ audience: 'agent' })), /needs an agent file/);
  assert.throws(() => encode(base({ audience: 'both', agentFile: { ...file, name: 'other.json' } })), /agent file name/);
  assert.throws(() => encode(base({ body: '  ' })), /body is empty/);
  assert.throws(() => encode(base({ threadId: '41aa8d61-72ee-43a9-860e-f51ec749de02' })), /first message uses its own ID/);
  assert.ok(encode(base({ audience: 'both', agentFile: file })));
});

test('agent files: version 1 parses, an unknown version and a mismatch are refused, and the hash is checked first', () => {
  const file = fixture('stage-request.json');
  const expected = { id: ID, audience: 'both' as const, subject: 'Please confirm the Stage hosting settings' };
  assert.equal(parseAgentFile(file, expected).version, 'a2anotes.request/1');
  const v2 = Buffer.from(file.toString('utf8').replace('a2anotes.request/1', 'a2anotes.request/2'));
  assert.throws(() => parseAgentFile(v2, expected), (e: ProtocolError) => e.code === 'unsupported_version');
  const other = Buffer.from(file.toString('utf8').replace('"version"', '"extra": 1,\n  "version"'));
  assert.throws(() => parseAgentFile(other, expected), /not a version 1 field/);
  assert.throws(() => parseAgentFile(file, { ...expected, subject: 'Other' }), /subject does not match/);
  assert.throws(() => readAgentFile(Buffer.from(file.toString('utf8').replace('Alex', 'Eve.')), { id: 'x', name: 'n', size: 1130, sha256: sha256(file) }, expected), /do not match the size and hash/);
  assert.throws(() => parseAgentFile(Buffer.from(file.toString('utf8').trimEnd())), /one trailing LF/);
});

test('the format resource sample is a valid A2ANotes/1 message', () => {
  const result = decode(formatDescription().sample);
  assert.ok(result.ok, JSON.stringify(result));
});

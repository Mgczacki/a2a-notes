// The A2ANotes/1 wire format and the a2anotes.request/1 agent file format.
// The codec does not know any delivery service. A transport adapter (src/slack.ts) puts the encoded text in its own
// message field and reads the `Transport-File-<Adapter>` lines that map attachment IDs to its own file IDs.
import { createHash } from 'node:crypto';

export const WIRE_VERSION = 'A2ANotes/1';
export const END_MARKER = 'A2ANotes End/1';
export const FILE_VERSION = 'a2anotes.request/1';
export const MAX_TEXT_BYTES = 40_000;
export const MAX_SUBJECT_BYTES = 200;
export const MAX_SUPPORT_FILES = 4;
export const MAX_RAW_COPY = 4000;

export type Audience = 'person' | 'agent' | 'both';
export const AUDIENCES: Audience[] = ['person', 'agent', 'both'];

export interface FileRef { id: string; name: string; size: number; sha256: string }
export interface WireMessage {
  id: string; from: string; to: string; subject: string; audience: Audience;
  threadId: string; replyTo: string | null; body: string;
  agentFile?: FileRef; files: FileRef[];
  // adapter name (for example "Slack") -> attachment ID -> adapter file ID
  transportFiles: Record<string, Record<string, string>>;
  footer?: string;
}

// Error codes that decode and file checks return. Each code has a plain reason for the person.
export type DecodeCode = 'not_a2anotes' | 'unsupported_version' | 'malformed' | 'body_bytes_mismatch' | 'missing_end_marker' | 'too_large';
export type DecodeResult = { ok: true; message: WireMessage } | { ok: false; code: DecodeCode; reason: string; version?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADDRESS = /^[a-z][a-z0-9-]{0,19}:[A-Za-z0-9:._@-]{1,200}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const BODY_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export const isAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value);
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

// Slack stores &, < and > as entities. The sender escapes these three characters in the whole text so that no
// mention or link markup is active, and the receiver reverses exactly these three before it parses.
export const escapeMarkup = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const unescapeMarkup = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function checkSubject(subject: unknown): string {
  if (typeof subject !== 'string' || !subject.trim()) throw new ProtocolError('malformed', 'The subject is empty.');
  if (bytes(subject) > MAX_SUBJECT_BYTES) throw new ProtocolError('malformed', `The subject is longer than ${MAX_SUBJECT_BYTES} bytes.`);
  if (CONTROL.test(subject)) throw new ProtocolError('malformed', 'The subject contains a control character.');
  return subject;
}
export function checkBody(body: unknown): string {
  if (typeof body !== 'string' || !body.trim()) throw new ProtocolError('malformed', 'The message body is empty. A file cannot replace the body.');
  if (BODY_CONTROL.test(body) || body.includes('\r')) throw new ProtocolError('malformed', 'The message body contains a control character.');
  return body;
}
export function checkFileName(name: unknown): string {
  if (typeof name !== 'string' || !name || name.length > 200 || CONTROL.test(name) || /[\\/]/.test(name) || name === '.' || name === '..')
    throw new ProtocolError('malformed', 'The file name is not allowed.');
  return name;
}

export class ProtocolError extends Error {
  constructor(readonly code: DecodeCode | 'agent_file_invalid', message: string) { super(message); }
}

const fileLine = (f: FileRef) => `${f.id} | ${JSON.stringify(f.name)} | ${f.size} | ${f.sha256}`;
export const agentFileName = (messageId: string) => `a2anotes-request-${messageId}.json`;

// Checks the fields that every message needs. encode and decode both call it, so the sender cannot send a message
// that the receiver would reject.
export function validateMessage(m: WireMessage) {
  if (!isUuid(m.id)) throw new ProtocolError('malformed', 'ID must be a lowercase UUID.');
  if (!isAddress(m.from)) throw new ProtocolError('malformed', 'From is not a transport address.');
  if (!isAddress(m.to)) throw new ProtocolError('malformed', 'To is not a transport address.');
  checkSubject(m.subject);
  if (!AUDIENCES.includes(m.audience)) throw new ProtocolError('malformed', 'Audience must be person, agent, or both.');
  if (!isUuid(m.threadId)) throw new ProtocolError('malformed', 'Thread-ID must be a UUID.');
  if (m.replyTo === null ? m.threadId !== m.id : !isUuid(m.replyTo)) throw new ProtocolError('malformed', 'A first message uses its own ID as Thread-ID. A reply gives the earlier message ID.');
  checkBody(m.body);
  if (m.audience === 'person' && m.agentFile) throw new ProtocolError('malformed', 'A person message cannot have an agent file.');
  if (m.audience !== 'person' && !m.agentFile) throw new ProtocolError('malformed', `An ${m.audience} message needs an agent file.`);
  if (m.files.length > MAX_SUPPORT_FILES) throw new ProtocolError('malformed', `A message can have at most ${MAX_SUPPORT_FILES} supporting files.`);
  const ids = new Set<string>();
  for (const f of [...(m.agentFile ? [m.agentFile] : []), ...m.files]) {
    if (!isUuid(f.id) || ids.has(f.id)) throw new ProtocolError('malformed', 'Each file needs its own UUID.');
    ids.add(f.id);
    checkFileName(f.name);
    if (!Number.isInteger(f.size) || f.size < 1 || f.size > 10 * 1024 * 1024) throw new ProtocolError('malformed', 'A file size must be between 1 byte and 10 MiB.');
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new ProtocolError('malformed', 'A file hash must be a SHA-256 hex value.');
  }
  if (m.agentFile && m.agentFile.name !== agentFileName(m.id)) throw new ProtocolError('malformed', 'The agent file name must be a2anotes-request-<ID>.json.');
  for (const [adapter, map] of Object.entries(m.transportFiles)) {
    if (!/^[A-Z][A-Za-z0-9]{0,19}$/.test(adapter)) throw new ProtocolError('malformed', 'A transport file line names an adapter that is not allowed.');
    for (const [id, ref] of Object.entries(map)) {
      if (!ids.has(id)) throw new ProtocolError('malformed', 'A transport file line names an attachment that the message does not list.');
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(ref)) throw new ProtocolError('malformed', 'A transport file reference is not allowed.');
    }
  }
}

export const footerFor = (senderName: string) => `Sent by ${senderName.replace(/\s+/g, ' ').trim().slice(0, 80) || 'someone'} with A2A Notes.`;

// Returns the text before markup escapes. A transport that stores entities (Slack) sends escapeMarkup(encode(m)).
export function encode(m: WireMessage): string {
  validateMessage(m);
  const lines = [WIRE_VERSION, `ID: ${m.id}`, `From: ${m.from}`, `To: ${m.to}`, `Subject: ${m.subject}`, `Audience: ${m.audience}`,
    `Thread-ID: ${m.threadId}`, `Reply-To: ${m.replyTo ?? 'none'}`, `Body-Bytes: ${bytes(m.body)}`];
  if (m.agentFile) lines.push(`Agent-File: ${fileLine(m.agentFile)}`);
  for (const f of m.files) lines.push(`File: ${fileLine(f)}`);
  for (const [adapter, map] of Object.entries(m.transportFiles)) for (const [id, ref] of Object.entries(map)) lines.push(`Transport-File-${adapter}: ${id} | ${ref}`);
  const text = `${lines.join('\n')}\n\n${m.body}\n${END_MARKER}${m.footer ? `\n${m.footer}` : ''}`;
  if (bytes(escapeMarkup(text)) > MAX_TEXT_BYTES) throw new ProtocolError('too_large', `The encoded message is longer than ${MAX_TEXT_BYTES} bytes. Move detail to the agent file.`);
  return text;
}

function parseFileLine(value: string): FileRef {
  const match = /^([0-9a-f-]{36}) \| ("(?:[^"\\]|\\.)*") \| (\d{1,9}) \| ([0-9a-f]{64})$/.exec(value);
  if (!match) throw new ProtocolError('malformed', 'A file line does not have the form: UUID | "name" | size | sha256.');
  let name: unknown;
  try { name = JSON.parse(match[2]); } catch { throw new ProtocolError('malformed', 'A file name is not valid JSON text.'); }
  return { id: match[1], name: checkFileName(name), size: Number(match[3]), sha256: match[4] };
}

const FIXED = ['ID', 'From', 'To', 'Subject', 'Audience', 'Thread-ID', 'Reply-To', 'Body-Bytes'] as const;

// Reads text that a transport received. The caller passes the text after unescapeMarkup.
// Text that does not start with an A2ANotes line returns not_a2anotes: ordinary chat stays outside the inbox.
export function decode(raw: unknown): DecodeResult {
  try { return { ok: true, message: decodeOrThrow(raw) }; }
  catch (error) {
    if (error instanceof ProtocolError && error.code !== 'agent_file_invalid') {
      const version = typeof raw === 'string' ? /^A2ANotes\/(\S+)/.exec(raw)?.[1] : undefined;
      return { ok: false, code: error.code, reason: error.message, ...(version ? { version: `A2ANotes/${version}` } : {}) };
    }
    throw error;
  }
}

function decodeOrThrow(raw: unknown): WireMessage {
  if (typeof raw !== 'string') throw new ProtocolError('not_a2anotes', 'The message has no text.');
  if (!raw.startsWith('A2ANotes')) throw new ProtocolError('not_a2anotes', 'The text is not an A2A Notes message.');
  if (bytes(raw) > MAX_TEXT_BYTES) throw new ProtocolError('too_large', `The text is longer than ${MAX_TEXT_BYTES} bytes.`);
  const first = raw.slice(0, raw.indexOf('\n') < 0 ? raw.length : raw.indexOf('\n'));
  // identify the version before any other field: an unknown major version is never parsed as version 1
  const version = /^A2ANotes\/(\d{1,4})$/.exec(first);
  if (!version) throw new ProtocolError('malformed', 'The first line must be A2ANotes/<major version>.');
  if (version[1] !== '1') throw new ProtocolError('unsupported_version', `This message says ${first}. This receiver reads only ${WIRE_VERSION}. Ask the sender to use ${WIRE_VERSION} or update A2A Notes.`);
  const split = raw.indexOf('\n\n');
  if (split < 0) throw new ProtocolError('malformed', 'The header has no blank line after it.');
  const header = raw.slice(first.length + 1, split).split('\n');
  const fields: Record<string, string> = {};
  let index = 0;
  for (const name of FIXED) {
    const line = header[index++] ?? '';
    if (!line.startsWith(`${name}: `)) throw new ProtocolError('malformed', `Header line ${index + 1} must be ${name}.`);
    fields[name] = line.slice(name.length + 2);
  }
  let agentFile: FileRef | undefined;
  const files: FileRef[] = [];
  const transportFiles: Record<string, Record<string, string>> = {};
  for (; index < header.length; index++) {
    const line = header[index];
    const transport = /^Transport-File-([A-Z][A-Za-z0-9]{0,19}): ([0-9a-f-]{36}) \| (\S+)$/.exec(line);
    if (line.startsWith('Agent-File: ')) {
      if (agentFile || files.length || Object.keys(transportFiles).length) throw new ProtocolError('malformed', 'Agent-File must appear once, before File lines.');
      agentFile = parseFileLine(line.slice(12));
    } else if (line.startsWith('File: ')) {
      if (Object.keys(transportFiles).length) throw new ProtocolError('malformed', 'File lines must come before transport file lines.');
      files.push(parseFileLine(line.slice(6)));
    } else if (transport) {
      (transportFiles[transport[1]] ||= {})[transport[2]] = transport[3];
    } else throw new ProtocolError('malformed', `Header line ${index + 2} is not a version 1 field.`);
  }
  const declared = /^\d{1,6}$/.test(fields['Body-Bytes']) ? Number(fields['Body-Bytes']) : NaN;
  if (!Number.isFinite(declared)) throw new ProtocolError('malformed', 'Body-Bytes must be a whole number.');
  const rest = Buffer.from(raw.slice(split + 2), 'utf8');
  const marker = Buffer.from(`\n${END_MARKER}`, 'utf8');
  if (!rest.subarray(declared, declared + marker.length).equals(marker)) {
    const end = rest.lastIndexOf(marker);
    if (end < 0) throw new ProtocolError('missing_end_marker', `The message has no ${END_MARKER} line.`);
    throw new ProtocolError('body_bytes_mismatch', `Body-Bytes says ${declared}, but the body before the end marker has ${end} bytes.`);
  }
  const body = rest.subarray(0, declared).toString('utf8');
  if (Buffer.byteLength(body) !== declared) throw new ProtocolError('body_bytes_mismatch', 'Body-Bytes ends inside a character.');
  const after = rest.subarray(declared + marker.length).toString('utf8');
  let footer: string | undefined;
  if (after) {
    if (!after.startsWith('\n') || after.slice(1).includes('\n') || !/^Sent by .{1,80} with A2A Notes\.$/.test(after.slice(1))) throw new ProtocolError('malformed', 'Only one footer line may follow the end marker.');
    footer = after.slice(1);
  }
  const message: WireMessage = {
    id: fields.ID, from: fields.From, to: fields.To, subject: fields.Subject, audience: fields.Audience as Audience,
    threadId: fields['Thread-ID'], replyTo: fields['Reply-To'] === 'none' ? null : fields['Reply-To'], body, agentFile, files, transportFiles, footer,
  };
  validateMessage(message);
  return message;
}

// ---- agent file ----

export interface AgentRequest {
  version: typeof FILE_VERSION; message_id: string; audience: 'agent' | 'both'; subject: string;
  target: Record<string, string | number | boolean | null> | null;
  facts: { statement: string; source: string; status: string }[];
  agent_request: { when: string | null; ask: string; details: { name: string; ask: string }[]; deadline: string | null };
  unknowns: string[];
}

const text = (value: unknown, limit = 4000) => typeof value === 'string' && value.length <= limit && !BODY_CONTROL.test(value);

// Checks the bytes of an agent file against its header line, then parses and checks the JSON. The hash is checked
// before the JSON is parsed. expected is the wire message the file belongs to.
export function readAgentFile(data: Buffer, ref: FileRef, expected: Pick<WireMessage, 'id' | 'audience' | 'subject'>): AgentRequest {
  if (data.length !== ref.size || sha256(data) !== ref.sha256) throw new ProtocolError('agent_file_invalid', 'The agent file bytes do not match the size and hash in the message.');
  return parseAgentFile(data, expected);
}

export function parseAgentFile(data: Buffer, expected?: Pick<WireMessage, 'id' | 'audience' | 'subject'>): AgentRequest {
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new ProtocolError('agent_file_invalid', 'The agent file is not UTF-8 text.'); }
  if (!source.endsWith('}\n') || source.endsWith('\n\n')) throw new ProtocolError('agent_file_invalid', 'The agent file must be one JSON object with one trailing LF.');
  let value: any;
  try { value = JSON.parse(source); } catch { throw new ProtocolError('agent_file_invalid', 'The agent file is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('agent_file_invalid', 'The agent file must be a JSON object.');
  const version = typeof value.version === 'string' ? /^a2anotes\.request\/(\d{1,4})$/.exec(value.version) : null;
  if (!version) throw new ProtocolError('agent_file_invalid', 'The agent file has no a2anotes.request version.');
  if (version[1] !== '1') throw new ProtocolError('unsupported_version', `The agent file says ${value.version}. This receiver reads only ${FILE_VERSION}.`);
  const allowed = new Set(['version', 'message_id', 'audience', 'subject', 'target', 'facts', 'agent_request', 'unknowns']);
  const extra = Object.keys(value).find(key => !allowed.has(key));
  if (extra) throw new ProtocolError('agent_file_invalid', `The agent file field ${JSON.stringify(extra).slice(0, 60)} is not a version 1 field.`);
  if (!isUuid(value.message_id)) throw new ProtocolError('agent_file_invalid', 'message_id must be the message UUID.');
  if (value.audience !== 'agent' && value.audience !== 'both') throw new ProtocolError('agent_file_invalid', 'audience must be agent or both.');
  if (!text(value.subject, 400)) throw new ProtocolError('agent_file_invalid', 'subject must be text.');
  if (expected) {
    if (value.message_id !== expected.id) throw new ProtocolError('agent_file_invalid', 'The agent file message_id does not match the message ID.');
    if (value.audience !== expected.audience) throw new ProtocolError('agent_file_invalid', 'The agent file audience does not match the message Audience.');
    if (value.subject !== expected.subject) throw new ProtocolError('agent_file_invalid', 'The agent file subject does not match the message Subject.');
  }
  const target = value.target;
  if (target !== null && (typeof target !== 'object' || Array.isArray(target) || Object.values(target).some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v))))
    throw new ProtocolError('agent_file_invalid', 'target must be an object of plain values, or null.');
  if (!Array.isArray(value.facts) || value.facts.length > 100 || value.facts.some((f: any) => !f || !text(f.statement) || !text(f.source, 400) || !text(f.status, 100)))
    throw new ProtocolError('agent_file_invalid', 'facts must be a list of statement, source, and status.');
  const request = value.agent_request;
  if (!request || typeof request !== 'object' || !(request.when === null || text(request.when)) || !text(request.ask) || !request.ask.trim() ||
      !(request.deadline === null || text(request.deadline, 100)) || !Array.isArray(request.details) || request.details.length > 50 ||
      request.details.some((d: any) => !d || !text(d.name, 200) || !text(d.ask)))
    throw new ProtocolError('agent_file_invalid', 'agent_request must have when, ask, details, and deadline.');
  if (!Array.isArray(value.unknowns) || value.unknowns.length > 100 || value.unknowns.some((u: unknown) => !text(u)))
    throw new ProtocolError('agent_file_invalid', 'unknowns must be a list of text.');
  return value as AgentRequest;
}

// Writes an agent file with the fixed format: two-space JSON and one trailing LF.
export const writeAgentFile = (request: AgentRequest) => Buffer.from(`${JSON.stringify(request, null, 2)}\n`, 'utf8');

// ---- legacy Taskboard messages ----

// Taskboard sent `[Taskboard message v1]` or `[Taskboard message v2]` followed by JSON. The package reads them during
// the switch so that no message that the old receiver accepted is lost. Legacy messages have audience person.
export function decodeLegacyTaskboard(text: unknown): { id: string; subject: string; body: string; files?: { id: string; name: string; size: number; hash: string; longBody?: boolean }[] } | null {
  if (typeof text !== 'string' || bytes(text) > MAX_TEXT_BYTES) return null;
  if (!text.startsWith('Taskboard message: ') && !text.startsWith('[Taskboard message v')) return null;
  for (const match of text.matchAll(/\[Taskboard message v([12])\]\s+(?=\{)/g)) {
    try {
      const hasFiles = match[1] === '2';
      const m = JSON.parse(text.slice(match.index! + match[0].length));
      if (typeof m.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(m.id) || typeof m.subject !== 'string' || typeof m.body !== 'string') continue;
      if (hasFiles && (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > 5 || m.files.some((f: any) => !/^F[A-Z0-9]+$/.test(f.id) || typeof f.name !== 'string' ||
          !Number.isInteger(f.size) || f.size < 1 || f.size > 10 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(f.hash)))) continue;
      return m;
    } catch { /* A subject can contain the marker before the actual data. */ }
  }
  return null;
}

// A bounded copy of text that failed a check, for the person to inspect. Agents never receive it.
export const rawCopy = (text: string) => {
  const buffer = Buffer.from(text, 'utf8');
  return buffer.length <= MAX_RAW_COPY ? text : `${buffer.subarray(0, MAX_RAW_COPY).toString('utf8').replace(/�$/, '')}\n[cut at ${MAX_RAW_COPY} bytes]`;
};

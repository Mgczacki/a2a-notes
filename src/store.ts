// The message store: one private JSON file in the data folder, written by one service process.
// Each change reads the file, applies the change, and replaces the file with an atomic rename, so a crash leaves the
// old file or the new file and never half of one.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRequest, Audience } from './protocol.ts';
import { DEFAULT_POLICY, type Policy } from './policy.ts';
import type { BodyCheck, ReviewResult } from './checks.ts';

export type Role = 'person' | 'reviewer' | 'agent';
export type OutState = 'draft' | 'approved' | 'queued' | 'sending' | 'sent' | 'delivery_uncertain' | 'permanent_failure' | 'rejected';
export type InState = 'held' | 'approved' | 'rejected' | 'failed' | 'quarantined';

export interface StoredFile {
  id: string; name: string; size: number; sha256: string; kind: 'agent' | 'support'; direction: 'out' | 'in';
  created: string; stagedBy?: string; agentRequest?: AgentRequest;
}
export interface Approval { by: 'person' | 'reviewer'; actor: string; at: string; hash: string; policyVersion: number }
export interface Note {
  id: string; messageId: string; direction: 'in' | 'out'; state: OutState | InState;
  from: string; to: string; peerName?: string; subject: string; body: string; audience: Audience;
  threadId: string; replyTo: string | null; agentFileId?: string; fileIds: string[]; hash: string;
  bodyCheck?: BodyCheck; review?: ReviewResult; approval?: Approval; rejected?: { actor: string; at: string; comment?: string };
  // the instruction that authorized an outgoing draft, used to compare the ask (src/checks.ts compareAsk)
  instruction?: string;
  // client data for this note, for example myclient.task_id. It stays in this store: it is not in the content
  // hash and never goes over the transport (src/service.ts checkMetadata)
  metadata?: Metadata;
  createdBy?: { session: string; role: Role };
  transport?: { name: string; channel?: string; ts?: string; threadTs?: string; files?: Record<string, string> };
  failure?: { code: string; reason: string; raw?: string };
  error?: string; seen?: string; created: string; updated: string; sendStartedAt?: string; sentAt?: string;
  nextRetryAt?: string; retryCount?: number; sendName?: string;
}
export type Metadata = Record<string, string | number | boolean | null>;
export interface Trusted { address: string; name: string; at: string }
export interface Audit { at: string; actor: string; action: string; id?: string; detail?: string }
export interface Health { lastScanAt?: string; lastSuccessAt?: string; lastError?: string; rateLimitedUntil?: string; scans: number }
export interface Data {
  version: 1; notes: Note[]; files: StoredFile[]; trusted: Trusted[]; policy: Policy;
  // transport conversation -> newest message time that the service stored and checked
  cursors: Record<string, string>;
  // request_id -> the result of the first call, so a retried tool call does not create a second draft or send
  requests: Record<string, { tool: string; id: string; at: string }>;
  audit: Audit[]; health: Health;
}

export function savePrivate(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}

export function noteHash(n: Pick<Note, 'messageId' | 'to' | 'subject' | 'body' | 'audience' | 'threadId' | 'replyTo'>, files: Pick<StoredFile, 'id' | 'name' | 'size' | 'sha256' | 'kind'>[]) {
  return createHash('sha256').update(JSON.stringify(['a2anotes-note/1', n.messageId, n.to, n.subject, n.body, n.audience, n.threadId, n.replyTo,
    files.map(f => [f.kind, f.id, f.name, f.size, f.sha256])])).digest('hex');
}

const MAX_NOTES = 20_000, MAX_AUDIT = 5000, MAX_REQUESTS = 5000;

export class Store {
  readonly file: string;
  readonly filesDir: string;
  constructor(readonly dir: string) {
    this.file = join(dir, 'store.json');
    this.filesDir = join(dir, 'files');
    mkdirSync(this.filesDir, { recursive: true, mode: 0o700 });
  }
  read(): Data {
    if (!existsSync(this.file)) return { version: 1, notes: [], files: [], trusted: [], policy: { ...DEFAULT_POLICY }, cursors: {}, requests: {}, audit: [], health: { scans: 0 } };
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.notes)) throw new Error('The A2A Notes store needs repair.');
    return data;
  }
  change<T>(fn: (data: Data) => T): T {
    const data = this.read();
    const result = fn(data);
    if (data.notes.length > MAX_NOTES) throw new Error('The message store is full.');
    data.audit = data.audit.slice(-MAX_AUDIT);
    const keys = Object.keys(data.requests);
    if (keys.length > MAX_REQUESTS) for (const key of keys.slice(0, keys.length - MAX_REQUESTS)) delete data.requests[key];
    savePrivate(this.file, data);
    return result;
  }
  note(id: string) { return this.read().notes.find(n => n.id === id); }
  update(id: string, fn: (n: Note, data: Data) => void) {
    return this.change(data => {
      const n = data.notes.find(x => x.id === id);
      if (!n) throw new ServiceError('not_found', 'No message has this ID.', 'List messages to find the ID.');
      fn(n, data); n.updated = new Date().toISOString();
      return n;
    });
  }
  audit(data: Data, actor: string, action: string, id?: string, detail?: string) {
    data.audit.push({ at: new Date().toISOString(), actor, action, ...(id ? { id } : {}), ...(detail ? { detail: detail.slice(0, 300) } : {}) });
  }
  filePath(id: string) { return join(this.filesDir, id); }
  writeFileBytes(id: string, bytes: Buffer) { writeFileSync(this.filePath(id), bytes, { flag: 'wx', mode: 0o600 }); }
  readFileBytes(file: StoredFile) {
    const bytes = readFileSync(this.filePath(file.id));
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new ServiceError('file_changed', `The stored file ${file.name} changed.`, 'Stage the file again and create a new draft.');
    return bytes;
  }
}

// An error with a stable code, a plain reason, and the next action. MCP tools return all three.
export class ServiceError extends Error {
  constructor(readonly code: string, message: string, readonly next = '') { super(message); }
}

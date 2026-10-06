// The protocol core. It owns drafts, files, checks, approvals, sends, and the inbox. MCP tools (src/mcp.ts) and the
// review page (src/http.ts) call these methods with the caller's session. The session role comes from the client token,
// never from a tool argument or message text.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { sep } from 'node:path';
import {
  agentFileName, checkBody, checkFileName, checkSubject, decode, encode, footerFor, isAddress, isUuid,
  parseAgentFile, ProtocolError, rawCopy, readAgentFile, sha256, type Audience, type FileRef, type WireMessage, AUDIENCES, MAX_SUPPORT_FILES,
} from './protocol.ts';
import { checkPolicy, incomingApprover, outgoingApprover, type Approver, type Policy } from './policy.ts';
import { checkOutgoingBody, fileTextForChecks, review, type BodyCheck, type BodyChecker, type ReviewResult, type Reviewer } from './checks.ts';
import { noteHash, ServiceError, Store, type Data, type Metadata, type Note, type Role, type StoredFile } from './store.ts';
import { TransportError, type Received, type Transport } from './transport.ts';

export interface Session { name: string; role: Role }
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface ServiceOptions {
  store: Store; transport: Transport; reviewer?: Reviewer;
  // a command that checks outgoing bodies in addition to the fixed rules (src/checks.ts commandBodyChecker)
  bodyChecker?: BodyChecker;
  // how long a draft call waits for the checks before it returns and the checks finish in the background
  checkWaitMs?: number;
  // the only folder that stage_file reads a path from
  stagingDir?: string;
  scanIntervalMs?: number;
}

const HELD = '(held for review)', PERSON_ONLY = '(for the person only)';
const page = <T>(items: T[], limit: unknown, cursor: unknown) => {
  const size = Math.min(100, Math.max(1, Number(limit) || 20));
  const start = typeof cursor === 'string' && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0;
  const slice = items.slice(start, start + size);
  return { items: slice, ...(start + size < items.length ? { next_cursor: String(start + size) } : {}) };
};

// Client metadata: at most 20 keys with a client prefix (for example myclient.task_id), plain values, 4 KiB in all.
export function checkMetadata(value: unknown): Metadata | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ServiceError('invalid_input', 'metadata must be an object.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw new ServiceError('invalid_input', 'metadata can have at most 20 keys.');
  for (const [key, v] of entries) {
    if (!/^[a-z][a-z0-9_-]{0,30}\.[a-z0-9_.-]{1,60}$/.test(key)) throw new ServiceError('invalid_input', `The metadata key ${JSON.stringify(key).slice(0, 80)} needs a client prefix, for example myclient.task_id.`);
    if (!(v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' && v.length <= 500 && !/[\x00-\x1f\x7f]/.test(v)))
      throw new ServiceError('invalid_input', `The metadata value for ${key} must be text of at most 500 characters, a number, true, false, or null.`);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 4096) throw new ServiceError('invalid_input', 'metadata must have at most 4096 bytes.');
  return Object.fromEntries(entries) as Metadata;
}

export class NotesService {
  readonly store: Store;
  readonly transport: Transport;
  private reviewer?: Reviewer;
  private timer?: NodeJS.Timeout;
  private sendTimer?: NodeJS.Timeout;
  private draining = false;
  private scanning?: Promise<void>;
  private sending = new Set<string>();
  constructor(private options: ServiceOptions) {
    this.store = options.store;
    this.transport = options.transport;
    this.reviewer = options.reviewer;
  }

  // After a restart: a message that was sending when the process stopped may or may not be in Slack.
  start() {
    this.store.change(data => {
      for (const n of data.notes) if (n.direction === 'out' && (n.state === 'sending' || n.state === 'delivery_uncertain')) {
        n.state = 'queued'; n.nextRetryAt = new Date().toISOString();
        n.error = 'The service stopped during the send. It will check Slack before it sends again.';
        this.store.audit(data, 'service', 'queued', n.id, 'restart during send');
      }
    });
    const every = this.options.scanIntervalMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => { void this.scanNow().catch(() => {}); }, every);
      this.timer.unref();
      void this.scanNow().catch(() => {});
    }
    this.sendTimer = setInterval(() => { void this.processQueue(); }, 1000);
    this.sendTimer.unref();
    void this.processQueue();
  }
  stop() { if (this.timer) clearInterval(this.timer); if (this.sendTimer) clearInterval(this.sendTimer); this.timer = undefined; this.sendTimer = undefined; }

  private retryDelay(error: unknown, count: number) {
    if (error instanceof TransportError && error.retryAfter > 0) return error.retryAfter * 1000;
    return Math.min(60 * 60_000, 60_000 * 2 ** Math.min(count - 1, 6));
  }
  private queue(id: string, error: unknown) {
    this.store.update(id, (n, data) => {
      n.retryCount = (n.retryCount || 0) + 1;
      n.nextRetryAt = new Date(Date.now() + this.retryDelay(error, n.retryCount)).toISOString();
      n.state = 'queued'; n.error = `Delivery will retry: ${(error as Error).message}`;
      this.store.audit(data, 'service', 'queued', id, n.error);
    });
  }
  async processQueue(now = Date.now()) {
    if (this.draining) return;
    this.draining = true;
    try {
      const due = this.store.read().notes.filter(n => n.direction === 'out' && n.state === 'queued' && Date.parse(n.nextRetryAt || '') <= now);
      for (const n of due) {
        try { await this.send({ name: 'service', role: 'reviewer' }, { id: n.id, expected_hash: n.hash, request_id: `retry-${randomUUID()}` }); }
        catch (error) {
          if (error instanceof ServiceError && error.code === 'send_in_progress') continue;
          if (error instanceof ServiceError && ['approval_invalid', 'not_approved', 'hash_changed', 'file_changed'].includes(error.code)) {
            this.store.update(n.id, (x, data) => { x.state = 'permanent_failure'; delete x.nextRetryAt; x.error = error.message; this.store.audit(data, 'service', 'permanent_failure', n.id, error.message); });
          } else this.queue(n.id, error);
        }
      }
    } finally { this.draining = false; }
  }

  // ---- policy ----

  private trusted(data: Pick<Data, 'trusted'>, address: string) { return data.trusted.some(t => t.address === address); }
  approverFor(n: Note, data: Pick<Data, 'trusted' | 'policy'>): Approver {
    if (n.state === 'rejected' || n.state === 'failed' || n.state === 'quarantined' || n.failure) return 'nobody';
    const verdict = n.review?.verdict;
    if (n.direction === 'in') return incomingApprover(verdict, data.policy.incoming, this.trusted(data, n.from));
    const flags = data.policy.checkBody ? (n.bodyCheck ? n.bodyCheck.flags.length : 1) : 0;
    return outgoingApprover(verdict, data.policy.outgoing, this.trusted(data, n.to), flags, data.policy);
  }
  // An approval counts when it matches the current hash and the current levels still permit the one who gave it.
  approvalValid(n: Note, data: Pick<Data, 'trusted' | 'policy'>) {
    if (!n.approval || n.approval.hash !== n.hash || n.state === 'rejected') return false;
    const approver = this.approverFor(n, data);
    return n.approval.by === 'person' ? approver !== 'nobody' : approver === 'reviewer';
  }

  // ---- views ----

  private files(data: Data, n: Note) {
    return [...(n.agentFileId ? [n.agentFileId] : []), ...n.fileIds].map(id => data.files.find(f => f.id === id)).filter((f): f is StoredFile => !!f);
  }
  private allowed(n: Note, data: Data, session: Session) {
    const approver = this.approverFor(n, data), actions: string[] = [];
    const canApprove = session.role === 'person' ? approver !== 'nobody' : session.role === 'reviewer' && approver === 'reviewer';
    if (n.direction === 'out') {
      if (['draft', 'approved', 'rejected', 'permanent_failure'].includes(n.state) && this.canEdit(n, session)) actions.push('revise');
      if (['draft', 'approved'].includes(n.state) && canApprove) actions.push('approve', 'reject');
      if ((n.state === 'approved' && this.approvalValid(n, data) || n.state === 'delivery_uncertain') && this.canSend(n, session)) actions.push('send');
    } else {
      if (n.state === 'held' && canApprove) actions.push('approve', 'reject');
      if (n.state === 'approved' && this.approvalValid(n, data)) actions.push('reply', ...(n.audience !== 'person' ? ['release_to_agent'] : []));
      actions.push('mark_seen');
    }
    return actions;
  }
  private canEdit(n: Note, session: Session) { return session.role === 'person' || n.createdBy?.session === session.name; }
  // the design lets an agent write and revise drafts; only the person or the review agent sends
  private canSend(_n: Note, session: Session) { return session.role !== 'agent'; }

  // What a session may see. The person sees everything. Agents and the review agent never see failed or quarantined
  // text. They see an incoming body only after a valid approval, and never the body of a message for a person only.
  // The review agent also sees a held body when the levels let it approve that message.
  visible(n: Note, data: Data, session: Session): boolean { return session.role === 'person' || !(n.direction === 'in' && ['failed', 'quarantined'].includes(n.state)); }
  private released(n: Note, data: Data, session: Session) {
    if (session.role === 'person' || n.direction === 'out') return true;
    if (this.approvalValid(n, data) && n.state === 'approved') return n.audience !== 'person';
    return session.role === 'reviewer' && n.state === 'held' && this.approverFor(n, data) === 'reviewer';
  }
  summary(n: Note, data: Data, session: Session) {
    const open = this.released(n, data, session);
    return {
      id: n.id, message_id: n.messageId, direction: n.direction, state: n.state, audience: n.audience,
      subject: open ? n.subject : n.state === 'approved' && n.audience === 'person' ? PERSON_ONLY : HELD,
      from: n.from, to: n.to, peer_name: n.peerName, trusted: this.trusted(data, n.direction === 'in' ? n.from : n.to),
      check: n.review ? { verdict: n.review.verdict, reviewer: n.review.reviewer } : null, body_flags: n.bodyCheck?.flags.length ?? null, format_warnings: n.bodyCheck?.warnings?.length ?? null,
      approver: this.approverFor(n, data), approved_by: n.approval && n.approval.hash === n.hash ? n.approval.by : null,
      thread_id: n.threadId, created: n.created, updated: n.updated, seen: !!n.seen, ...(n.failure ? { failure_code: n.failure.code } : {}),
      next_retry_at: n.nextRetryAt ?? null, sent_at: n.sentAt ?? null,
      metadata: n.metadata ?? null, reply_to_local: this.replyLink(n, data),
      hash: n.hash, allowed_actions: this.allowed(n, data, session),
    };
  }
  // The local outgoing message that an incoming reply answers, with its metadata. The link exists only when the reply
  // comes from the address that received the original, so a message from someone else cannot claim a local task.
  replyLink(n: Note, data: Data) {
    if (n.direction !== 'in' || !n.replyTo || n.failure) return null;
    const original = data.notes.find(x => x.direction === 'out' && x.messageId === n.replyTo && x.to === n.from && x.threadId === n.threadId);
    return original ? { id: original.id, subject: original.subject, metadata: original.metadata ?? null } : null;
  }
  detail(n: Note, data: Data, session: Session) {
    const open = this.released(n, data, session);
    const files = this.files(data, n);
    const agentFile = n.agentFileId ? files.find(f => f.id === n.agentFileId) : undefined;
    // the parsed agent file goes to an agent only after a valid approval (or before send, to the agent that wrote it)
    const release = session.role === 'person' || n.direction === 'out' || (open && n.state === 'approved');
    return {
      ...this.summary(n, data, session), body: open ? n.body : '', reply_to: n.replyTo,
      body_check: open ? n.bodyCheck ?? null : null,
      review: n.review ? { verdict: n.review.verdict, reason: open ? n.review.reason : '(visible to the person only)', reviewer: n.review.reviewer, at: n.review.at } : null,
      approval: n.approval ? { ...n.approval, current: n.approval.hash === n.hash } : null,
      rejected: n.rejected ?? null,
      agent_file: agentFile ? { id: agentFile.id, name: agentFile.name, size: agentFile.size, sha256: agentFile.sha256, status: release ? 'released' : 'held',
        ...(release && agentFile.agentRequest ? { data: agentFile.agentRequest } : {}) } : null,
      files: files.filter(f => f.kind === 'support').map(f => ({ id: f.id, name: f.name, size: f.size, sha256: f.sha256, ...(release ? { status: 'released' } : { status: 'held' }) })),
      transport: n.transport ? { name: n.transport.name, channel: n.transport.channel, ts: n.transport.ts } : null,
      error: n.error ?? null,
      ...(n.failure ? { failure: session.role === 'person' ? n.failure : { code: n.failure.code, reason: n.failure.reason } } : {}),
    };
  }

  // ---- tools ----

  identity() {
    const id = this.transport.identity();
    return id ? { transport: id.transport, address: id.address, name: id.name, connected: !id.missingScopes.length, scopes: id.scopes } : { transport: this.transport.name, connected: false };
  }
  connectionStatus() {
    const id = this.transport.identity(), health = this.store.read().health;
    const stale = !health.lastSuccessAt || Date.now() - Date.parse(health.lastSuccessAt) > 5 * 60_000;
    return { transport: this.transport.name, signed_in: !!id, address: id?.address ?? null, missing_scopes: id?.missingScopes ?? [], optional_missing: id?.optionalMissing ?? [],
      last_scan_at: health.lastScanAt ?? null, last_success_at: health.lastSuccessAt ?? null, last_error: health.lastError ?? null,
      rate_limited_until: health.rateLimitedUntil && Date.parse(health.rateLimitedUntil) > Date.now() ? health.rateLimitedUntil : null, stale };
  }
  async findPeople(query: unknown, limit: unknown, cursor: unknown) {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200) throw new ServiceError('invalid_input', 'The search text must have 2 to 200 characters.', 'Search with a longer name or an email address.');
    const result = await this.wrap(() => this.transport.findPeople(query, Math.min(50, Math.max(1, Number(limit) || 10)), typeof cursor === 'string' ? cursor : undefined));
    return { people: result.people.map(p => ({ address: p.address, name: p.name, real_name: p.realName, title: p.title, active: p.active })), ...(result.next ? { next_cursor: result.next } : {}) };
  }
  // A member of the transport workspace: name, title, and profile picture address.
  async getPerson(address: unknown) {
    if (!isAddress(address)) throw new ServiceError('invalid_input', 'address must be a transport address.');
    const p = await this.transport.personOf?.(address);
    if (!p) throw new ServiceError('not_found', 'No member has this address.', 'Use a2anotes_find_people to find the address.');
    return { address: p.address, name: p.name, real_name: p.realName, title: p.title, active: p.active, image_url: p.image ?? null };
  }
  list(session: Session, input: { direction?: string; state?: string; audience?: string; limit?: unknown; cursor?: unknown }) {
    const data = this.store.read();
    const items = data.notes.filter(n => this.visible(n, data, session))
      .filter(n => !input.direction || input.direction === 'all' || n.direction === (input.direction === 'incoming' ? 'in' : input.direction === 'outgoing' ? 'out' : input.direction))
      .filter(n => !input.state || input.state === 'all' || n.state === input.state)
      .filter(n => !input.audience || n.audience === input.audience)
      .sort((a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
    const result = page(items, input.limit, input.cursor);
    return { messages: result.items.map(n => this.summary(n, data, session)), ...(result.next_cursor ? { next_cursor: result.next_cursor } : {}) };
  }
  get(session: Session, id: unknown) {
    const data = this.store.read();
    const n = data.notes.find(x => x.id === id);
    if (!n || !this.visible(n, data, session)) throw new ServiceError('not_found', 'No message has this ID.', 'List messages to find the ID.');
    return this.detail(n, data, session);
  }

  stageFile(session: Session, input: { name?: unknown; text?: unknown; content_base64?: unknown; path?: unknown; sha256?: unknown; kind?: unknown; request_id?: unknown }) {
    const requestId = this.requestId(input.request_id);
    const earlier = this.store.read().requests[requestId];
    if (earlier) { const f = this.store.read().files.find(x => x.id === earlier.id); if (f) return this.fileView(f); }
    const kind = input.kind === 'agent' ? 'agent' : input.kind === undefined || input.kind === 'support' ? 'support' : undefined;
    if (!kind) throw new ServiceError('invalid_input', 'kind must be agent or support.');
    let bytes: Buffer;
    const sources = [input.text, input.content_base64, input.path].filter(x => x !== undefined).length;
    if (sources !== 1) throw new ServiceError('invalid_input', 'Give exactly one of text, content_base64, or path.');
    if (typeof input.text === 'string') bytes = Buffer.from(input.text, 'utf8');
    else if (typeof input.content_base64 === 'string') bytes = Buffer.from(input.content_base64, 'base64');
    else bytes = this.readStaged(input.path);
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new ServiceError('invalid_input', 'A file must have between 1 byte and 10 MiB.');
    const hash = sha256(bytes);
    if (input.sha256 !== hash) throw new ServiceError('hash_mismatch', 'The file bytes do not match sha256.', 'Compute the SHA-256 hash of the exact bytes and stage the file again.');
    let name: string;
    let agentRequest;
    if (kind === 'agent') {
      try { agentRequest = parseAgentFile(bytes); } catch (error) { throw new ServiceError(error instanceof ProtocolError ? error.code : 'agent_file_invalid', (error as Error).message, 'Fix the agent file and stage it again.'); }
      name = agentFileName(agentRequest.message_id);
    } else {
      try { name = checkFileName(input.name); } catch (error) { throw new ServiceError('invalid_input', (error as Error).message); }
    }
    const file: StoredFile = { id: randomUUID(), name, size: bytes.length, sha256: hash, kind, direction: 'out', created: new Date().toISOString(), stagedBy: session.name, ...(agentRequest ? { agentRequest } : {}) };
    this.store.writeFileBytes(file.id, bytes);
    this.store.change(data => { data.files.push(file); data.requests[requestId] = { tool: 'stage_file', id: file.id, at: file.created }; this.store.audit(data, session.name, 'stage_file', file.id, file.name); });
    return this.fileView(file);
  }
  private fileView(f: StoredFile) {
    return { file_id: f.id, name: f.name, size: f.size, sha256: f.sha256, kind: f.kind, check: 'ok', ...(f.agentRequest ? { message_id: f.agentRequest.message_id } : {}) };
  }
  private readStaged(path: unknown): Buffer {
    const root = this.options.stagingDir;
    if (!root) throw new ServiceError('invalid_input', 'This service has no staging folder. Send the file as text or content_base64.');
    if (typeof path !== 'string' || !path) throw new ServiceError('invalid_input', 'path must be text.');
    let real: string;
    try { real = realpathSync(path.startsWith('/') ? path : `${root}/${path}`); } catch { throw new ServiceError('invalid_input', 'The file does not exist in the staging folder.'); }
    if (!real.startsWith(realpathSync(root) + sep) || lstatSync(real).isSymbolicLink()) throw new ServiceError('invalid_input', 'The service reads files only from its staging folder.');
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new ServiceError('invalid_input', 'Choose a regular file under 10 MiB.');
      return readFileSync(fd);
    } finally { closeSync(fd); }
  }

  private requestId(value: unknown) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(value)) throw new ServiceError('invalid_input', 'request_id must have 8 to 100 letters, digits, or . _ : -', 'Create a new random request_id for each new action and reuse it only for a retry.');
    return value;
  }

  // Resolves and checks the content fields of a draft. Used by create and revise.
  private draftFields(data: Data, input: { subject?: unknown; body?: unknown; audience?: unknown; agent_file_id?: unknown; file_ids?: unknown }, messageId?: string) {
    let subject: string, body: string;
    try { subject = checkSubject(input.subject); body = checkBody(input.body); } catch (error) { throw new ServiceError('invalid_input', (error as Error).message, 'Write a subject and a body of one or two sentences for a person.'); }
    const audience = input.audience as Audience;
    if (!AUDIENCES.includes(audience)) throw new ServiceError('invalid_input', 'audience must be person, agent, or both.');
    const fileIds = input.file_ids === undefined ? [] : input.file_ids;
    if (!Array.isArray(fileIds) || fileIds.length > MAX_SUPPORT_FILES || fileIds.some(id => typeof id !== 'string')) throw new ServiceError('invalid_input', `file_ids must be a list of at most ${MAX_SUPPORT_FILES} file IDs.`);
    const support = fileIds.map(id => {
      const f = data.files.find(x => x.id === id && x.direction === 'out' && x.kind === 'support');
      if (!f) throw new ServiceError('file_not_found', 'A supporting file ID is not a staged supporting file.', 'Stage the file with kind support first.');
      return f;
    });
    let agentFile: StoredFile | undefined;
    if (audience === 'person') {
      if (input.agent_file_id !== undefined && input.agent_file_id !== null) throw new ServiceError('invalid_input', 'A person message cannot have an agent file.', 'Use audience agent or both, or remove agent_file_id.');
    } else {
      agentFile = data.files.find(x => x.id === input.agent_file_id && x.direction === 'out' && x.kind === 'agent');
      if (!agentFile?.agentRequest) throw new ServiceError('agent_file_missing', `An ${audience} message needs a staged agent file.`, 'Stage an a2anotes.request/1 file with kind agent and pass its file_id.');
      const r = agentFile.agentRequest;
      if (messageId && r.message_id !== messageId) throw new ServiceError('agent_file_invalid', 'The agent file message_id does not match this draft.', `Write the agent file with message_id ${messageId}.`);
      if (r.audience !== audience) throw new ServiceError('agent_file_invalid', 'The agent file audience does not match the draft audience.');
      if (r.subject !== subject) throw new ServiceError('agent_file_invalid', 'The agent file subject does not match the draft subject.');
    }
    return { subject, body, audience, support, agentFile };
  }

  async createDraft(session: Session, input: { to_address?: unknown; subject?: unknown; body?: unknown; audience?: unknown; agent_file_id?: unknown; thread_id?: unknown; reply_to?: unknown; file_ids?: unknown; request_id?: unknown; instruction?: unknown; metadata?: unknown }) {
    const requestId = this.requestId(input.request_id);
    const earlier = this.store.read().requests[requestId];
    if (earlier) return this.get(session, earlier.id);
    const identity = this.transport.identity();
    if (!identity) throw new ServiceError('not_connected', 'Sign in to Slack first.', 'Open the review page and connect Slack.');
    let data = this.store.read();
    const fields = this.draftFields(data, input);
    if (typeof input.to_address !== 'string' || !isAddress(input.to_address)) throw new ServiceError('invalid_input', 'to_address must be a transport address.', 'Use a2anotes_find_people to get the address.');
    const to = input.to_address;
    let threadId: string, replyTo: string | null = null, threadTs: string | undefined;
    if (input.reply_to !== undefined && input.reply_to !== null && input.reply_to !== 'none') {
      const parent = data.notes.find(n => n.messageId === input.reply_to && !n.failure);
      if (!parent) throw new ServiceError('not_found', 'reply_to does not name a message in this store.');
      if (parent.direction === 'in' && !this.approvalValid(parent, data) && session.role !== 'person') throw new ServiceError('not_approved', 'Reply only to a message that was approved.');
      replyTo = parent.messageId; threadId = parent.threadId; threadTs = parent.transport?.threadTs || parent.transport?.ts;
      if (input.thread_id !== undefined && input.thread_id !== threadId) throw new ServiceError('invalid_input', 'thread_id does not match the thread of reply_to.');
    } else if (input.thread_id !== undefined) throw new ServiceError('invalid_input', 'A first message cannot give thread_id. Give reply_to to reply.');
    const messageId = fields.agentFile ? fields.agentFile.agentRequest!.message_id : randomUUID();
    if (!isUuid(messageId) || data.notes.some(n => n.messageId === messageId && n.direction === 'out')) throw new ServiceError('agent_file_invalid', 'The agent file message_id is already used by another draft.', 'Write a new agent file with a new message_id.');
    threadId ??= messageId;
    const person = await this.wrap(() => this.transport.checkRecipient(to));
    const instruction = typeof input.instruction === 'string' ? input.instruction.slice(0, 4000) : undefined;
    const metadata = checkMetadata(input.metadata);
    const files = [...(fields.agentFile ? [fields.agentFile] : []), ...fields.support];
    const now = new Date().toISOString();
    const note: Note = {
      id: messageId, messageId, direction: 'out', state: 'draft', from: identity.address, to, peerName: person.name, subject: fields.subject, body: fields.body,
      audience: fields.audience, threadId, replyTo, ...(fields.agentFile ? { agentFileId: fields.agentFile.id } : {}), fileIds: fields.support.map(f => f.id),
      hash: '', createdBy: { session: session.name, role: session.role }, ...(instruction ? { instruction } : {}), ...(metadata ? { metadata } : {}),
      ...(threadTs ? { transport: { name: this.transport.name, threadTs } } : {}), created: now, updated: now,
    };
    note.hash = noteHash(note, files);
    const finish = await this.check(note, files);
    this.store.change(d => {
      if (d.requests[requestId]) return;
      d.notes.push(note); d.requests[requestId] = { tool: 'create_draft', id: note.id, at: now };
      this.store.audit(d, session.name, 'create_draft', note.id);
    });
    finish?.();
    data = this.store.read();
    return this.get(session, data.requests[requestId].id);
  }

  async reviseDraft(session: Session, input: { id?: unknown; expected_hash?: unknown; subject?: unknown; body?: unknown; audience?: unknown; agent_file_id?: unknown; file_ids?: unknown; metadata?: unknown }) {
    const data = this.store.read();
    const n = data.notes.find(x => x.id === input.id && x.direction === 'out');
    if (!n) throw new ServiceError('not_found', 'No outgoing draft has this ID.');
    if (!this.canEdit(n, session)) throw new ServiceError('forbidden', 'Only the person or the agent that created this draft can revise it.');
    if (!['draft', 'approved', 'rejected', 'permanent_failure'].includes(n.state)) throw new ServiceError('not_editable', `A message in state ${n.state} cannot change.`);
    if (input.expected_hash !== n.hash) throw new ServiceError('hash_changed', 'The draft changed since you read it.', 'Read the draft again and revise the current version.');
    const fields = this.draftFields(data, input, n.messageId);
    const files = [...(fields.agentFile ? [fields.agentFile] : []), ...fields.support];
    const next: Note = { ...n, subject: fields.subject, body: fields.body, audience: fields.audience, fileIds: fields.support.map(f => f.id), state: 'draft' };
    // omitted metadata keeps the old metadata
    if (input.metadata !== undefined) { const m = checkMetadata(input.metadata); if (m) next.metadata = m; else delete next.metadata; }
    if (fields.agentFile) next.agentFileId = fields.agentFile.id; else delete next.agentFileId;
    delete next.approval; delete next.rejected; delete next.error;
    next.hash = noteHash(next, files);
    const finish = await this.check(next, files);
    this.store.update(n.id, (x, d) => {
      if (x.hash !== n.hash) throw new ServiceError('hash_changed', 'The draft changed during the revision.', 'Read it again.');
      Object.assign(x, next);
      if (!next.agentFileId) delete x.agentFileId;
      delete x.approval; delete x.rejected; delete x.error;
      if (!next.review) delete x.review;
      this.store.audit(d, session.name, 'revise_draft', n.id, 'approval ended');
    });
    finish?.();
    return this.get(session, n.id);
  }

  // Runs the checks on a draft and changes the note object. The fixed rules finish at once. A configured check
  // command can take longer: when the checks do not finish within checkWaitMs, the note keeps no verdict (so nobody
  // may approve it) and the returned function, called after the note is stored, saves the result later. The saved
  // result applies only while the draft still has the same hash.
  private async check(n: Note, files: StoredFile[]): Promise<(() => void) | undefined> {
    const rules = checkOutgoingBody(n.body, { agentFile: files.find(f => f.kind === 'agent')?.agentRequest, instruction: n.instruction });
    const work = this.runChecks(n, files, rules);
    const wait = this.options.checkWaitMs ?? 1500;
    const done = await Promise.race([work, new Promise<undefined>(r => setTimeout(() => r(undefined), wait).unref())]);
    if (done) { n.bodyCheck = done.bodyCheck; n.review = done.review; return undefined; }
    n.bodyCheck = { ...rules, state: 'checking' }; delete n.review;
    const id = n.id, hash = n.hash;
    return () => { void work.then(r => {
      try { this.store.update(id, x => { if (x.hash === hash) { x.bodyCheck = r.bodyCheck; x.review = r.review; } }); } catch { /* the draft was removed */ }
    }); };
  }
  private async runChecks(n: Note, files: StoredFile[], rules: BodyCheck): Promise<{ bodyCheck: BodyCheck; review: ReviewResult }> {
    const input = { direction: n.direction === 'in' ? 'incoming' as const : 'outgoing' as const, subject: n.subject, body: n.body, files: files.map(f => ({ name: f.name, text: this.fileText(f) })) };
    const [verdict, extra] = await Promise.all([
      review(input, this.reviewer),
      this.options.bodyChecker ? this.options.bodyChecker({ subject: n.subject, body: n.body, audience: n.audience, ...(n.instruction ? { instruction: n.instruction } : {}) }) : undefined,
    ]);
    if (!extra) return { bodyCheck: { ...rules, state: 'done' }, review: verdict };
    if (!extra.ok) return { review: verdict, bodyCheck: { ...rules, state: 'failed', flags: [...rules.flags,
      { code: 'check_failed', text: '', start: 0, end: 0, reason: 'The message check command did not finish. The person must approve this draft.' }] } };
    const flags = [...rules.flags, ...extra.flags.filter(f => !rules.flags.some(r => r.start <= f.start && r.end >= f.end))].sort((a, b) => a.start - b.start);
    return { bodyCheck: { ...rules, flags, state: 'done' }, review: verdict };
  }
  private fileText(f: StoredFile) {
    try { return fileTextForChecks(this.store.readFileBytes(f), f.name); } catch { return `(the file ${f.name} has no readable text)`; }
  }

  reviewMessage(session: Session, id: unknown) {
    const data = this.store.read();
    const n = data.notes.find(x => x.id === id);
    if (!n || !this.visible(n, data, session)) throw new ServiceError('not_found', 'No message has this ID.');
    const open = this.released(n, data, session);
    return { id: n.id, verdict: n.review?.verdict ?? null, reason: open ? n.review?.reason ?? n.failure?.reason ?? null : '(visible to the person only)',
      body_flags: open ? n.bodyCheck?.flags ?? [] : [], format_warnings: open ? n.bodyCheck?.warnings ?? [] : [], instruction: n.bodyCheck?.instruction ?? null, approver: this.approverFor(n, data), hash: n.hash };
  }

  approve(session: Session, input: { id?: unknown; expected_hash?: unknown; decision?: unknown; review_context?: unknown }) {
    if (session.role === 'agent') throw new ServiceError('forbidden', 'An agent session cannot approve messages.', 'Ask the person to approve it on the review page.');
    if (input.decision !== 'approve' && input.decision !== 'reject') throw new ServiceError('invalid_input', 'decision must be approve or reject.');
    const n = this.store.update(String(input.id), (n, data) => {
      if (input.expected_hash !== n.hash) throw new ServiceError('hash_changed', 'The message changed since you read it.', 'Read it again before you decide.');
      const approvable = n.direction === 'out' ? ['draft', 'approved'].includes(n.state) : n.state === 'held';
      if (!approvable) throw new ServiceError('not_approvable', `A message in state ${n.state} cannot be decided.`);
      const approver = this.approverFor(n, data);
      if (approver === 'nobody') throw new ServiceError('not_approvable', 'The checks hold this message. Nobody can approve it.', 'The person can inspect it on the review page.');
      if (session.role === 'reviewer' && approver !== 'reviewer') throw new ServiceError('needs_person', 'This message needs the person to decide.', 'Ask the person to open the review page.');
      const at = new Date().toISOString();
      if (input.decision === 'reject') { n.state = 'rejected'; n.rejected = { actor: session.name, at, ...(typeof input.review_context === 'string' && input.review_context.trim() ? { comment: input.review_context.slice(0, 2000) } : {}) }; delete n.approval; }
      else { n.state = 'approved'; n.approval = { by: session.role === 'person' ? 'person' : 'reviewer', actor: session.name, at, hash: n.hash, policyVersion: data.policy.version }; }
      this.store.audit(data, session.name, input.decision === 'reject' ? 'reject' : 'approve', n.id, typeof input.review_context === 'string' ? input.review_context : undefined);
    });
    return this.get(session, n.id);
  }

  private buildWire(n: Note, data: Data, fileMap: Record<string, string>, senderName: string): WireMessage {
    const files = this.files(data, n);
    const ref = (f: StoredFile): FileRef => ({ id: f.id, name: f.name, size: f.size, sha256: f.sha256 });
    const agent = files.find(f => f.kind === 'agent');
    return { id: n.messageId, from: n.from, to: n.to, subject: n.subject, audience: n.audience, threadId: n.threadId, replyTo: n.replyTo, body: n.body,
      ...(agent ? { agentFile: ref(agent) } : {}), files: files.filter(f => f.kind === 'support').map(ref),
      transportFiles: Object.keys(fileMap).length ? { [this.transport.fileField]: fileMap } : {}, footer: footerFor(senderName) };
  }

  async send(session: Session, input: { id?: unknown; expected_hash?: unknown; request_id?: unknown }) {
    const requestId = this.requestId(input.request_id);
    const id = String(input.id);
    let data = this.store.read();
    const n = data.notes.find(x => x.id === id && x.direction === 'out');
    if (!n) throw new ServiceError('not_found', 'No outgoing message has this ID.');
    if (!this.canSend(n, session)) throw new ServiceError('forbidden', 'An agent session cannot send messages.', 'Ask the person or the review agent to send it.');
    if (input.expected_hash !== n.hash) throw new ServiceError('hash_changed', 'The message changed since you read it.', 'Read it again.');
    if (n.state === 'sent') return this.get(session, id);
    if (n.state === 'queued' && Date.parse(n.nextRetryAt || '') > Date.now()) return this.get(session, id);
    if (this.sending.has(id) || n.state === 'sending') throw new ServiceError('send_in_progress', 'This message is being sent now.', 'Check its status in a minute.');
    if (!['approved', 'queued', 'delivery_uncertain'].includes(n.state)) throw new ServiceError('not_approved', 'Approve this message before it is sent.');
    if (!this.approvalValid(n, data)) throw new ServiceError('approval_invalid', 'The approval does not match the current message or levels.', 'Ask for a new approval.');
    if (!n.review || n.review.verdict === 'quarantine') throw new ServiceError('not_approved', 'The message has not passed the checks.');
    const identity = this.transport.identity();
    if (!identity) throw new ServiceError('not_connected', 'Sign in to Slack first.');
    if (identity.address !== n.from) throw new ServiceError('identity_changed', 'The Slack account changed. Connect the account that approved this draft.');
    this.sending.add(id);
    try {
      if (n.state === 'delivery_uncertain' || n.state === 'queued') {
        // look for the message in the conversation before a second send
        let found;
        try { found = await this.transport.findSent(n.to, n.messageId, n.sendStartedAt); }
        catch (error) { this.queue(id, error); return this.get(session, id); }
        if (found) {
          this.store.update(id, (x, d) => { x.state = 'sent'; x.sentAt = new Date().toISOString(); x.transport = { ...x.transport, name: this.transport.name, channel: found.channel, ts: found.ts }; delete x.error; delete x.nextRetryAt; this.store.audit(d, session.name, 'send_found', id); });
          return this.get(session, id);
        }
      }
      data = this.store.read();
      if (!this.approvalValid(n, data)) throw new ServiceError('approval_invalid', 'The approval does not match the current message or levels.', 'Ask for a new approval.');
      const files = this.files(data, n);
      const bytes = files.map(f => this.store.readFileBytes(f));
      const agentFile = files.find(f => f.kind === 'agent');
      const senderName = n.sendName || identity.name;
      this.store.update(id, (x, d) => {
        if (x.hash !== n.hash || !this.approvalValid(x, d)) throw new ServiceError('approval_invalid', 'The approval changed. Approve it again.');
        x.state = 'sending'; x.sendStartedAt ||= new Date().toISOString(); x.sendName ||= senderName; delete x.error;
        d.requests[requestId] = { tool: 'send', id, at: new Date().toISOString() };
        this.store.audit(d, session.name, 'send_attempt', id);
      });
      data = this.store.read();
      let result;
      try {
        result = await this.transport.send({
          to: n.to, messageId: n.messageId, threadTs: n.transport?.threadTs,
          files: files.map((f, i) => ({ id: f.id, name: f.name, bytes: bytes[i] })),
          wire: map => encode(this.buildWire(n, data, map, senderName)),
          display: { subject: n.subject, body: n.body, audience: n.audience, senderName,
            ...(agentFile ? { agentFile: { name: agentFile.name, size: agentFile.size } } : {}),
            files: files.filter(f => f.kind === 'support').map(f => ({ name: f.name, size: f.size })) },
        });
      } catch (error) {
        const retryable = !(error instanceof TransportError) || !error.definite || error.rateLimited;
        if (retryable) { this.queue(id, error); return this.get(session, id); }
        this.store.update(id, (x, d) => {
          x.state = 'permanent_failure'; delete x.nextRetryAt;
          x.error = `Slack did not post the message: ${(error as Error).message}`;
          this.store.audit(d, 'service', 'permanent_failure', id, (error as Error).message);
        });
        throw new ServiceError('send_failed', `The message was not sent: ${(error as Error).message}`, 'Revise the draft and approve the new version.');
      }
      this.store.update(id, (x, d) => {
        x.state = 'sent'; x.sentAt = new Date().toISOString(); delete x.error; delete x.nextRetryAt;
        x.transport = { ...x.transport, name: this.transport.name, channel: result.channel, ts: result.ts, files: result.files };
        this.store.audit(d, session.name, 'sent', id);
      });
      return this.get(session, id);
    } finally { this.sending.delete(id); }
  }

  markSeen(session: Session, id: unknown) {
    const data = this.store.read();
    const n = data.notes.find(x => x.id === id);
    if (!n || !this.visible(n, data, session)) throw new ServiceError('not_found', 'No message has this ID.');
    this.store.update(n.id, x => { x.seen ||= new Date().toISOString(); });
    return { id: n.id, seen: true };
  }

  setTrusted(session: Session, input: { address?: unknown; team_id?: unknown; user_id?: unknown; trusted?: unknown; name?: unknown }) {
    if (session.role !== 'person') throw new ServiceError('forbidden', 'Only the person can change trusted senders.', 'Use the review page.');
    const address = typeof input.address === 'string' ? input.address : typeof input.team_id === 'string' && typeof input.user_id === 'string' ? `slack:${input.team_id}:${input.user_id}` : '';
    if (!isAddress(address)) throw new ServiceError('invalid_input', 'Give a transport address, or team_id and user_id.');
    const at = new Date().toISOString();
    this.store.change(data => {
      data.trusted = data.trusted.filter(t => t.address !== address);
      if (input.trusted !== false) data.trusted.push({ address, name: typeof input.name === 'string' ? input.name.slice(0, 100) : address, at });
      this.store.audit(data, session.name, input.trusted === false ? 'untrust' : 'trust', undefined, address);
    });
    return { address, trusted: input.trusted !== false, at };
  }

  policy() { const d = this.store.read(); return { ...d.policy, trusted: d.trusted }; }
  setPolicy(session: Session, patch: unknown) {
    if (session.role !== 'person') throw new ServiceError('forbidden', 'Only the person can change the levels.', 'Use the review page.');
    let next: Policy | undefined;
    this.store.change(data => {
      try { next = checkPolicy(patch, data.policy); } catch (error) { throw new ServiceError('invalid_input', (error as Error).message); }
      data.policy = next; this.store.audit(data, session.name, 'set_policy', undefined, JSON.stringify(next));
    });
    return next!;
  }
  auditLog(session: Session, limit = 100) {
    if (session.role !== 'person') throw new ServiceError('forbidden', 'Only the person can read the audit records.');
    return this.store.read().audit.slice(-limit).reverse();
  }

  // ---- receive ----

  async scanNow() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      if (!this.transport.identity()) return;
      const health = this.store.read().health;
      if (health.rateLimitedUntil && Date.parse(health.rateLimitedUntil) > Date.now()) return;
      const at = new Date().toISOString();
      try {
        await this.transport.scan(this.store.read().cursors, m => this.receive(m), (conversation, ts) => this.store.change(d => { d.cursors[conversation] = ts; }));
        this.store.change(d => { d.health = { ...d.health, lastScanAt: at, lastSuccessAt: at, scans: (d.health.scans || 0) + 1 }; delete d.health.lastError; delete d.health.rateLimitedUntil; });
      } catch (error) {
        const retry = error instanceof TransportError ? error.retryAfter : 0;
        this.store.change(d => {
          d.health = { ...d.health, lastScanAt: at, lastError: (error as Error).message.slice(0, 300), scans: (d.health.scans || 0) + 1 };
          if (retry) d.health.rateLimitedUntil = new Date(Date.now() + retry * 1000).toISOString();
        });
        throw error;
      }
    })().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  // Stores one received transport message. Malformed text is kept for the person with a reason and a bounded raw copy.
  // A download that may work later throws, so the adapter does not move the cursor past this message.
  async receive(m: Received) {
    const identity = this.transport.identity();
    if (!identity) throw new TransportError('Slack was disconnected during the scan.', false);
    const id = `in-${createHash('sha256').update(m.ref).digest('hex').slice(0, 32)}`;
    if (this.store.read().notes.some(n => n.id === id)) return;
    const now = new Date().toISOString();
    const base = { id, direction: 'in' as const, from: m.sender, to: identity.address, fileIds: [] as string[], created: now, updated: now,
      transport: { name: this.transport.name, channel: m.channel, ts: m.ts, ...(m.threadTs ? { threadTs: m.threadTs } : {}) } };
    const fail = (code: string, reason: string, extra: Partial<Note> = {}) => this.store.change(d => {
      if (d.notes.some(n => n.id === id)) return;
      d.notes.push({ ...base, messageId: extra.messageId || randomUUID(), state: 'failed', subject: extra.subject || '(message could not be read)', body: '', audience: extra.audience || 'person',
        threadId: extra.threadId || randomUUID(), replyTo: null, hash: '', failure: { code, reason, raw: rawCopy(m.text) } });
      this.store.audit(d, 'service', 'parse_failure', id, `${code}: ${reason}`);
    });
    if (m.error) return fail('malformed', m.error);
    const decoded = decode(m.text);
    if (!decoded.ok) {
      if (decoded.code === 'not_a2anotes') return; // ordinary Slack chat stays outside the inbox
      return fail(decoded.code, decoded.reason);
    }
    const w = decoded.message;
    const known = { messageId: w.id, subject: w.subject, audience: w.audience, threadId: w.threadId };
    // the Slack event and the signed-in member decide identity; the header must agree with both
    if (w.from !== m.sender) return fail('identity_mismatch', `The From field says ${w.from}, but Slack says ${m.sender} sent it.`, known);
    if (w.to !== identity.address) return fail('identity_mismatch', `The To field says ${w.to}, but this inbox is ${identity.address}.`, known);
    if (this.store.read().notes.some(n => n.direction === 'in' && n.from === w.from && n.messageId === w.id && !n.failure)) return;
    const stored: StoredFile[] = [];
    // a failed file check keeps no bytes: remove the files that this message already wrote
    const failFiles = (code: string, reason: string) => { for (const f of stored) { try { unlinkSync(this.store.filePath(f.id)); } catch { /* not written */ } } return fail(code, reason, known); };
    for (const ref of [...(w.agentFile ? [w.agentFile] : []), ...w.files]) {
      const kind = ref === w.agentFile ? 'agent' : 'support';
      const slackId = w.transportFiles[this.transport.fileField]?.[ref.id];
      if (!slackId) return failFiles('file_missing', `The message lists ${ref.name}, but no ${this.transport.fileField} file carries it.`);
      let bytes: Buffer;
      try { bytes = await this.transport.download(slackId, m, MAX_FILE_BYTES); }
      catch (error) { if (error instanceof TransportError && error.definite) return failFiles('file_check_failed', error.message); throw error; }
      if (bytes.length !== ref.size || sha256(bytes) !== ref.sha256) return failFiles('file_check_failed', `The file ${ref.name} does not match its size and hash.`);
      let agentRequest;
      if (kind === 'agent') {
        try { agentRequest = readAgentFile(bytes, ref, w); }
        catch (error) { return failFiles(error instanceof ProtocolError ? error.code : 'agent_file_invalid', (error as Error).message); }
      }
      const file: StoredFile = { id: randomUUID(), name: ref.name, size: ref.size, sha256: ref.sha256, kind, direction: 'in', created: now, ...(agentRequest ? { agentRequest } : {}) };
      this.store.writeFileBytes(file.id, bytes);
      stored.push(file);
    }
    const peerName = await this.transport.nameOf?.(m.sender);
    const note: Note = { ...base, ...known, ...(peerName ? { peerName } : {}), replyTo: w.replyTo, body: w.body, state: 'held', hash: '',
      ...(stored[0]?.kind === 'agent' ? { agentFileId: stored[0].id } : {}), fileIds: stored.filter(f => f.kind === 'support').map(f => f.id) };
    note.hash = noteHash(note, stored);
    note.review = await review({ direction: 'incoming', subject: note.subject, body: note.body, files: stored.map(f => ({ name: f.name, text: this.fileText(f) })) }, this.reviewer);
    if (note.review.verdict === 'quarantine') note.state = 'quarantined';
    this.store.change(d => {
      if (d.notes.some(n => n.id === id)) return;
      d.files.push(...stored); d.notes.push(note);
      this.store.audit(d, 'service', 'received', id, note.review!.verdict);
    });
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (error instanceof TransportError) {
        if (error.retryAfter) throw new ServiceError('rate_limited', error.message, `Wait ${error.retryAfter} seconds.`);
        throw new ServiceError(error.definite ? 'transport_error' : 'transport_unavailable', error.message, error.definite ? 'Check the input and the Slack connection.' : 'Try again later.');
      }
      throw error;
    }
  }
}

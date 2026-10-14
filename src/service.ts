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
import { noteHash, ServiceError, Store, type Data, type AgentDeliveryStatus, type Metadata, type Note, type Role, type StoredFile } from './store.ts';
import { Acknowledgements } from './acknowledgement.ts';
import { TransportError, type Received, type SendInput, type Transport } from './transport.ts';

export interface Session { name: string; role: Role; humanApproval?: boolean }
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
  retryIntervalMs?: number;
  now?: () => number;
  random?: () => number;
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
  private retryTimer?: NodeJS.Timeout;
  private now() { return (this.options.now || Date.now)(); }
  private at() { return new Date(this.now()).toISOString(); }
  private scanning?: Promise<void>;
  private sending = new Set<string>();
  private active = new Set<Promise<void>>();
  private humanApprovals = new Set<string>();
  private stopping = false;
  private acknowledgements: Acknowledgements;
  constructor(private options: ServiceOptions) {
    this.store = options.store;
    this.transport = options.transport;
    this.reviewer = options.reviewer;
    this.acknowledgements = new Acknowledgements(this.store, this.transport, () => this.now());
  }

  // After a restart: a message that was sending when the process stopped may or may not be in Slack.
  start() {
    this.stopping = false;
    this.acknowledgements.start();
    this.store.change(data => {
      for (const n of data.notes) if (n.direction === 'out' && !n.delivery && ['queued', 'sending', 'delivery_uncertain'].includes(n.state)) {
        n.delivery = { hash: n.approval?.hash || n.hash, actor: n.approval?.actor || 'service',
          attempts: n.retryCount || 0, rateLimits: 0, nextAttemptAt: n.nextRetryAt || this.at(),
          uncertain: n.state !== 'queued' || !!n.sendStartedAt };
        if (n.delivery.uncertain) n.state = 'delivery_uncertain';
        delete n.nextRetryAt; delete n.retryCount;
      }
      for (const n of data.notes) if (n.direction === 'out' && n.state === 'sending') {
        n.state = n.checkpoint && !n.checkpoint.postStarted ? 'queued' : 'delivery_uncertain';
        n.error = 'The service stopped during the send. Saved progress will be checked.';
        if (n.delivery) { n.delivery.uncertain = n.state === 'delivery_uncertain'; n.delivery.nextAttemptAt ||= this.at(); }
        this.store.audit(data, 'service', 'delivery_uncertain', n.id, 'restart during send');
      }
    });
    const retryEvery = this.options.retryIntervalMs ?? 1000;
    if (retryEvery > 0) {
      this.retryTimer = setInterval(() => { void this.processQueue().catch(() => {}); }, retryEvery);
      this.retryTimer.unref();
    }
    const every = this.options.scanIntervalMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => {
        const at = this.store.read().health.lastScanAt;
        if (this.desktopListening && at && Date.now() - Date.parse(at) < 300_000) return;
        void this.scanNow().catch(() => {});
      }, every);
      this.timer.unref();
      void this.scanNow().catch(() => {});
    }
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.timer = undefined; this.retryTimer = undefined;
    await Promise.allSettled([...this.active]);
    await this.scanning?.catch(() => {});
    await this.acknowledgements.stop();
  }

  private desktopListening = false;
  desktopStatus?: () => import('./slack-desktop.ts').DesktopStatus;
  setDesktopListening(connected: boolean) { this.desktopListening = connected; }

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
    if (n.ownerMessage && noteHash(n, this.files(this.store.read(), n)) !== n.hash) return false;
    if (!n.approval || n.approval.hash !== n.hash || n.approval.policyVersion !== data.policy.version || n.state === 'rejected') return false;
    const approver = this.approverFor(n, data);
    return n.approval.by === 'person' ? approver !== 'nobody' : approver === 'reviewer';
  }

  // ---- views ----

  private files(data: Data, n: Note) {
    return [...(n.agentFileId ? [n.agentFileId] : []), ...n.fileIds].map(id => data.files.find(f => f.id === id)).filter((f): f is StoredFile => !!f);
  }
  private allowed(n: Note, data: Data, session: Session) {
    const approver = this.approverFor(n, data), actions: string[] = [];
    if ((session.role === 'person' || session.humanApproval) && approver !== 'nobody' &&
      (n.direction === 'out' ? ['draft', 'approved'].includes(n.state) : n.state === 'held')) actions.push('request_approval');
    const canApprove = session.role === 'person' ? approver !== 'nobody' : session.role === 'reviewer' && approver === 'reviewer';
    if (n.direction === 'out') {
      if (this.editable(n) && this.canEdit(n, session)) actions.push('revise');
      if (['draft', 'approved'].includes(n.state) && canApprove) actions.push('approve', 'reject');
      if ((n.state === 'approved' && this.approvalValid(n, data) || n.state === 'delivery_uncertain' && !n.delivery) && this.canSend(n, session)) actions.push('send');
      if (this.retryableBeforePost(n) && this.approvalValid(n, data) && this.canSend(n, session) && this.transport.verifyRetry) actions.push('retry_send');
    } else {
      if (n.state === 'held' && canApprove) actions.push('approve', 'reject');
      if (n.state === 'approved' && this.approvalValid(n, data)) actions.push('reply', ...(n.audience !== 'person' ? ['release_to_agent'] : []));
      actions.push('mark_seen');
      if (this.canAcknowledge(n, data, session)) actions.push('ack');
    }
    return actions;
  }
  private editable(n: Note) {
    if (['draft', 'approved', 'rejected'].includes(n.state)) return true;
    if (n.state === 'queued') return n.delivery?.attempts === 0;
    return n.state === 'permanent_failure' && !n.delivery?.uncertain &&
      !Object.values(n.checkpoint?.uploads || {}).some(u => u.phase === 'completing');
  }
  private canEdit(n: Note, session: Session) { return session.role === 'person' || n.createdBy?.session === session.name; }
  // the design lets an agent write and revise drafts; only the person or the review agent sends
  private canSend(_n: Note, session: Session) { return session.role !== 'agent'; }
  private retryableBeforePost(n: Note) {
    return n.direction === 'out' && n.state === 'permanent_failure' && !!n.delivery?.stoppedAt &&
      n.delivery.attempts > 0 && n.delivery.attempts < 8 && !n.delivery.uncertain && !n.transport?.ts &&
      !!n.checkpoint?.channel && !n.checkpoint.postStarted &&
      (n.delivery.failureCode === 'app_control_unavailable' || n.delivery.failureCode === 'transport_error' &&
        n.error === 'The Slack app control is unavailable. No action was confirmed.');
  }

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
      next_retry_at: n.delivery?.nextAttemptAt ?? n.nextRetryAt ?? null, sent_at: n.sentAt ?? null,
      source: n.source ?? 'a2anotes', direct_target: n.directTarget ?? null, owner_message: this.isOwnerMessage(n, data), delivery: n.delivery ?? null, error: n.error ?? null,
      acknowledgement: n.acknowledgement ?? null, agent_delivery: n.agentDelivery ?? null, delivery_notice: n.deliveryNotice ?? null,
      metadata: n.metadata ?? null, reply_to_local: this.replyLink(n, data),
      hash: n.hash, allowed_actions: this.allowed(n, data, session),
    };
  }
  // The local outgoing message that an incoming reply answers, with its metadata. The link exists only when the reply
  // comes from the address that received the original, so a message from someone else cannot claim a local task.
  replyLink(n: Note, data: Data) {
    if (n.direction !== 'in' || !n.replyTo || n.failure) return null;
    const original = data.notes.find(x => x.direction === 'out' && x.messageId === n.replyTo && x.to === n.from && x.threadId === n.threadId && x.state === 'sent');
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
    return id ? { transport: id.transport, address: id.address, name: id.name, connected: id.available !== false && !id.missingScopes.length, scopes: id.scopes } : { transport: this.transport.name, connected: false };
  }
  connectionStatus() {
    const id = this.transport.identity(), health = this.store.read().health;
    const stale = !health.lastSuccessAt || Date.now() - Date.parse(health.lastSuccessAt) > 5 * 60_000;
    return { transport: this.transport.name, signed_in: !!id, available: id?.available !== false && !!id, address: id?.address ?? null, missing_scopes: id?.missingScopes ?? [], optional_missing: id?.optionalMissing ?? [],
      last_scan_at: health.lastScanAt ?? null, last_success_at: health.lastSuccessAt ?? null, last_error: health.lastError ?? null,
      rate_limited_until: health.rateLimitedUntil && Date.parse(health.rateLimitedUntil) > Date.now() ? health.rateLimitedUntil : null, stale, ...(this.desktopStatus ? { desktop: this.desktopStatus() } : {}) };
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
    this.checkDraftTransport(note, data, identity.name);
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
    if (this.sending.has(n.id)) throw new ServiceError('send_in_progress', 'This note is being sent.');
    if (!this.canEdit(n, session)) throw new ServiceError('forbidden', 'Only the person or the agent that created this draft can revise it.');
    if (!this.editable(n)) throw new ServiceError('not_editable', `A message in state ${n.state} cannot change.`);
    if (input.expected_hash !== n.hash) throw new ServiceError('hash_changed', 'The draft changed since you read it.', 'Read the draft again and revise the current version.');
    const fields = this.draftFields(data, input, n.messageId);
    const files = [...(fields.agentFile ? [fields.agentFile] : []), ...fields.support];
    const next: Note = { ...n, subject: fields.subject, body: fields.body, audience: fields.audience, fileIds: fields.support.map(f => f.id), state: 'draft' };
    // omitted metadata keeps the old metadata
    if (input.metadata !== undefined) { const m = checkMetadata(input.metadata); if (m) next.metadata = m; else delete next.metadata; }
    if (fields.agentFile) next.agentFileId = fields.agentFile.id; else delete next.agentFileId;
    delete next.approval; delete next.rejected; delete next.error; delete next.delivery; delete next.checkpoint;
    next.hash = noteHash(next, files);
    const identity = this.transport.identity();
    if (!identity || identity.address !== next.from) throw new ServiceError('not_connected', 'Connect the original Slack app account before revising this draft.');
    this.checkDraftTransport(next, data, identity.name);
    const finish = await this.check(next, files);
    this.store.update(n.id, (x, d) => {
      if (x.hash !== n.hash) throw new ServiceError('hash_changed', 'The draft changed during the revision.', 'Read it again.');
      Object.assign(x, next);
      if (!next.agentFileId) delete x.agentFileId;
      delete x.approval; delete x.rejected; delete x.error; delete x.delivery; delete x.checkpoint;
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

  // Only a registered human client can receive private text in a confirmation form.
  // The callback represents the client's human interface, never a tool argument.
  async requestHumanApproval(session: Session, input: { id: string; expected_hash: string },
    confirm: (message: ReturnType<NotesService['detail']>) => Promise<'approve' | 'reject' | 'cancel'>) {
    if (session.role !== 'person' && !session.humanApproval)
      throw new ServiceError('human_approval_not_enabled', 'This client is not registered for human confirmation.', 'Register a trusted interactive client with token add --role agent --human-approval.');
    const data = this.store.read(), n = data.notes.find(x => x.id === input.id);
    if (!n) throw new ServiceError('not_found', 'No message has this ID.');
    if (n.hash !== input.expected_hash) throw new ServiceError('hash_changed', 'The message changed since you read it.');
    if (n.approval && this.approvalValid(n, data) && (n.direction === 'in' && n.state === 'approved' || n.direction === 'out' && ['queued', 'sending', 'sent', 'delivery_uncertain', 'permanent_failure'].includes(n.state)))
      return this.get(session, n.id);
    if (!(n.direction === 'out' ? ['draft', 'approved'].includes(n.state) : n.state === 'held') || this.approverFor(n, data) === 'nobody')
      throw new ServiceError('not_approvable', 'This message cannot be decided under the current checks.');
    const validateContent = (note: Note, records: Data) => {
      const files = this.files(records, note);
      if (files.length !== note.fileIds.length + (note.agentFileId ? 1 : 0) || noteHash(note, files) !== input.expected_hash)
        throw new ServiceError('hash_changed', 'The note content or file records changed.');
      for (const file of files) this.store.readFileBytes(file);
    };
    validateContent(n, data);
    if (this.humanApprovals.has(n.id)) throw new ServiceError('approval_in_progress', 'A human confirmation is already open for this note.');
    if (this.humanApprovals.size >= 128) throw new ServiceError('too_many_confirmations', 'Too many human confirmations are open.', 'Finish an open confirmation before requesting another.');
    const policy = JSON.stringify({ policy: data.policy, trusted: data.trusted });
    const started = this.now(), state = n.state, hash = n.hash;
    this.humanApprovals.add(n.id);
    try {
      const decision = await confirm(this.detail(n, data, { name: session.name, role: 'person' }));
      if (decision === 'cancel') return { ...this.get(session, n.id), confirmation: 'cancelled' };
      if (decision !== 'approve' && decision !== 'reject') throw new ServiceError('invalid_confirmation', 'The client did not return a valid human decision.');
      if (this.now() - started >= 300_000) throw new ServiceError('confirmation_expired', 'The human confirmation expired.');
      const current = this.store.read(), latest = current.notes.find(x => x.id === n.id);
      if (!latest || latest.hash !== hash) throw new ServiceError('hash_changed', 'The message changed while the confirmation was open.');
      if (latest.state !== state) throw new ServiceError('state_changed', 'Another decision changed this message while the confirmation was open.');
      if (JSON.stringify({ policy: current.policy, trusted: current.trusted }) !== policy)
        throw new ServiceError('policy_changed', 'The approval rules changed while the confirmation was open.');
      validateContent(latest, current);
      this.approve({ name: `human:${session.name}`, role: 'person' }, { ...input, decision, review_context: `Human confirmation through MCP client ${session.name}.` });
      return this.get(session, n.id);
    } finally { this.humanApprovals.delete(n.id); }
  }

  approve(session: Session, input: { id?: unknown; expected_hash?: unknown; decision?: unknown; review_context?: unknown }) {
    if (session.role === 'agent') throw new ServiceError('forbidden', 'An agent session cannot approve messages.', 'Use a2anotes_request_approval with a registered interactive client, or ask the person to use the review page.');
    if (input.decision !== 'approve' && input.decision !== 'reject') throw new ServiceError('invalid_input', 'decision must be approve or reject.');
    const n = this.store.update(String(input.id), (n, data) => {
      if (input.expected_hash !== n.hash) throw new ServiceError('hash_changed', 'The message changed since you read it.', 'Read it again before you decide.');
      const approvable = n.direction === 'out' ? ['draft', 'approved'].includes(n.state) : n.state === 'held';
      if (!approvable) throw new ServiceError('not_approvable', `A message in state ${n.state} cannot be decided.`);
      const approver = this.approverFor(n, data);
      if (approver === 'nobody') throw new ServiceError('not_approvable', 'The checks hold this message. Nobody can approve it.', 'The person can inspect it on the review page.');
      if (session.role === 'reviewer' && approver !== 'reviewer') throw new ServiceError('needs_person', 'This message needs the person to decide.', 'Ask the person to open the review page.');
      if (n.direction === 'out' && input.decision === 'approve') {
        const identity = this.transport.identity();
        if (!identity || identity.address !== n.from) throw new ServiceError('not_connected', 'Connect the original Slack app account before approval.');
        this.checkDraftTransport(n, data, identity.name);
      }
      const at = new Date().toISOString();
      if (input.decision === 'reject') { n.state = 'rejected'; n.rejected = { actor: session.name, at, ...(typeof input.review_context === 'string' && input.review_context.trim() ? { comment: input.review_context.slice(0, 2000) } : {}) }; delete n.approval; }
      else {
        n.state = n.direction === 'out' ? 'queued' : 'approved';
        n.approval = { by: session.role === 'person' ? 'person' : 'reviewer', actor: session.name, at, hash: n.hash, policyVersion: data.policy.version };
        if (n.direction === 'out') n.delivery = { hash: n.hash, actor: session.name, attempts: 0, rateLimits: 0, nextAttemptAt: this.at() };
      }
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

  private checkDraftTransport(n: Note, data: Data, senderName: string) {
    if (!this.transport.checkDraft) return;
    const files = this.files(data, n), agent = files.find(f => f.kind === 'agent');
    const input: SendInput = {
      to: n.to, messageId: n.messageId, threadTs: n.transport?.threadTs,
      files: files.map(f => ({id: f.id, name: f.name, bytes: this.store.readFileBytes(f)})),
      wire: map => encode(this.buildWire(n, data, map, senderName)),
      display: {messageId: n.messageId, subject: n.subject, body: n.body, audience: n.audience, senderName,
        ...(agent ? {agentFile: {name: agent.name, size: agent.size}} : {}),
        files: files.filter(f => f.kind === 'support').map(f => ({name: f.name, size: f.size}))},
    };
    try { this.transport.checkDraft(input); }
    catch (error) {
      if (error instanceof TransportError || error instanceof ProtocolError)
        throw new ServiceError('transport_limit', (error as Error).message, 'Revise the draft before approval.');
      throw error;
    }
  }

  async send(session: Session, input: { id?: unknown; expected_hash?: unknown; request_id?: unknown }) {
    const requestId = this.requestId(input.request_id), id = String(input.id);
    const n = this.store.note(id);
    if (!n || n.direction !== 'out') throw new ServiceError('not_found', 'No outgoing message has this ID.');
    if (!this.canSend(n, session)) throw new ServiceError('forbidden', 'An agent session cannot send messages.');
    if (input.expected_hash !== n.hash) throw new ServiceError('hash_changed', 'The message changed since you read it.');
    if (n.state === 'sent' || n.state === 'permanent_failure') return this.get(session, id);
    if (this.sending.has(id) || n.state === 'sending') throw new ServiceError('send_in_progress', 'This message is being sent now.');
    if (!['approved', 'queued', 'delivery_uncertain'].includes(n.state)) throw new ServiceError('not_approved', 'Approve this message before it is sent.');
    if (!n.delivery) {
      if (!this.approvalValid(n, this.store.read())) throw new ServiceError('approval_invalid', 'The approval does not match the current message or levels.');
      this.store.update(id, (x, d) => {
        x.delivery = { hash: x.hash, actor: session.name, attempts: 0, rateLimits: 0, nextAttemptAt: this.at(), uncertain: x.state === 'delivery_uncertain' };
        if (x.state !== 'delivery_uncertain') x.state = 'queued';
        d.requests[requestId] = { tool: 'send', id, at: this.at() };
        this.store.audit(d, session.name, 'send_queued', id);
      });
    }
    await this.attemptSend(id);
    return this.get(session, id);
  }

  async retrySend(session: Session, input: { id?: unknown; expected_hash?: unknown; request_id?: unknown }) {
    const requestId = this.requestId(input.request_id), id = String(input.id);
    const validate = (data: Data) => {
      const n = data.notes.find(n => n.id === id && n.direction === 'out');
      if (!n) throw new ServiceError('not_found', 'No outgoing message has this ID.');
      if (!this.canSend(n, session)) throw new ServiceError('forbidden', 'An agent session cannot retry a send.');
      if (input.expected_hash !== n.hash) throw new ServiceError('hash_changed', 'The message changed since you read it.');
      if (!this.approvalValid(n, data) || n.delivery?.hash !== n.hash)
        throw new ServiceError('approval_invalid', 'The content or current policy no longer permits this send.');
      const files = this.files(data, n);
      if (files.length !== n.fileIds.length + (n.agentFileId ? 1 : 0) || noteHash(n, files) !== n.hash)
        throw new ServiceError('content_changed', 'The approved content or file records changed.');
      for (const file of files) this.store.readFileBytes(file);
      const identity = this.transport.identity();
      if (!identity || identity.address !== n.from || identity.missingScopes.length || identity.available === false)
        throw new ServiceError('invalid_credentials', 'The connected sender no longer matches this note.');
      const earlier = data.requests[requestId];
      if (earlier && (earlier.tool !== 'retry_send' || earlier.id !== id))
        throw new ServiceError('request_conflict', 'This request_id belongs to another operation.');
      return {n, earlier};
    };
    const {n, earlier} = validate(this.store.read());
    if (earlier || ['queued', 'sending', 'sent'].includes(n.state)) return this.get(session, id);
    if (this.stopping) throw new ServiceError('service_stopping', 'The service is stopping.');
    if (!this.retryableBeforePost(n)) throw new ServiceError('retry_not_permitted', 'This failure does not permit another post.');
    if (!this.transport.verifyRetry) throw new ServiceError('retry_not_supported', 'This transport cannot verify saved attempts.');
    if (this.sending.has(id)) throw new ServiceError('send_in_progress', 'This message is already being checked.');
    this.sending.add(id);
    try {
      await this.transport.verifyRetry(n.to, n.messageId, n.checkpoint!);
      if (this.stopping) throw new ServiceError('service_stopping', 'The service is stopping.');
      this.store.update(id, (x, data) => {
        validate(data);
        if (!this.retryableBeforePost(x)) throw new ServiceError('retry_not_permitted', 'The saved delivery changed during the check.');
        x.state = 'queued'; delete x.error;
        delete x.delivery!.stoppedAt; delete x.delivery!.failureCode;
        x.delivery!.nextAttemptAt = this.at();
        data.requests[requestId] = {tool:'retry_send', id, at:this.at()};
        this.store.audit(data, session.name, 'send_retry_queued', id);
      });
      return this.get(session, id);
    } finally { this.sending.delete(id); }
  }

  async processQueue() {
    if (this.stopping) return;
    await this.acknowledgements.process();
    const due = this.store.read().notes.filter(n => n.direction === 'out' &&
      ['queued', 'delivery_uncertain'].includes(n.state) && n.delivery?.nextAttemptAt &&
      Date.parse(n.delivery.nextAttemptAt) <= this.now());
    for (const n of due) await this.attemptSend(n.id).catch(() => {});
  }

  private finishFailure(id: string, code: string, reason: string) {
    this.store.update(id, (x, d) => {
      x.state = 'permanent_failure'; x.error = reason;
      if (x.delivery && (x.checkpoint?.postStarted || code === 'delivery_uncertain')) x.delivery.uncertain = true;
      if (x.delivery) { x.delivery.failureCode = code; x.delivery.stoppedAt = this.at(); delete x.delivery.nextAttemptAt; }
      this.store.audit(d, 'service', 'permanent_failure', id, `${code}: ${reason}`);
    });
  }

  private attemptSend(id: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const work = this.runAttempt(id);
    this.active.add(work);
    return work.finally(() => { this.active.delete(work); });
  }

  private async runAttempt(id: string) {
    if (this.sending.has(id)) return;
    const data = this.store.read(), n = data.notes.find(x => x.id === id)!;
    const delivery = n.delivery;
    if (!delivery || delivery.stoppedAt || !delivery.nextAttemptAt || Date.parse(delivery.nextAttemptAt) > this.now()) return;
    this.sending.add(id);
    try {
      if (n.hash !== delivery.hash || !this.approvalValid(n, data)) {
        this.finishFailure(id, 'approval_invalid', 'The message or current policy no longer permits this send.'); return;
      }
      const identity = this.transport.identity();
      if (!identity || identity.address !== n.from || identity.missingScopes.length) {
        this.finishFailure(id, 'invalid_credentials', 'The connected sender or Slack scopes no longer match this note.'); return;
      }
      const files = this.files(data, n);
      if (files.length !== n.fileIds.length + (n.agentFileId ? 1 : 0) || noteHash(n, files) !== delivery.hash) {
        this.finishFailure(id, 'content_changed', 'The approved content or file records changed.'); return;
      }
      const bytes = files.map(f => this.store.readFileBytes(f));
      this.store.update(id, (x, d) => {
        x.state = 'sending'; x.sendStartedAt ||= this.at(); x.sendName ||= identity.name; x.delivery!.attempts++;
        this.store.audit(d, delivery.actor, 'send_attempt', id);
      });
      // A note with postedTs is posted, and the next attempt only attaches its files.
      if ((delivery.uncertain || n.checkpoint?.postStarted) && !n.checkpoint?.postedTs) {
        const found = await this.transport.findSent(n.to, n.messageId, n.sendStartedAt, {
          cursor: n.checkpoint?.reconcileCursor,
          expectedFiles: files.filter(f => f.kind === 'support').map(f => ({name: f.name, size: f.size})),
          save: cursor => this.store.update(id, x => {
            x.checkpoint ||= { uploads: {}, postStarted: true };
            x.checkpoint.reconcileCursor = cursor;
          }),
        });
        if (found?.filesMissing) {
          this.store.update(id, x => { x.checkpoint ||= { uploads: {}, postStarted: true }; x.checkpoint.postedTs = found.ts; x.checkpoint.channel ||= found.channel; });
        } else if (found) {
          this.store.update(id, (x, d) => {
            x.state = 'sent'; x.sentAt = this.at(); delete x.error; delete x.delivery!.nextAttemptAt;
            const uploaded = Object.fromEntries(Object.entries(x.checkpoint?.uploads || {}).filter(([, u]) => u.phase === 'complete').map(([key, u]) => [key, u.fileId]));
            x.transport = { ...x.transport, name: this.transport.name, channel: found.channel, ts: found.ts, files: uploaded };
            this.store.audit(d, 'service', 'send_found', id);
          }); return;
        }
        else throw new TransportError('Slack has not confirmed delivery. No second post was attempted.', false, 0, 'conversations.history');
      }
      const agentFile = files.find(f => f.kind === 'agent');
      const result = await this.transport.send({
        to: n.to, messageId: n.messageId, threadTs: n.transport?.threadTs,
        checkpoint: this.store.note(id)!.checkpoint || { uploads: {} },
        saveCheckpoint: checkpoint => this.store.update(id, (x, current) => {
          if (this.stopping) throw new ServiceError('service_stopping', 'The service is stopping. Saved progress remains available.');
          if (x.hash !== delivery.hash || !this.approvalValid(x, current) || noteHash(x, this.files(current, x)) !== delivery.hash)
            throw new ServiceError('approval_invalid', 'The content or policy changed during the send.');
          for (const file of this.files(current, x)) this.store.readFileBytes(file);
          x.checkpoint = checkpoint;
        }),
        files: files.map((f, i) => ({ id: f.id, name: f.name, bytes: bytes[i] })),
        wire: map => encode(this.buildWire(n, data, map, n.sendName || identity.name)),
        display: { messageId: n.messageId, subject: n.subject, body: n.body, audience: n.audience, senderName: n.sendName || identity.name,
          ...(agentFile ? { agentFile: { name: agentFile.name, size: agentFile.size } } : {}),
          files: files.filter(f => f.kind === 'support').map(f => ({ name: f.name, size: f.size })) },
      });
      this.store.update(id, (x, d) => {
        x.state = 'sent'; x.sentAt = this.at(); delete x.error; delete x.delivery!.nextAttemptAt;
        x.transport = { ...x.transport, name: this.transport.name, channel: result.channel, ts: result.ts, files: result.files };
        this.store.audit(d, delivery.actor, 'sent', id);
      });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      const t = error instanceof TransportError ? error : undefined;
      const current = this.store.note(id)!;
      if (error instanceof ServiceError && error.code === 'service_stopping') {
        this.store.update(id, x => { x.state = x.checkpoint?.postStarted ? 'delivery_uncertain' : 'queued'; }); return;
      }
      const uncertain = t && !t.definite;
      const quotaWait = !!t?.retryAfter && t.status === 0;
      const attempts = current.delivery!.attempts - (quotaWait ? 1 : 0);
      if ((t?.rateLimited || uncertain) && attempts < 8) {
        const count = current.delivery!.rateLimits + (t?.rateLimited && !quotaWait ? 1 : 0);
        const backoff = Math.min(300, 2 ** Math.min(9, current.delivery!.attempts)) * (0.5 + (this.options.random || Math.random)() * 0.5);
        const fallback = Math.min(300, 60 * 2 ** Math.min(5, count - 1)) * (0.5 + (this.options.random || Math.random)() * 0.5);
        const seconds = t?.rateLimited ? t.retryAfter ? Math.max(t.retryAfter, count > 1 ? backoff : 0) : fallback : backoff;
        this.store.update(id, (x, d) => {
          x.state = x.delivery!.uncertain || x.checkpoint?.postStarted || uncertain && !x.checkpoint ? 'delivery_uncertain' : 'queued';
          x.delivery!.uncertain = x.state === 'delivery_uncertain';
          x.delivery!.attempts = attempts; x.delivery!.rateLimits = count; x.delivery!.nextAttemptAt = new Date(this.now() + seconds * 1000).toISOString();
          x.delivery!.lastMethod = t?.method; x.delivery!.lastStatus = t?.status;
          x.delivery!.lastRequestId = t?.requestId; x.delivery!.lastRetryAfter = t?.retryAfter;
          x.error = e.message; this.store.audit(d, 'service', 'send_waiting', id, `${t?.method || 'transport'}: ${e.message}`);
        });
        if (uncertain) throw new ServiceError('delivery_uncertain', e.message, 'The service checks saved progress before a retry.');
        return;
      }
      this.finishFailure(id, t?.rateLimited ? 'retry_exhausted' : uncertain ? 'delivery_uncertain' : error instanceof ServiceError ? error.code : t?.failureCode || 'transport_error', e.message);
      if (!t?.rateLimited) throw new ServiceError('send_failed', e.message, 'Read the final failure. This note will not retry.');
    } finally { this.sending.delete(id); }
  }

  private canAcknowledge(n: Note, data: Data, session: Session) {
    return n.direction === 'in' && !n.failure && ['held', 'approved'].includes(n.state) &&
      n.to === this.transport.identity()?.address && n.transport?.name === this.transport.name &&
      !!this.transport.acknowledge && (session.role === 'person' ||
        n.state === 'approved' && this.approvalValid(n, data) && n.audience !== 'person');
  }

  async acknowledge(session: Session, input: { id?: unknown; expected_hash?: unknown }) {
    const data = this.store.read(), n = data.notes.find(x => x.id === input.id);
    if (!n || !this.visible(n, data, session)) throw new ServiceError('not_found', 'No message has this ID.');
    if (!this.canAcknowledge(n, data, session)) throw new ServiceError('forbidden', 'This session cannot acknowledge this message.');
    if (input.expected_hash !== n.hash) throw new ServiceError('hash_changed', 'Read the current message before acknowledging it.');
    if (n.acknowledgement?.status === 'failed' && n.acknowledgement.hash === n.hash) {
      this.store.update(n.id, (x, d) => {
        const ack = x.acknowledgement!;
        ack.status = 'pending'; ack.attempts = 0; ack.nextAttemptAt = this.at();
        delete ack.error; delete ack.failureCode;
        this.store.audit(d, session.name, 'ack_retry_requested', x.id);
      });
    }
    this.acknowledgements.queue(n, session.name);
    await this.acknowledgements.attempt(n.id);
    return this.get(session, n.id);
  }

  async reportAgentDelivery(session: Session, input: { id?: unknown; expected_hash?: unknown; status?: unknown }) {
    if (session.role === 'agent') throw new ServiceError('forbidden', 'Only the person or a connector reviewer can report agent delivery.');
    const data = this.store.read(), n = data.notes.find(x => x.id === input.id);
    if (!n || n.direction !== 'in') throw new ServiceError('not_found', 'No incoming message has this ID.');
    if (n.to !== this.transport.identity()?.address || !this.approvalValid(n, data) || n.state !== 'approved')
      throw new ServiceError('not_approved', 'Accept this message before reporting agent delivery.');
    if (input.expected_hash !== n.hash) throw new ServiceError('hash_changed', 'Read the current message before reporting delivery.');
    if (!['unassigned', 'notification_pending', 'notified'].includes(String(input.status))) throw new ServiceError('invalid_input', 'Unknown delivery status.');
    const status = input.status as AgentDeliveryStatus;
    this.store.update(n.id, (x, d) => {
      if (x.agentDelivery?.status === status) {
        if (x.deliveryNotice?.status === 'failed') {
          x.deliveryNotice.status = 'pending'; x.deliveryNotice.attempts = 0; x.deliveryNotice.nextAttemptAt = this.at();
          delete x.deliveryNotice.error; delete x.deliveryNotice.failureCode;
          this.store.audit(d, session.name, 'delivery_notice_retry_requested', x.id);
        }
        return;
      }
      const hadFailure = !!x.agentDelivery && x.agentDelivery.status !== 'notified';
      x.agentDelivery = { status, updatedAt: this.at() };
      if (status === 'notified' && !hadFailure) delete x.deliveryNotice;
      else x.deliveryNotice = { by: x.to, requestedBy: session.name, hash: x.hash, requestedAt: this.at(),
        status: 'pending', attempts: 0, nextAttemptAt: this.at(), deliveryStatus: status, operationId: randomUUID() };
      this.store.audit(d, session.name, 'agent_delivery', x.id, status);
    });
    await this.acknowledgements.attempt(n.id, 'deliveryNotice');
    return this.get(session, n.id);
  }

  private async acknowledgeIntake(n: Note) {
    if (n.failure || !['held', 'approved'].includes(n.state) || !this.transport.acknowledge) return;
    this.acknowledgements.queue(n, 'service');
    await this.acknowledgements.attempt(n.id);
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
        const data = this.store.read();
        const threads = data.notes.filter(n => n.direction === 'out' && n.state === 'sent' && n.transport?.channel && n.transport.ts)
          .map(n => ({ channel: n.transport!.channel!, ts: n.transport!.threadTs || n.transport!.ts! }));
        await this.transport.scan(data.cursors, m => this.receive(m), (conversation, ts) => this.store.change(d => { d.cursors[conversation] = ts; }), threads);
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
      if (decoded.code === 'not_a2anotes') {
        if (/^A2A [#@]/.test(m.text)) return this.receiveHumanMessage(m, base);
        return this.receiveHumanReply(m, id, base);
      }
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

  private async receiveHumanReply(m: Received, id: string, base: Pick<Note, 'id' | 'direction' | 'from' | 'to' | 'fileIds' | 'created' | 'updated' | 'transport'>) {
    if (!m.text.startsWith('A2A Reply/1 ') || m.automated) return;
    const match = /^A2A Reply\/1 ([0-9a-f-]{36})\r?\n([\s\S]+)$/.exec(m.text);
    const original = match && this.store.read().notes.find(n => n.direction === 'out' && n.state === 'sent' &&
      n.messageId === match[1] && n.to === m.sender && n.from === base.to && n.transport?.channel === m.channel &&
      (!m.threadTs || m.threadTs === (n.transport?.threadTs || n.transport?.ts)));
    if (!original) {
      this.store.change(d => {
        d.notes.push({ ...base, messageId: randomUUID(), state: 'failed', source: 'human_reply', subject: '(reply could not be linked)',
          body: '', audience: 'person', threadId: randomUUID(), replyTo: null, hash: '',
          failure: { code: 'reply_not_verified', reason: 'The explicit reply does not match a sent note and its Slack recipient.', raw: rawCopy(m.text) } });
      }); return;
    }
    let body: string;
    try { body = checkBody(match![2]); } catch (error) {
      this.store.change(d => {
        d.notes.push({ ...base, messageId: randomUUID(), source: 'human_reply', state: 'failed', subject: original.subject,
          body: '', audience: original.audience, threadId: original.threadId, replyTo: original.messageId, hash: '',
          failure: { code: 'reply_body_invalid', reason: (error as Error).message, raw: rawCopy(m.text) } });
      }); return;
    }
    const note: Note = { ...base, messageId: randomUUID(), source: 'human_reply', state: 'held', subject: original.subject,
      body, audience: original.audience, threadId: original.threadId, replyTo: original.messageId, hash: '' };
    note.hash = noteHash(note, []);
    note.review = await review({ direction: 'incoming', subject: note.subject, body, files: [] }, this.reviewer);
    if (note.review.verdict === 'quarantine') note.state = 'quarantined';
    this.acceptOwnerMessage(m, note);
    if (['held', 'approved'].includes(note.state) && this.transport.acknowledge) this.acknowledgements.prepare(note, 'service');
    this.store.change(d => {
      if (d.notes.some(n => n.id === id)) return;
      d.notes.push(note); this.store.audit(d, 'service', 'human_reply_received', id, original.id);
    });
    await this.acknowledgeIntake(note);
  }

  private isOwnerMessage(n: Note, data: Data): boolean {
    return !!n.ownerMessage && n.direction === 'in' && ['human_reply', 'human_message'].includes(n.source || '') &&
      n.ownerMessage.address === this.transport.identity()?.address && n.from === n.to && n.from === n.ownerMessage.address &&
      n.approval?.by === 'person' && n.approval.actor === n.from && n.ownerMessage.hash === n.hash && noteHash(n, this.files(data, n)) === n.hash && n.state === 'approved' && this.approvalValid(n, data);
  }

  private acceptOwnerMessage(m: Received, note: Note) {
    const data = this.store.read();
    if (!m.ownerConversation || m.automated || m.sender !== this.transport.identity()?.address || note.from !== note.to ||
      this.approverFor(note, data) === 'nobody') return;
    note.ownerMessage = { address: m.sender, hash: note.hash };
    note.approval = { by: 'person', actor: m.sender, at: note.updated, hash: note.hash, policyVersion: data.policy.version };
    note.state = 'approved';
  }

  private async receiveHumanMessage(m: Received, base: Pick<Note, 'id' | 'direction' | 'from' | 'to' | 'fileIds' | 'created' | 'updated' | 'transport'>) {
    if (m.automated) return;
    const match = /^A2A (#[1-9][0-9]*|@[a-z][a-z0-9_-]{0,31})\r?\n([\s\S]+)$/.exec(m.text);
    let body: string;
    try { if (!match) throw new Error('Use A2A #task or A2A @alias on the first line, then write the message.'); body = checkBody(match[2]); }
    catch (error) {
      this.store.change(d => {
        if (d.notes.some(n => n.id === base.id)) return;
        d.notes.push({ ...base, messageId: randomUUID(), source: 'human_message', state: 'failed', subject: '(direct message could not be read)',
          body: '', audience: 'person', threadId: randomUUID(), replyTo: null, hash: '',
          failure: { code: 'direct_message_invalid', reason: (error as Error).message, raw: rawCopy(m.text) } });
      }); return;
    }
    const note: Note = { ...base, messageId: randomUUID(), source: 'human_message', state: 'held', subject: `Slack message to ${match![1]}`,
      body, audience: 'agent', directTarget: match![1], threadId: randomUUID(), replyTo: null, hash: '' };
    note.hash = noteHash(note, []);
    note.review = await review({ direction: 'incoming', subject: note.subject, body, files: [] }, this.reviewer);
    if (note.review.verdict === 'quarantine') note.state = 'quarantined';
    this.acceptOwnerMessage(m, note);
    if (['held', 'approved'].includes(note.state) && this.transport.acknowledge) this.acknowledgements.prepare(note, 'service');
    this.store.change(d => {
      if (d.notes.some(n => n.id === base.id)) return;
      d.notes.push(note); this.store.audit(d, 'service', 'human_message_received', note.id, note.directTarget);
    });
    await this.acknowledgeIntake(note);
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

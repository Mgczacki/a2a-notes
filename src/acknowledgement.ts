// Receipt acknowledgements do not change content, approval, or task delivery.
import { noteHash, Store, type Note } from './store.ts';
import { TransportError, type Transport } from './transport.ts';

export class Acknowledgements {
  private stopping = false;
  private running = new Map<string, Promise<void>>();
  constructor(private store: Store, private transport: Transport, private now: () => number) {}
  private at() { return new Date(this.now()).toISOString(); }

  prepare(n: Note, actor: string) {
    n.acknowledgement ||= { by: n.to, requestedBy: actor, hash: n.hash, requestedAt: this.at(),
      status: 'pending', attempts: 0, nextAttemptAt: this.at() };
  }

  queue(n: Note, actor: string) {
    this.store.update(n.id, (x, d) => {
      if (x.acknowledgement) return;
      this.prepare(x, actor);
      this.store.audit(d, actor, 'ack_queued', x.id);
    });
  }

  start() { this.stopping = false; }

  async process() {
    for (const n of this.store.read().notes) {
      if (this.stopping) break;
      for (const slot of ['acknowledgement', 'deliveryNotice'] as const) {
        const a = n[slot];
        if (a?.status === 'pending' && a.nextAttemptAt && Date.parse(a.nextAttemptAt) <= this.now()) await this.attempt(n.id, slot);
      }
    }
  }

  attempt(id: string, slot: 'acknowledgement' | 'deliveryNotice' = 'acknowledgement'): Promise<void> {
    const key = `${id}:${slot}`;
    if (this.stopping) return Promise.resolve();
    const pending = this.running.get(key);
    if (pending) return pending;
    const work = this.run(id, slot).finally(() => this.running.delete(key));
    this.running.set(key, work);
    return work;
  }
  async stop() { this.stopping = true; await Promise.allSettled([...this.running.values()]); }

  private async run(id: string, slot: 'acknowledgement' | 'deliveryNotice') {
    const n = this.store.note(id), a = n?.[slot];
    if (!n || !a || a.status !== 'pending' || !a.nextAttemptAt || Date.parse(a.nextAttemptAt) > this.now()) return;
    const current = (x: Note) => !!x[slot] && (slot === 'acknowledgement' || x.deliveryNotice?.operationId === n.deliveryNotice?.operationId);
    const fail = (code: string, error: string) => { this.store.update(id, (x, d) => {
      if (!current(x)) return;
      const ack = x[slot]!;
      ack.status = 'failed'; ack.failureCode = code; ack.error = error; delete ack.nextAttemptAt;
      this.store.audit(d, 'service', 'ack_failed', id, `${code}: ${error}`);
    }); };
    const data = this.store.read();
    const files = data.files.filter(f => n.agentFileId === f.id || n.fileIds.includes(f.id));
    // Match noteHash's attachment order when supporting files precede the agent file in the store.
    const ordered = [...(n.agentFileId ? [n.agentFileId] : []), ...n.fileIds].map(id => files.find(f => f.id === id)).filter(f => !!f);
    if (n.direction !== 'in' || n.to !== a.by || n.hash !== a.hash || noteHash(n, ordered) !== a.hash ||
      n.failure || ['failed', 'quarantined', 'rejected'].includes(n.state)) return fail('message_changed', 'The message no longer permits acknowledgement.');
    if (this.transport.identity()?.address !== a.by || n.transport?.name !== this.transport.name)
      return fail('recipient_changed', 'The connected recipient changed.');
    if (slot === 'acknowledgement' && !this.transport.acknowledge || slot === 'deliveryNotice' && !this.transport.notifyDelivery)
      return fail('ack_unsupported', 'This transport cannot confirm receipt or delivery status.');
    const reference = Object.fromEntries(Object.entries(n.transport || {}).filter(([k, v]) => k !== 'name' && typeof v === 'string')) as Record<string, string>;
    this.store.update(id, x => { x[slot]!.attempts++; if (slot === 'deliveryNotice') x.deliveryNotice!.uncertain = true; });
    try {
      if (slot === 'deliveryNotice') {
        const notice = n.deliveryNotice!;
        await this.transport.notifyDelivery!({ ...reference, operation_id: notice.operationId, reconcile: notice.uncertain ? 'true' : 'false' }, notice.deliveryStatus);
      } else await this.transport.acknowledge!(reference);
      this.store.update(id, (x, d) => {
        if (!current(x)) return;
        const ack = x[slot]!;
        ack.status = 'confirmed'; ack.confirmedAt = this.at(); delete ack.nextAttemptAt; delete ack.error;
        this.store.audit(d, 'service', 'ack_confirmed', id);
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The transport did not confirm acknowledgement.';
      const latest = this.store.note(id)!;
      if (!current(latest)) return;
      const attempts = latest[slot]!.attempts;
      const retry = error instanceof TransportError && (error.rateLimited || !error.definite);
      if (!retry || attempts >= 8) return fail(attempts >= 8 ? 'retry_exhausted' : 'ack_failed', reason);
      const seconds = Math.max(error.retryAfter || 0, Math.min(3600, 30 * 2 ** (attempts - 1)));
      this.store.update(id, (x, d) => {
        if (!current(x)) return;
        if (slot === 'deliveryNotice' && error instanceof TransportError) x.deliveryNotice!.uncertain = !error.definite || !!n.deliveryNotice?.uncertain;
        x[slot]!.error = reason;
        x[slot]!.nextAttemptAt = new Date(this.now() + seconds * 1000).toISOString();
        this.store.audit(d, 'service', 'ack_retry', id, reason);
      });
    }
  }
}

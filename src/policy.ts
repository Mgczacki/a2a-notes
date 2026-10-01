// Who may approve a message. The person sets one level for incoming and one for outgoing messages.
// Level 1: the person approves every message. Level 2: a review agent approves ordinary messages to or from trusted
// senders after the checks pass. Level 3: a review agent also approves trusted messages that the check is unsure about.
// The service calls these functions on every approve, send, and release, and never stores the answer, so a changed
// level applies to the next action. A peer that is not a trusted sender always needs the person.

export type Verdict = 'communication' | 'uncertain' | 'action-request' | 'quarantine';
export type Level = 1 | 2 | 3;
export type Approver = 'person' | 'reviewer' | 'nobody';
export interface Policy { incoming: Level; outgoing: Level; checkBody: boolean; version: number }
export const DEFAULT_POLICY: Policy = { incoming: 2, outgoing: 2, checkBody: true, version: 1 };

const rank: Record<Verdict, number> = { communication: 0, uncertain: 1, 'action-request': 2, quarantine: 3 };
export const worse = (a: Verdict, b: Verdict): Verdict => rank[b] > rank[a] ? b : a;
export const VERDICTS: Verdict[] = ['communication', 'uncertain', 'action-request', 'quarantine'];

export function incomingApprover(verdict: Verdict | undefined, level: Level, trusted: boolean): Approver {
  if (!verdict || verdict === 'quarantine') return 'nobody';
  if (verdict === 'action-request') return level === 3 ? 'nobody' : 'person';
  if (!trusted || level === 1) return 'person';
  if (verdict === 'uncertain') return level === 3 ? 'reviewer' : 'person';
  return 'reviewer';
}

export function outgoingApprover(verdict: Verdict | undefined, level: Level, trusted: boolean, bodyFlags: number, policy: Policy): Approver {
  if (!verdict || verdict === 'quarantine') return 'nobody';
  if (verdict === 'action-request' || !trusted || level === 1) return 'person';
  // a flagged body (internal terms, a changed ask) needs the person when the body check is on
  if (policy.checkBody && bodyFlags > 0) return 'person';
  if (verdict === 'uncertain') return level === 3 ? 'reviewer' : 'person';
  return 'reviewer';
}

export function checkPolicy(value: unknown, current: Policy): Policy {
  const v = (value || {}) as Partial<Policy>;
  const level = (x: unknown, fallback: Level): Level => {
    if (x === undefined) return fallback;
    if (x !== 1 && x !== 2 && x !== 3) throw new Error('A level must be 1, 2, or 3.');
    return x;
  };
  const next: Policy = { incoming: level(v.incoming, current.incoming), outgoing: level(v.outgoing, current.outgoing),
    checkBody: v.checkBody === undefined ? current.checkBody : !!v.checkBody, version: current.version };
  if (next.incoming !== current.incoming || next.outgoing !== current.outgoing || next.checkBody !== current.checkBody) next.version = current.version + 1;
  return next;
}

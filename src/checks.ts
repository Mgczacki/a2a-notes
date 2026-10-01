// Checks that run before a person or agent can approve a message.
// 1. The body check (outgoing only): internal terms, local paths, secrets, sender notes, code-like terms, detail names
//    from the agent file that the body uses without explanation, and an ask that differs from the authorizing instruction.
// 2. The content check (both directions): a verdict for the policy (src/policy.ts). The default reviewer uses fixed
//    rules. A person can configure a command, for example a model with no tools, that returns a verdict as JSON.
// Message text is data. No check result can change a role, an approval, or a route.
import { execFile } from 'node:child_process';
import type { AgentRequest } from './protocol.ts';
import type { Verdict } from './policy.ts';

export interface BodyFlag { code: 'sender_note' | 'internal_term' | 'local_path' | 'secret' | 'code_term' | 'agent_detail' | 'ask_changed'; text: string; start: number; end: number; reason: string }
export interface BodyCheck { flags: BodyFlag[]; instruction: 'matched' | 'changed' | 'unavailable'; at: string }

const rules: { code: BodyFlag['code']; pattern: RegExp; reason: string }[] = [
  { code: 'sender_note', pattern: /\b(?:I will|I'll|I plan to|once I|my next step|my next check|the next check|we still need to)\b/i, reason: "Looks like a note about the sender's own work." },
  { code: 'internal_term', pattern: /\b(?:task\s*#\d+|ticket\s*#\d+)/i, reason: 'Names an internal task number that the reader may not know.' },
  { code: 'local_path', pattern: /(?:\/Users\/[^\s`]+|\/home\/[^\s`]+|[A-Z]:\\[^\s`]+|~\/[^\s`]+)/, reason: "Contains a path on the sender's machine." },
  { code: 'secret', pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b|(?:api[_ -]?key|secret|token|password)\s*[:=]\s*\S{8,}/i, reason: 'Looks like a secret or key.' },
  { code: 'code_term', pattern: /`[^`]+`|\b[a-z]+(?:_[a-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/, reason: 'Uses a code name that the reader may not know. Explain it or move it to the agent file.' },
];

export function sentenceSpans(body: string) {
  const spans: { text: string; start: number; end: number }[] = [];
  for (const line of body.matchAll(/[^\n]+/g)) {
    let offset = 0;
    const push = (raw: string, at: number) => {
      const left = raw.length - raw.trimStart().length, text = raw.trim();
      if (text) spans.push({ text, start: line.index! + at + left, end: line.index! + at + left + text.length });
    };
    for (const end of line[0].matchAll(/[.!?]+(?=\s|$)/g)) { push(line[0].slice(offset, end.index! + end[0].length), offset); offset = end.index! + end[0].length; }
    push(line[0].slice(offset), offset);
  }
  return spans;
}

const STOP = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'your', 'our', 'my', 'his', 'her', 'their', 'its', 'of', 'for', 'to', 'and', 'or', 'with', 'on', 'in', 'at', 'by', 'from', 'exact', 'all', 'any', 'some', 'please', 'us', 'me', 'him', 'them', 'it']);
const ASK_VERBS = ['confirm', 'approve', 'send', 'provide', 'review', 'share', 'check', 'sign', 'update', 'answer', 'decide', 'choose'];
const stem = (word: string) => word.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(?:ies)$/, 'y').replace(/(?:es|s)$/, '');

// The noun words after each ask verb, for example "confirm the exact release key names" -> confirm: release, key, name.
export function asks(text: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const verbs = ASK_VERBS.join('|');
  // the words after a verb end at punctuation or at the next ask verb
  for (const match of text.matchAll(new RegExp(`\\b(${verbs})\\b((?:(?!\\b(?:${verbs})\\b)[^.;:!?\\n])*)`, 'gi'))) {
    const words = new Set<string>();
    for (const raw of match[2].split(/\s+/)) {
      if (/^(?:before|after|by|when|if|so|because|until|about|and|or|with|to)$/i.test(raw)) break;
      const word = stem(raw);
      if (word && !STOP.has(raw.toLowerCase()) && word.length > 1) words.add(word);
      if (words.size >= 5) break;
    }
    if (!words.size) continue;
    const verb = match[1].toLowerCase();
    found.set(verb, new Set([...(found.get(verb) || []), ...words]));
  }
  return found;
}

// Compares what the instruction asked the reader to do with what the body asks. For each ask verb in the
// instruction, the body must use the same verb with at least one of the same nouns.
export function compareAsk(instruction: string | undefined, body: string): { state: BodyCheck['instruction']; changed: { verb: string; expected: string[]; found: string[] }[] } {
  if (!instruction?.trim()) return { state: 'unavailable', changed: [] };
  const expected = asks(instruction), found = asks(body);
  const changed: { verb: string; expected: string[]; found: string[] }[] = [];
  for (const [verb, nouns] of expected) {
    const got = found.get(verb) || new Set<string>();
    if (![...nouns].some(n => got.has(n))) changed.push({ verb, expected: [...nouns], found: [...got] });
  }
  return { state: changed.length ? 'changed' : 'matched', changed };
}

// Detail names from the agent file ("release_keys" -> "release keys") that the body uses. The body is for a person,
// so an agent term in the body needs a plain explanation or a move to the agent file.
function agentTerms(request: AgentRequest | undefined) {
  if (!request) return [];
  return request.agent_request.details.map(d => d.name.replace(/[_-]+/g, ' ').trim().toLowerCase()).filter(n => n.split(' ').length >= 2);
}

export function checkOutgoingBody(body: string, options: { agentFile?: AgentRequest; instruction?: string } = {}): BodyCheck {
  const flags: BodyFlag[] = [];
  for (const span of sentenceSpans(body)) {
    const rule = rules.find(rule => rule.pattern.test(span.text));
    if (rule) flags.push({ code: rule.code, ...span, reason: rule.reason });
  }
  const lower = body.toLowerCase();
  for (const term of agentTerms(options.agentFile)) {
    const words = term.split(' ').map(w => w.replace(/[^a-z0-9]/g, '')).filter(Boolean);
    // "release keys" matches "release keys" and "release-key"; "conditional write plan" matches "conditional-write plan"
    const pattern = new RegExp(`\\b${words.map((w, i) => i === words.length - 1 ? `${w.replace(/s$/, '')}s?` : w).join('[\\s-]+')}\\b`, 'i');
    const match = pattern.exec(lower);
    if (match) flags.push({ code: 'agent_detail', text: body.slice(match.index, match.index + match[0].length), start: match.index, end: match.index + match[0].length,
      reason: `"${match[0]}" is a detail name from the agent file. Explain it in plain words or leave it to the agent file.` });
  }
  const ask = compareAsk(options.instruction, body);
  for (const change of ask.changed) flags.push({ code: 'ask_changed', text: change.verb, start: 0, end: 0,
    reason: `The instruction asks the reader to ${change.verb} ${change.expected.join(' ')}, but the body asks to ${change.verb} ${change.found.join(' ') || 'something else'}. Keep the original ask or get a new instruction.` });
  flags.sort((a, b) => a.start - b.start);
  return { flags, instruction: ask.state, at: new Date().toISOString() };
}

// ---- content check ----

export interface ReviewInput { direction: 'incoming' | 'outgoing'; subject: string; body: string; files: { name: string; text: string }[] }
export interface ReviewResult { verdict: Verdict; reason: string; reviewer: string; at: string }
export type Reviewer = (input: ReviewInput) => Promise<Omit<ReviewResult, 'at'>>;

const injection = /\b(?:ignore (?:all |any )?(?:previous|prior|earlier) (?:instructions|messages)|disregard (?:the|your) (?:instructions|rules)|you are now|new system prompt|system prompt|developer mode|act as the (?:owner|system|administrator)|do not tell (?:the|your) (?:user|owner|person)|without (?:review|approval)|bypass (?:the )?(?:review|approval|check))/i;
const encoded = /(?:[A-Za-z0-9+/]{200,}={0,2})/;
const risky = /\b(?:password|passcode|credential|secret|api key|private key|access token|grant (?:me |us )?(?:access|admin|permission)|add me as (?:an )?admin|wire (?:money|funds)|bank (?:account|transfer)|gift card|payment|invoice|delete (?:the )?(?:production|prod|database)|drop table|deploy to production|production (?:data|database|deploy))\b/i;

// The default reviewer: fixed rules, no model. It never returns communication for text that matches a risk rule.
export const ruleReviewer: Reviewer = async input => {
  const all = [input.subject, input.body, ...input.files.map(f => f.text)].join('\n');
  if (injection.test(all)) return { verdict: 'quarantine', reason: 'The text tries to change agent instructions or skip review.', reviewer: 'rules' };
  if (encoded.test(all)) return { verdict: 'quarantine', reason: 'The text contains a long encoded block.', reviewer: 'rules' };
  if (risky.test(all)) return { verdict: 'action-request', reason: 'The text mentions secrets, access, money, or production changes.', reviewer: 'rules' };
  return { verdict: 'communication', reason: 'No risk rule matched.', reviewer: 'rules' };
};

// A reviewer that runs a command. The command reads the review input as JSON on stdin and writes
// {"verdict": "...", "reason": "..."} on stdout. It must not have tools. A failure gives the verdict uncertain.
export function commandReviewer(argv: string[], timeoutMs = 120_000): Reviewer {
  if (!argv.length) throw new Error('The review command is empty.');
  return input => new Promise(resolve => {
    const child = execFile(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME } }, (error, stdout) => {
      if (error) return resolve({ verdict: 'uncertain', reason: 'The review command failed.', reviewer: 'command' });
      try {
        const out = JSON.parse(stdout);
        const value = out.structured_output || out;
        if (!['communication', 'uncertain', 'action-request', 'quarantine'].includes(value.verdict) || typeof value.reason !== 'string') throw new Error();
        resolve({ verdict: value.verdict, reason: value.reason.slice(0, 500), reviewer: 'command' });
      } catch { resolve({ verdict: 'uncertain', reason: 'The review command returned output that is not a verdict.', reviewer: 'command' }); }
    });
    child.stdin?.end(JSON.stringify(input));
  });
}

// Runs the configured reviewer and the rules. The result is the more serious verdict of the two, so a command
// reviewer cannot lower a rule result.
export async function review(input: ReviewInput, reviewer?: Reviewer): Promise<ReviewResult> {
  const rules = await ruleReviewer(input);
  if (!reviewer) return { ...rules, at: new Date().toISOString() };
  const other = await reviewer(input);
  const order = ['communication', 'uncertain', 'action-request', 'quarantine'];
  return { ...(order.indexOf(other.verdict) > order.indexOf(rules.verdict) ? other : rules), at: new Date().toISOString() };
}

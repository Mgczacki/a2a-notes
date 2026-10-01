import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startFakeSlack, type FakeSlack } from '../src/fake-slack.ts';
import { NotesService, type ServiceOptions, type Session } from '../src/service.ts';
import { SlackTransport } from '../src/slack.ts';
import { savePrivate, Store } from '../src/store.ts';
import { sha256, writeAgentFile, type AgentRequest } from '../src/protocol.ts';

export const MARIO = 'UMARIO01', ALEX = 'UALEX01', EVE = 'UEVE01';
export const person: Session = { name: 'review-page', role: 'person' };
export const agent: Session = { name: 'agent-1', role: 'agent' };
export const reviewer: Session = { name: 'controller', role: 'reviewer' };
export const rid = () => `req-${randomUUID()}`;

export async function fakeWorkspace() {
  return startFakeSlack({ team: 'TEXAMPLE', users: [
    { id: MARIO, name: 'Mario G', email: 'mario@example.test' }, { id: ALEX, name: 'Alex B', email: 'alex@example.test' }, { id: EVE, name: 'Eve', email: 'eve@example.test' },
    { id: 'UBOT01', name: 'Robot', is_bot: true },
  ] });
}

export function slackConfig(fake: FakeSlack, extra = {}) {
  return { clientId: 'fake-client', teamId: fake.team, redirectUri: 'http://localhost:4460/slack/callback', apiBase: `${fake.url}/api`, authorizeUrl: `${fake.url}/oauth/v2/authorize`, ...extra };
}

// One person's service with a signed-in fake Slack member. The same dir gives the same store after a restart.
export function personService(fake: FakeSlack, user: string, dir = mkdtempSync(join(tmpdir(), `a2an-${user}-`)), extra: Partial<ServiceOptions> = {}) {
  savePrivate(join(dir, 'slack-credentials.json'), fake.credentials(user));
  const transport = new SlackTransport(join(dir, 'slack-credentials.json'), slackConfig(fake));
  const service = new NotesService({ store: new Store(dir), transport, scanIntervalMs: 0, ...extra });
  service.start();
  return { dir, service, transport, address: `slack:${fake.team}:${user}` };
}

export function agentRequest(messageId: string, subject: string, audience: 'agent' | 'both' = 'both', extra: Partial<AgentRequest> = {}): AgentRequest {
  return { version: 'a2anotes.request/1', message_id: messageId, audience, subject, target: { host: 'files.example.test', cdn_account_id: null },
    facts: [{ statement: 'Alex confirmed the hosting request.', source: 'Alex reply', status: 'confirmed' }],
    agent_request: { when: 'Before any hosting change.', ask: 'Confirm the exact setting names.', details: [{ name: 'release_keys', ask: 'Confirm the key names.' }], deadline: null },
    unknowns: [], ...extra };
}
export function stageAgentFile(service: NotesService, session: Session, request: AgentRequest) {
  const bytes = writeAgentFile(request);
  return service.stageFile(session, { kind: 'agent', text: bytes.toString('utf8'), sha256: sha256(bytes), request_id: rid() });
}

export const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name));

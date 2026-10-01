// Public API of the a2a-notes package.
export * from './protocol.ts';
export * from './policy.ts';
export * from './checks.ts';
export { Store, ServiceError, noteHash, type Note, type Role, type Data } from './store.ts';
export { NotesService, type Session } from './service.ts';
export { SlackTransport, slackAddress, parseSlackAddress, REQUIRED_SCOPES, OPTIONAL_SCOPES, type SlackConfig } from './slack.ts';
export type { Transport, Received, Person, Identity } from './transport.ts';
export { createMcpServer, VERSION } from './mcp.ts';
export { startHttp } from './http.ts';
export { Clients } from './clients.ts';
export { startService, readConfig, defaultDir, type Config } from './daemon.ts';
export { runBridge } from './bridge.ts';

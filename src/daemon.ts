// Starts one A2A Notes service for one person: the store, the Slack adapter, the scan timer, and the HTTP server.
// The data folder holds config.json, store.json, clients.json, slack-credentials.json, files/, and local-secret.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Clients } from './clients.ts';
import { commandReviewer } from './checks.ts';
import { startHttp } from './http.ts';
import { NotesService } from './service.ts';
import { SlackTransport, type SlackConfig } from './slack.ts';
import { savePrivate, Store } from './store.ts';

export interface Config {
  port: number; host?: string;
  slack: SlackConfig;
  reviewCommand?: string[];
  stagingDir?: string;
  scanIntervalSeconds?: number;
}
export const defaultDir = () => process.env.A2A_NOTES_DIR || join(homedir(), '.a2a-notes');

export function readConfig(dir: string): Config {
  const file = join(dir, 'config.json');
  if (!existsSync(file)) throw new Error(`No config.json in ${dir}. Run a2a-notes init first.`);
  const config = JSON.parse(readFileSync(file, 'utf8')) as Config;
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('config.json needs a port.');
  if (!config.slack?.clientId || !config.slack.teamId || !config.slack.redirectUri) throw new Error('config.json needs slack.clientId, slack.teamId, and slack.redirectUri.');
  return config;
}

export interface Running { service: NotesService; server: Server & { url: string }; clients: Clients; slack: SlackTransport; close(): Promise<void> }

export async function startService(dir: string, overrides: Partial<Config> = {}, fetcher?: typeof fetch, onStop?: () => void): Promise<Running> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = { ...readConfig(dir), ...overrides };
  const store = new Store(dir);
  const slack = new SlackTransport(join(dir, 'slack-credentials.json'), config.slack, fetcher);
  const service = new NotesService({ store, transport: slack, reviewer: config.reviewCommand?.length ? commandReviewer(config.reviewCommand) : undefined,
    stagingDir: config.stagingDir, scanIntervalMs: (config.scanIntervalSeconds ?? 60) * 1000 });
  const clients = new Clients(dir);
  // the local secret lets the command-line tool on this account ask the running service for a page sign-in code
  const secretFile = join(dir, 'local-secret');
  const secret = randomBytes(32).toString('base64url');
  savePrivate(secretFile, secret);
  const server = await startHttp({ service, clients, port: config.port, host: config.host, slack, onStop,
    local: given => { const a = Buffer.from(given), b = Buffer.from(secret); return a.length === b.length && timingSafeEqual(a, b); } });
  service.start();
  savePrivate(join(dir, 'service.json'), { url: server.url, pid: process.pid, started: new Date().toISOString() });
  return {
    service, server, clients, slack,
    close: () => new Promise(resolve => {
      service.stop();
      try { unlinkSync(join(dir, 'service.json')); } catch { /* already removed */ }
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

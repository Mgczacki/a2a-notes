// Starts one A2A Notes service for one person: the store, the Slack adapter, the scan timer, and the HTTP server.
// The data folder holds config.json, store.json, clients.json, slack-credentials.json, files/, and local-secret.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Clients } from './clients.ts';
import { commandBodyChecker, commandReviewer } from './checks.ts';
import { startHttp } from './http.ts';
import { NotesService } from './service.ts';
import { SlackTransport, type SlackConfig } from './slack.ts';
import { SlackDesktopHook, desktopURL, type DesktopConfig } from './slack-desktop.ts';
import type { Transport } from './transport.ts';
import { savePrivate, Store } from './store.ts';

export interface Config {
  port: number; host?: string;
  slack: SlackConfig;
  // commands for the content check and the outgoing body check (src/checks.ts); the fixed rules always run
  reviewCommand?: string[];
  bodyCheckCommand?: string[];
  stagingDir?: string;
  scanIntervalSeconds?: number;
  desktop?: DesktopConfig;
}
export const defaultDir = () => process.env.A2A_NOTES_DIR || join(homedir(), '.a2a-notes');

export function readConfig(dir: string): Config {
  const file = join(dir, 'config.json');
  if (!existsSync(file)) throw new Error(`No config.json in ${dir}. Run a2a-notes init first.`);
  const config = JSON.parse(readFileSync(file, 'utf8')) as Config;
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('config.json needs a port.');
  if (!/^T[A-Z0-9]+$/.test(config.slack?.teamId)) throw new Error('config.json needs slack.teamId.');
  desktopURL(config.desktop?.url || config.slack.desktopUrl || 'http://127.0.0.1:19322');
  if (config.desktop) desktopURL(config.desktop.url);
  if (config.desktop?.send !== undefined && typeof config.desktop.send !== 'boolean') throw new Error('desktop.send must be a boolean.');
  return config;
}

export interface Running { service: NotesService; server: Server & { url: string }; clients: Clients; slack: Transport; close(): Promise<void> }

export async function startService(dir: string, overrides: Partial<Config> = {}, fetcher?: typeof fetch, onStop?: () => void, dependencies: {transport?: Transport} = {}): Promise<Running> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = { ...readConfig(dir), ...overrides };
  const lockFile = join(dir, 'service.lock');
  const recordFile = join(dir, 'service.json');
  if (!existsSync(lockFile) && existsSync(recordFile)) {
    const pid = JSON.parse(readFileSync(recordFile, 'utf8')).pid;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error('An A2A Notes service already owns this data folder.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('The service lock has no valid owner. Check the data folder.');
    try { process.kill(pid, 0); throw new Error('An A2A Notes service already owns this data folder.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const recoveryFile = join(dir, 'service-recovery.lock');
    const recovery = openSync(recoveryFile, 'wx', 0o600);
    try {
      // Another process can claim the store while this process checks the old owner.
      if (readFileSync(lockFile, 'utf8') !== String(pid)) throw new Error('The service owner changed. Try again.');
      unlinkSync(lockFile);
    } finally { closeSync(recovery); unlinkSync(recoveryFile); }
  }
  const fd = openSync(lockFile, 'wx', 0o600);
  try { writeFileSync(fd, String(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
  let service: NotesService | undefined;
  let desktop: SlackDesktopHook | undefined;
  let refresh: ReturnType<typeof setInterval> | undefined;
  try {
    const store = new Store(dir);
    const slack = dependencies.transport || new SlackTransport(join(dir, 'slack-app-account.json'), {...config.slack, desktopUrl: config.desktop?.url || config.slack.desktopUrl}, fetcher);
    if (slack instanceof SlackTransport) {
      await slack.refresh().catch(() => {});
      refresh = setInterval(() => {void slack.refresh().catch(() => {});}, 10_000); refresh.unref();
    }
    service = new NotesService({ store, transport: slack, reviewer: config.reviewCommand?.length ? commandReviewer(config.reviewCommand) : undefined,
      bodyChecker: config.bodyCheckCommand?.length ? commandBodyChecker(config.bodyCheckCommand) : undefined,
      stagingDir: config.stagingDir, scanIntervalMs: (config.scanIntervalSeconds ?? 60) * 1000 });
    if (slack instanceof SlackTransport) {
      const owner = service;
      desktop = new SlackDesktopHook({ config: {url: config.desktop?.url || config.slack.desktopUrl || 'http://127.0.0.1:19322', ...(config.desktop?.send ? {send:true} : {})}, dir,
        identity: () => slack.identity(), verifyChannel: channel => slack.verifyDesktopChannel(channel),
        receive: event => owner.receive(event), connection: active => owner.setDesktopListening(active) });
      service.desktopStatus = () => desktop!.status();
      slack.desktopSender = desktop;
    }
    const clients = new Clients(dir);
    // the local secret lets the command-line tool on this account ask the running service for a page sign-in code
    const secretFile = join(dir, 'local-secret');
    const secret = randomBytes(32).toString('base64url');
    savePrivate(secretFile, secret);
    const server = await startHttp({ service, clients, port: config.port, host: config.host, ...(slack instanceof SlackTransport ? {slack} : {}), onStop,
      local: given => { const a = Buffer.from(given), b = Buffer.from(secret); return a.length === b.length && timingSafeEqual(a, b); } });
    service.start(); desktop?.start();
    savePrivate(join(dir, 'service.json'), { url: server.url, pid: process.pid, started: new Date().toISOString() });
    return {
      service, server, clients, slack,
      close: async () => {
        clearInterval(refresh);
        await desktop?.close();
        await service!.stop();
        return new Promise(resolve => {
          try { unlinkSync(join(dir, 'service.json')); } catch { /* already removed */ }
          server.closeAllConnections();
          server.close(() => { try { unlinkSync(lockFile); } catch { /* already removed */ } resolve(); });
        });
      },
    };
  } catch (error) {
    clearInterval(refresh);
    await desktop?.close();
    await service?.stop();
    try { unlinkSync(lockFile); } catch { /* already removed */ }
    throw error;
  }
}

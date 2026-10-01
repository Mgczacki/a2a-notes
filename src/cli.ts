// a2a-notes: the command-line tool. See README.md for each command.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultDir, readConfig, startService } from './daemon.ts';
import { Clients, ROLES } from './clients.ts';
import { runBridge } from './bridge.ts';
import { startFakeSlack } from './fake-slack.ts';
import { savePrivate, type Role } from './store.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const has = (name: string) => args.includes(name);
const dir = resolve(flag('--dir') || defaultDir());
const usage = `a2a-notes <command>
  init --client-id ID --team-id T [--port 4460] [--api-base URL] [--authorize-url URL]   write config.json
  serve                                   run the service (MCP endpoint, review page, Slack scan)
  token add <name> --role person|reviewer|agent    print a new client token once
  token list | token remove <name>
  open                                    print a one-time link to the review page
  status                                  print the connection and scan status
  stop                                    stop the running service
  bridge [--url URL]                      stdio MCP bridge; reads the token from A2A_NOTES_TOKEN
  import-slack <credentials.json> [--no-refresh]   use existing Slack user credentials
  service-file                            print a macOS LaunchAgent file that starts the service at sign-in
  fake-slack --port P --users U1:Name,U2:Name     run a fake Slack workspace for tests
All commands take --dir <data folder> (default ~/.a2a-notes or A2A_NOTES_DIR).`;

async function local(path: string) {
  const service = JSON.parse(readFileSync(join(dir, 'service.json'), 'utf8'));
  const res = await fetch(`${service.url}${path}`, { method: 'POST', headers: { 'x-a2a-local': readFileSync(join(dir, 'local-secret'), 'utf8') } });
  if (!res.ok) throw new Error(`The service refused the request (HTTP ${res.status}).`);
  return res.json();
}

const [cmd, sub] = args;
switch (cmd) {
  case 'init': {
    const port = Number(flag('--port') || 4460);
    const config = { port, slack: { clientId: flag('--client-id') || '', teamId: flag('--team-id') || '', redirectUri: `http://localhost:${port}/slack/callback`,
      ...(flag('--api-base') ? { apiBase: flag('--api-base') } : {}), ...(flag('--authorize-url') ? { authorizeUrl: flag('--authorize-url') } : {}), ...(has('--allow-self') ? { allowSelf: true } : {}) },
      scanIntervalSeconds: Number(flag('--scan-seconds') || 60) };
    if (!config.slack.clientId || !config.slack.teamId) { console.error('init needs --client-id and --team-id'); process.exit(1); }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    savePrivate(join(dir, 'config.json'), config);
    console.log(`Wrote ${join(dir, 'config.json')}. Add ${config.slack.redirectUri} as a redirect URL in the Slack app.`);
    break;
  }
  case 'serve': {
    let stop = () => {};
    const running = await startService(dir, {}, undefined, () => stop());
    stop = () => { void running.close().then(() => process.exit(0)); };
    console.log(`A2A Notes is running at ${running.server.url}. MCP endpoint: ${running.server.url}/mcp`);
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    break;
  }
  case 'token': {
    const clients = new Clients(dir);
    if (sub === 'add') {
      const role = flag('--role') as Role;
      if (!ROLES.includes(role)) { console.error('token add needs --role person, reviewer, or agent'); process.exit(1); }
      console.log(clients.add(args[2], role));
    } else if (sub === 'list') console.log(JSON.stringify(clients.list(), null, 2));
    else if (sub === 'remove') { clients.remove(args[2]); console.log(`Removed ${args[2]}.`); }
    else { console.error(usage); process.exit(1); }
    break;
  }
  case 'open': console.log((await local('/local/login-code')).url); break;
  case 'status': console.log(JSON.stringify((await local('/local/login-code')).status, null, 2)); break;
  case 'stop': await local('/local/stop'); console.log('The service is stopping.'); break;
  case 'bridge': {
    const token = process.env.A2A_NOTES_TOKEN;
    if (!token) { console.error('Set A2A_NOTES_TOKEN to a client token from a2a-notes token add.'); process.exit(1); }
    const url = flag('--url') || `${JSON.parse(readFileSync(join(dir, 'service.json'), 'utf8')).url}/mcp`;
    await runBridge(url, token);
    break;
  }
  case 'import-slack': {
    const source = args[1];
    if (!source || !existsSync(source)) { console.error('import-slack needs a credentials file'); process.exit(1); }
    const c = JSON.parse(readFileSync(source, 'utf8'));
    if (!c.user || !c.team || !c.access || !Array.isArray(c.scopes)) { console.error('The file does not have Slack user credentials.'); process.exit(1); }
    savePrivate(join(dir, 'slack-credentials.json'), { user: c.user, team: c.team, name: c.name || c.user, scopes: c.scopes, access: c.access,
      ...(has('--no-refresh') ? {} : { refresh: c.refresh, expires: c.expires }) });
    if (has('--no-refresh')) {
      const config = readConfig(dir); config.slack.noRefresh = true; savePrivate(join(dir, 'config.json'), config);
    }
    console.log(`Imported the Slack credentials for ${c.user}. The token itself is not printed.`);
    break;
  }
  case 'service-file': {
    const bin = process.argv[1];
    console.log(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.a2anotes.service</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${bin}</string><string>serve</string><string>--dir</string><string>${dir}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${join(dir, 'service.log')}</string>
</dict></plist>`);
    console.error(`Save it as ${join(homedir(), 'Library/LaunchAgents/com.a2anotes.service.plist')} and run: launchctl load <that file>`);
    break;
  }
  case 'fake-slack': {
    const users = (flag('--users') || 'UFAKEA:Alex,UFAKEB:Blair').split(',').map(x => { const [id, name] = x.split(':'); return { id, name: name || id, email: `${(name || id).toLowerCase()}@example.test` }; });
    const fake = await startFakeSlack({ port: Number(flag('--port') || 0), team: flag('--team'), users });
    if (flag('--credentials-dir')) for (const u of users) {
      const out = join(flag('--credentials-dir')!, `${u.id}.json`);
      writeFileSync(out, JSON.stringify(fake.credentials(u.id)), { mode: 0o600 });
    }
    console.log(JSON.stringify({ url: fake.url, api: `${fake.url}/api`, authorize: `${fake.url}/oauth/v2/authorize`, team: fake.team, users }));
    break;
  }
  default: console.error(usage); process.exit(cmd ? 1 : 0);
}

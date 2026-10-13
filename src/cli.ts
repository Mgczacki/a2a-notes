// a2a-notes: the command-line tool. See README.md for each command.
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultDir, readConfig, startService } from './daemon.ts';
import { Clients, ROLES } from './clients.ts';
import { runBridge } from './bridge.ts';
import { startFakeSlack } from './fake-slack.ts';
import { savePrivate, type Role } from './store.ts';
import { SlackDesktopHook, desktopURL } from './slack-desktop.ts';
import { SlackTransport } from './slack.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const has = (name: string) => args.includes(name);
const dir = resolve(flag('--dir') || defaultDir());
const usage = `a2a-notes <command>
  init --team-id T [--desktop-url http://127.0.0.1:19322] [--port 4460]   write config.json
  serve                                   run the service (MCP endpoint, review page, Slack scan)
  token add <name> --role person|reviewer|agent [--human-approval]    print a new client token once
  token list | token remove <name>
  open                                    print a one-time link to the review page
  status                                  print the connection and scan status
  desktop enable --url http://127.0.0.1:P  save the optional Slack Desktop endpoint
  desktop disable                         remove the endpoint from config
  desktop probe --url URL [--seconds 30]   check the installed app without delivering notes
  stop                                    stop the running service
  bridge [--url URL]                      stdio MCP bridge; reads the token from A2A_NOTES_TOKEN
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
    const config = {port, slack: {teamId: flag('--team-id') || '', desktopUrl: desktopURL(flag('--desktop-url') || 'http://127.0.0.1:19322').origin,
      ...(has('--allow-self') ? {allowSelf: true} : {})}, scanIntervalSeconds: Number(flag('--scan-seconds') || 60)};
    if (!/^T[A-Z0-9]+$/.test(config.slack.teamId)) throw new Error('init needs --team-id.');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    savePrivate(join(dir, 'config.json'), config);
    console.log(`Wrote ${join(dir, 'config.json')}. Open Slack Desktop with its loopback debugging port.`);
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
      console.log(clients.add(args[2], role, { humanApproval: has('--human-approval') }));
    } else if (sub === 'list') console.log(JSON.stringify(clients.list(), null, 2));
    else if (sub === 'remove') { clients.remove(args[2]); console.log(`Removed ${args[2]}.`); }
    else { console.error(usage); process.exit(1); }
    break;
  }
  case 'open': console.log((await local('/local/login-code')).url); break;
  case 'status': console.log(JSON.stringify((await local('/local/login-code')).status, null, 2)); break;
  case 'stop': await local('/local/stop'); console.log('The service is stopping.'); break;
  case 'desktop': {
    const config = readConfig(dir);
    if (sub === 'enable') {
      const url = desktopURL(flag('--url') || '').origin;
      config.desktop = { url, ...(has('--send') ? {send:true} : {}) }; savePrivate(join(dir, 'config.json'), config);
      console.log('Saved the Slack Desktop endpoint. Restart A2A Notes to connect.');
    } else if (sub === 'disable') {
      throw new Error('Slack Desktop is the only Slack transport. Disconnect it on the review page.');
    } else if (sub === 'probe') {
      const url = desktopURL(flag('--url') || config.desktop?.url || '').origin;
      const seconds = Number(flag('--seconds') || 30);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error('Use a probe time from 1 to 300 seconds.');
      const slack = new SlackTransport(join(dir, 'slack-app-account.json'), {...config.slack, desktopUrl: url});
      await slack.connect();
      const temporary = mkdtempSync(join(tmpdir(), 'a2a-desktop-probe-'));
      let events = 0;
      const hook = new SlackDesktopHook({ config: { url, ...(has('--send') ? {send:true} : {}) }, dir: temporary, identity: () => slack.identity(),
        verifyChannel: channel => slack.verifyDesktopChannel(channel), receive: async () => { events++; } });
      try {
        hook.start();
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        console.log(JSON.stringify({ ...hook.status(), app: slack.viewStatus(), events, delivered: false }, null, 2));
      } finally { await hook.close(); rmSync(temporary, { recursive: true, force: true }); }
    } else throw new Error('Use desktop enable, disable, or probe.');
    break;
  }
  case 'bridge': {
    const token = process.env.A2A_NOTES_TOKEN;
    if (!token) { console.error('Set A2A_NOTES_TOKEN to a client token from a2a-notes token add.'); process.exit(1); }
    const url = flag('--url') || `${JSON.parse(readFileSync(join(dir, 'service.json'), 'utf8')).url}/mcp`;
    await runBridge(url, token);
    break;
  }
  case 'import-slack': throw new Error('Slack credentials are no longer used. Connect the signed-in desktop app.');
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

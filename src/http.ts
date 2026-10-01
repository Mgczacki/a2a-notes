// The local HTTP server: the Streamable HTTP MCP endpoint (/mcp), the review page (/), the page's JSON API (/api),
// and the Slack sign-in redirect (/slack/callback). It listens on loopback only and accepts only loopback Host headers.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp.ts';
import { reviewPage } from './page.ts';
import { ServiceError } from './store.ts';
import type { NotesService, Session } from './service.ts';
import type { Clients } from './clients.ts';
import type { SlackTransport } from './slack.ts';

export interface HttpOptions { service: NotesService; clients: Clients; port: number; host?: string; slack?: SlackTransport; local?: (secret: string) => boolean; onStop?: () => void }
const MAX_BODY = 16 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY) { reject(new ServiceError('too_large', 'The request is too large.')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { if (!size) return resolve(undefined); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ServiceError('invalid_input', 'The request body is not JSON.')); } });
    req.on('error', reject);
  });
}
const send = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(value));
};
const cookie = (req: IncomingMessage, name: string) => (req.headers.cookie || '').split(/;\s*/).map(x => x.split('=')).find(([k]) => k === name)?.[1];

export function startHttp(options: HttpOptions): Promise<Server & { url: string }> {
  const { service, clients, port } = options;
  const host = options.host || '127.0.0.1';
  let base = `http://${host}:${port}`;
  const loopback = (value: string | undefined) => !!value && /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(value);
  const pageLink = () => `${base}/login?code=${clients.loginCode()}`;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', base);
    // DNS rebinding and cross-site requests: the Host must be loopback, and a browser Origin must be this server
    if (!loopback(req.headers.host)) return send(res, 421, { error: { code: 'bad_host', reason: 'This server answers only on loopback.' } });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: { code: 'bad_origin', reason: 'Cross-site requests are refused.' } });

    if (url.pathname === '/mcp') {
      const session = clients.session(req.headers.authorization);
      if (!session) return send(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'A valid A2A Notes client token is required.' }, id: null }, { 'www-authenticate': 'Bearer' });
      if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'This server is stateless. Use POST.' }, id: null }, { allow: 'POST' });
      const body = await readBody(req);
      const server = createMcpServer(service, session, { pageLink });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    // the command-line tool on this account proves access to the data folder with the local secret
    if (url.pathname === '/local/login-code' && req.method === 'POST') {
      if (!options.local?.(String(req.headers['x-a2a-local'] || ''))) return send(res, 403, { error: { code: 'forbidden', reason: 'The local secret does not match.' } });
      return send(res, 200, { url: pageLink(), status: service.connectionStatus() });
    }
    if (url.pathname === '/local/stop' && req.method === 'POST') {
      if (!options.local?.(String(req.headers['x-a2a-local'] || '')) || !options.onStop) return send(res, 403, { error: { code: 'forbidden', reason: 'The local secret does not match.' } });
      send(res, 200, { stopping: true });
      setImmediate(options.onStop);
      return;
    }
    if (url.pathname === '/login') {
      const value = clients.redeem(url.searchParams.get('code') || '');
      if (!value) return res.writeHead(403, { 'content-type': 'text/plain' }).end('This sign-in link expired or was used. Run a2a-notes open to get a new link.');
      return res.writeHead(303, { location: '/', 'set-cookie': `a2an_page=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`, 'cache-control': 'no-store' }).end();
    }
    if (url.pathname === '/slack/callback') {
      if (!options.slack) return send(res, 404, { error: { code: 'not_found', reason: 'Slack is not configured.' } });
      try { await options.slack.finishSignIn(url.searchParams.get('state') || '', url.searchParams.get('code') || ''); }
      catch (error) { return res.writeHead(400, { 'content-type': 'text/plain' }).end(`Slack sign-in failed: ${(error as Error).message}`); }
      void service.scanNow().catch(() => {});
      // Slack returns to the redirect host (localhost). The page cookie belongs to the host of the sign-in link.
      return res.writeHead(303, { location: `${base}/` }).end();
    }
    const page = clients.page(cookie(req, 'a2an_page'));
    if (url.pathname === '/') {
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self' http://localhost:* http://127.0.0.1:*", 'referrer-policy': 'no-referrer' })
        .end(reviewPage(!!page));
    }
    if (url.pathname.startsWith('/api/')) {
      if (!page) return send(res, 401, { error: { code: 'signed_out', reason: 'Open the review page with a new link from a2a-notes open.' } });
      // a form or image on another site cannot set this header. SameSite=Lax sends the cookie on a top-level
      // navigation, which the return from Slack sign-in needs, and never on a cross-site POST.
      if (req.method !== 'GET' && req.headers['x-a2a-page'] !== '1') return send(res, 403, { error: { code: 'bad_request', reason: 'Missing page header.' } });
      return pageApi(req, res, url, page);
    }
    return send(res, 404, { error: { code: 'not_found', reason: 'Not found.' } });
  };

  const pageApi = async (req: IncomingMessage, res: ServerResponse, url: URL, session: Session) => {
    const body = (req.method === 'POST' ? await readBody(req) : {}) as Record<string, any> || {};
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const reply = (value: unknown) => send(res, 200, value);
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const all = service.list(session, { direction: 'all', limit: 100 });
      return reply({ identity: service.identity(), status: service.connectionStatus(), policy: service.policy(),
        messages: all.messages.map(m => service.get(session, m.id)), audit: service.auditLog(session, 30) });
    }
    if (req.method === 'POST' && parts[1] === 'messages' && parts[3] === 'decide') return reply(service.approve(session, { id: parts[2], expected_hash: body.hash, decision: body.decision }));
    if (req.method === 'POST' && parts[1] === 'messages' && parts[3] === 'send') return reply(await service.send(session, { id: parts[2], expected_hash: body.hash, request_id: `page-${parts[2]}-${String(body.hash).slice(0, 16)}-${Date.now()}` }));
    if (req.method === 'POST' && parts[1] === 'messages' && parts[3] === 'seen') return reply(service.markSeen(session, parts[2]));
    if (req.method === 'POST' && url.pathname === '/api/trusted') return reply(service.setTrusted(session, body));
    if (req.method === 'POST' && url.pathname === '/api/policy') return reply(service.setPolicy(session, body));
    if (req.method === 'POST' && url.pathname === '/api/sync') { await service.scanNow().catch(() => {}); return reply(service.connectionStatus()); }
    if (req.method === 'POST' && url.pathname === '/api/slack/connect') {
      if (!options.slack) throw new ServiceError('not_configured', 'Slack is not configured.', 'Add slack settings to config.json.');
      return reply({ url: options.slack.beginSignIn() });
    }
    if (req.method === 'POST' && url.pathname === '/api/slack/disconnect') { options.slack?.disconnect(); return reply({ ok: true }); }
    throw new ServiceError('not_found', 'Not found.');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) return res.end();
      const e = error instanceof ServiceError ? error : new ServiceError('internal_error', 'The service could not finish the request.');
      send(res, e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 400, { error: { code: e.code, reason: e.message, next: e.next } });
    });
  }) as Server & { url: string };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address && typeof address === 'object') base = `http://${host}:${address.port}`;
      server.url = base;
      resolve(server);
    });
  });
}

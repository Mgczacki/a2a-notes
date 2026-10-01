// Client tokens. Each MCP client gets its own bearer token with one role: person, reviewer, or agent. The file keeps
// only a SHA-256 hash of each token. The review page uses a person session that starts from a one-time sign-in code.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { savePrivate, type Role } from './store.ts';
import type { Session } from './service.ts';

interface Client { name: string; role: Role; hash: string; created: string }
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export const ROLES: Role[] = ['person', 'reviewer', 'agent'];

export class Clients {
  readonly file: string;
  private codes = new Map<string, number>();
  private pages = new Map<string, { expires: number }>();
  constructor(dir: string) { this.file = join(dir, 'clients.json'); }
  private read(): Client[] { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : []; }
  list() { return this.read().map(({ name, role, created }) => ({ name, role, created })); }
  add(name: string, role: Role) {
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(name)) throw new Error('A client name has 1 to 60 letters, digits, or . _ -');
    if (!ROLES.includes(role)) throw new Error('The role must be person, reviewer, or agent.');
    const token = `a2an_${randomBytes(32).toString('base64url')}`;
    savePrivate(this.file, [...this.read().filter(c => c.name !== name), { name, role, hash: hash(token), created: new Date().toISOString() }]);
    return token;
  }
  remove(name: string) { savePrivate(this.file, this.read().filter(c => c.name !== name)); }
  session(authorization: string | undefined): Session | undefined {
    const token = /^Bearer (a2an_[A-Za-z0-9_-]{20,100})$/.exec(authorization || '')?.[1];
    if (!token) return undefined;
    const digest = Buffer.from(hash(token), 'hex');
    const client = this.read().find(c => timingSafeEqual(Buffer.from(c.hash, 'hex'), digest));
    return client ? { name: client.name, role: client.role } : undefined;
  }
  // A one-time code for the review page. It works once, within two minutes.
  loginCode() {
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, Date.now() + 120_000);
    return code;
  }
  redeem(code: string) {
    const expires = this.codes.get(code);
    this.codes.delete(code);
    if (!expires || expires < Date.now()) return undefined;
    const cookie = randomBytes(32).toString('base64url');
    this.pages.set(cookie, { expires: Date.now() + 12 * 3600_000 });
    return cookie;
  }
  page(cookie: string | undefined): Session | undefined {
    const entry = cookie ? this.pages.get(cookie) : undefined;
    if (!entry || entry.expires < Date.now()) return undefined;
    return { name: 'review-page', role: 'person' };
  }
}

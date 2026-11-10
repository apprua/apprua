// Who is calling.
// - MCP / API: personal tokens (shown once, stored as SHA-256, expire after TOKEN_DAYS).
// - Portal: local accounts (email + password, signed session cookie) or identity headers from a login proxy.
import { createHash, createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { audit, countUsers, getDb, getUser, upsertUser, type User } from './db.js';
import { HttpError } from './errors.js';
import { secrets } from './secrets.js';

export { HttpError };

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------- personal tokens (MCP / API) ----------

export const TOKEN_PREFIX = 'apr_';

export function issueToken(email: string, by: string): { token: string; expiresAt: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + config.policy.tokenDays * 86_400_000).toISOString();
  getDb()
    .prepare('UPDATE users SET token_hash = ?, token_prefix = ?, token_expires_at = ?, revoked_at = NULL WHERE email = ?')
    .run(sha256(token), token.slice(0, 10), expiresAt, email);
  audit(by, 'token.issue', null, { email, expiresAt });
  return { token, expiresAt };
}

export function revokeToken(email: string, by: string): void {
  getDb()
    .prepare(`UPDATE users SET token_hash = NULL, token_expires_at = NULL, revoked_at = datetime('now') WHERE email = ?`)
    .run(email);
  audit(by, 'token.revoke', null, { email });
}

const renewHint = () => `Create a new one at ${config.publicUrl} and update it in your AI app's connector settings.`;

/** Authenticates an MCP/API call with "Authorization: Bearer <token>". */
export function requireToken(req: FastifyRequest): User {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!m) throw new HttpError(401, `Missing personal token. ${renewHint()}`);
  const user = getDb().prepare('SELECT * FROM users WHERE token_hash = ?').get(sha256(m[1])) as User | undefined;
  if (!user || user.disabled_at) throw new HttpError(401, `Invalid or revoked token. ${renewHint()}`);
  if (user.token_expires_at && Date.parse(user.token_expires_at) < Date.now())
    throw new HttpError(401, `Your token expired on ${user.token_expires_at.slice(0, 10)}. ${renewHint()}`);
  // Remember that an AI app is connected (at most one write every 10 minutes)
  if (!user.token_used_at || Date.now() - Date.parse(user.token_used_at + 'Z') > 600_000)
    getDb().prepare(`UPDATE users SET token_used_at = datetime('now') WHERE email = ?`).run(user.email);
  return user;
}

// ---------- local accounts ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [kind, salt, key] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
/** The same check, off the main thread: a burst of sign-ins does not stop the portal and the gate of the apps. */
export async function checkPassword(password: string, stored: string | null): Promise<boolean> {
  const [kind, salt, key] = (stored ?? '').split('$');
  const ok = kind === 'scrypt' && salt && key;
  // no account: the same work, so the time taken does not tell which emails have one
  const expected = ok ? Buffer.from(key, 'base64url') : Buffer.alloc(64);
  const actual = await scryptAsync(password, ok ? Buffer.from(salt, 'base64url') : Buffer.alloc(16), expected.length);
  return Boolean(ok) && timingSafeEqual(actual, expected);
}

/** Error messages are translation keys (see i18n.ts), so the portal can show them in the user's language. */
export function checkNewPassword(password: string): void {
  if (password.length < 10) throw new HttpError(400, 'err.password_short');
}

export function createLocalUser(email: string, name: string | null, password: string, role: 'user' | 'admin', by: string): User {
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) throw new HttpError(400, 'err.email_invalid');
  if (getUser(e)) throw new HttpError(409, 'err.email_taken');
  checkNewPassword(password);
  upsertUser(e, name || null, role);
  getDb().prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hashPassword(password), e);
  audit(by, 'user.create', null, { email: e, role });
  return getUser(e)!;
}

/** Sets a new password. Sessions are tied to the password (see sessionKey), so every device signed in with the old
 *  one is signed out. With endKey (a password that was lost: the "forgot your password?" link, or a new one given
 *  by an administrator) the personal key stops working too: whoever got into the account may have made one. */
export function setPassword(email: string, password: string, by: string, opts: { endKey?: boolean } = {}): void {
  checkNewPassword(password);
  getDb().prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hashPassword(password), email);
  if (opts.endKey && getUser(email)?.token_hash) revokeToken(email, by);
  // a "forgot your password?" link asked for before stops working too
  getDb().prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE email = ? AND used_at IS NULL`).run(email);
  audit(by, 'user.password', null, { email });
}

/** "Your account": the person changes their own password, after typing the current one. */
export function changeOwnPassword(email: string, current: string, next: string): void {
  const u = getUser(email);
  if (!u || !verifyPassword(current, u.password_hash)) throw new HttpError(400, 'err.password_wrong');
  setPassword(email, next, email);
}

/** A new password that is easy to read aloud: 4 groups of 4 letters and digits, without look-alikes (0/o, 1/l/i). */
export function randomPassword(): string {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = randomBytes(16);
  return Array.from(b, (x) => abc[x % abc.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
}

// ---------- "Forgot your password?": one-time links by email ----------

const RESET_MINUTES = 60;

/** A link token for a local account (null when there is no such account: the page answers the same either way). */
export function createResetToken(email: string): string | null {
  const u = getUser(email.trim().toLowerCase());
  if (!u || u.disabled_at || !u.password_hash) return null;
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + RESET_MINUTES * 60_000).toISOString();
  getDb().prepare('INSERT INTO password_resets (token_hash, email, expires_at) VALUES (?, ?, ?)').run(sha256(token), u.email, expires);
  audit(u.email, 'user.password_reset_asked', null, null);
  return token;
}

/** The account a link is for, if the link is still good (unused, not expired). */
export function resetTokenEmail(token: string): string | null {
  const r = getDb().prepare('SELECT email, expires_at, used_at FROM password_resets WHERE token_hash = ?').get(sha256(String(token))) as
    { email: string; expires_at: string; used_at: string | null } | undefined;
  return r && !r.used_at && Date.parse(r.expires_at) > Date.now() ? r.email : null;
}

/** Uses a link: sets the password, and every link of that account stops working. */
export function useResetToken(token: string, password: string): string {
  const email = resetTokenEmail(token);
  if (!email) throw new HttpError(400, 'err.reset_invalid');
  setPassword(email, password, email, { endKey: true });
  getDb().prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE email = ? AND used_at IS NULL`).run(email);
  return email;
}

/** First start: creates the admin given by the installer (INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD) if there are no users yet. */
export function ensureInitialAdmin(): void {
  const { initialAdminEmail: e, initialAdminPassword: p } = config.auth;
  if (config.auth.mode !== 'local' || !e || !p || countUsers() > 0) return;
  createLocalUser(e, null, p, 'admin', 'installer');
}

export const needsSetup = () => config.auth.mode === 'local' && countUsers() === 0;

// ---------- portal sessions (signed cookie: email.expiry.signature) ----------

/** The portal's own cookie, for the portal's address only: never sent to the apps (they run code written by AI, and
 *  the cookie would let them act as whoever opens them). With HTTPS the "__Host-" name also stops an app from setting
 *  a cookie of the same name for the whole domain. */
export const portalCookie = () => (config.publicUrl.startsWith('https://') ? '__Host-apprua_portal' : 'apprua_portal');
/** Until 0.3: one session cookie shared with every app (Domain=<baseDomain>). No longer accepted; removed when seen. */
const LEGACY_COOKIE = 'apprua_session';
const sign = (v: string) => createHmac('sha256', secrets().session).update(v).digest('base64url');
const pwPrint = (email: string) => {
  const u = getUser(email);
  return sha256((u?.password_hash ?? '') + (u?.session_gen ? `.${u.session_gen}` : '')).slice(0, 16);
};
/** A session is signed together with a fingerprint of the password and of the last sign-out: a new password, or signing
 *  out, ends the sessions on every device and the cookies of every app (they are signed the same way). */
const sessionKey = (e: string, exp: string) => `${e}.${exp}.${pwPrint(Buffer.from(e, 'base64url').toString('utf8'))}`;

/** Where the old shared cookie lived (local network and internet, portal under the domain), to remove it. */
export function legacyDomain(host: string): string {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  const d = config.baseDomain.toLowerCase();
  return config.network !== 'local' && (h === d || h.endsWith(`.${d}`)) ? `; Domain=${d}` : '';
}
const hostOf = (req: FastifyRequest) => String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
/** Every cookie with this name: an app on a sibling address can plant one with the same name ("cookie tossing") and
 *  the browser sends both; the one that verifies wins, so a planted one cannot lock anybody out. */
function readCookies(req: FastifyRequest, name: string): string[] {
  return String(req.headers.cookie ?? '').split(/;\s*/).filter((c) => c.startsWith(`${name}=`)).map((c) => c.slice(name.length + 1));
}
const readCookie = (req: FastifyRequest, name: string): string | undefined => readCookies(req, name)[0];
const clearLegacy = (req: FastifyRequest) => {
  const dom = legacyDomain(hostOf(req));
  return [`${LEGACY_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, ...(dom ? [`${LEGACY_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${dom}`] : [])];
};
const secureFlag = () => (config.publicUrl.startsWith('https://') ? '; Secure' : '');

export function startSession(req: FastifyRequest, reply: FastifyReply, email: string): void {
  const exp = Date.now() + config.auth.sessionDays * 86_400_000;
  const e = Buffer.from(email).toString('base64url');
  reply.header('Set-Cookie', [
    `${portalCookie()}=${e}.${exp}.${sign(sessionKey(e, String(exp)))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.auth.sessionDays * 86400}${secureFlag()}`,
    ...(readCookie(req, LEGACY_COOKIE) !== undefined ? clearLegacy(req) : []),
  ]);
}

export function endSession(req: FastifyRequest, reply: FastifyReply): void {
  const u = portalUser(req);
  if (u) getDb().prepare('UPDATE users SET session_gen = ? WHERE email = ?').run(randomBytes(12).toString('base64url'), u.email);
  reply.header('Set-Cookie', [`${portalCookie()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag()}`, ...clearLegacy(req)]);
}

// ---------- the sign-in in front of the apps (local network and internet) ----------
// Each app gets its own cookie, for its own address only and valid for that app only: an app can read the cookie of
// the people who open it (it runs its own code), but cannot use it anywhere else, not on the portal, not on other apps.
// The way in: gate -> portal /_apprua/pass (signed in? if not, the login) -> a code for one use, one minute, one app
// -> <app>/_apprua/enter, answered by the gate itself (the app never sees the code) -> the cookie -> the page asked for.

/** With HTTPS the "__Host-" name also stops a sibling app from setting a cookie of the same name for the domain. */
export const gateCookieName = (secure: boolean) => (secure ? '__Host-apprua_gate' : 'apprua_gate');
const GATE_HOURS = 12;
// each code remembers the fingerprint of the password and of the last sign-out: signing out or a new password
// in the minute before it is used makes it worthless
const passes = new Map<string, { email: string; app: string; until: number; print: string }>();

/** A code for one use that lets this person into this app (handed to the app's address in a redirect). */
export function issuePass(email: string, app: string): string {
  const now = Date.now();
  for (const [k, p] of passes) if (p.until < now) passes.delete(k);
  const code = randomBytes(24).toString('base64url');
  passes.set(sha256(code), { email, app, until: now + 60_000, print: pwPrint(email) });
  return code;
}

/** Uses the code: the person it was made for, if it is for this app and not used or expired yet. */
export function usePass(code: string, app: string): string | null {
  const k = sha256(String(code));
  const p = passes.get(k);
  passes.delete(k);
  return p && p.app === app && p.until >= Date.now() && p.print === pwPrint(p.email) ? p.email : null;
}

const gateKey = (app: string, e: string, exp: string) => `gate.${app}.${e}.${exp}.${pwPrint(Buffer.from(e, 'base64url').toString('utf8'))}`;

/** The Set-Cookie of an app's own cookie (no Domain: only that app's address). */
export function gateCookie(app: string, email: string, secure: boolean): string {
  const exp = String(Date.now() + GATE_HOURS * 3_600_000);
  const e = Buffer.from(email).toString('base64url');
  return `${gateCookieName(secure)}=${e}.${exp}.${sign(gateKey(app, e, exp))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GATE_HOURS * 3600}${secure ? '; Secure' : ''}`;
}

/** The email in the first of these cookie values whose signature (made with keyOf) verifies and has not expired. */
function signedEmail(values: string[], keyOf: (e: string, exp: string) => string): string | null {
  for (const raw of values) {
    const [e, exp, sig] = raw.split('.');
    if (e && exp && sig && safeEqual(sig, sign(keyOf(e, exp))) && Number(exp) >= Date.now()) return Buffer.from(e, 'base64url').toString('utf8');
  }
  return null;
}

/** Who opens this app, from the app's own cookie (null: nobody, or a cookie made for another app). */
export function gateUser(req: FastifyRequest, app: string, secure: boolean): User | null {
  const email = signedEmail(readCookies(req, gateCookieName(secure)), (e, exp) => gateKey(app, e, exp));
  const u = email ? getUser(email) : undefined;
  return u && !u.disabled_at ? u : null;
}

/** Where to go after signing in: only addresses of this installation (the portal, or one of its apps at the scheme
 *  and port the apps really use: a crafted link could otherwise send the code of the gate over plain http). */
export function safeNext(next: unknown): string | null {
  if (typeof next !== 'string' || !next || /[\x00-\x1f\x7f]/.test(next)) return null;
  try {
    const u = new URL(next);
    const d = config.baseDomain.toLowerCase();
    const h = u.hostname.toLowerCase();
    if (u.origin === new URL(config.publicUrl).origin) return u.toString();
    if ((h === d || h.endsWith(`.${d}`)) && u.protocol === `${config.appScheme}:` && u.port === '') return u.toString();
  } catch { /* not a URL */ }
  return null;
}

const sessionEmail = (req: FastifyRequest): string | null => signedEmail(readCookies(req, portalCookie()), sessionKey);

/** The signed-in portal user, or null (local mode: session cookie; proxy mode: trusted headers). */
export function portalUser(req: FastifyRequest): User | null {
  if (config.auth.mode === 'proxy') {
    const secret = String(req.headers[config.auth.proxySecretHeader] ?? '');
    if (!config.auth.proxySecret || !safeEqual(secret, config.auth.proxySecret))
      throw new HttpError(403, 'The portal must be opened through the login proxy.');
    const email = String(req.headers[config.auth.emailHeader] ?? '').toLowerCase();
    if (!email) return null;
    const groups = String(req.headers[config.auth.groupsHeader] ?? '').split(',').map((s) => s.trim());
    const role = config.auth.adminGroup && groups.includes(config.auth.adminGroup) ? 'admin' : 'user';
    const name = String(req.headers[config.auth.nameHeader] ?? '') || null;
    const existing = getUser(email);
    if (!existing || existing.role !== role) audit(email, existing ? 'user.role' : 'user.create', null, { role });
    return upsertUser(email, name, role);
  }
  const email = sessionEmail(req);
  const u = email ? getUser(email) : undefined;
  return u && !u.disabled_at ? u : null;
}

export function requireAdmin(user: User): void {
  if (user.role !== 'admin') throw new HttpError(403, 'Administrators only.');
}

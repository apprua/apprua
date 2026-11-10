// Passwords: change your own, a new one from an administrator, "forgot your password?" links,
// and sessions that end on every other device when the password changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

Object.assign(process.env, { DATA_DIR: await mkdtemp(join(tmpdir(), 'apd-acct-')), PUBLIC_URL: 'http://localhost:3000' });
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { setEngine } = await import('../src/engine/index.js');
const { portalRoutes } = await import('../src/routes/portal.js');

db.openDb(':memory:');
setEngine({ name: 'fake', check: async () => 'fake engine', runtimeStatus: async () => 'running' } as never);
const app = Fastify();
await app.register(portalRoutes);

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = (url: string, o: Record<string, string>, cookie = '') => app.inject({
  method: 'POST', url, payload: form(o), headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
});
const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const c = r.headers['set-cookie'];
  return String(Array.isArray(c) ? c[0] : c).split(';')[0];
};
const signedIn = async (cookie: string) => (await app.inject({ method: 'GET', url: '/account', headers: { cookie } })).statusCode === 200;

auth.createLocalUser('ada@example.test', 'Ada', 'first-password-1', 'admin', 'test');
auth.createLocalUser('bo@example.test', null, 'bo-password-123', 'user', 'test');

test('a new password from the administrator: easy to read aloud, at least 10 characters, no look-alikes', () => {
  const pw = auth.randomPassword();
  assert.match(pw, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  assert.doesNotMatch(pw, /[01ilo]/);
  assert.notEqual(pw, auth.randomPassword());
});

test('changing your own password needs the current one, and signs out every other device', async () => {
  const laptop = cookieOf(await post('/login', { email: 'ada@example.test', password: 'first-password-1' }));
  const phone = cookieOf(await post('/login', { email: 'ada@example.test', password: 'first-password-1' }));
  assert.ok(await signedIn(laptop) && await signedIn(phone));

  const wrong = await post('/account/password', { current: 'not-it-at-all', password: 'second-password-2', password2: 'second-password-2' }, laptop);
  assert.equal(wrong.statusCode, 400);
  assert.ok(await signedIn(phone), 'a wrong attempt changes nothing');

  const mismatch = await post('/account/password', { current: 'first-password-1', password: 'second-password-2', password2: 'other-password-3' }, laptop);
  assert.equal(mismatch.statusCode, 400);

  const ok = await post('/account/password', { current: 'first-password-1', password: 'second-password-2', password2: 'second-password-2' }, laptop);
  assert.equal(ok.statusCode, 200);
  const laptopNow = cookieOf(ok);
  assert.ok(await signedIn(laptopNow), 'the device that changed it stays signed in');
  assert.equal(await signedIn(phone), false, 'the other device is signed out');
  assert.equal(await signedIn(laptop), false, 'the old session of the same device too');
  assert.ok(auth.verifyPassword('second-password-2', db.getUser('ada@example.test')!.password_hash));
});

test('an administrator gives a person a new password, shown once', async () => {
  const admin = cookieOf(await post('/login', { email: 'ada@example.test', password: 'second-password-2' }));
  const bo = cookieOf(await post('/login', { email: 'bo@example.test', password: 'bo-password-123' }));
  const r = await post('/portal/admin/password', { email: 'bo@example.test' }, admin);
  assert.equal(r.statusCode, 200);
  const notice = r.body.slice(r.body.indexOf("New password for"));
  const pw = /class="snip"><span id="s\d+">([^<]+)</.exec(notice)?.[1];
  assert.ok(pw, 'the new password is on the page');
  assert.ok(auth.verifyPassword(pw!, db.getUser('bo@example.test')!.password_hash));
  assert.equal(await signedIn(bo), false, 'the person signs in again with the new password');
  assert.ok(await signedIn(admin), 'the administrator stays signed in');

  const notAdmin = cookieOf(await post('/login', { email: 'bo@example.test', password: pw! }));
  const refused = await post('/portal/admin/password', { email: 'ada@example.test' }, notAdmin);
  assert.equal(refused.statusCode, 403);
});

test('forgot your password: a one-time link that works for an hour', () => {
  assert.equal(auth.createResetToken('nobody@example.test'), null, 'no link for an unknown address');
  const token = auth.createResetToken('BO@example.test ')!;
  assert.equal(auth.resetTokenEmail(token), 'bo@example.test');
  assert.equal(auth.resetTokenEmail('made-up'), null);

  assert.throws(() => auth.useResetToken(token, 'short'), /err\.password_short/);
  assert.equal(auth.resetTokenEmail(token), 'bo@example.test', 'a refused password does not use up the link');
  const other = auth.createResetToken('bo@example.test')!;
  auth.issueToken('bo@example.test', 'test');
  assert.equal(auth.useResetToken(token, 'from-the-link-4'), 'bo@example.test');
  assert.ok(auth.verifyPassword('from-the-link-4', db.getUser('bo@example.test')!.password_hash));
  assert.throws(() => auth.useResetToken(token, 'again-and-again-5'), /err\.reset_invalid/, 'used once');
  assert.equal(db.getUser('bo@example.test')!.token_hash, null, 'a lost password ends the personal key too');
  assert.equal(auth.resetTokenEmail(other), null, 'the other links of the account stop working too');

  const late = auth.createResetToken('bo@example.test')!;
  db.getDb().prepare(`UPDATE password_resets SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL`).run();
  assert.equal(auth.resetTokenEmail(late), null, 'expired after an hour');
});

test('forgot your password without email: who can help, and the commands for the administrator', async () => {
  const r = await app.inject({ method: 'GET', url: '/forgot', headers: { 'accept-language': 'it' } });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.includes('install-apprua.ps1 -ResetPassword') && r.body.includes('install/reset-password.sh'));
  assert.ok(r.body.includes('Chiedi a un amministratore'));
  const login = await app.inject({ method: 'GET', url: '/login' });
  assert.ok(login.body.includes('href="/forgot"'), 'the sign-in page links to it');
  const bad = await app.inject({ method: 'GET', url: '/reset?t=made-up' });
  assert.equal(bad.statusCode, 400);
});

test('guessing passwords: after 10 wrong attempts the address waits, also with the right password', async () => {
  auth.createLocalUser('cy@example.test', null, 'cy-password-123', 'user', 'test');
  for (let i = 0; i < 10; i++) assert.equal((await post('/login', { email: 'cy@example.test', password: `wrong-${i}` })).statusCode, 401);
  const r = await post('/login', { email: 'cy@example.test', password: 'cy-password-123' });
  assert.equal(r.statusCode, 429);
  assert.match(r.body, /Too many attempts|Troppi tentativi/);
});

test('a new password ends a "forgot your password?" link asked for before; an absurd email is refused', async () => {
  auth.createLocalUser('di@example.test', null, 'di-password-123', 'user', 'test');
  const token = auth.createResetToken('di@example.test')!;
  auth.issueToken('di@example.test', 'test');
  auth.setPassword('di@example.test', 'di-password-456', 'test');
  assert.ok(db.getUser('di@example.test')!.token_hash, 'a password changed without losing it keeps the personal key');
  assert.throws(() => auth.useResetToken(token, 'di-password-789'));
  assert.equal((await post('/login', { email: 'x'.repeat(300), password: 'y' })).statusCode, 400);
});

test('an account removed on request: gone, and its email replaced in the history', async () => {
  const { forgetUser } = await import('../src/forget.js');
  auth.createLocalUser('ex@example.test', null, 'ex-password-123', 'user', 'test');
  db.audit('ex@example.test', 'login', null);
  db.audit(null, 'login.failed', null, { email: 'ex@example.test', ip: '10.0.0.9' });
  auth.createResetToken('ex@example.test');
  db.getDb().prepare(`INSERT INTO apps (name, owner, description, url, build_pack, cpus, memory) VALUES ('ex-app', 'ex@example.test', 'x', 'http://ex-app.localhost', 'static', '1', '512m')`).run();
  db.getDb().prepare(`INSERT INTO deploys (app, user, source) VALUES ('ex-app', 'ex@example.test', 'test')`).run();
  assert.throws(() => forgetUser('ex@example.test'), /ex-app/, 'not while an app still belongs to the account');
  db.getDb().prepare(`UPDATE apps SET owner = 'cy@example.test' WHERE name = 'ex-app'`).run();
  const { label } = forgetUser('EX@example.test');
  assert.match(label, /^removed-[0-9a-f]{8}$/);
  assert.equal(db.getUser('ex@example.test'), undefined);
  const rows = db.getDb().prepare(`SELECT 1 FROM audit WHERE user LIKE '%ex@example.test%' OR details LIKE '%ex@example.test%'
    UNION ALL SELECT 1 FROM deploys WHERE user = 'ex@example.test' UNION ALL SELECT 1 FROM password_resets WHERE email = 'ex@example.test'`).all();
  assert.equal(rows.length, 0, 'the email is nowhere in the database');
  assert.equal((await post('/login', { email: 'ex@example.test', password: 'ex-password-123' })).statusCode, 401, 'no sign-in');
  assert.throws(() => forgetUser('nobody@example.test'), /no account/);

  // another address that contains this one (ann@ inside joann@) stays as it is; the same address in capitals goes
  auth.createLocalUser('ann@example.test', null, 'ann-password-123', 'user', 'test');
  db.audit(null, 'login.failed', null, { email: 'joann@example.test', ip: '10.0.0.7' });
  db.audit(null, 'login.failed', null, { email: 'Ann@Example.test', ip: '10.0.0.8' });
  db.audit(null, 'admin.owner', 'x', { from: 'ann@example.test', to: 'joann@example.test', list: ['ann@example.test'] });
  const r2 = forgetUser('ann@example.test');
  const details = (db.getDb().prepare(`SELECT details FROM audit WHERE action IN ('login.failed', 'admin.owner') AND (details LIKE '%ann@%' OR details LIKE '%${r2.label}%') ORDER BY id`).all() as { details: string }[]).map((x) => JSON.parse(x.details));
  assert.deepEqual(details, [
    { email: 'joann@example.test', ip: '10.0.0.7' },
    { email: r2.label, ip: '10.0.0.8' },
    { from: r2.label, to: 'joann@example.test', list: [r2.label] },
  ]);
});

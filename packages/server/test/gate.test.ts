// The sign-in in front of the apps: the portal's cookie stays on the portal, every app gets its own cookie that is
// good only for itself, through a code for one use that only the gate sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

Object.assign(process.env, {
  DATA_DIR: await mkdtemp(join(tmpdir(), 'apd-gate-')),
  BASE_DOMAIN: 'app.ufficio.lan', APPRUA_NETWORK: 'lan', PUBLIC_URL: 'http://apprua.app.ufficio.lan',
});
const db = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { setEngine } = await import('../src/engine/index.js');
const { portalRoutes } = await import('../src/routes/portal.js');
const { gateRoutes } = await import('../src/routes/gate.js');

db.openDb(':memory:');
setEngine({ name: 'fake', check: async () => 'fake engine', runtimeStatus: async () => 'running' } as never);
const app = Fastify();
await app.register(portalRoutes);
await app.register(gateRoutes);

auth.createLocalUser('ada@example.test', 'Ada', 'ada-password-1', 'admin', 'test');
auth.createLocalUser('bo@example.test', null, 'bo-password-123', 'user', 'test');
const addApp = (name: string, owner: string, visibility: string) => db.getDb()
  .prepare(`INSERT INTO apps (name, owner, description, url, status, build_pack, cpus, memory, visibility) VALUES (?, ?, '', ?, 'running', 'static', '1', '512m', ?)`)
  .run(name, owner, `http://${name}.app.ufficio.lan`, visibility);
addApp('notes', 'bo@example.test', 'team');
addApp('evil', 'bo@example.test', 'team');
addApp('secret', 'bo@example.test', 'private');

const cookies = (r: { headers: Record<string, unknown> }) => {
  const c = r.headers['set-cookie'];
  return (Array.isArray(c) ? c : c ? [String(c)] : []).map(String);
};
const portal = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { host: 'apprua.app.ufficio.lan', ...(cookie ? { cookie } : {}) } });
/** What the engine's proxy asks before a request to an app. */
const gate = (host: string, uri: string, cookie = '') => app.inject({
  method: 'GET', url: '/_apprua/gate',
  headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'http', 'x-forwarded-uri': uri, ...(cookie ? { cookie } : {}) },
});

async function signIn(email: string, password: string): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: '/login', headers: { host: 'apprua.app.ufficio.lan', 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email, password }).toString(),
  });
  const c = cookies(r);
  assert.equal(c.length, 1);
  assert.match(c[0], /^apprua_portal=/);
  assert.doesNotMatch(c[0], /Domain=/i, 'the portal cookie is for the portal address only');
  return c[0].split(';')[0];
}

/** The whole way in: app -> portal pass -> code -> the app's own cookie. */
async function enter(host: string, uri: string, portalCookie: string): Promise<string> {
  const first = await gate(host, uri);
  assert.equal(first.statusCode, 302);
  const pass = new URL(String(first.headers.location));
  assert.equal(pass.origin, 'http://apprua.app.ufficio.lan');
  const toApp = await portal(pass.pathname + pass.search, portalCookie);
  assert.equal(toApp.statusCode, 302);
  const enterUrl = new URL(String(toApp.headers.location));
  assert.equal(enterUrl.host, host);
  assert.equal(enterUrl.pathname, '/_apprua/enter');
  const back = await gate(host, enterUrl.pathname + enterUrl.search);
  assert.equal(back.statusCode, 302);
  assert.equal(back.headers.location, `http://${host}${uri}`, 'back to the page that was asked for (a full address)');
  const c = cookies(back);
  assert.match(c[0], /^apprua_gate=/);
  assert.doesNotMatch(c[0], /Domain=/i, 'the app cookie is for the app address only');
  // the code works once
  assert.equal((await gate(host, enterUrl.pathname + enterUrl.search)).headers['set-cookie'], undefined);
  return c[0].split(';')[0];
}

test('the way in: the app gets its own cookie, the portal cookie never reaches it', async () => {
  const ada = await signIn('ada@example.test', 'ada-password-1');
  // nobody signed in: the gate sends to the portal, the portal to the login, and the login comes back here
  const first = await gate('notes.app.ufficio.lan', '/a?b=1');
  const pass = new URL(String(first.headers.location));
  const login = await portal(pass.pathname + pass.search);
  assert.equal(login.statusCode, 302);
  assert.match(String(login.headers.location), /^\/login\?next=/);

  const notesCookie = await enter('notes.app.ufficio.lan', '/a?b=1', ada);
  assert.equal((await gate('notes.app.ufficio.lan', '/a?b=1', notesCookie)).statusCode, 204);
  // the portal cookie is no good in front of an app (and is never sent there by the browser)
  assert.equal((await gate('notes.app.ufficio.lan', '/', ada)).statusCode, 302);
});

test('the app is told who is using it, with its own key', async () => {
  db.upsertUser('dee@example.test', 'Niccolò Müller', 'user');
  const code = auth.issuePass('dee@example.test', 'notes');
  const dee = cookies(await gate('notes.app.ufficio.lan', `/_apprua/enter?code=${code}&next=/`))[0].split(';')[0];
  const r = await gate('notes.app.ufficio.lan', '/', dee);
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers['x-apprua-user'], 'dee@example.test');
  assert.equal(decodeURIComponent(String(r.headers['x-apprua-user-name'])), 'Niccolò Müller', 'the name is URL-encoded');
  assert.equal(r.headers['x-apprua-role'], 'user');
  assert.equal(r.headers['x-apprua-key'], auth.appKey('notes'));
  assert.notEqual(auth.appKey('notes'), auth.appKey('evil'), 'every app has its own key');
  // a public app, nobody signed in: the key only, no user
  addApp('board', 'bo@example.test', 'public');
  const anon = await gate('board.app.ufficio.lan', '/');
  assert.equal(anon.statusCode, 204);
  assert.equal(anon.headers['x-apprua-key'], auth.appKey('board'));
  assert.equal(anon.headers['x-apprua-user'], undefined);
  // a refused request tells the app nothing
  const refused = await gate('notes.app.ufficio.lan', '/');
  assert.equal(refused.statusCode, 302);
  assert.equal(refused.headers['x-apprua-user'], undefined);
  assert.equal(refused.headers['x-apprua-key'], undefined);
});

test('an app cannot use the cookie of the people who open it anywhere else', async () => {
  const ada = await signIn('ada@example.test', 'ada-password-1');
  const evilCookie = await enter('evil.app.ufficio.lan', '/', ada);
  // not on another app
  assert.equal((await gate('notes.app.ufficio.lan', '/', evilCookie)).statusCode, 302);
  assert.equal((await gate('secret.app.ufficio.lan', '/', evilCookie)).statusCode, 302);
  // not on the portal
  assert.equal((await portal('/account', evilCookie)).statusCode, 302);
});

test('a code is for one app only, and expires', async () => {
  const code = auth.issuePass('ada@example.test', 'evil');
  const r = await gate('notes.app.ufficio.lan', `/_apprua/enter?code=${code}&next=/`);
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers['set-cookie'], undefined, 'a code for evil does not open notes');
  assert.equal(auth.usePass(code, 'evil'), null, 'and it is used up');
  assert.equal(auth.usePass('made-up', 'notes'), null);
});

test('the return path stays on the app', async () => {
  const code = auth.issuePass('ada@example.test', 'notes');
  const r = await gate('notes.app.ufficio.lan', `/_apprua/enter?code=${code}&next=${encodeURIComponent('//evil.example.com/')}`);
  assert.equal(r.headers.location, 'http://notes.app.ufficio.lan/');
  const pass = await portal(`/_apprua/pass?next=${encodeURIComponent('https://evil.example.com/')}`);
  assert.equal(pass.headers.location, '/', 'the portal only lets into apps of this installation');
});

test('private apps, new password, the old shared cookie', async () => {
  const bo = await signIn('bo@example.test', 'bo-password-123');
  const ada = await signIn('ada@example.test', 'ada-password-1');
  const boSecret = await enter('secret.app.ufficio.lan', '/', bo);
  assert.equal((await gate('secret.app.ufficio.lan', '/', boSecret)).statusCode, 204);
  // a colleague with an account: the page that says the app is private
  db.upsertUser('cy@example.test', 'Cy', 'user');
  const cyCode = auth.issuePass('cy@example.test', 'secret');
  const cy = cookies(await gate('secret.app.ufficio.lan', `/_apprua/enter?code=${cyCode}&next=/`))[0].split(';')[0];
  assert.equal((await gate('secret.app.ufficio.lan', '/', cy)).statusCode, 403);
  // a new password closes the apps too
  auth.setPassword('bo@example.test', 'bo-password-456', 'test');
  assert.equal((await gate('secret.app.ufficio.lan', '/', boSecret)).statusCode, 302);
  // the shared cookie of the versions before is not accepted, and is removed at the next sign-in
  const old = 'apprua_session=' + ada.split('=')[1];
  assert.equal((await portal('/account', old)).statusCode, 302);
  const r = await app.inject({
    method: 'POST', url: '/login', headers: { host: 'apprua.app.ufficio.lan', 'content-type': 'application/x-www-form-urlencoded', cookie: old },
    payload: new URLSearchParams({ email: 'ada@example.test', password: 'ada-password-1' }).toString(),
  });
  assert.ok(cookies(r).some((c) => /^apprua_session=;.*Max-Age=0; Domain=app\.ufficio\.lan/.test(c)));
});

test('a cookie planted by an app (same name, whole domain) does not lock anybody out', async () => {
  const ada = await signIn('ada@example.test', 'ada-password-1');
  const notes = await enter('notes.app.ufficio.lan', '/', ada);
  // the browser sends the planted one first (longer Path wins), then the real one
  assert.equal((await gate('notes.app.ufficio.lan', '/', `apprua_gate=junk.junk.junk; ${notes}`)).statusCode, 204);
  assert.equal((await portal('/account', `apprua_portal=junk; ${ada}`)).statusCode, 200);
});

test('HTTPS: cookies only over HTTPS, with the __Host- name, and the pass only to https addresses', async () => {
  const { config } = await import('../src/config.js');
  const before = { publicUrl: config.publicUrl, appScheme: config.appScheme };
  Object.assign(config, { publicUrl: 'https://apprua.app.ufficio.lan', appScheme: 'https' });
  try {
    const r = await app.inject({
      method: 'POST', url: '/login', headers: { host: 'apprua.app.ufficio.lan', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email: 'ada@example.test', password: 'ada-password-1' }).toString(),
    });
    const c = cookies(r)[0];
    assert.match(c, /^__Host-apprua_portal=.*; Secure/);
    const ada = c.split(';')[0];
    const pass = await portal(`/_apprua/pass?next=${encodeURIComponent('https://notes.app.ufficio.lan/p')}`, ada);
    const enterUrl = new URL(String(pass.headers.location));
    const back = await app.inject({ method: 'GET', url: '/_apprua/gate', headers: { 'x-forwarded-host': 'notes.app.ufficio.lan', 'x-forwarded-proto': 'https', 'x-forwarded-uri': enterUrl.pathname + enterUrl.search } });
    const g = cookies(back)[0];
    assert.match(g, /^__Host-apprua_gate=.*; Secure/);
    assert.equal((await app.inject({ method: 'GET', url: '/_apprua/gate', headers: { 'x-forwarded-host': 'notes.app.ufficio.lan', 'x-forwarded-proto': 'https', 'x-forwarded-uri': '/', cookie: g.split(';')[0] } })).statusCode, 204);
    // a crafted link cannot send the code over plain http or to another port
    for (const bad of ['http://notes.app.ufficio.lan/', 'https://notes.app.ufficio.lan:8000/']) {
      assert.equal((await portal(`/_apprua/pass?next=${encodeURIComponent(bad)}`, ada)).headers.location, '/', bad);
    }
  } finally { Object.assign(config, before); }
});

test('logout needs the same origin; a control character in the return path is ignored', async () => {
  const ada = await signIn('ada@example.test', 'ada-password-1');
  const r = await app.inject({ method: 'POST', url: '/logout', headers: { host: 'apprua.app.ufficio.lan', origin: 'https://evil.example.com', cookie: ada } });
  assert.equal(r.statusCode, 403);
  const code = auth.issuePass('ada@example.test', 'notes');
  assert.equal((await gate('notes.app.ufficio.lan', `/_apprua/enter?code=${code}&next=${encodeURIComponent('/a\r\nX: y')}`)).headers.location, 'http://notes.app.ufficio.lan/');
});

test('signing out closes the apps opened with that session too; an archived app is closed to everyone', async () => {
  const ada = await signIn('ada@example.test', 'ada-password-1');
  const notes = await enter('notes.app.ufficio.lan', '/', ada);
  assert.equal((await gate('notes.app.ufficio.lan', '/', notes)).statusCode, 204);
  const out = await app.inject({ method: 'POST', url: '/logout', headers: { host: 'apprua.app.ufficio.lan', cookie: ada } });
  assert.equal(out.statusCode, 302);
  assert.equal((await gate('notes.app.ufficio.lan', '/', notes)).statusCode, 302, 'the app cookie no longer opens the app');
  assert.equal((await portal('/account', ada)).statusCode, 302, 'nor the old portal cookie the portal');

  const again = await signIn('ada@example.test', 'ada-password-1');
  const notes2 = await enter('notes.app.ufficio.lan', '/', again);
  db.updateApp('notes', { status: 'archived' });
  try {
    const r = await gate('notes.app.ufficio.lan', '/', notes2);
    assert.equal(r.statusCode, 403);
    assert.match(r.body, /archived/);
    db.updateApp('notes', { visibility: 'public' });
    assert.equal((await gate('notes.app.ufficio.lan', '/')).statusCode, 403, 'also when it was open to everyone');
  } finally { db.updateApp('notes', { status: 'active', visibility: 'team' }); }
});

test('a code already handed out stops working when the person signs out in the meantime', async () => {
  const ada = await signIn('ada@example.test', 'ada-password-1');
  const code = auth.issuePass('ada@example.test', 'notes');
  await app.inject({ method: 'POST', url: '/logout', headers: { host: 'apprua.app.ufficio.lan', cookie: ada } });
  const r = await gate('notes.app.ufficio.lan', `/_apprua/enter?code=${code}&next=/`);
  assert.equal(r.headers['set-cookie'], undefined, 'no cookie for the app');
});

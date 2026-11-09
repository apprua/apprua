// Signpost: the page at app addresses where no app answers (paused, missing, on its way, needs a fix, restarting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

Object.assign(process.env, { DATA_DIR: await mkdtemp(join(tmpdir(), 'apd-sign-')) });
const db = await import('../src/db.js');
const sp = await import('../src/signpost.js');

db.openDb(':memory:');
db.upsertUser('me@example.test', 'Me', 'user');
const addApp = (name: string, status: string) => db.getDb()
  .prepare(`INSERT INTO apps (name, owner, description, url, status, build_pack, cpus, memory) VALUES (?, 'me@example.test', '', ?, ?, 'static', '1', '512m')`).run(name, `http://${name}.localhost`, status);
const addDeploy = (app: string, result: string | null) => db.getDb()
  .prepare(`INSERT INTO deploys (app, user, source, result) VALUES (?, 'me@example.test', 'test', ?)`).run(app, result);

test('app name from the address', () => {
  assert.equal(sp.appNameOf('notes.localhost'), 'notes');
  assert.equal(sp.appNameOf('Notes.LocalHost:80'), 'notes');
  assert.equal(sp.appNameOf('a.b.localhost'), null);
  assert.equal(sp.appNameOf('example.com'), null);
  assert.equal(sp.appNameOf('<x>.localhost'), null);
});

test('the reason matches the state of the app', () => {
  addApp('paused', 'stopped');
  addApp('gone', 'archived');
  addApp('new', 'active');
  addApp('broken', 'active'); addDeploy('broken', 'running'); addDeploy('broken', 'failed');
  addApp('flaky', 'active'); addDeploy('flaky', 'running');
  assert.equal(sp.signKind(null), 'none');
  assert.equal(sp.signKind('nothing'), 'none');
  assert.equal(sp.signKind('paused'), 'stopped');
  assert.equal(sp.signKind('gone'), 'archived');
  assert.equal(sp.signKind('new'), 'coming');
  assert.equal(sp.signKind('broken'), 'failed');
  assert.equal(sp.signKind('flaky'), 'down');
});

test('pages in both languages: texts, codes, refresh, no dashes', () => {
  for (const lang of ['it', 'en'] as const) {
    for (const host of ['nothing.localhost', 'example.com', 'paused.localhost', 'gone.localhost', 'new.localhost', 'broken.localhost', 'flaky.localhost']) {
      const p = sp.signpostPage(host, lang);
      const text = p.html.replace(/<style>[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, '');
      assert.ok(!/\bsign\.[a-z.]+\b/.test(text), `no missing texts (${lang}, ${host})`);
      assert.ok(!/\{app\}|\{brand\}/.test(text), 'placeholders filled');
      assert.ok(!/[—–]/.test(text), 'no em/en dashes');
      assert.equal(p.status, p.kind === 'none' || p.kind === 'archived' ? 404 : 503);
      assert.equal(/http-equiv="refresh"/.test(p.html), p.kind === 'coming' || p.kind === 'down');
    }
  }
  assert.match(sp.signpostPage('paused.localhost', 'it').html, /Paused è in pausa/);
  assert.match(sp.signpostPage('paused.localhost', 'en').html, /Paused is paused/);
});

test('served on its own port: page by Host, assets, nothing else', async () => {
  const s = sp.startSignpost(0);
  await new Promise((r) => s.once('listening', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${base}/some/path`, { headers: { 'X-Forwarded-Host': 'paused.localhost', 'Accept-Language': 'it-IT,it;q=0.9' } });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '10');
    assert.match(await r.text(), /Paused è in pausa/);
    const img = await fetch(`${base}/_apprua/img/riposo.svg`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/svg+xml');
    const font = await fetch(`${base}/_apprua/fonts/lilita-one-latin.woff2`);
    assert.equal(font.status, 200);
    const sneaky = await fetch(`${base}/_apprua/img/..%2F..%2Fpackage.json`);
    assert.equal(sneaky.headers.get('content-type'), 'text/html; charset=utf-8', 'no files outside the assets');
  } finally {
    s.close();
  }
});

test('the gate in front of the apps: who opens what, shared sign-in, safe return after signing in', async () => {
  const { config } = await import('../src/config.js');
  const { canOpen } = await import('../src/routes/gate.js');
  const auth = await import('../src/auth.js');
  const owner = db.getUser('me@example.test')!;
  const other = db.upsertUser('colleague@example.test', 'C', 'user');
  const admin = db.upsertUser('boss@example.test', 'B', 'admin');
  const app = (visibility: 'private' | 'team' | 'public') => ({ ...db.getApp('flaky')!, visibility });
  assert.deepEqual(canOpen(app('public'), null), { allow: true });
  assert.deepEqual(canOpen(app('team'), null), { allow: false, signIn: true });
  assert.deepEqual(canOpen(app('team'), other), { allow: true });
  assert.deepEqual(canOpen(app('private'), other), { allow: false, signIn: false });
  assert.deepEqual(canOpen(app('private'), owner), { allow: true });
  assert.deepEqual(canOpen(app('private'), admin), { allow: true });
  assert.equal(db.getApp('flaky')!.visibility, 'team', 'apps are for people with an account by default');

  const before = { baseDomain: config.baseDomain, network: config.network, publicUrl: config.publicUrl };
  Object.assign(config, { baseDomain: 'app.ufficio.lan', network: 'lan', publicUrl: 'http://apprua.app.ufficio.lan' });
  try {
    assert.equal(auth.legacyDomain('apprua.app.ufficio.lan'), '; Domain=app.ufficio.lan', 'the old shared cookie is removed there');
    assert.equal(auth.legacyDomain('localhost:3000'), '');
    assert.equal(auth.safeNext('http://notes.app.ufficio.lan/a?b=1'), 'http://notes.app.ufficio.lan/a?b=1');
    assert.equal(auth.safeNext('http://apprua.app.ufficio.lan/'), 'http://apprua.app.ufficio.lan/');
    assert.equal(auth.safeNext('https://evil.example.com/'), null, 'no open redirect');
    assert.equal(auth.safeNext('http://app.ufficio.lan.evil.com/'), null);
    assert.equal(auth.safeNext('javascript:alert(1)'), null);
    Object.assign(config, { network: 'local' });
    assert.equal(auth.legacyDomain('apprua.app.ufficio.lan'), '', 'only this computer: there was nothing shared');
  } finally {
    Object.assign(config, before);
  }
});

// Apps that are on but not answering: found by the periodic check, shown in the portal after 2 minutes, cleared when
// they run again or when someone restarts them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

Object.assign(process.env, { DATA_DIR: await mkdtemp(join(tmpdir(), 'apd-mon-')) });
const db = await import('../src/db.js');
const { setEngine } = await import('../src/engine/index.js');
const monitor = await import('../src/monitor.js');
const i18n = await import('../src/i18n.js');
const views = await import('../src/views.js');

let status: string | null = 'running:healthy';
let engineDown = false;
setEngine({
  name: 'fake', check: async () => 'fake',
  runtimeStatus: async () => { if (engineDown) throw new Error('no answer'); return status; },
  restart: async () => {},
} as never);

db.openDb(':memory:');
const owner = db.upsertUser('me@example.test', 'Me', 'user');
const add = (name: string) => db.getDb().prepare(`INSERT INTO apps (name, owner, description, engine_id, url, status, build_pack, cpus, memory)
  VALUES (?, ?, 'An app', ?, ?, 'active', 'static', '1', '512m')`).run(name, owner.email, `id-${name}`, `http://${name}.localhost`);
add('shop');
const app = () => db.getApp('shop')!;
const MIN = 60_000;

test('an engine status is "answering" only when the app runs and is not unhealthy', () => {
  assert.ok(monitor.answering('running') && monitor.answering('running:healthy') && monitor.answering('running:unknown'));
  for (const s of ['exited', 'exited:unhealthy', 'restarting', 'running:unhealthy', 'dead', null]) assert.equal(monitor.answering(s), false, String(s));
});

test('found down, shown after 2 minutes, cleared when it runs again', async () => {
  const t0 = Date.parse('2026-11-06T10:00:00Z');
  status = 'exited';
  await monitor.checkApps(t0);
  assert.ok(app().down_since, 'noted at the first check');
  assert.equal(monitor.isDown(app(), t0 + 1 * MIN), false, 'not an alarm during the first 2 minutes (a restart)');
  await monitor.checkApps(t0 + 2 * MIN);
  assert.equal(app().down_since, new Date(t0).toISOString(), 'the time it was first found down is kept');
  assert.ok(monitor.isDown(app(), t0 + 3 * MIN));

  engineDown = true;
  await monitor.checkApps(t0 + 4 * MIN);
  assert.ok(app().down_since, 'the engine not answering changes nothing');
  engineDown = false;

  status = 'running:healthy';
  await monitor.checkApps(t0 + 5 * MIN);
  assert.equal(app().down_since, null, 'back to normal');
});

test('a paused app, or one being published, is not an alarm', async () => {
  status = 'exited';
  db.updateApp('shop', { status: 'stopped', down_since: null });
  await monitor.checkApps();
  assert.equal(app().down_since, null, 'paused: nothing to check');
  db.updateApp('shop', { status: 'active' });
  db.getDb().prepare(`INSERT INTO deploys (app, user, source) VALUES ('shop', 'me@example.test', 'test')`).run();
  await monitor.checkApps();
  assert.equal(app().down_since, null, 'being published: no verdict yet');
  db.getDb().prepare(`UPDATE deploys SET result = 'running', finished_at = datetime('now')`).run();
});

test('the portal shows "Not answering" with a restart button', () => {
  db.updateApp('shop', { status: 'active', down_since: new Date(Date.now() - 10 * MIN).toISOString() });
  const html = views.home({ lang: 'it', u: owner, flash: '', mine: [app()], history: { shop: [{ result: 'running', at: '2026-11-06 10:00:00' }] }, versions: { shop: 1 }, engineOk: true, admin: false } as never);
  assert.ok(html.includes(i18n.t('it', 'status.down')), 'the state');
  assert.ok(html.includes(i18n.t('it', 'sum.down', { app: 'Shop' })), 'the sentence at the top');
  assert.ok(html.includes('action="/portal/apps/shop/restart"'), 'the restart button');
});

test('ran out of memory: read from what apprua-guard writes, shown in the portal, cleared by more memory', async () => {
  const { writeFile } = await import('node:fs/promises');
  const file = join(process.env.DATA_DIR!, 'oom.log');
  db.updateApp('shop', { status: 'active', down_since: null, oom_at: null, last_deploy_at: '2026-11-07T08:00:00.000Z' });
  // an event before the last version is about the old one; lines that are not events are skipped
  await writeFile(file, '2026-11-07T07:00:00Z id-shop\nnot a line\n2026-11-07T09:00:00Z <no value>\n');
  await monitor.checkMemory(file);
  assert.equal(app().oom_at ?? null, null, 'old version: nothing to say');
  await writeFile(file, '2026-11-07T07:00:00Z id-shop\n2026-11-07T09:30:00Z id-shop\n');
  await monitor.checkMemory(file);
  assert.equal(app().oom_at, '2026-11-07T09:30:00.000Z');
  const now = Date.parse('2026-11-07T10:00:00Z');
  assert.ok(monitor.outOfMemory(app(), now));
  assert.equal(monitor.outOfMemory(app(), now + 8 * 86_400_000), false, 'after a week it is old news');
  db.updateApp('shop', { oom_at: null });
  await monitor.checkMemory(file);
  assert.equal(app().oom_at, null, 'an event is read once');

  db.updateApp('shop', { oom_at: new Date().toISOString() });
  const html = views.home({ lang: 'it', u: owner, flash: '', mine: [app()], history: { shop: [{ result: 'running', at: '2026-11-06 10:00:00' }] }, versions: { shop: 1 }, engineOk: true, admin: false } as never);
  assert.ok(html.includes(i18n.t('it', 'mem.tag')) && html.includes('href="/portal/apps/shop#mem"'), 'the list says it, with a link to the memory');
  // the page of the app: the owner is told to ask; an administrator chooses, up to the ceiling of the machine
  const page = (u: unknown) => views.appPage('it', u as never, app(), [], [], '', true, { onMb: 3072, roomMb: 6144 });
  const own = page(owner);
  assert.ok(own.includes(views.esc(i18n.t('it', 'mem.ask'))) && !own.includes('action="/portal/apps/shop/memory"'));
  assert.ok(own.indexOf('id="mem"') < own.indexOf('id="ver-h"'), 'the memory first, when it ran out');
  const adm = page({ ...owner, role: 'admin' });
  assert.ok(adm.includes('action="/portal/apps/shop/memory"') && adm.includes(views.esc(i18n.t('it', 'mem.save.on'))));
  assert.ok(adm.includes('<option value="512m" selected>'), 'the memory it has now');
  assert.ok(adm.includes('Le app accese possono usare insieme fino a 3 GB'), 'what the apps on take together');
  assert.ok(!/[—–]/.test(adm.replace(/<style>[\s\S]*?<\/style>/g, '')), 'no em/en dashes');

  // a new memory limit: the old "ran out" is gone
  setEngine({ name: 'fake', check: async () => 'fake', runtimeStatus: async () => status, restart: async () => {}, updateApp: async () => {} } as never);
  const ops = await import('../src/adminOps.js');
  await ops.setLimits('admin@example.test', 'shop', undefined, '1g');
  assert.equal(app().memory, '1g');
  assert.equal(app().oom_at, null);
});

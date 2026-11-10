// Publication with a fake engine: code archive (git), registry, redeploy, version conflicts, source export,
// the read-only git server, and the translated portal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';

Object.assign(process.env, { DATA_DIR: await mkdtemp(join(tmpdir(), 'apd-pub-')), GIT_INTERNAL_URL: 'http://127.0.0.1:39417' });
const { VERSION } = await import('../src/version.js');
const db = await import('../src/db.js');
const { setEngine } = await import('../src/engine/index.js');
const { publish } = await import('../src/publish.js');
const repos = await import('../src/repos.js');
const i18n = await import('../src/i18n.js');
const views = await import('../src/views.js');

const calls: string[] = [];
const envs: Record<string, Set<string>> = {};
let failNext = 0;
setEngine({
  name: 'fake',
  check: async () => 'fake engine',
  createApp: async (i) => { calls.push(`create ${i.name} ${i.buildPack} ${i.port} ${i.url} ${i.gitUrl}`); return `id-${i.name}`; },
  updateApp: async (id, i) => { calls.push(`update ${id} ${JSON.stringify(i)}`); },
  deleteApp: async (id) => { calls.push(`delete ${id}`); },
  setUrl: async (id, url) => { calls.push(`url ${id} ${url}`); },
  start: async (id) => { calls.push(`start ${id}`); },
  stop: async (id) => { calls.push(`stop ${id}`); },
  restart: async (id) => { calls.push(`restart ${id}`); },
  addPersistentStorage: async (id) => { calls.push(`volume ${id}`); },
  applyLabels: async (id, app, owner) => { calls.push(`labels ${id} ${app} ${owner}`); },
  setEnv: async (id, key) => { (envs[id] ??= new Set()).add(key); },
  listEnv: async (id) => [...(envs[id] ?? [])].sort(),
  deleteEnv: async (id, key) => { envs[id]?.delete(key); calls.push(`unset ${id} ${key}`); },
  runtimeStatus: async () => 'running',
  runtimeLogs: async () => [],
  deploy: async (id) => { calls.push(`deploy ${id}`); return `dep-${calls.length}`; },
  waitDeployment: async () => (failNext-- > 0
    ? { status: 'failed', logTail: ['ERROR: failed to resolve source metadata: lookup auth.docker.io on 127.0.0.11:53: server misbehaving'] }
    : { status: 'finished', logTail: [] }),
});

async function archiveOf(files: Record<string, string>) {
  const d = await mkdtemp(join(tmpdir(), 'app-'));
  for (const [f, c] of Object.entries(files)) {
    await mkdir(join(d, f, '..'), { recursive: true });
    await writeFile(join(d, f), c);
  }
  const arc = join(await mkdtemp(join(tmpdir(), 'arc-')), 'a.tar.gz');
  await tar.c({ gzip: true, file: arc, cwd: d, portable: true }, Object.keys(files));
  return arc;
}

db.openDb(':memory:');
// open publications are followed in the background: short pauses between rounds in the tests
(await import('../src/publish.js')).followTiming.pauseMs = 5;
const user = db.upsertUser('me@example.test', 'Me', 'user');
const other = db.upsertUser('you@example.test', 'You', 'user');

test('publish a new static app, then a new version', async () => {
  const r = await publish({ user, name: 'my-notes', description: 'Notes', archivePath: await archiveOf({ 'index.html': '<h1>v1</h1>', 'old.txt': 'x' }) });
  assert.equal(r.status, 'running');
  assert.equal(r.url, 'http://my-notes.localhost');
  assert.match(calls.find((c) => c.startsWith('create'))!, /^create my-notes static 80 http:\/\/my-notes\.localhost http:\/\/127\.0\.0\.1:39417\/git\/[A-Za-z0-9_-]{32}\/my-notes\.git$/);
  assert.ok(calls.includes('labels id-my-notes my-notes me@example.test'));
  const v1 = r.commit;
  assert.equal(await repos.headCommit('my-notes'), v1);

  // Same content again: no new version, but still deployed
  const same = await publish({ user, name: 'my-notes', archivePath: await archiveOf({ 'index.html': '<h1>v1</h1>', 'old.txt': 'x' }), baseCommit: v1 });
  assert.equal(same.commit, v1);

  // New version from an up-to-date copy; deleted files disappear
  const r2 = await publish({ user, name: 'my-notes', archivePath: await archiveOf({ 'index.html': '<h1>v2</h1>' }), baseCommit: v1 });
  assert.notEqual(r2.commit, v1);
  const hist = await repos.history('my-notes');
  assert.equal(hist.length, 2);
  assert.match(hist[0].author, /me@example\.test/);

  const out = join(await mkdtemp(join(tmpdir(), 'exp-')), 's.tar.gz');
  await repos.exportArchive('my-notes', out);
  const dest = await mkdtemp(join(tmpdir(), 'x-'));
  await tar.x({ file: out, cwd: dest });
  assert.equal(await readFile(join(dest, 'index.html'), 'utf8'), '<h1>v2</h1>');
  assert.ok(!existsSync(join(dest, 'old.txt')));
  assert.ok(existsSync(join(dest, 'README.md')), 'a README is added when missing');

  // A stale copy is refused instead of overwriting
  await assert.rejects(publish({ user, name: 'my-notes', archivePath: await archiveOf({ 'index.html': 'stale' }), baseCommit: v1 }), /changed since your copy/);
});

test('names of other people and secrets are refused', async () => {
  await assert.rejects(publish({ user: other, name: 'my-notes', description: 'x', archivePath: await archiveOf({ 'index.html': 'x' }) }), /already used/);
  await assert.rejects(publish({ user, name: 'leaky', description: 'x', archivePath: await archiveOf({ 'index.html': 'x', '.env': 'A=1' }) }), /secrets/);
  assert.equal(db.getApp('leaky'), undefined);
});

test('a build that fails for a network glitch is retried once', async () => {
  failNext = 1;
  const before = calls.filter((c) => c.startsWith('deploy')).length;
  const r = await publish({ user, name: 'retry-me', description: 'x', archivePath: await archiveOf({ 'index.html': 'x' }) });
  assert.equal(r.status, 'running');
  assert.equal(calls.filter((c) => c.startsWith('deploy')).length - before, 2);
});

test('the git server serves clones with the right key only, never pushes', async () => {
  const server = repos.startGitServer(39417);
  try {
    const dest = join(await mkdtemp(join(tmpdir(), 'clone-')), 'c');
    // Async: the git server runs in this same process
    await promisify(execFile)('git', ['clone', '-q', '--depth', '1', '--branch', 'main', repos.internalGitUrl('my-notes'), dest], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000 });
    assert.equal(await readFile(join(dest, 'index.html'), 'utf8'), '<h1>v2</h1>');
    const wrong = await fetch('http://127.0.0.1:39417/git/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/my-notes.git/info/refs?service=git-upload-pack');
    assert.equal(wrong.status, 404);
    const push = await fetch(`${repos.internalGitUrl('my-notes')}/info/refs?service=git-receive-pack`);
    assert.equal(push.status, 403);
    // an address that cannot be read is answered, and the server stays up
    assert.equal((await fetch('http://127.0.0.1:39417//')).status, 400);
    assert.equal((await fetch(`${repos.internalGitUrl('my-notes')}/info/refs?service=git-receive-pack`)).status, 403, 'still answering');
  } finally { server.close(); }
});

test('portal texts exist in every language and render', () => {
  assert.deepEqual(i18n.checkDictionaries(), []);
  const u = db.getUser('me@example.test')!;
  const mine = [db.getApp('my-notes')!];
  const history = { 'my-notes': [{ result: 'running', at: '2026-11-01 10:00:00' }, { result: 'failed', at: '2026-11-02 10:00:00' }, { result: 'running', at: '2026-11-03 10:00:00' }] };
  const en = views.home({ lang: 'en', u, mine, history, versions: { 'my-notes': 12 } });
  const it = views.home({ lang: 'it', u, mine, history, versions: { 'my-notes': 12 } });
  // minimal home (2026-11-05): no history bars, no app count, no switch, no admin section, no visible command bar
  for (const gone of ['hist-n', 'class="switch"', 'class="admin"', '4 app']) assert.ok(!it.includes(gone), `no ${gone}`);
  assert.match(it, /<details class="menu acct">/, 'one account menu');
  assert.match(it, /data-open-cmd/, 'search reachable from the account menu');
  // connect your AI app: one tab per app; with the key just created, one-click buttons for Cursor and VS Code
  const withKey = { ...u, token_prefix: 'apr_abc', token_expires_at: '2099-01-01', revoked_at: null, token_used_at: null };
  const step2 = views.home({ lang: 'it', u: withKey, mine: [] });
  assert.match(step2, /Quale app AI usi\?/);
  for (const app of ['Claude Desktop', 'Claude Code', 'Cursor', 'VS Code', 'Altre app']) assert.ok(step2.includes(`>${app}</label>`), `tab ${app}`);
  assert.ok(!step2.includes('cursor://'), 'no one-click link without the key');
  assert.ok(!/[—–]/.test(step2), 'no em/en dashes');
  // a release takes the connector of its own version from npm; a copy built from the source, from the portal

  const fromNpm = views.home({ lang: 'it', u: withKey, mine: [], fresh: { token: 'apr_secret123', expiresAt: '2099-01-01' } });
  assert.ok(fromNpm.includes(`npx -y @apprua/mcp@${VERSION}`), 'from npm, at this exact version');
  assert.ok(!fromNpm.includes('--package'));
  process.env.APPRUA_CONNECTOR_SOURCE = 'server';
  const fresh = views.home({ lang: 'it', u: withKey, mine: [], fresh: { token: 'apr_secret123', expiresAt: '2099-01-01' } });
  const links = views.installLinks('apr_secret123');
  assert.ok(fresh.includes(links.cursor.replace(/&/g, '&amp;')) && fresh.includes('vscode:mcp/install?'), 'one-click links with the new key');
  const cfg = JSON.parse(Buffer.from(decodeURIComponent(links.cursor.split('config=')[1]), 'base64').toString());
  assert.deepEqual(cfg.args.slice(0, 2), ['-y', '--package']);
  assert.equal(cfg.env.APPRUA_TOKEN, 'apr_secret123');
  assert.equal(JSON.parse(decodeURIComponent(links.vscode.split('?')[1])).name, 'apprua');
  assert.match(fresh, /i passi sono qui sotto/, 'the key notice points to step 2 instead of repeating it');
  assert.match(fresh, /-- cmd \/c npx -y --package \S+ apprua-mcp/, 'Claude Code on Windows: cmd /c npx');
  assert.match(fresh, /apprua-mcp\.tgz apprua-mcp<\/span>/, 'Claude Code elsewhere: npx');
  assert.match(fresh, /-- npx -y --package /);
  delete process.env.APPRUA_CONNECTOR_SOURCE;
  // status: "On" with a working engine; "Engine stopped" and a notice without; the hidden notice for when the portal stops
  assert.match(it, /class="live" id="live"[^>]*hidden/, 'no status shown when all is well');
  assert.match(it, /id="offline" role="alert" hidden/);
  const noEngine = views.home({ lang: 'it', u, mine, engineOk: false });
  assert.match(noEngine, /class="live bad"[^>]*>.*Motore fermo/);
  assert.match(noEngine, /Il motore delle app non risponde/);
  assert.ok(!/class="live/.test(views.loginPage('it')), 'no status on the sign-in page');
  assert.match(en, /Your apps/);
  assert.match(it, /Le tue app/);
  assert.ok(!/\{[a-z]+\}/.test(en.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '')), 'no untranslated placeholders');
  assert.ok(!/\b(sum|hist|cmd|act|apps|step\d|steps|status|time)\.[a-z.]+\b/.test((en + it).replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '')), 'no missing text keys shown');
  assert.ok(!/[—–]/.test(en + it), 'no em/en dashes in portal copy (house style)');
  assert.match(it, /role="combobox"/, 'command bar present');
  assert.match(it, /Cosa vuoi fare\?/);
  assert.match(en, /data-k="[^"]*my-notes"/, 'apps reachable from the command bar');
  // the inline script must parse (it is written inside a TypeScript template string)
  for (const s of it.match(/<script>([\s\S]*?)<\/script>/g) ?? []) new Function(s.replace(/<\/?script>/g, ''));
  assert.match(en, /apprua/i, 'brand shown');
  assert.match(it, /apprua/i, 'brand shown');
  // the mark: the lighthouse whose tower is the "A" of Lilita One (same shape as the Windows icons and the illustrations)
  assert.ok(views.favicon().startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && views.favicon().includes(views.TOWER_A), 'lighthouse favicon');
  assert.ok(!/var\(--/.test(views.favicon()), 'favicon uses fixed colours');
  assert.match(step2, /class="surface empty"><img class="art" src="\/assets\/img\/barca\.svg\?v=\d+"/, 'the boat illustration in the empty app list');
  assert.match(views.loginPage('it'), /<main class="split"><div class="pic" role="img"/, 'the harbour beside the sign-in form');
  assert.ok(views.favicon().includes('#2234EE') && views.favicon().includes('#FFC94D'), 'the mark in the four inks');
  // an app is just its name; the tiny lighthouse before the state tells the state (no tiles, initials or icons)
  assert.match(it, /<li[^>]*>\n<span class="meta">/);
  assert.match(it, /class="state active"><span class="beacon active" aria-hidden="true"><svg class="lamp"/);
  assert.ok(!/class="tile|\/app-icon\//.test(it), 'no app tiles');
  const running = views.home({ lang: 'it', u, mine, history: { 'my-notes': [{ result: null, at: '2026-11-03 10:00:00' }] } });
  assert.match(running, /class="state publishing"><span class="beacon publishing"[^]*?In pubblicazione/, 'a publication in progress');
  // the one celebration: the very first app, online in the last two minutes
  const now = new Date().toISOString();
  const firstApp = [{ ...mine[0], status: 'active' as const, last_deploy_at: now }];
  const party = views.home({ lang: 'it', u, mine: firstApp, history: { 'my-notes': [{ result: 'running', at: now }] }, versions: { 'my-notes': 1 } });
  assert.match(party, /La tua prima app è online/);
  assert.match(party, /src="\/assets\/img\/prima-app\.svg\?v=\d+"/, 'the celebration illustration');
  const second = views.home({ lang: 'it', u, mine: firstApp, history: { 'my-notes': [{ result: 'running', at: now }] }, versions: { 'my-notes': 2 } });
  assert.ok(!/La tua prima app è online/.test(second), 'only the first time');
});

test('apps move to the new addresses when the network changes', async () => {
  const { config } = await import('../src/config.js');
  const { moveAppsToCurrentAddresses } = await import('../src/addresses.js');
  const before = { baseDomain: config.baseDomain, network: config.network, lanIp: config.lanIp, https: config.https, appScheme: config.appScheme };
  calls.length = 0;
  assert.deepEqual(await moveAppsToCurrentAddresses(), [], 'nothing to move while the addresses are right');
  // the local network, with a name of the user's network (no public service in between)
  Object.assign(config, { baseDomain: 'app.ufficio.lan', network: 'lan', lanIp: '192.168.1.20' });
  try {
    const moved = await moveAppsToCurrentAddresses();
    assert.ok(moved.includes('my-notes'));
    assert.equal(db.getApp('my-notes')!.url, 'http://my-notes.app.ufficio.lan');
    assert.ok(calls.includes('url id-my-notes http://my-notes.app.ufficio.lan'));
    assert.ok(calls.includes('labels id-my-notes my-notes me@example.test'), 'owner labels applied again');
    assert.deepEqual(await moveAppsToCurrentAddresses(), [], 'once only');
    // Settings tells where the apps open, where the names must point, that there is no HTTPS, and how to change it
    const u = db.getUser('me@example.test')!;
    const r = { memTotalMb: 8000, memUsedMb: 1000, diskTotalMb: null, diskFreeMb: null, appsOn: 1, fitOn: 8, fitNew: 7, wsl: true, hostMemoryGb: 16 } as any;
    const it = views.settingsPage('it', u, r);
    assert.match(it, /Dalla rete locale/);
    assert.match(it, /apprua\.app\.ufficio\.lan e \*\.app\.ufficio\.lan portano a questo computer \(192.168.1.20\)/);
    assert.match(it, /Senza HTTPS/);
    assert.match(it, /href="\/settings\?check=net#net-h">Verifica/);
    assert.ok(it.includes('install\\windows\\install-apprua.ps1 -Network local'), 'how to go back, with the right path');
    assert.ok(it.includes('-Network lan -Cert C:\\certificati\\cert.pem -CertKey C:\\certificati\\chiave.pem'), 'how to add HTTPS');
    assert.ok(!/sslip/.test(it), 'no public name service');
    assert.ok(!/\b(set\.net|net\.check)\.[a-z.]+\b/.test(it), 'no missing texts');
    // after Check: every line in words, and the device test with this installation's id
    const checked = views.settingsPage('en', u, r, '', true, { apps: [], users: [], engine: '', net: { id: 'abc123', cert: null, check: [
      { state: 'ok', key: 'portal.ok', vars: { name: 'apprua.app.ufficio.lan', ips: '192.168.1.20' } },
      { state: 'bad', key: 'apps.none', vars: { domain: 'app.ufficio.lan', ip: '192.168.1.20' } },
      { state: 'warn', key: 'https.off' },
    ] } });
    assert.match(checked, /apprua\.app\.ufficio\.lan leads to this computer/);
    assert.match(checked, /the line \*\.app\.ufficio\.lan pointing to 192.168.1.20 is missing/);
    assert.match(checked, /data-url="http:\/\/verifica-[a-z0-9]+\.app\.ufficio\.lan\/_apprua\/ping" data-id="abc123"/);
    assert.ok(!/\b(set\.net|net\.check)\.[a-z.]+\b/.test(checked), 'no missing texts');
    // your certificate: when it ends shows without pressing Check, with a warning near the end
    Object.assign(config, { https: 'own', appScheme: 'https' });
    const soon = views.settingsPage('it', u, r, '', true, { apps: [], users: [], engine: '', net: { id: 'x', check: null,
      cert: { subject: '*.app.ufficio.lan', issuer: 'Ufficio CA', validTo: new Date(Date.now() + 10 * 86_400_000), daysLeft: 10, trusted: false, coversPortal: true, coversApps: true, placeholder: false } } });
    assert.match(soon, /Il tuo certificato scade il \d{4}-\d\d-\d\d \(mancano 10 giorni\)/);
    assert.ok(soon.includes('-Network lan -Https off'), 'how to go back to http');
  } finally {
    Object.assign(config, before);
  }
});

test('versions: go back to an earlier one, download it; secrets: names only, change, remove', async () => {
  const appOps = await import('../src/appOps.js');
  const me = db.getUser('me@example.test')!;
  const vs = await appOps.appVersions(me, 'my-notes');
  assert.ok(vs.length >= 2, 'more than one version');
  assert.ok(vs[0].current && !vs[1].current);
  const old = vs[vs.length - 1];
  const r = await appOps.restoreVersion(me, 'my-notes', old.sha, true) as any;
  assert.equal(r.status, 'running');
  const after = await appOps.appVersions(me, 'my-notes');
  assert.equal(after.length, vs.length + 1, 'a new version, nothing lost');
  assert.match(after[0].message, /Back to the version of/);
  // the files are those of the old version again
  const out = join(await mkdtemp(join(tmpdir(), 'zip-')), 'v.zip');
  await repos.exportArchive('my-notes', out, after[0].sha, 'zip');
  assert.ok(existsSync(out), 'zip of a version');
  await assert.rejects(appOps.restoreVersion(me, 'my-notes', 'deadbeef'), /Not a version/);
  await assert.rejects(appOps.restoreVersion(db.getUser('you@example.test')!, 'my-notes', old.sha), /not|own/i, 'only the owner');

  await appOps.setEnv(me, 'my-notes', 'API_KEY', 'secret-value', false);
  assert.deepEqual(await appOps.listEnv(me, 'my-notes'), ['API_KEY']);
  await appOps.deleteEnv(me, 'my-notes', 'API_KEY', false);
  assert.deepEqual(await appOps.listEnv(me, 'my-notes'), []);

  const page = views.appPage('it', me, db.getApp('my-notes')!, after, ['API_KEY', 'DB_PASSWORD']);
  assert.match(page, /Torna a questa/);
  assert.match(page, /Scarica il codice/);
  assert.match(page, /API_KEY/);
  assert.ok(!page.includes('secret-value'), 'values never in the page');
  assert.ok(!/\b(ver|env)\.[a-z_.]+\b/.test(page.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '')), 'no missing texts');
  assert.ok(!/[—–]/.test(page), 'no dashes');
  for (const s of page.match(/<script>([\s\S]*?)<\/script>/g) ?? []) new Function(s.replace(/<\/?script>/g, ''));
});

test('settings for administrators: the engine for experts, and the apps it does not agree on', () => {
  const me = db.getUser('me@example.test')!;
  const r = { memTotalMb: 8000, memUsedMb: 1000, diskTotalMb: null, diskFreeMb: null, appsOn: 1, fitOn: 8, fitNew: 7, wsl: true, hostMemoryGb: 16 } as any;
  const base = { apps: [], users: [], engine: 'fake' };
  const ok = views.settingsPage('it', me, r, '', true, { ...base, drift: [] });
  assert.match(ok, /Il motore \(per esperti\)/);
  assert.match(ok, /girano anche nel motore/);
  assert.match(ok, /http:\/\/localhost:8000/);
  assert.match(ok, /COOLIFY_ADMIN_PASSWORD/);
  const bad = views.settingsPage('en', me, { ...r, wsl: false }, '', true, { ...base, drift: [{ name: 'my-notes', problem: 'missing' }] });
  assert.match(bad, /My notes: on in Apprua, but not found in the engine/);
  assert.match(bad, /ssh -L 8000:localhost:8000/);
  for (const page of [ok, bad]) {
    assert.ok(!/\beng\.[a-z_.]+\b/.test(page.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '')), 'no missing texts');
    assert.ok(!/[—–]/.test(page), 'no dashes');
  }
});

test('publications at the same time: one per app, and the quota counts the ones in progress', async () => {
  const { config } = await import('../src/config.js');
  const quota = config.policy.defaultQuota;
  const solo = db.upsertUser('solo@example.test', 'Solo', 'user');
  const [a, b] = await Promise.allSettled([
    publish({ user: solo, name: 'twin-app', description: 'x', archivePath: await archiveOf({ 'index.html': '1' }) }),
    publish({ user: solo, name: 'twin-app', description: 'x', archivePath: await archiveOf({ 'index.html': '2' }) }),
  ]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.match(String((b as PromiseRejectedResult).reason.message), /being published right now/);
  // two new apps at once with one place left: only one passes
  config.policy.defaultQuota = db.countActiveApps('solo@example.test') + 1;
  try {
    const results = await Promise.allSettled([
      publish({ user: solo, name: 'quota-one', description: 'x', archivePath: await archiveOf({ 'index.html': '1' }) }),
      publish({ user: solo, name: 'quota-two', description: 'x', archivePath: await archiveOf({ 'index.html': '2' }) }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message), /quota/);
  } finally { config.policy.defaultQuota = quota; }
  // when it is over, the app can be published again
  assert.equal((await publish({ user: solo, name: 'twin-app', archivePath: await archiveOf({ 'index.html': '3' }) })).status, 'running');
});

test('a publication the engine does not take is closed as failed, not left open', async () => {
  const { engine } = await import('../src/engine/index.js');
  const e = engine();
  const deploy = e.deploy;
  e.deploy = async () => { throw new Error('engine down'); };
  try {
    await assert.rejects(publish({ user, name: 'my-notes', archivePath: await archiveOf({ 'index.html': 'x' }) }), /engine down/);
  } finally { e.deploy = deploy; }
  const last = db.getDb().prepare(`SELECT result, log_excerpt FROM deploys WHERE app = 'my-notes' ORDER BY id DESC LIMIT 1`).get() as { result: string; log_excerpt: string };
  assert.equal(last.result, 'failed');
  assert.match(last.log_excerpt, /engine down/);
});

test('after a restore the apps are published again; a start that stops halfway goes on from there', async () => {
  const { republishAfterRestore } = await import('../src/addresses.js');
  const { engine } = await import('../src/engine/index.js');
  const e = engine();
  const deploy = e.deploy;
  const active = (db.getDb().prepare(`SELECT name FROM apps WHERE engine_id IS NOT NULL AND status = 'active' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  assert.ok(active.length >= 2);
  process.env.APPRUA_REPUBLISH = 'restore-1';
  try {
    // the engine fails on the second app: the first is done, the second is tried again at the next start
    let n = 0;
    e.deploy = async (id) => { if (++n === 2) throw new Error('engine busy'); return deploy(id); };
    const first = await republishAfterRestore();
    assert.equal(first.length, active.length - 1);
    e.deploy = deploy;
    const second = await republishAfterRestore();
    assert.equal(second.length, 1, 'only the one left');
    assert.deepEqual([...first, ...second].sort(), active, 'every app once');
    assert.deepEqual(await republishAfterRestore(), [], 'and then never again for this restore');
  } finally { e.deploy = deploy; delete process.env.APPRUA_REPUBLISH; }
});

test('after a restore: a publication that fails or runs out of time is tried again, up to three starts', async () => {
  const { republishAfterRestore } = await import('../src/addresses.js');
  const { engine } = await import('../src/engine/index.js');
  const e = engine();
  const wait = e.waitDeployment;
  const active = (db.getDb().prepare(`SELECT name FROM apps WHERE engine_id IS NOT NULL AND status = 'active'`).all() as { name: string }[]).length;
  process.env.APPRUA_REPUBLISH = 'restore-2';
  try {
    e.waitDeployment = async () => ({ status: 'timeout', logTail: ['still building'] });
    calls.length = 0;
    assert.deepEqual(await republishAfterRestore(), [], 'a timeout is not a success');
    assert.equal(calls.filter((x) => x.startsWith('deploy')).length, active, 'every app tried');
    e.waitDeployment = async () => ({ status: 'failed', logTail: ['build error'] });
    assert.deepEqual(await republishAfterRestore(), [], 'nor a failure');
    assert.deepEqual(await republishAfterRestore(), [], 'third start: given up, left as failed');
    e.waitDeployment = wait;
    calls.length = 0;
    assert.deepEqual(await republishAfterRestore(), [], 'and not tried a fourth time');
    assert.equal(calls.filter((c) => c.startsWith('deploy')).length, 0, 'no publication at the fourth start');
  } finally { e.waitDeployment = wait; delete process.env.APPRUA_REPUBLISH; }
  // the publications left open by the timeouts are followed in the background: wait until the engine has closed them
  await (await import('../src/publish.js')).followersDone();
  assert.ok(active > 0);
});

test('archiving waits for a publication of the same app; a publication never makes an archived app active', async () => {
  const appOps = await import('../src/appOps.js');
  const { runDeploy } = await import('../src/publish.js');
  const running = publish({ user, name: 'my-notes', archivePath: await archiveOf({ 'index.html': 'v-arch' }) });
  await assert.rejects(appOps.archiveOwnApp(user, 'my-notes'), /being published right now/);
  await running;
  assert.equal(db.getApp('my-notes')!.status, 'active');
  // archived by another way while a publication runs: it stays archived and the engine stops it
  db.updateApp('my-notes', { status: 'archived' });
  calls.length = 0;
  await runDeploy('my-notes', 'me@example.test', 'manual', null);
  assert.equal(db.getApp('my-notes')!.status, 'archived');
  assert.ok(calls.includes('stop id-my-notes'));
  db.updateApp('my-notes', { status: 'active' });
  // an app the engine no longer has (404) can still be archived
  const { engine } = await import('../src/engine/index.js');
  const e = engine();
  const stop = e.stop;
  e.stop = async () => { throw new Error('Coolify API GET /applications/x/stop: 404 Not Found'); };
  try { assert.equal((await appOps.archiveOwnApp(user, 'my-notes')).status, 'archived'); }
  finally { e.stop = stop; db.updateApp('my-notes', { status: 'active' }); }
  e.stop = async () => { throw new Error('connect ECONNREFUSED'); };
  try { await assert.rejects(appOps.archiveOwnApp(user, 'my-notes'), /did not stop the app/); }
  finally { e.stop = stop; }
  assert.equal(db.getApp('my-notes')!.status, 'active', 'not marked archived when the engine did not stop it');
});

test('the sign-in labels: a first attempt that fails leaves nothing half made, and every publication applies them again', async () => {
  const { engine } = await import('../src/engine/index.js');
  const e = engine();
  const applyLabels = e.applyLabels;
  e.applyLabels = async () => { throw new Error('labels refused'); };
  calls.length = 0;
  try {
    await assert.rejects(publish({ user, name: 'half-made', description: 'x', archivePath: await archiveOf({ 'index.html': '1' }) }), /labels refused/);
  } finally { e.applyLabels = applyLabels; }
  assert.ok(calls.includes('delete id-half-made'), 'the incomplete engine app is removed');
  assert.equal(db.getApp('half-made')!.engine_id, null, 'and not kept');
  calls.length = 0;
  assert.equal((await publish({ user, name: 'half-made', archivePath: await archiveOf({ 'index.html': '2' }) })).status, 'running');
  assert.ok(calls.some((c) => c.startsWith('create half-made')), 'made again from the start');
  assert.ok(calls.filter((c) => c === 'labels id-half-made half-made me@example.test').length >= 1, 'with its labels');
  // a later publication applies them again, before the deploy
  calls.length = 0;
  await publish({ user, name: 'half-made', archivePath: await archiveOf({ 'index.html': '3' }) });
  const i = calls.indexOf('labels id-half-made half-made me@example.test');
  assert.ok(i >= 0 && i < calls.findIndex((c) => c.startsWith('deploy id-half-made')), 'labels before every deploy');
});

test('start, archive and settings share one reservation; a paused app stays off when a secret changes', async () => {
  const appOps = await import('../src/appOps.js');
  const { engine } = await import('../src/engine/index.js');
  const e = engine();
  const start = e.start;
  let release!: () => void;
  e.start = (id) => new Promise((r) => { release = () => { calls.push(`start ${id}`); r(); }; });
  try {
    db.updateApp('half-made', { status: 'stopped' });
    const starting = appOps.controlApp(user, 'half-made', 'start');
    await assert.rejects(appOps.archiveOwnApp(user, 'half-made'), /being published right now/);
    release();
    await starting;
  } finally { e.start = start; }
  assert.equal(db.getApp('half-made')!.status, 'active');
  db.updateApp('half-made', { status: 'stopped' });
  calls.length = 0;
  const r = await appOps.setEnv(user, 'half-made', 'API_URL', 'x');
  assert.equal(r.restarted, false);
  assert.ok(!calls.some((c) => c.startsWith('restart')), 'not started by a change of settings');
  db.updateApp('half-made', { status: 'active' });
});

test('a publication that runs out of time keeps the app reserved until the engine has finished it', async () => {
  const { engine } = await import('../src/engine/index.js');
  const { exclusive } = await import('../src/publish.js');
  const e = engine();
  const wait = e.waitDeployment;
  let finish!: () => void;
  let n = 0;
  e.waitDeployment = async () => (++n === 1
    ? { status: 'timeout', logTail: ['still building'] }
    : new Promise((r) => { finish = () => r({ status: 'finished', logTail: [] }); }));
  try {
    const r = await publish({ user, name: 'half-made', archivePath: await archiveOf({ 'index.html': 'slow' }) });
    assert.equal(r.status, 'timeout');
    await assert.rejects(exclusive('half-made', async () => 'x'), /still building/);
    finish();
    await new Promise((res) => setTimeout(res, 20));
  } finally { e.waitDeployment = wait; }
  assert.equal(await exclusive('half-made', async () => 'free'), 'free', 'free again once the engine has finished');
  const last = db.getDb().prepare(`SELECT result FROM deploys WHERE app = 'half-made' ORDER BY id DESC LIMIT 1`).get() as { result: string };
  assert.equal(last.result, 'running', 'and the history says how it ended');
});

test('an open publication keeps the app reserved through lost contact, a restart of Apprua, and until the engine answers', async () => {
  const { engine } = await import('../src/engine/index.js');
  const { exclusive, followTiming, followersDone, resumeOpenPublications } = await import('../src/publish.js');
  followTiming.pauseMs = 5;
  const e = engine();
  const wait = e.waitDeployment;
  // contact lost while waiting: the publication stays open and followed, the app reserved
  let answering = false, n = 0;
  e.waitDeployment = async () => {
    n++;
    if (n === 1 || !answering) throw new Error('connect ECONNREFUSED');
    return { status: 'finished', logTail: [] };
  };
  try {
    await assert.rejects(publish({ user, name: 'half-made', archivePath: await archiveOf({ 'index.html': 'lost' }) }), /Lost contact with the engine/);
    await new Promise((r) => setTimeout(r, 40));
    await assert.rejects(exclusive('half-made', async () => 'x'), /still building/, 'still reserved while the engine does not answer');
    answering = true;
    await followersDone();
  } finally { e.waitDeployment = wait; }
  assert.equal(await exclusive('half-made', async () => 'free'), 'free');
  let last = db.getDb().prepare(`SELECT result FROM deploys WHERE app = 'half-made' ORDER BY id DESC LIMIT 1`).get() as { result: string };
  assert.equal(last.result, 'running');

  // a restart of Apprua with a publication the engine had taken: still open, followed again at the start
  db.getDb().prepare(`INSERT INTO deploys (app, user, source, commit_sha, engine_deployment) VALUES ('half-made', 'me@example.test', 'manual', NULL, 'dep-before-restart')`).run();
  await assert.rejects(exclusive('half-made', async () => 'x'), /still building/);
  e.waitDeployment = async () => ({ status: 'failed', logTail: ['build error'] });
  try {
    assert.equal(resumeOpenPublications(), 1);
    await followersDone();
  } finally { e.waitDeployment = wait; }
  last = db.getDb().prepare(`SELECT result FROM deploys WHERE app = 'half-made' ORDER BY id DESC LIMIT 1`).get() as { result: string };
  assert.equal(last.result, 'failed', 'closed with what the engine said');
  // a publication the engine no longer knows (404) is closed, not kept forever
  db.getDb().prepare(`INSERT INTO deploys (app, user, source, commit_sha, engine_deployment) VALUES ('half-made', 'me@example.test', 'manual', NULL, 'dep-gone')`).run();
  e.waitDeployment = async () => { throw new Error('Coolify API GET /deployments/dep-gone: 404 Not Found'); };
  try { resumeOpenPublications(); await followersDone(); } finally { e.waitDeployment = wait; }
  assert.equal(await exclusive('half-made', async () => 'free'), 'free');
});

test('the answer to "publish" is lost: the engine is asked whether it started, and the app stays reserved until it knows', async () => {
  const { engine } = await import('../src/engine/index.js');
  const { exclusive, followersDone, resumeOpenPublications } = await import('../src/publish.js');
  const e = engine();
  const deploy = e.deploy;
  const last = () => ({ ...(db.getDb().prepare(`SELECT result, engine_deployment FROM deploys WHERE app = 'half-made' ORDER BY id DESC LIMIT 1`).get() as { result: string | null; engine_deployment: string | null }) });
  try {
    // 1. the engine started it, the answer was lost: found, followed, closed with the engine's result
    e.deploy = async () => { throw new Error('socket hang up'); };
    e.findDeployment = async () => 'dep-lost-answer';
    await assert.rejects(publish({ user, name: 'half-made', archivePath: await archiveOf({ 'index.html': 'a1' }) }), /Lost contact/);
    await followersDone();
    assert.deepEqual(last(), { result: 'running', engine_deployment: 'dep-lost-answer' });

    // 2. the engine does not answer at all: open and reserved; when it answers "nothing started", closed and free
    let answers = false;
    e.findDeployment = async () => { if (!answers) throw new Error('connect ECONNREFUSED'); return null; };
    await assert.rejects(publish({ user, name: 'half-made', archivePath: await archiveOf({ 'index.html': 'a2' }) }), /checks with the engine whether it started/);
    await new Promise((r) => setTimeout(r, 30));
    await assert.rejects(exclusive('half-made', async () => 'x'), /still building/, 'reserved while it is not known');
    answers = true;
    await followersDone();
    assert.equal(last().result, 'failed');
    assert.equal(await exclusive('half-made', async () => 'free'), 'free');

    // 3. a restart of Apprua right after the request: asked again at the start
    db.getDb().prepare(`INSERT INTO deploys (app, user, source, requested_at) VALUES ('half-made', 'me@example.test', 'manual', ?)`).run(new Date().toISOString());
    await assert.rejects(exclusive('half-made', async () => 'x'), /still building/);
    e.findDeployment = async () => 'dep-after-restart';
    assert.equal(resumeOpenPublications(), 1);
    await followersDone();
    assert.deepEqual(last(), { result: 'running', engine_deployment: 'dep-after-restart' });
  } finally { e.deploy = deploy; delete e.findDeployment; }
});

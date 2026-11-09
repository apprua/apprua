import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';

Object.assign(process.env, { DATA_DIR: await mkdtemp(join(tmpdir(), 'apd-data-')) });
const checks = await import('../src/checks.js');
const auth = await import('../src/auth.js');
const db = await import('../src/db.js');
const setup = await import('../src/setup.js');
const { config, autoAppMemory } = await import('../src/config.js');
const views = await import('../src/views.js');

test('first-run setup: choice saved and applied, rules bounded, one-time code', () => {
  db.openDb(':memory:');
  setup.saveSetup({ profile: 'team', ...setup.parseRules('8', '12') });
  assert.equal(config.profile, 'team');
  assert.equal(config.policy.defaultQuota, 8);
  assert.equal(config.policy.reviewMonths, 12);
  setup.applyProfileReset();
  setup.loadStoredSettings(); // as at the next start
  assert.equal(config.policy.defaultQuota, 8);
  assert.deepEqual(setup.parseRules('9999', '7'), { quota: 100, reviewMonths: 6 });
  assert.deepEqual(setup.parseRules('x', '0'), { quota: 5, reviewMonths: 0 });
  setup.saveSetup({ profile: 'personal' });
  assert.equal(config.policy.reviewMonths, 0);
  assert.equal(setup.checkSetupCode('anything'), true, 'no code configured: no question');
  config.auth.setupCode = 'ABCD-EFGH-IJKL';
  assert.equal(setup.checkSetupCode(' abcd-efgh-ijkl '), true);
  assert.equal(setup.checkSetupCode('ABCD-EFGH-IJKX'), false);
  assert.equal(setup.checkSetupCode(''), false);
  for (const lang of ['it', 'en'] as const) {
    const pages = views.setupChoicePage(lang, 'personal') + views.setupPage(lang, { profile: 'team' }) + views.setupPage(lang, { profile: 'personal' });
    const text = pages.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '');
    assert.ok(!/\b(setup|login)\.[a-z.0-9]+\b/.test(text), `no missing setup texts (${lang})`);
    assert.ok(!/[—–]/.test(text), 'no em/en dashes');
    assert.match(pages, /name="code"/, 'code asked when configured');
  }
  config.auth.setupCode = '';
});

test('settings: resources estimate, rules, change of use, page', async () => {
  const res = await import('../src/resources.js');
  db.openDb(':memory:');
  // 8 GB, 1 GB for each app: 2 GB kept for the platform, so 6 apps on together; 10 GB free disk: 10 new apps
  assert.deepEqual(res.estimate(8192, 1024, 10240), { fitOn: 6, fitNew: 10 });
  assert.deepEqual(res.estimate(1024, 512, null), { fitOn: 0, fitNew: null });
  assert.equal(res.memoryMb('512m'), 512);
  assert.equal(res.memoryMb('2G'), 2048);

  setup.saveSetup({ profile: 'team', quota: 3 });
  setup.saveRules({ reviewMonths: 12, memory: setup.parseMemory('1g') });
  assert.equal(config.policy.defaultQuota, 3, 'rules not given stay');
  assert.equal(config.policy.reviewMonths, 12);
  assert.equal(config.policy.defaultMemory, '1g');
  assert.equal(config.policy.memoryAuto, false);
  assert.equal(setup.parseMemory('64g'), undefined, 'only the choices offered');
  setup.applyProfileReset();
  setup.loadStoredSettings(); // as at the next start
  assert.equal(config.policy.defaultMemory, '1g');
  setup.changeProfile('personal');
  assert.equal(config.profile, 'personal');
  assert.equal(config.policy.defaultQuota, 50, 'a new use starts from its suggested rules');
  assert.equal(config.policy.memoryAuto, true, 'and with automatic memory');
  assert.equal(config.policy.defaultMemory, autoAppMemory(undefined, config.policy.maxMemoryMb));
  setup.saveRules({ memory: setup.parseMemory('auto') });
  assert.equal(config.policy.memoryAuto, true);
  // automatic memory: at least 8 apps on together after 2 GB for the platform, never below 512 MB
  assert.equal(autoAppMemory(4096), '512m');
  assert.equal(autoAppMemory(8192), '512m');
  assert.equal(autoAppMemory(16384), '1g');
  assert.equal(autoAppMemory(32768), '2g');
  assert.equal(autoAppMemory(32768, 1024), '1g', 'within the maximum');
  assert.equal(autoAppMemory(131072, 16384), '2g', 'a new app never gets more than 2 GB by itself');
  // the most one app can get: about half of the memory for apps
  const { maxAppMemoryMb } = await import('../src/config.js');
  assert.deepEqual([4096, 8192, 16384, 32768, 65536].map((m) => maxAppMemoryMb(m)), [1024, 2048, 4096, 8192, 16384]);

  const u = auth.createLocalUser('admin@example.test', 'Admin', 'correct horse battery', 'admin', 't');
  const r = await res.readResources();
  assert.ok(r.memTotalMb > 0);
  for (const profile of ['personal', 'team'] as const) {
    setup.changeProfile(profile);
    for (const lang of ['it', 'en'] as const) {
      for (const wsl of [true, false]) {
        const html = views.settingsPage(lang, u, { ...r, wsl, appsOn: 9, fitOn: 6, hostMemoryGb: 16 });
        const text = html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '');
        assert.ok(!/\b(set|setup)\.[a-z.0-9]+\b/.test(text), `no missing settings texts (${lang})`);
        assert.ok(!/[—–]/.test(text), 'no em/en dashes');
        assert.equal(/-SetMemoryGB/.test(html), wsl, 'Windows command only inside WSL');
        assert.equal(/name="quota"/.test(html), profile === 'team', 'quota per person only for a group');
      }
    }
  }
  setup.applyProfileReset();
});

test('connector package: a valid tar.gz that tar can read back', async () => {
  const { tarFiles } = await import('../src/downloads.js');
  const { gzipSync, strToU8 } = await import('fflate');
  const dir = await mkdtemp(join(tmpdir(), 'tgz-'));
  const big = 'x'.repeat(1000);
  await writeFile(join(dir, 'p.tgz'), gzipSync(tarFiles({ 'package/package.json': strToU8('{"name":"apprua-mcp"}'), 'package/server.mjs': strToU8(big) })));
  await tar.x({ file: join(dir, 'p.tgz'), cwd: dir, strict: true });
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(dir, 'package/package.json'), 'utf8'), '{"name":"apprua-mcp"}');
  assert.equal(await readFile(join(dir, 'package/server.mjs'), 'utf8'), big);
});

async function folder(files: Record<string, string>) {
  const d = await mkdtemp(join(tmpdir(), 'chk-'));
  for (const [f, c] of Object.entries(files)) {
    await mkdir(join(d, f, '..'), { recursive: true });
    await writeFile(join(d, f), c);
  }
  return d;
}

test('app names', () => {
  for (const ok of ['my-notes', 'abc', 'a1-b2']) assert.doesNotThrow(() => checks.checkName(ok));
  for (const bad of ['ab', 'Abc', '1abc', 'abc-', 'a--b', 'auth', 'git', 'apprua', 'x'.repeat(32), 'a_b'])
    assert.throws(() => checks.checkName(bad), /name/i, bad);
});

test('secret scan finds files and keys, ignores .env.example', async () => {
  const d = await folder({
    '.env': 'X=1', '.env.example': 'API_KEY=', 'config/id_rsa': 'x',
    'src/a.js': `const k = "sk-ant-api03-${'a'.repeat(40)}";`,
    'src/b.py': `aws = "AKIA${'A'.repeat(16)}"`,
    'src/c.js': `const t = "apr_${'b'.repeat(43)}";`,
    'src/ok.js': 'const task = "task-runner"; // sk- prefix alone is fine',
  });
  const found = await checks.scanSecrets(d, await checks.listFiles(d));
  const files = found.map((f) => f.file).sort();
  assert.deepEqual(files, ['.env', 'config/id_rsa', 'src/a.js', 'src/b.py', 'src/c.js']);
  assert.match(checks.secretsError(found).message, /set_env/);
});

test('warnings for apps made inside an AI chat', async () => {
  const d = await folder({ 'index.html': '<script>window.storage.set("a",1); fetch("https://api.anthropic.com/v1/messages")</script>' });
  const w = await checks.claudeWarnings(d, await checks.listFiles(d));
  assert.equal(w.length, 2);
});

test('build detection', async () => {
  let d = await folder({ 'index.html': '<h1>hi</h1>' });
  assert.deepEqual(await checks.detectBuild(d, await checks.listFiles(d)), { buildPack: 'static', port: 80 });
  d = await folder({ Dockerfile: 'FROM nginx\nEXPOSE 8080\n' });
  assert.deepEqual(await checks.detectBuild(d, await checks.listFiles(d)), { buildPack: 'dockerfile', port: 8080 });
  // labels for the proxy could take the portal's address: refused, also split over several lines
  d = await folder({ Dockerfile: 'FROM nginx\nLABEL a=b \\\n  traefik.http.routers.x.rule=Host(`apprua.example.com`)\n' });
  await assert.rejects(checks.detectBuild(d, await checks.listFiles(d)), /LABEL lines for the proxy/);
  // the same, with what Docker skips or puts back together inside a continued line
  for (const df of [
    'FROM nginx\nLABEL a=b \\\n# note\n  traefik.http.routers.x.rule=Host(`apprua.example.com`)\n',
    'FROM nginx\nLABEL a=b \\  \n  traefik.enable=true\n',
    'FROM nginx\nLABEL a=b \\\n\n  traefik.enable=true\n',
    'FROM nginx\nLABEL trae\\\nfik.enable=true\n',
    'FROM nginx\nLABEL "trae"fik.enable=true\n',
    'FROM nginx\nLABEL trae\\fik.enable=true\n',
    'FROM nginx\r\nLABEL a=b \\\r\n  # note\r\n  caddy=apprua.example.com\r\n',
    'FROM nginx\nonbuild label traefik.enable=true\n',
  ]) {
    d = await folder({ Dockerfile: df });
    await assert.rejects(checks.detectBuild(d, await checks.listFiles(d)), /LABEL lines for the proxy/, JSON.stringify(df));
  }
  // a comment that ends with a backslash does not swallow the next instruction
  assert.deepEqual(checks.dockerInstructions('# a \\\nLABEL x=1\nRUN a \\\n  b'), ['# a \\', 'LABEL x=1', 'RUN a   b']);
  d = await folder({ Dockerfile: 'FROM nginx\n# hide \\\nLABEL traefik.enable=true\n' });
  await assert.rejects(checks.detectBuild(d, await checks.listFiles(d)), /LABEL lines for the proxy/);
  d = await folder({ Dockerfile: 'FROM nginx\nLABEL org.opencontainers.image.title="notes"\n' });
  assert.equal((await checks.detectBuild(d, await checks.listFiles(d))).buildPack, 'dockerfile', 'other labels are fine');
  d = await folder({ 'package.json': '{"scripts":{"start":"node server.js"}}' });
  assert.deepEqual(await checks.detectBuild(d, await checks.listFiles(d), 3000), { buildPack: 'nixpacks', port: 3000 });
  d = await folder({ 'Dashboard_v2.html': '<h1>x</h1>' });
  assert.deepEqual(await checks.detectBuild(d, await checks.listFiles(d)), { buildPack: 'static', port: 80, entryHtml: 'Dashboard_v2.html' });
  d = await folder({ 'a.html': 'x', 'b.html': 'y' });
  await assert.rejects(checks.detectBuild(d, await checks.listFiles(d)), /index\.html/);
  d = await folder({ 'notes.txt': 'x' });
  await assert.rejects(checks.detectBuild(d, await checks.listFiles(d)), /Dockerfile/);
});

test('archive extraction skips symlinks', async () => {
  const src = await folder({ 'a.txt': 'hello' });
  await symlink('/etc/passwd', join(src, 'evil')).catch(() => {});
  const arc = join(await mkdtemp(join(tmpdir(), 'arc-')), 'x.tar.gz');
  await tar.c({ gzip: true, file: arc, cwd: src }, ['.']);
  const out = await mkdtemp(join(tmpdir(), 'out-'));
  await checks.extractArchive(arc, out);
  assert.deepEqual(await checks.listFiles(out), ['a.txt']);
});

test('archive over the limits: a refused upload, not a stopped server', async () => {
  const src = await folder({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3', 'd.txt': '4' });
  const arc = join(await mkdtemp(join(tmpdir(), 'arc-')), 'x.tar.gz');
  await tar.c({ gzip: true, file: arc, cwd: src }, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  let crashed = false;
  const onCrash = () => { crashed = true; };
  process.on('uncaughtException', onCrash);
  const { maxFiles, maxExtractedBytes } = config.policy;
  try {
    config.policy.maxFiles = 2;
    await assert.rejects(checks.extractArchive(arc, await mkdtemp(join(tmpdir(), 'out-'))), /too many files/);
    config.policy.maxFiles = maxFiles; config.policy.maxExtractedBytes = 2;
    await assert.rejects(checks.extractArchive(arc, await mkdtemp(join(tmpdir(), 'out-'))), /too large/);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    Object.assign(config.policy, { maxFiles, maxExtractedBytes });
    process.off('uncaughtException', onCrash);
  }
  assert.equal(crashed, false);
});

test('tokens: issue, authenticate, expire, revoke', () => {
  db.openDb(':memory:');
  db.upsertUser('a@example.test', 'A', 'user');
  const { token } = auth.issueToken('a@example.test', 'test');
  assert.ok(token.startsWith('apr_'));
  const req = (t: string) => ({ headers: { authorization: `Bearer ${t}` } }) as any;
  assert.equal(auth.requireToken(req(token)).email, 'a@example.test');
  assert.throws(() => auth.requireToken(req('nope')), /Invalid/);
  db.getDb().prepare(`UPDATE users SET token_expires_at = '2000-01-01T00:00:00Z'`).run();
  assert.throws(() => auth.requireToken(req(token)), /expired/);
  auth.revokeToken('a@example.test', 'test');
  assert.throws(() => auth.requireToken(req(token)), /Invalid or revoked/);
});

test('local accounts: setup, password check, session cookie', () => {
  db.openDb(':memory:');
  assert.equal(auth.needsSetup(), true);
  assert.throws(() => auth.createLocalUser('x@example.test', null, 'short', 'admin', 't'), /err.password_short/);
  assert.throws(() => auth.createLocalUser('not-an-email', null, 'long enough pw', 'admin', 't'), /err.email_invalid/);
  const u = auth.createLocalUser('Boss@Example.test', 'Boss', 'correct horse battery', 'admin', 't');
  assert.equal(u.email, 'boss@example.test');
  assert.equal(auth.needsSetup(), false);
  assert.throws(() => auth.createLocalUser('boss@example.test', null, 'another password', 'user', 't'), /err.email_taken/);
  assert.ok(auth.verifyPassword('correct horse battery', u.password_hash));
  assert.ok(!auth.verifyPassword('wrong password!!', u.password_hash));

  let cookie = '';
  const reply = { header: (_k: string, v: string | string[]) => { cookie = [v].flat()[0].split(';')[0]; return reply; } } as any;
  auth.startSession({ headers: { host: 'localhost:3000' } } as any, reply, u.email);
  assert.equal(auth.portalUser({ headers: { cookie } } as any)?.email, 'boss@example.test');
  const tampered = cookie.replace(/\.[^.]+$/, '.AAAA');
  assert.equal(auth.portalUser({ headers: { cookie: tampered } } as any), null);
  assert.equal(auth.portalUser({ headers: {} } as any), null);
});

test('brand kit: every scene uses the logo lighthouse and only the four inks', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = join(import.meta.dirname, '../../assets/img');
  const scenes = readdirSync(dir).filter((f) => f.endsWith('.svg'));
  assert.deepEqual(scenes.sort(), ['barca.svg', 'da-sistemare.svg', 'porto-notte.svg', 'prima-app.svg', 'riposo.svg']);
  for (const s of scenes) {
    const svg = readFileSync(join(dir, s), 'utf8');
    assert.ok(svg.includes(`d="${views.TOWER_A}"`), `${s}: the lighthouse is the "A" of the logo`);
    const colours = new Set((svg.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((c) => c.toUpperCase()));
    for (const c of colours) assert.ok(['#2234EE', '#F1E9DA', '#121212', '#FFC94D', '#6E6A62'].includes(c), `${s}: ${c} is not one of our inks`);
  }
});
test('the request log never shows a link that opens something', async () => {
  const { hideSecrets } = await import('../src/logs.js');
  assert.equal(hideSecrets('/reset?t=abc123secret'), '/reset?t=[hidden]');
  assert.equal(hideSecrets('/_apprua/enter?code=XYZ&next=%2Fa'), '/_apprua/enter?code=[hidden]&next=%2Fa');
  assert.equal(hideSecrets('/login?next=%2Faccount'), '/login?next=%2Faccount');
  assert.equal(hideSecrets('/git/0123456789abcdef0123456789abcdef/notes.git/info/refs'), '/git/[hidden]/notes.git/info/refs');
  // the real logger of Apprua, with a fake reset link
  const Fastify = (await import('fastify')).default;
  const lines: string[] = [];
  const { Writable } = await import('node:stream');
  const stream = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } });
  const app = Fastify({ logger: { level: 'info', stream, serializers: { req: (req: any) => ({ method: req.method, url: hideSecrets(req.url) }) } } });
  app.get('/reset', async () => 'ok');
  await app.inject({ method: 'GET', url: '/reset?t=very-secret-token' });
  assert.ok(lines.length > 0);
  assert.ok(!lines.join('').includes('very-secret-token'));
});

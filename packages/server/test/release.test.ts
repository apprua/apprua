// Releases: one version for everything, and the installer line the release workflow fills in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { VERSION } from '../src/version.js';

const root = new URL('../../../../', import.meta.url);
const json = (p: string) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

test('one version: the repository, the server, the connector and the lock file agree', () => {
  const v = json('package.json').version;
  assert.match(v, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.equal(json('packages/server/package.json').version, v, 'server');
  assert.equal(json('packages/mcp/package.json').version, v, 'connector');
  const lock = json('package-lock.json');
  assert.equal(lock.version, v, 'lock file');
  assert.equal(lock.packages['packages/server'].version, v, 'lock file, server');
  assert.equal(lock.packages['packages/mcp'].version, v, 'lock file, connector');
  assert.equal(VERSION, v, 'the version Apprua reports');
});

test('the connector package is ready for npm: no dependencies, the bundled file with its licenses, a command', () => {
  const p = json('packages/mcp/package.json');
  assert.equal(p.private, undefined);
  assert.equal(p.dependencies, undefined, 'everything is bundled into dist/server.mjs');
  assert.deepEqual(p.files, ['dist/server.mjs', 'dist/THIRD_PARTY_LICENSES.txt']);
  // npm always adds README and LICENSE: they must be there, a version on npm cannot be published again
  for (const f of ['README.md', 'LICENSE']) assert.ok(existsSync(new URL(`packages/mcp/${f}`, root)), `packages/mcp/${f}`);
  assert.equal(readFileSync(new URL('packages/mcp/LICENSE', root), 'utf8'), readFileSync(new URL('LICENSE', root), 'utf8'), 'the same license');
  assert.equal(p.bin['apprua-mcp'], 'dist/server.mjs');
});

test('the installer has the line the release workflow fills in with the image of the release', () => {
  const sh = readFileSync(new URL('install/install.sh', root), 'utf8');
  assert.equal(sh.split('\n').filter((l) => l === 'RELEASE_IMAGE=""').length, 1);
  const script = readFileSync(new URL('scripts/release.mjs', root), 'utf8');
  assert.ok(script.includes('RELEASE_IMAGE=""'), 'scripts/release.mjs writes it');
});

test('the changelog has a section for the current version', () => {
  const log = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
  assert.ok(log.includes(`## [${VERSION}]`), `CHANGELOG.md: "## [${VERSION}]"`);
});

test('the guard keeps every app in its own lane, and the installer sets it up as a service', () => {
  const guard = readFileSync(new URL('install/apprua-guard.sh', root), 'utf8');
  assert.ok(guard.includes('APP_LABEL=coolify.type=application') && guard.includes('APP_LABEL=apprua.app'), 'it finds the published apps by their label');
  assert.ok(guard.includes('--dports 80,443 -j RETURN'), 'apps reach other apps only through the proxy');
  assert.ok(guard.includes('--dst-type LOCAL $O -j DROP'), 'apps cannot reach the machine itself');
  assert.ok(guard.includes('-restore" -w --noflush'), 'the rules are replaced in one step');
  assert.ok(/for fam in 4 6/.test(guard), 'IPv4 and IPv6');
  assert.ok(guard.includes('event=create') && guard.includes("grep -Ei '^(traefik|caddy)'"), 'images with labels for the proxy are removed before they start');
  const sh = readFileSync(new URL('install/install.sh', root), 'utf8');
  assert.ok(sh.includes('apprua-guard.service') && sh.includes('apprua-guard watch'), 'installed as a service');
  assert.equal(sh.split('WantedBy=multi-user.target docker.service').length - 1, 2, 'the guard and the lock start again with Docker');
});

test('the engine stays on the version Apprua was tested with, and never updates by itself', () => {
  const pin = json('package.json').apprua?.coolify;
  assert.match(pin, /^\d+\.\d+\.\d+/, 'package.json: "apprua": { "coolify": "x.y.z" }');
  const sh = readFileSync(new URL('install/install.sh', root), 'utf8');
  assert.ok(sh.includes('"coolify": *"'), 'install.sh reads the version from package.json');
  assert.ok(sh.includes('AUTOUPDATE=false') && sh.includes('is_auto_update_enabled = false'), 'no automatic updates, new or existing installs');
  assert.ok(sh.includes('APPRUA_COOLIFY_TESTED='), 'the portal is told the tested version');
});

test('Windows scripts: no accented letters written directly (PowerShell 5.1 reads them wrong), and Apprua in Settings > Apps', () => {
  for (const f of ['install-apprua.ps1', 'network-apprua.ps1', 'open-apprua.ps1', 'tray-apprua.ps1']) {
    const src = readFileSync(new URL(`install/windows/${f}`, root), 'utf8');
    const bad = src.split('\n').findIndex((l) => /[^\x00-\x7F]/.test(l));
    assert.equal(bad, -1, `${f}, line ${bad + 1}: use $([char]0xE8) and the like`);
  }
  const ps = readFileSync(new URL('install/windows/install-apprua.ps1', root), 'utf8');
  assert.ok(ps.includes(String.raw`CurrentVersion\Uninstall\Apprua`) && ps.includes('-Uninstall -Wait'), 'the Uninstall entry');
  assert.ok(ps.includes('Remove-Item $UninstallKey'), 'removed with Apprua');
});

// The guard itself, run with a fake docker and iptables: the rules it really writes, in the order they work.
// Needs bash (Linux, macOS, Git Bash on Windows).
test('the guard: a connection an app opened before its lane existed is cut too', { skip: process.platform === 'win32' && !process.env.MSYSTEM }, async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const bin = mkdtempSync(join(tmpdir(), 'guard-bin-'));
  const out = mkdtempSync(join(tmpdir(), 'guard-out-')).replace(/\\/g, '/');
  const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  fake('docker', `case "$1 $2" in
  "network ls") echo n1 ;;
  "network inspect") echo 172.18.0.0/16 ;;
  "inspect coolify-proxy") echo "172.18.0.2 " ;;
  "ps -q") if [ "$4" = "label=apprua.app" ]; then echo c1; else printf 'c1\\nc9\\n'; fi ;;
  "inspect c1") case "$4" in *apprua.app*) echo notes ;; *coolify.type*) echo application ;; *) echo "172.18.0.5 " ;; esac ;;
  "inspect c9") case "$4" in *apprua.app*) echo "" ;; *coolify.type*) echo application ;; *) echo "172.18.0.9 " ;; esac ;;
esac`);
  fake('iptables', 'exit 0');
  fake('ip6tables', 'exit 0');
  fake('iptables-restore', `cat > "${out}/v4"`);
  fake('ip6tables-restore', `cat > "${out}/v6"`);
  const script = fileURLToPath(new URL('install/apprua-guard.sh', root));
  const PATH = `${bin.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)}:${process.env.PATH}`;
  const own = join(mkdtempSync(join(tmpdir(), 'guard-env-')), 'apprua.env').replace(/\\/g, '/');
  writeFileSync(own, 'APPRUA_NETWORK=lan\n');
  execFileSync('bash', [script.replace(/\\/g, '/'), 'apply'], { env: { ...process.env, PATH, APPRUA_ENV: own } });
  const lines = readFileSync(`${out}/v4`, 'utf8').split('\n');
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const proxy = at(/^-A APPRUA-APPS -s 172\.18\.0\.5 -d 172\.18\.0\.2 -p tcp -m multiport --dports 80,443 -j RETURN$/);
  const toNets = at(/^-A APPRUA-APPS -s 172\.18\.0\.5 -d 172\.18\.0\.0\/16 -m conntrack --ctdir ORIGINAL -j DROP$/);
  const toHost = at(/^-A APPRUA-APPS -s 172\.18\.0\.5 -m addrtype --dst-type LOCAL -m conntrack --ctdir ORIGINAL -j DROP$/);
  const established = at(/^-A APPRUA-APPS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN$/);
  assert.ok(proxy >= 0 && toNets > proxy && toHost > proxy, 'other apps only through the proxy, never directly nor the machine');
  assert.ok(established > toNets && established > toHost, 'the drops come before "established", so an early connection does not live on');
  const hostDrop = at(/^-A APPRUA-HOST -d 172\.18\.0\.5 -m conntrack --ctdir ORIGINAL -j DROP$/);
  assert.ok(hostDrop >= 0 && hostDrop < at(/^-A APPRUA-HOST -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN$/), 'from the machine: the same');
  assert.ok(lines.some((l) => l.includes('-s 172.18.0.9')), 'with its own Coolify every application has a lane');
  // a Coolify shared with other projects: only Apprua's apps get a lane, and only they can be removed for proxy labels
  const shared = join(mkdtempSync(join(tmpdir(), 'guard-env-')), 'apprua.env').replace(/\\/g, '/');
  writeFileSync(shared, 'APPRUA_NETWORK=lan\nCOOLIFY_FOREIGN=1\n');
  execFileSync('bash', [script.replace(/\\/g, '/'), 'apply'], { env: { ...process.env, PATH, APPRUA_ENV: shared } });
  const sharedLines = readFileSync(`${out}/v4`, 'utf8').split('\n');
  assert.ok(sharedLines.some((l) => l.includes('-s 172.18.0.5')), 'the app of Apprua has its lane');
  assert.ok(!sharedLines.some((l) => l.includes('172.18.0.9')), 'the other project is not touched');
  const pick = (c: string) => execFileSync('bash', ['-c', `source "${script.replace(/\\/g, '/')}" status >/dev/null 2>&1; is_app ${c} && echo app || echo other`],
    { env: { ...process.env, PATH, APPRUA_ENV: shared }, encoding: 'utf8' }).trim();
  assert.equal(pick('c1'), 'app');
  assert.equal(pick('c9'), 'other', 'its containers are never removed by the image check');
});

test('"this machine only" closes the ports of the apps to the network; the other modes open them again', { skip: process.platform === 'win32' && !process.env.MSYSTEM }, async () => {
  const { mkdtempSync, writeFileSync, chmodSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
  const run = (localOnly: string) => {
    const bin = mkdtempSync(join(tmpdir(), 'lock-bin-'));
    const log = join(mkdtempSync(join(tmpdir(), 'lock-out-')), 'calls').replace(/\\/g, '/');   // C:/... works in node and bash
    // -C and -D answer "no such rule" (so -I is called, and the loops that remove end); the rest works
    const body = `echo "$0 $*" >> "${log}"; case "$1" in -C|-D) exit 1 ;; esac; exit 0`;
    for (const t of ['iptables', 'ip6tables']) { writeFileSync(join(bin, t), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, t), 0o755); }
    execFileSync('bash', [posix(fileURLToPath(new URL('install/apprua-coolify-lock.sh', root))), 'on'],
      { env: { ...process.env, PATH: `${posix(bin)}:${process.env.PATH}`, APPRUA_LOCAL_ONLY: localOnly } });
    return existsSync(log) ? readFileSync(log, 'utf8') : '';
  };
  const local = run('1');
  for (const p of ['8000', '80', '443']) assert.match(local, new RegExp(`-I DOCKER-USER .*--ctorigdstport ${p} -j DROP`), `local: port ${p} closed`);
  assert.match(local, /-I INPUT -p tcp --dport 80 ! -i lo -j DROP/);
  const lan = run('0');
  assert.match(lan, /-I DOCKER-USER .*--ctorigdstport 8000 -j DROP/, 'the engine panel stays closed');
  assert.doesNotMatch(lan, /-I (DOCKER-USER|INPUT) .*(--ctorigdstport|--dport) (80|443) /, 'the ports of the apps are not closed');
  assert.match(lan, /-D DOCKER-USER .*--ctorigdstport 80 -j DROP/, 'and a closing left from "this machine only" is removed');
});

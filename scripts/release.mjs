// Helpers for the release workflow (.github/workflows/release.yml); they also run on a PC to try a release out.
//
//   node scripts/release.mjs check v0.2.0           the tag matches the version of the code
//   node scripts/release.mjs notes 0.2.0            the CHANGELOG section of that version (the text of the release)
//   node scripts/release.mjs files 0.2.0 <image>    the files attached to the release, in release/:
//       apprua.zip     for Windows (extract, then run install\windows\install-apprua.ps1)
//       apprua.tar.gz  for a Linux server (extract, then sudo bash install/install.sh)
//       apprua.mcpb    the Claude Desktop extension (it asks for the address of your Apprua and your key)
//       SHA256SUMS.txt to check the files
//   Both archives hold only what is needed to install and run Apprua, and their installer downloads <image>
//   instead of building Apprua from the source.
//
// Run "npm run build" first: the extension needs packages/mcp/dist/server.mjs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'release');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const [cmd, arg, image] = process.argv.slice(2);
const fail = (msg) => { console.error(`release: ${msg}`); process.exit(1); };

/** What a release carries: enough to install, run and understand Apprua, with the pages the README and the guides link to
 *  (no brand kit or website). */
const KEEP = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.base.json',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'README.it.md', 'CHANGELOG.md', 'SECURITY.md', 'TRADEMARKS.md',
  'CONTRIBUTING.md', 'CLA.md', 'CODE_OF_CONDUCT.md', 'RELEASING.md',
  'install/', 'packages/', 'docs/'];
const SKIP = [];

function notes(v) {
  const log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const start = log.indexOf(`## [${v}]`);
  if (start < 0) fail(`CHANGELOG.md has no section "## [${v}]"`);
  const next = log.indexOf('\n## [', start + 1);
  return log.slice(start, next < 0 ? undefined : next).split('\n').slice(1).join('\n').trim() + '\n';
}

async function files(v, img) {
  // loaded here, so "check" and "notes" also work before "npm ci"
  const { strToU8, zipSync } = await import('fflate');
  const tar = await import('tar');
  if (!img) fail('which image? node scripts/release.mjs files <version> <image>');
  const connector = join(ROOT, 'packages/mcp/dist/server.mjs');
  if (!existsSync(connector)) fail('run "npm run build" first');
  // empty release/ (its contents only: on Windows a folder open in a terminal cannot be removed)
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { recursive: true, force: true });
  const stage = join(OUT, 'stage', 'apprua');
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const chosen = tracked.filter((f) => KEEP.some((k) => f === k || (k.endsWith('/') && f.startsWith(k))) && !SKIP.some((s) => f.startsWith(s)));
  for (const f of chosen) { mkdirSync(dirname(join(stage, f)), { recursive: true }); cpSync(join(ROOT, f), join(stage, f)); }

  // the installer of the release downloads the image made for it
  const sh = join(stage, 'install/install.sh');
  const lines = readFileSync(sh, 'utf8').split('\n');
  const at = lines.indexOf('RELEASE_IMAGE=""');
  if (at < 0 || lines.lastIndexOf('RELEASE_IMAGE=""') !== at) fail('install.sh must have exactly one line RELEASE_IMAGE=""');
  lines[at] = `RELEASE_IMAGE="${img}"`;
  writeFileSync(sh, lines.join('\n'));

  // apprua.zip (Windows) and apprua.tar.gz (Linux), both with one folder "apprua" inside
  const tree = {};
  for (const f of chosen) tree[`apprua/${f}`] = new Uint8Array(readFileSync(join(stage, f)));
  writeFileSync(join(OUT, 'apprua.zip'), zipSync(tree, { level: 9 }));
  tar.c({ gzip: true, file: join(OUT, 'apprua.tar.gz'), cwd: join(OUT, 'stage'), portable: true, sync: true }, ['apprua']);

  // the Claude Desktop extension, for any Apprua: it asks for the address (the portal gives one with the address in)
  const manifest = readFileSync(join(ROOT, 'packages/mcp/manifest.template.json'), 'utf8')
    .replaceAll('{{BRAND}}', 'Apprua').replaceAll('{{VERSION}}', v).replace(/^\s*"default": "\{\{PUBLIC_URL\}\}",\r?\n/m, '');
  if (manifest.includes('{{')) fail('manifest.template.json has a placeholder the release does not fill');
  writeFileSync(join(OUT, 'apprua.mcpb'), zipSync({
    'manifest.json': strToU8(manifest),
    server: { 'index.mjs': new Uint8Array(readFileSync(connector)) },
    'icon.png': new Uint8Array(readFileSync(join(ROOT, 'packages/mcp/icon.png'))),
    'LICENSE': new Uint8Array(readFileSync(join(ROOT, 'LICENSE'))),
  }, { level: 9 }));

  rmSync(join(OUT, 'stage'), { recursive: true, force: true });
  const assets = ['apprua.zip', 'apprua.tar.gz', 'apprua.mcpb'];
  const sums = assets.map((a) => `${createHash('sha256').update(readFileSync(join(OUT, a))).digest('hex')}  ${a}`).join('\n') + '\n';
  writeFileSync(join(OUT, 'SHA256SUMS.txt'), sums);
  for (const a of [...assets, 'SHA256SUMS.txt']) console.log(`${a.padEnd(16)} ${(statSync(join(OUT, a)).size / 1024).toFixed(0)} KB`);
  console.log(`${chosen.length} files, installer image: ${img}`);
}

if (cmd === 'check') {
  if (arg !== `v${version}`) fail(`the tag is ${arg} but the code says ${version}: run "npm version ${String(arg).replace(/^v/, '')} --workspaces --include-workspace-root --no-git-tag-version" first`);
  console.log(`version ${version}: ok`);
} else if (cmd === 'notes') {
  process.stdout.write(notes(arg ?? version));
} else if (cmd === 'files') {
  if (arg !== version) fail(`the code says ${version}, not ${arg}`);
  await files(arg, image);
} else {
  fail('usage: check <tag> | notes <version> | files <version> <image>');
}

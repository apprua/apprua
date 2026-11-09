// Builds the connector as one file (dist/server.mjs) with its dependencies inside, so it runs with plain Node.js.
// The version comes from package.json, the one place where it is written.
// The licenses of the libraries inside the file go with it: at the end of the file itself (so every copy carries them:
// npm, the Claude Desktop extension, the downloads of the portal) and in dist/THIRD_PARTY_LICENSES.txt.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const result = await build({
  entryPoints: [join(here, 'src/server.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20',
  outfile: join(here, 'dist/server.mjs'), logLevel: 'info', metafile: true,
  define: { __APPRUA_VERSION__: JSON.stringify(version) },
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
});

/** The folder of every package with code inside the bundle (the innermost node_modules entry of each input). A package
 *  that ships one pre-built file (tar: dist/esm/index.min.js) has its own dependencies inside it: those count too. */
function bundledPackages(metafile) {
  const dirs = new Set();
  const addDeps = (dir) => {
    const deps = Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {});
    for (const d of deps) {
      // nested first, then up the folders, the way Node finds it
      let at = dir, found = null;
      for (;;) {
        const c = join(at, 'node_modules', d);
        if (existsSync(join(c, 'package.json'))) { found = c; break; }
        const up = dirname(at);
        if (up === at) break;
        at = up;
      }
      if (!found) throw new Error(`${d} (inside ${dir}) not found`);
      if (!dirs.has(found)) { dirs.add(found); addDeps(found); }
    }
  };
  for (const input of Object.keys(metafile.inputs)) {
    const p = input.replaceAll('\\', '/');
    const m = [...p.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].pop();
    if (!m) continue;
    const dir = join(process.cwd(), p.slice(0, m.index + m[0].length - 1));
    dirs.add(dir);
    if (/\.min\.js$/.test(p)) addDeps(dir);
  }
  return [...dirs].sort();
}

const sections = [];
for (const dir of bundledPackages(result.metafile)) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|-|$)/i.test(f));
  if (!file) throw new Error(`${pkg.name}: no license file found, its notice cannot go with the connector`);
  const text = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim();
  sections.push(`${pkg.name} ${pkg.version} (${pkg.license ?? 'see the license text'})\n\n${text}`);
}
const seen = new Set();
const unique = sections.filter((s) => { const k = s.split('\n')[0]; if (seen.has(k)) return false; seen.add(k); return true; });
const notices =
  `Apprua connector ${version}. Copyright the Apprua authors. License: AGPL-3.0-only.\n` +
  `This file also contains the following libraries, each under its own license:\n\n` +
  unique.join('\n\n' + '-'.repeat(72) + '\n\n') + '\n';
writeFileSync(join(here, 'dist/THIRD_PARTY_LICENSES.txt'), notices);
appendFileSync(join(here, 'dist/server.mjs'), `\n/*\n${notices.replaceAll('*/', '* /')}*/\n`);
console.log(`licenses of ${unique.length} bundled libraries added to dist/server.mjs and dist/THIRD_PARTY_LICENSES.txt`);

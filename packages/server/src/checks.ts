// Publication checks: app name, archive safety, secrets in the code, warnings for AI-chat apps, build method.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import * as tar from 'tar';
import { config } from './config.js';
import { HttpError } from './errors.js';

export const NAME_RE = /^[a-z][a-z0-9-]{2,30}$/;

export function checkName(name: string): void {
  if (!NAME_RE.test(name) || name.endsWith('-') || name.includes('--'))
    throw new HttpError(400, `Invalid app name "${name}": use 3-31 lowercase letters, digits and single dashes, starting with a letter (e.g. "my-notes").`);
  if (config.policy.reservedNames.includes(name))
    throw new HttpError(400, `The name "${name}" is reserved for the platform. Choose another one.`);
}

/** Extracts a .tar.gz safely: no absolute paths, no "..", no links or devices, size and file-count limits. */
export async function extractArchive(archive: string, dest: string): Promise<void> {
  let total = 0, files = 0;
  let tooBig: HttpError | null = null;
  const problems: string[] = [];
  // The filter never throws: an error thrown inside tar's stream escapes the request and stops the whole server.
  // Past a limit every other entry is skipped (nothing more is written) and the error comes after the stream ends.
  await tar.x({
    file: archive,
    cwd: dest,
    strict: true,
    preservePaths: false,
    filter: (path, entry) => {
      if (tooBig) return false;
      const e = entry as tar.ReadEntry;
      if (path.split('/').includes('..') || path.startsWith('/')) { problems.push(`unsafe path ${path}`); return false; }
      if (e.type !== 'File' && e.type !== 'Directory' && e.type !== 'OldFile' && e.type !== 'ContiguousFile') {
        problems.push(`${path} (${e.type}) skipped`); return false;
      }
      total += e.size ?? 0; files++;
      if (total > config.policy.maxExtractedBytes) tooBig = new HttpError(413, 'Archive content is too large once extracted.');
      else if (files > config.policy.maxFiles) tooBig = new HttpError(413, 'Archive contains too many files.');
      return !tooBig;
    },
  });
  if (tooBig) throw tooBig;
  if (problems.some((p) => p.startsWith('unsafe'))) throw new HttpError(400, 'Archive contains unsafe paths.', problems);
}

export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.name === '.git') continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else if (d.isFile()) out.push(relative(root, p).split(sep).join('/'));
    }
  }
  await walk(root);
  return out.sort();
}

const SECRET_FILE_RE = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)\.npmrc$/,
  /(^|\/)credentials(\.json)?$/i,
];
const ALLOWED_ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template)$/i;
const SECRET_CONTENT_RE: { re: RegExp; what: string }[] = [
  { re: /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, what: 'private key' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, what: 'Anthropic API key' },
  { re: /\bsk-(?!ant-)(proj-)?[A-Za-z0-9_-]{32,}/, what: 'OpenAI-style API key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'AWS access key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, what: 'GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/, what: 'GitHub token' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, what: 'Slack token' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, what: 'Google API key' },
  { re: /\bapr_[A-Za-z0-9_-]{40,}/, what: 'Apprua personal token' },
];

export interface Finding { file: string; line?: number; what: string }

const isProbablyText = (buf: Buffer) => !buf.subarray(0, 8000).includes(0);

/** Rejects archives with secret files or secret-looking strings. */
export async function scanSecrets(root: string, files: string[]): Promise<Finding[]> {
  const found: Finding[] = [];
  for (const f of files) {
    if (!ALLOWED_ENV_EXAMPLE.test(f) && SECRET_FILE_RE.some((r) => r.test(f))) {
      found.push({ file: f, what: 'secret file' });
      continue;
    }
    const s = await stat(join(root, f));
    if (s.size > 2 * 1024 * 1024) continue;
    const buf = await readFile(join(root, f));
    if (!isProbablyText(buf)) continue;
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((l, i) => {
      for (const { re, what } of SECRET_CONTENT_RE) if (re.test(l)) found.push({ file: f, line: i + 1, what });
    });
  }
  return found;
}

export function secretsError(found: Finding[]): HttpError {
  const list = found.slice(0, 20).map((f) => `${f.file}${f.line ? `:${f.line}` : ''} (${f.what})`).join('; ');
  return new HttpError(422,
    `Publication refused: the folder contains secrets (${list}). Remove them from the files, ` +
    `add them to .gitignore, and set the values with set_env instead (they become environment variables of the app).`,
    found);
}

/** Warnings for apps made inside an AI chat (e.g. Claude artifacts), which use features that exist only there. */
export async function claudeWarnings(root: string, files: string[]): Promise<string[]> {
  const checks = [
    { re: /window\.storage\b/, msg: 'uses window.storage, which only exists inside Claude: save data on a server (e.g. SQLite in /data with persistent=true).' },
    { re: /window\.claude\b/, msg: 'uses window.claude, which only exists inside Claude: it will not work outside Claude.' },
    { re: /api\.anthropic\.com/, msg: 'calls api.anthropic.com from the code: never put an API key in the browser; call the API from a small server part of the app, with the key in set_env.' },
  ];
  const warnings = new Set<string>();
  for (const f of files.filter((f) => /\.(m?jsx?|tsx?|html?|vue|svelte)$/i.test(f) && !f.includes('node_modules/'))) {
    const s = await stat(join(root, f));
    if (s.size > 2 * 1024 * 1024) continue;
    const text = await readFile(join(root, f), 'utf8');
    for (const c of checks) if (c.re.test(text)) warnings.add(`${f} ${c.msg}`);
  }
  return [...warnings];
}

/**
 * Dockerfile instructions joined the way Docker joins them: a backslash at the end of a line (spaces after it allowed)
 * continues the instruction, the pieces are joined with nothing in between, and comment or empty lines inside a
 * continuation are skipped. A comment line never continues, even when it ends with a backslash.
 */
export function dockerInstructions(df: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (const raw of df.split(/\r?\n/)) {
    if (cur === null && /^\s*#/.test(raw)) { out.push(raw); continue; }
    if (cur !== null && /^\s*(#.*)?$/.test(raw)) continue;
    const m = /^(.*)\\[ \t]*$/.exec(raw);
    cur = (cur ?? '') + (m ? m[1] : raw);
    if (!m) { out.push(cur); cur = null; }
  }
  if (cur !== null) out.push(cur);
  return out;
}

export interface BuildPlan {
  buildPack: 'dockerfile' | 'static' | 'nixpacks' | 'railpack';
  port: number | null;
  /** Static site with a single page not called index.html (typical Claude artifact export): add an index.html pointing to it. */
  entryHtml?: string;
}

/** Build method: Dockerfile > static (index.html only) > automatic buildpack. */
export async function detectBuild(root: string, files: string[], requestedPort?: number): Promise<BuildPlan> {
  const has = (f: string) => files.includes(f);
  if (has('Dockerfile')) {
    const df = await readFile(join(root, 'Dockerfile'), 'utf8');
    // Instructions for the proxy in the app's own labels could take the portal's address or skip the sign-in
    // (apprua-guard also removes containers whose image has them, for labels that come from the FROM image)
    const labels = dockerInstructions(df).filter((l) => /^\s*(ONBUILD\s+)?LABEL\s/i.test(l));
    // quotes, escapes and spaces can split a word that Docker puts back together ("trae"fik, trae\fik)
    if (labels.some((l) => /traefik|caddy/i.test(l.replace(/[\s"'\\]/g, ''))))
      throw new HttpError(422, 'The Dockerfile has LABEL lines for the proxy (traefik or caddy): remove them. Apprua sets the address and the sign-in of every app.');
    // labels built from variables, or another line-continuation character, could hide the same thing
    if (labels.some((l) => l.includes('$')) || /^\s*#\s*escape\s*=/im.test(df))
      throw new HttpError(422, 'The Dockerfile has LABEL lines with variables, or an "escape" directive: write labels as plain text.');
    const m = /^\s*EXPOSE\s+(\d+)/im.exec(df);
    return { buildPack: 'dockerfile', port: requestedPort ?? (m ? Number(m[1]) : null) };
  }
  const appMarkers = ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Gemfile', 'composer.json', 'Cargo.toml', 'pom.xml'];
  if (!appMarkers.some(has) && has('index.html')) return { buildPack: 'static', port: 80 };
  const rootPages = files.filter((f) => !f.includes('/') && /\.html?$/i.test(f));
  if (!appMarkers.some(has) && rootPages.length === 1) return { buildPack: 'static', port: 80, entryHtml: rootPages[0] };
  if (!appMarkers.some(has) && rootPages.length > 1)
    throw new HttpError(422, `Static site with several pages (${rootPages.join(', ')}) but no index.html: rename the main page to index.html.`);
  if (!appMarkers.some(has)) throw new HttpError(422, 'Cannot tell how to run this folder: add a Dockerfile, a package.json/requirements.txt, or an index.html for a static site.');
  let port = requestedPort ?? null;
  if (!port && has('package.json')) {
    const pkg = await readFile(join(root, 'package.json'), 'utf8');
    const m = /PORT[^\d]{0,10}(\d{4,5})/.exec(pkg);
    if (m) port = Number(m[1]);
  }
  return { buildPack: config.engine.autoBuildpack, port };
}

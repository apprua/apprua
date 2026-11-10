// Packs a local folder for upload: respects .gitignore files (also in subfolders), always excludes heavy and secret
// paths and files > 20 MB, and refuses folders that are clearly not a project (the user's home, a drive, a folder of
// keys): an AI app led astray by a web page or a README could otherwise send them.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import * as tar from 'tar';

export const STATE_FILE = '.apprua.json';
export const APP_NAME_RE = /^[a-z][a-z0-9-]{2,30}$/;

/** What this connector wrote in the folder at the last publication. The file can also come with a downloaded
 *  project: a name or a version that do not look like the real ones are ignored (the name becomes part of an address). */
export function readState(dir: string): { app?: string; commit?: string } {
  try {
    const s = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'));
    if (typeof s?.app !== 'string' || !APP_NAME_RE.test(s.app)) return {};
    if (typeof s?.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(s.commit)) return { app: s.app };
    return { app: s.app, commit: s.commit };
  } catch { return {}; }
}
const ALWAYS_EXCLUDED = ['node_modules/', '.git/', '.env', '.env.*', '!.env.example', '__pycache__/', '.venv/', 'venv/', STATE_FILE,
  '.DS_Store', 'Thumbs.db',
  // keys and credentials of the PC, never part of an app
  '.ssh/', '.aws/', '.gnupg/', '.kube/', '.docker/', '.azure/', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '*_history'];
const MAX_FILE = 20 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_TOTAL = 200 * 1024 * 1024;
/** Folders of keys and settings: a project is never one of them nor inside one (the second list: right in the home). */
const PRIVATE_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure'];
const PRIVATE_HOME_DIRS = ['.config', 'appdata', 'library'];

export interface PackResult { archive: string; files: number; bytes: number; skippedLarge: string[] }

const norm = (p: string) => {
  const r = resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
};

/** Where a path really is (through links and junctions); the path itself if it cannot be resolved. */
const real = (p: string) => { try { return realpathSync.native(p); } catch { return resolve(p); } };

/** Refuses a folder that is not a project: a drive or the root, the home folder or one above it, a folder of keys.
 *  Checked on the path as written and on where it really leads, so a link or a junction does not get around it. */
export function checkFolder(root: string, home = homedir()): void {
  const why = (what: string) => new Error(`${resolve(root)} is ${what}, not the folder of an app: pass the folder of the project.`);
  for (const r of new Set([resolve(root), real(root)])) for (const h of new Set([resolve(home), real(home)])) checkOne(r, h, why);
}

function checkOne(root: string, home: string, why: (what: string) => Error): void {
  const r = norm(root), h = norm(home);
  if (r === norm(parse(resolve(root)).root)) throw why('the root of a drive');
  if (r === h) throw why('your home folder');
  if (h.startsWith(`${r}${sep}`) || h.startsWith(`${r}/`)) throw why('a folder that contains your home folder');
  const underHome = Boolean(h) && (r.startsWith(`${h}${sep}`) || r.startsWith(`${h}/`));
  const parts = (underHome ? r.slice(h.length + 1) : r).split(/[\\/]/).map((s) => s.toLowerCase());
  const priv = parts.find((s) => PRIVATE_DIRS.includes(s)) ?? (underHome && PRIVATE_HOME_DIRS.includes(parts[0]) ? parts[0] : undefined);
  if (priv) throw why(`inside "${priv}" (keys and settings of this PC)`);
}

export async function listPublishable(root: string): Promise<{ files: string[]; skippedLarge: string[] }> {
  const files: string[] = [], skippedLarge: string[] = [];
  let total = 0;
  const rules = (dir: string, inherited: { base: string; ig: Ignore }[]) => {
    const gi = join(dir, '.gitignore');
    return existsSync(gi) ? [...inherited, { base: dir, ig: ignore().add(readFileSync(gi, 'utf8')) }] : inherited;
  };
  const ignored = (abs: string, isDir: boolean, list: { base: string; ig: Ignore }[]) => list.some(({ base, ig }) => {
    const rel = relative(base, abs).split(sep).join('/');
    return ig.ignores(isDir ? `${rel}/` : rel);
  });
  async function walk(dir: string, inherited: { base: string; ig: Ignore }[]) {
    const list = rules(dir, inherited);
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, d.name);
      if (d.isDirectory()) { if (!ignored(abs, true, list)) await walk(abs, list); continue; }
      if (!d.isFile() || ignored(abs, false, list)) continue;
      const rel = relative(root, abs).split(sep).join('/');
      const size = statSync(abs).size;
      if (size > MAX_FILE) { skippedLarge.push(rel); continue; }
      files.push(rel);
      total += size;
      if (files.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} files in ${root}: is this really the folder of one app? Add the extra folders to .gitignore.`);
      if (total > MAX_TOTAL) throw new Error(`More than ${MAX_TOTAL / 1024 / 1024} MB of files in ${root}: is this really the folder of one app? Add the heavy folders to .gitignore.`);
    }
  }
  await walk(root, [{ base: root, ig: ignore().add(ALWAYS_EXCLUDED) }]);
  return { files: files.sort(), skippedLarge };
}

/** The archive goes in a new private folder of its own (remove the whole folder when done: see cleanup). */
export async function packFolder(root: string): Promise<PackResult> {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Folder not found: ${root}`);
  checkFolder(root);
  const { files, skippedLarge } = await listPublishable(root);
  if (!files.length) throw new Error('Nothing to publish in this folder (everything is ignored or empty).');
  const dir = mkdtempSync(join(tmpdir(), 'apprua-'));
  const archive = join(dir, 'app.tar.gz');
  try {
    await tar.c({ gzip: true, file: archive, cwd: root, portable: true, noDirRecurse: true }, files);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { archive, files: files.length, bytes: statSync(archive).size, skippedLarge };
}

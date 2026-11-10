// Built-in code archive (replaces an external git server): one bare git repository per app in DATA_DIR/repos.
// Every publication is a commit, so the history of each app is kept. The engine downloads the code through a
// small read-only git server (smart HTTP via `git http-backend`) on GIT_PORT, reachable only on the internal
// Docker network; each app has its own secret read key in the URL.
import { execFile, spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertNoGitInside } from './checks.js';
import { config } from './config.js';
import { secrets } from './secrets.js';

const exec = promisify(execFile);
const NAME_RE = /^[a-z][a-z0-9-]{2,30}$/;

export const reposDir = () => join(config.dataDir, 'repos');
export const repoDir = (name: string) => join(reposDir(), `${name}.git`);
export const repoExists = (name: string) => existsSync(join(repoDir(name), 'HEAD'));

const baseEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  // The data folder may belong to another user id than the process (e.g. after a restore)
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
});

const git = (args: string[], env: Record<string, string> = {}) =>
  exec('git', args, { env: { ...baseEnv(), ...env }, maxBuffer: 20 * 1024 * 1024 });

/** Secret read key of an app (stable, derived from the instance secret). */
export function readKey(name: string): string {
  return createHmac('sha256', secrets().git).update(`read:${name}`).digest('base64url').slice(0, 32);
}

/** URL the engine uses to download the app's code. */
export const internalGitUrl = (name: string) => `${config.git.internalUrl}/git/${readKey(name)}/${name}.git`;

export async function headCommit(name: string): Promise<string | null> {
  if (!repoExists(name)) return null;
  try { return (await git(['--git-dir', repoDir(name), 'rev-parse', '--verify', '-q', 'refs/heads/main'])).stdout.trim() || null; }
  catch { return null; }
}

export interface CommitInput { name: string; srcDir: string; author: { name: string; email: string }; message: string }

/** Stores the content of srcDir as the new version of the app (deleted files are removed). Returns the commit sha. */
export async function commitTree(i: CommitInput): Promise<{ sha: string; changed: boolean }> {
  // Second lock, at the point where git reads the files: a repository inside them would be obeyed by git.
  await assertNoGitInside(i.srcDir);
  const gitDir = repoDir(i.name);
  if (!repoExists(i.name)) {
    mkdirSync(reposDir(), { recursive: true });
    await git(['init', '-q', '--bare', '-b', 'main', gitDir]);
  }
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: i.srcDir, GIT_INDEX_FILE: join(gitDir, 'apprua-index') };
  const head = await headCommit(i.name);
  await git(head ? ['read-tree', head] : ['read-tree', '--empty'], env);
  await git(['add', '-A', '--force', '.'], env);
  if (head) {
    const changed = await git(['diff', '--cached', '--quiet', head], env).then(() => false, () => true);
    if (!changed) return { sha: head, changed: false };
  }
  await git(['-c', 'user.name=Apprua', '-c', 'user.email=apprua@localhost', 'commit', '-q', '--no-verify',
    '-m', i.message, `--author=${i.author.name} <${i.author.email}>`], env);
  const sha = (await git(['rev-parse', 'HEAD'], env)).stdout.trim();
  return { sha, changed: true };
}

/** A version of the app's code (default: latest) as tar.gz (for the AI) or zip (for people: Windows opens it). */
export async function exportArchive(name: string, outFile: string, ref = 'main', format: 'tar.gz' | 'zip' = 'tar.gz'): Promise<void> {
  await git(['--git-dir', repoDir(name), 'archive', `--format=${format}`, '-o', outFile, ref]);
}

/** Makes an older version the newest one again: a new commit with the same files as that version (history kept).
 *  Returns the new commit, or the current one when the files are already the same. */
export async function restoreVersion(name: string, sha: string, author: { name: string; email: string }): Promise<{ sha: string; changed: boolean }> {
  const head = await headCommit(name);
  if (!head) throw new Error('no code stored for this app');
  const gd = ['--git-dir', repoDir(name)];
  const full = (await git([...gd, 'rev-parse', '--verify', '-q', `${sha}^{commit}`])).stdout.trim();
  const tree = (await git([...gd, 'rev-parse', `${full}^{tree}`])).stdout.trim();
  if ((await git([...gd, 'rev-parse', `${head}^{tree}`])).stdout.trim() === tree) return { sha: head, changed: false };
  const env = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: 'Apprua', GIT_COMMITTER_EMAIL: 'apprua@localhost' };
  const commit = (await git([...gd, 'commit-tree', tree, '-p', head, '-m', `Back to the version of ${full.slice(0, 7)}`], env)).stdout.trim();
  await git([...gd, 'update-ref', 'refs/heads/main', commit, head]);
  return { sha: commit, changed: true };
}

export async function history(name: string, limit = 20): Promise<{ sha: string; at: string; author: string; message: string }[]> {
  if (!(await headCommit(name))) return [];
  const { stdout } = await git(['--git-dir', repoDir(name), 'log', `-${limit}`, '--format=%H%x1f%aI%x1f%an <%ae>%x1f%s', 'main']);
  return stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [sha, at, author, message] = l.split('\x1f');
    return { sha, at, author, message };
  });
}

/** Permanent deletion keeps a copy aside (repos/.deleted) so a mistake can still be undone by hand. */
export async function removeRepo(name: string): Promise<void> {
  if (!repoExists(name)) return;
  const trash = join(reposDir(), '.deleted');
  mkdirSync(trash, { recursive: true });
  await rename(repoDir(name), join(trash, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.git`));
}

// ---------- read-only git server for the engine ----------

function sameKey(a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Starts the read-only git server (clone/fetch only, never push). */
export function startGitServer(port = config.gitPort): Server {
  const server = createServer((req, res) => {
    const deny = (code: number, msg: string) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg); };
    // An address that cannot be read (for example "//") gets an answer: an error thrown here would stop the whole server.
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://x'); } catch { return deny(400, 'Bad request'); }
    const m = /^\/git\/([A-Za-z0-9_-]+)\/([a-z0-9-]+)\.git(\/.*)$/.exec(url.pathname);
    if (!m || !NAME_RE.test(m[2]) || !sameKey(m[1], readKey(m[2])) || !repoExists(m[2])) return deny(404, 'Not found');
    const [, , name, rest] = m;
    const service = url.searchParams.get('service');
    const readOnly = (rest === '/info/refs' && service === 'git-upload-pack' && req.method === 'GET') ||
      (rest === '/git-upload-pack' && req.method === 'POST');
    if (!readOnly) return deny(403, 'Read-only');

    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...baseEnv(),
        GIT_PROJECT_ROOT: reposDir(),
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: `/${name}.git${rest}`,
        REQUEST_METHOD: req.method ?? 'GET',
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
        HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
        GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
        REMOTE_ADDR: req.socket.remoteAddress ?? '',
      },
    });
    // git may close its input before the request is over (a body it refuses): without a listener that error stops the server
    cgi.stdin.on('error', () => {});
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0), headersDone = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) { res.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      let end = head.indexOf('\r\n\r\n'), sep = 4;
      if (end < 0) { end = head.indexOf('\n\n'); sep = 2; }
      if (end < 0) return;
      headersDone = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString('utf8').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = Number(v.split(' ')[0]) || 200;
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + sep));
    });
    cgi.stdout.on('end', () => { if (!headersDone) res.writeHead(502); res.end(); });
    cgi.on('error', () => { if (!res.headersSent) deny(502, 'git not available'); });
    cgi.stderr.on('data', (d) => console.error(`[git] ${name}: ${String(d).trim()}`));
  });
  server.listen(port, '0.0.0.0');
  return server;
}

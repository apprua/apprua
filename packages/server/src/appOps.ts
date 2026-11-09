// Owner operations on an app (owner or admin), shared by the /v1 API (MCP) and the portal buttons.
import { HttpError } from './errors.js';
import { audit, getApp, getDb, updateApp, VISIBILITIES, type User, type Visibility } from './db.js';
import { engine } from './engine/index.js';
import { assertCanManage, exclusive, isBusy, runDeploy } from './publish.js';
import * as repos from './repos.js';

export type Control = 'restart' | 'stop' | 'start';

export async function controlApp(u: User, name: string, action: Control) {
  const a = assertCanManage(u, getApp(name), name);
  if (a.status === 'archived') throw new HttpError(409, 'The app is archived.');
  if (!a.engine_id) throw new HttpError(409, 'The app was never deployed: publish it again.');
  // the engine would really start a paused app on "restart", while Apprua still showed it paused
  if (action === 'restart' && a.status === 'stopped') throw new HttpError(409, 'The app is paused: start it instead of restarting it.');
  // the same reservation as publishing and archiving: an archive cannot arrive while a start is under way
  return exclusive(a.name, async () => {
    await engine()[action](a.engine_id!);
    if (action !== 'restart') updateApp(a.name, { status: action === 'stop' ? 'stopped' : 'active' });
    updateApp(a.name, { down_since: null });   // checked again from now (monitor.ts)
    audit(u.email, `app.${action}`, a.name);
    return { app: a.name, action, ok: true };
  });
}

/** Who can open the app (checked by the gate in front of the apps, at once: no restart needed). */
export function setVisibility(u: User, name: string, visibility: unknown) {
  const a = assertCanManage(u, getApp(name), name);
  if (!VISIBILITIES.includes(visibility as Visibility)) throw new HttpError(400, `visibility must be one of: ${VISIBILITIES.join(', ')}`);
  updateApp(a.name, { visibility: visibility as Visibility });
  audit(u.email, 'app.visibility', a.name, { visibility });
  return { app: a.name, visibility };
}

/** Stops an app before archiving it. If the engine does not stop it, the app is not marked archived: the error says so. */
export async function stopForArchive(engineId: string): Promise<void> {
  try { await engine().stop(engineId); }
  catch (e) {
    if (/\b404\b/.test(String((e as Error).message))) return;   // already gone from the engine: nothing left to stop
    throw new HttpError(502, `The engine did not stop the app, so it is not archived: try again in a minute. (${(e as Error).message})`);
  }
}

export async function archiveOwnApp(u: User, name: string) {
  const a = assertCanManage(u, getApp(name), name);
  // not while it is being published: the end of that publication would start it again
  return exclusive(a.name, async () => {
    if (a.engine_id) await stopForArchive(a.engine_id);
    updateApp(a.name, { status: 'archived' });
    audit(u.email, 'app.archive', a.name);
    return { app: a.name, status: 'archived', note: 'Stopped and archived. Code and data are kept; an administrator can restore it.' };
  });
}

export async function appLogs(u: User, name: string, type: 'runtime' | 'build', linesIn = 100) {
  const a = assertCanManage(u, getApp(name), name);
  const lines = Math.min(Math.max(Number(linesIn) || 100, 10), 1000);
  if (type === 'build') {
    const d = getDb().prepare('SELECT engine_deployment, result FROM deploys WHERE app = ? ORDER BY id DESC LIMIT 1').get(a.name) as any;
    if (!d?.engine_deployment) return { type, result: null as string | null, lines: [] as string[] };
    const r = await engine().waitDeployment(d.engine_deployment, 0);
    return { type, result: d.result as string | null, lines: r.logTail.slice(-lines) };
  }
  if (!a.engine_id || a.status !== 'active') return { type, result: null, lines: [] as string[] };
  return { type, result: null, lines: await engine().runtimeLogs(a.engine_id, lines) };
}

export async function setEnv(u: User, name: string, key: string, value: unknown, restart = true) {
  const a = assertCanManage(u, getApp(name), name);
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key ?? '')) throw new HttpError(400, 'Variable name must be UPPER_CASE letters, digits and underscores.');
  if (typeof value !== 'string') throw new HttpError(400, 'Missing value.');
  if (!a.engine_id) throw new HttpError(409, 'The app was never deployed: publish it again.');
  await engine().setEnv(a.engine_id, key, value);
  audit(u.email, 'app.env.set', a.name, { key }); // never the value
  // restarted only when it is on (a paused or archived app stays off), and not while it is being published or archived
  const restarted = await restartIfActive(a.name, restart);
  return { app: a.name, key, ok: true, restarted };
}

/** After a change of its settings: restarts the app only if it is on, with the same reservation as publishing. */
async function restartIfActive(name: string, wanted: boolean): Promise<boolean> {
  // being published right now: that publication starts the app with the new settings anyway
  if (!wanted || isBusy(name)) return false;
  return exclusive(name, async () => {
    const now = getApp(name);
    if (!now?.engine_id || now.status !== 'active') return false;
    await engine().restart(now.engine_id);
    return true;
  });
}

/** Names of the secrets and settings of the app (never the values: they cannot be read back). */
export async function listEnv(u: User, name: string): Promise<string[]> {
  const a = assertCanManage(u, getApp(name), name);
  return a.engine_id ? engine().listEnv(a.engine_id) : [];
}

export async function deleteEnv(u: User, name: string, key: string, restart = true) {
  const a = assertCanManage(u, getApp(name), name);
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key ?? '')) throw new HttpError(400, 'Variable name must be UPPER_CASE letters, digits and underscores.');
  if (!a.engine_id) throw new HttpError(409, 'The app was never deployed: publish it again.');
  await engine().deleteEnv(a.engine_id, key);
  audit(u.email, 'app.env.delete', a.name, { key });
  const restarted = await restartIfActive(a.name, restart);
  return { app: a.name, key, removed: true, restarted };
}

export interface Version { sha: string; at: string; author: string; message: string; current: boolean; result: string | null }

/** The versions of the app (newest first), with how their last publication went. */
export async function appVersions(u: User, name: string, limit = 30): Promise<Version[]> {
  const a = assertCanManage(u, getApp(name), name);
  const list = await repos.history(a.name, limit);
  const results = new Map<string, string | null>();
  for (const r of getDb().prepare('SELECT commit_sha, result FROM deploys WHERE app = ? AND commit_sha IS NOT NULL ORDER BY id').all(a.name) as { commit_sha: string; result: string | null }[]) {
    results.set(r.commit_sha, r.result);
  }
  return list.map((v, i) => ({ ...v, current: i === 0, result: results.get(v.sha) ?? null }));
}

/** Puts an older version online again: it becomes the newest version (the history is kept) and is published.
 *  The publication runs in the background (a few minutes); the portal shows it as "publishing". */
export async function restoreVersion(u: User, name: string, sha: string, wait = false) {
  const a = assertCanManage(u, getApp(name), name);
  if (a.status === 'archived') throw new HttpError(409, 'The app is archived.');
  if (!/^[0-9a-f]{7,40}$/.test(sha ?? '')) throw new HttpError(400, 'Not a version of this app.');
  const known = (await repos.history(a.name, 200)).find((v) => v.sha.startsWith(sha));
  if (!known) throw new HttpError(404, 'Not a version of this app.');
  // The app stays reserved until the publication ends (also when it runs in the background)
  let committed!: (sha: string) => void;
  const commit = new Promise<string>((res) => { committed = res; });
  const run = exclusive(a.name, async () => {
    const r = await repos.restoreVersion(a.name, known.sha, { name: u.name ?? u.email, email: u.email });
    audit(u.email, 'app.restore_version', a.name, { from: known.sha, commit: r.sha });
    committed(r.sha);
    return runDeploy(a.name, u.email, 'manual', r.sha);
  });
  if (wait) return { ...(await run), restored_from: known.sha };
  run.catch(() => { /* the result is in the deploy history */ });
  return { app: a.name, restored_from: known.sha, commit: await Promise.race([commit, run.then(() => '')]), status: 'publishing' };
}

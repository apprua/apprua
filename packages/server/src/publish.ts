// Publication workflow: checks → new version in the code archive → app in the engine → deploy.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appKey, APP_KEY_ENV } from './auth.js';
import { appUrl, config } from './config.js';
import { HttpError } from './errors.js';
import { audit, countActiveApps, getApp, getDb, updateApp, type App, type User } from './db.js';
import { checkName, claudeWarnings, detectBuild, extractArchive, listFiles, scanSecrets, secretsError, type BuildPlan } from './checks.js';
import { engine } from './engine/index.js';
import * as repos from './repos.js';

export interface PublishInput {
  user: User;
  name: string;
  description?: string;
  port?: number;
  persistent?: boolean;
  archivePath: string;
  /** Version the user's copy was based on: if the app moved on in the meantime, refuse instead of overwriting. */
  baseCommit?: string;
  force?: boolean;
}

export interface PublishResult {
  app: string;
  url: string;
  status: 'running' | 'failed' | 'timeout';
  commit: string;
  warnings: string[];
  logTail?: string[];
}

const addMonths = (m: number) => { const d = new Date(); d.setMonth(d.getMonth() + m); return d.toISOString().slice(0, 10); };
export const nextReview = () => (config.policy.reviewMonths > 0 ? addMonths(config.policy.reviewMonths) : null);

export function canManage(user: User, app: App): boolean {
  return user.role === 'admin' || app.owner === user.email;
}

export function assertCanManage(user: User, app: App | undefined, name: string): App {
  // Same answer for "missing" and "not yours", so names of other people's apps are not disclosed via errors
  if (!app || !canManage(user, app)) throw new HttpError(404, `App "${name}" not found among your apps.`);
  return app;
}

function readme(app: { name: string; owner: string; description: string }) {
  return `# ${app.name}\n\n${app.description}\n\n- Owner: ${app.owner}\n- URL: ${appUrl(app.name)}\n` +
    `- Published with ${config.brand}. Secrets go in environment variables (set_env), never in the code.\n`;
}

/** Apps with a publication in progress. Apprua is a single process, so this is enough to keep two publications of the
 *  same app (same code archive, same engine app) from mixing: the second one is refused at once. */
const busy = new Set<string>();
/** New apps being published, per person, not yet in the database: counted in the quota. */
const newInProgress = new Map<string, number>();

/** A publication the engine has taken stays open (a deploy without a result) until the engine says it ended: finished,
 *  failed, cancelled or unknown to it. Not a guess: Apprua running out of time, losing contact with the engine or
 *  restarting leaves it open, and a follower (also started again at every start of Apprua) closes it when the engine
 *  answers. Meanwhile the app stays reserved, so nothing else starts on top of a build still running. */
const following = new Map<number, Promise<void>>();
/** How long one round of waiting lasts, and the pause after a round without an answer (changed by the tests). */
export const followTiming = { roundMs: 15 * 60_000, pauseMs: 60_000 };
const openDeploy = (name: string) => !!getDb().prepare('SELECT 1 FROM deploys WHERE app = ? AND result IS NULL LIMIT 1').get(name);

/** Whether something is being done to the app right now (a publication, a start, an archive, a build still running). */
export const isBusy = (name: string) => busy.has(name) || openDeploy(name);

/** Runs fn with the app reserved; refuses if a publication of the same app is already running. */
export async function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!busy.has(name) && openDeploy(name)) throw new HttpError(409, `The engine is still building the last version of "${name}": wait until it ends, then try again.`);
  if (busy.has(name)) throw new HttpError(409, `"${name}" is being published right now: wait until that publication ends, then try again.`);
  busy.add(name);
  try { return await fn(); } finally { busy.delete(name); }
}

export async function publish(i: PublishInput): Promise<PublishResult> {
  checkName(i.name);
  const existing = getApp(i.name);
  const isNew = !existing;
  if (existing) {
    if (existing.owner !== i.user.email && i.user.role !== 'admin')
      throw new HttpError(409, `The name "${i.name}" is already used by someone else. Choose a different name.`);
    if (existing.status === 'archived')
      throw new HttpError(409, `"${i.name}" is archived. Ask an administrator to restore it, or choose a new name.`);
  } else {
    if (!i.description?.trim()) throw new HttpError(400, 'A short description is required for a new app.');
    const quota = i.user.quota ?? config.policy.defaultQuota;
    if (countActiveApps(i.user.email) + (newInProgress.get(i.user.email) ?? 0) >= quota)
      throw new HttpError(403, `You already have ${quota} active apps (your quota). Archive one you no longer need, or ask an administrator for more.`);
    if (repos.repoExists(i.name)) throw new HttpError(409, `Code for an app called "${i.name}" already exists. Choose a different name.`);
  }

  // Everything above runs without waiting, so the checks and the reservation below cannot interleave with another request.
  if (isNew) newInProgress.set(i.user.email, (newInProgress.get(i.user.email) ?? 0) + 1);
  try {
    return await exclusive(i.name, () => publishReserved(i, existing, isNew));
  } finally {
    if (isNew) {
      const n = (newInProgress.get(i.user.email) ?? 1) - 1;
      if (n > 0) newInProgress.set(i.user.email, n); else newInProgress.delete(i.user.email);
    }
  }
}

async function publishReserved(i: PublishInput, existing: App | undefined, isNew: boolean): Promise<PublishResult> {
  if (isNew && getApp(i.name)) throw new HttpError(409, `The name "${i.name}" was just taken. Choose a different name.`);
  const src = await mkdtemp(join(tmpdir(), 'src-'));
  try {
    await extractArchive(i.archivePath, src);
    const files = await listFiles(src);
    if (!files.length) throw new HttpError(400, 'The archive is empty.');
    const secretsFound = await scanSecrets(src, files);
    if (secretsFound.length) throw secretsError(secretsFound);
    const warnings = await claudeWarnings(src, files);
    const plan: BuildPlan = await detectBuild(src, files, i.port ?? existing?.port ?? undefined);
    if (!plan.port) throw new HttpError(422, 'Which port does the app listen on? Pass "port" (e.g. 3000 for Node, 8000 for Python).');

    if (!isNew && i.baseCommit && !i.force) {
      const head = await repos.headCommit(i.name);
      if (head && head !== i.baseCommit)
        throw new HttpError(409, `The app changed since your copy (now at ${head.slice(0, 8)}, yours is ${i.baseCommit.slice(0, 8)}). ` +
          'Use clone_app to get the latest version, apply your changes there, then update_app. Nothing was overwritten.');
    }

    const description = i.description?.trim() || existing!.description;
    const owner = existing?.owner ?? i.user.email;
    if (!files.some((f) => /^readme(\.md)?$/i.test(f))) await writeFile(join(src, 'README.md'), readme({ name: i.name, owner, description }));
    if (plan.entryHtml) {
      const target = encodeURI(plan.entryHtml);
      await writeFile(join(src, 'index.html'), `<!doctype html><meta charset="utf-8"><title>${i.name}</title>` +
        `<meta http-equiv="refresh" content="0;url=${target}"><a href="${target}">${target}</a>\n`);
      warnings.push(`No index.html: added one that opens ${plan.entryHtml}.`);
    }
    const { sha } = await repos.commitTree({
      name: i.name, srcDir: src,
      author: { name: i.user.name ?? i.user.email, email: i.user.email },
      message: isNew ? `Publish ${i.name}` : `Update ${i.name}`,
    });

    let id = existing?.engine_id ?? null;
    if (isNew) {
      getDb().prepare(`INSERT INTO apps (name, owner, description, url, status, persistent, port, build_pack, cpus, memory, review_at)
                       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
        .run(i.name, i.user.email, description, appUrl(i.name), i.persistent ? 1 : 0, plan.port,
          plan.buildPack, config.policy.defaultCpus, config.policy.defaultMemory, nextReview());
      audit(i.user.email, 'app.create', i.name, { buildPack: plan.buildPack, port: plan.port, persistent: !!i.persistent });
    }
    const e = engine();
    if (!id) {
      // New app, or a previous creation that stopped before the engine step: (re)create the engine side
      id = await e.createApp({
        name: i.name, description, gitUrl: repos.internalGitUrl(i.name), buildPack: plan.buildPack, port: plan.port,
        url: appUrl(i.name), cpus: config.policy.defaultCpus, memory: config.policy.defaultMemory,
      });
      // The engine side is kept only once it is complete: if a step fails it is removed, and the next attempt makes it
      // again from the start (never an app without its data volume). The sign-in labels are applied by runDeploy.
      try {
        if (i.persistent || existing?.persistent) await e.addPersistentStorage(id, `${i.name}-data`);
        await e.applyLabels(id, i.name, owner);
      } catch (err) {
        await e.deleteApp(id).catch(() => { /* the next attempt makes a new one */ });
        throw err;
      }
      updateApp(i.name, { engine_id: id });
    } else {
      await e.updateApp(id, {
        buildPack: plan.buildPack !== existing!.build_pack ? plan.buildPack : undefined,
        port: plan.port !== existing!.port ? plan.port : undefined,
        description: i.description && i.description !== existing!.description ? i.description : undefined,
      });
      updateApp(i.name, { build_pack: plan.buildPack, port: plan.port, description });
      if (i.persistent && !existing!.persistent) { await e.addPersistentStorage(id, `${i.name}-data`); updateApp(i.name, { persistent: 1 }); }
    }

    const result = await runDeploy(i.name, i.user.email, 'upload', sha);
    return { ...result, warnings };
  } finally {
    await rm(src, { recursive: true, force: true });
  }
}

/** The end of a publication: the app is marked active only if the new version runs and the app was not archived in the
 *  meantime (archiving is refused while a publication runs, so only by a path that skipped that): then the engine
 *  stops it again, never "active" because a publication ended. */
async function settle(name: string, status: string, sha: string | null): Promise<void> {
  const now = getApp(name);
  const archived = now?.status === 'archived';
  if (archived && status === 'running' && now?.engine_id) await engine().stop(now.engine_id).catch(() => { /* the gate keeps it closed anyway */ });
  updateApp(name, { last_deploy_at: new Date().toISOString(), ...(sha ? { last_commit: sha } : {}), ...(status === 'running' && !archived ? { status: 'active', down_since: null, oom_at: null } : {}) });
}

const pause = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); });

/** Follows an open publication in the background until the engine says how it ended, then closes it. */
function followUp(name: string, deployment: string, id: number, user: string, sha: string | null): void {
  if (!deployment || following.has(id)) return;
  const p = (async () => {
    for (;;) {
      let r: Awaited<ReturnType<ReturnType<typeof engine>['waitDeployment']>>;
      try {
        r = await engine().waitDeployment(deployment, followTiming.roundMs);
      } catch (e) {
        if (/\b404\b/.test(String((e as Error).message))) {
          // the engine no longer knows this publication: nothing is running for it any more
          getDb().prepare(`UPDATE deploys SET finished_at = datetime('now'), result = 'failed', log_excerpt = ? WHERE id = ? AND result IS NULL`)
            .run('The engine no longer knows this publication.', id);
          audit(user, 'app.deploy_followed', name, { status: 'failed', sha, reason: 'unknown to the engine' });
          return;
        }
        await pause(followTiming.pauseMs);   // no answer from the engine: still open, try again
        continue;
      }
      if (r.status === 'timeout') { await pause(followTiming.pauseMs); continue; }   // still building
      const status = r.status === 'finished' ? 'running' : 'failed';
      getDb().prepare(`UPDATE deploys SET finished_at = datetime('now'), result = ?, log_excerpt = ? WHERE id = ? AND result IS NULL`)
        .run(status, status === 'running' ? null : r.logTail.join('\n'), id);
      await settle(name, status, sha);
      audit(user, 'app.deploy_followed', name, { status, sha });
      return;
    }
  })().catch(() => { /* never leaves the publication closed by mistake: it stays open for the next start */ }).finally(() => { following.delete(id); });
  following.set(id, p);
}

/** Asked the engine to publish, but its answer (the deployment id) was lost: did a deployment of this app start since
 *  the request? "found" (then it is saved and followed), "none" (the engine answered: nothing started, safe to close),
 *  or "unknown" (the engine does not answer: the publication stays open). */
async function discover(name: string, id: number): Promise<{ state: 'found'; deployment: string } | { state: 'none' | 'unknown' }> {
  const e = engine();
  const app = getApp(name);
  const row = getDb().prepare('SELECT requested_at FROM deploys WHERE id = ?').get(id) as { requested_at: string | null } | undefined;
  if (!e.findDeployment || !app?.engine_id || !row?.requested_at) return { state: 'none' };
  const known = (getDb().prepare('SELECT engine_deployment FROM deploys WHERE app = ? AND engine_deployment IS NOT NULL').all(name) as { engine_deployment: string }[])
    .map((r) => r.engine_deployment);
  try {
    const found = await e.findDeployment(app.engine_id, row.requested_at, known);
    if (!found) return { state: 'none' };
    getDb().prepare('UPDATE deploys SET engine_deployment = ? WHERE id = ?').run(found, id);
    return { state: 'found', deployment: found };
  } catch { return { state: 'unknown' }; }
}

const closeNotStarted = (id: number, why: string) => getDb()
  .prepare(`UPDATE deploys SET finished_at = datetime('now'), result = 'failed', log_excerpt = ? WHERE id = ? AND result IS NULL`).run(why.slice(0, 2000), id);

/** Keeps asking the engine (in the background, also after a restart) until it says whether the publication started. */
const discovering = new Map<number, Promise<void>>();
function discoverLater(name: string, id: number, user: string, sha: string | null): void {
  if (discovering.has(id)) return;
  const p = (async () => {
    for (;;) {
      const d = await discover(name, id);
      if (d.state === 'found') { followUp(name, d.deployment, id, user, sha); return; }
      if (d.state === 'none') { closeNotStarted(id, 'The engine did not start this publication.'); return; }
      await pause(followTiming.pauseMs);
    }
  })().catch(() => { /* stays open for the next start */ }).finally(() => { discovering.delete(id); });
  discovering.set(id, p);
}

/** At every start of Apprua: the publications still open are followed again (those with a deployment id), or the
 *  engine is asked whether they started (those whose request was sent but whose answer never arrived). */
export function resumeOpenPublications(): number {
  const rows = getDb().prepare(`SELECT id, app, user, commit_sha, engine_deployment FROM deploys WHERE result IS NULL AND (engine_deployment IS NOT NULL OR requested_at IS NOT NULL)`)
    .all() as { id: number; app: string; user: string; commit_sha: string | null; engine_deployment: string | null }[];
  for (const r of rows) {
    if (r.engine_deployment) followUp(r.app, r.engine_deployment, r.id, r.user, r.commit_sha);
    else discoverLater(r.app, r.id, r.user, r.commit_sha);
  }
  return rows.length;
}

/** Waits for the followers running now (for the tests). */
export const followersDone = async () => { while (following.size || discovering.size) await Promise.all([...following.values(), ...discovering.values()]); };

const NETWORK_ERROR = /lookup .* (on|server misbehaving)|i\/o timeout|TLS handshake timeout|connection reset by peer|temporary failure in name resolution|could not resolve host/i;

export async function runDeploy(name: string, user: string, source: 'upload' | 'manual', sha: string | null) {
  const app = getApp(name)!;
  const e = engine();
  let attempt = 0;
  for (;;) {
    attempt++;
    const id = Number(getDb().prepare('INSERT INTO deploys (app, user, source, commit_sha) VALUES (?, ?, ?, ?)').run(name, user, source, sha).lastInsertRowid);
    let r: Awaited<ReturnType<typeof e.waitDeployment>>;
    let deployment = '';
    try {
      // Before every publication: the labels of the app, with the sign-in in front of it, set again and checked. A
      // step that failed before (or an app from an older version) can never be published without them.
      await e.applyLabels(app.engine_id!, name, app.owner);
      // the app's own key, to tell the user headers of the gate from made-up ones (see APP_KEY_ENV in auth.ts)
      await e.setEnv(app.engine_id!, APP_KEY_ENV, appKey(name));
      // from here the engine may start a deployment even if its answer is lost: the time of the request is kept
      getDb().prepare('UPDATE deploys SET requested_at = ? WHERE id = ?').run(new Date().toISOString(), id);
      deployment = await e.deploy(app.engine_id!);
      getDb().prepare('UPDATE deploys SET engine_deployment = ? WHERE id = ?').run(deployment, id);
      r = await e.waitDeployment(deployment, config.policy.deployTimeoutMs);
    } catch (err) {
      if (!deployment && getDb().prepare('SELECT 1 FROM deploys WHERE id = ? AND requested_at IS NOT NULL').get(id)) {
        // the request was sent and its answer was lost: ask the engine whether it started before freeing the app
        const d = await discover(name, id);
        if (d.state === 'found') deployment = d.deployment;
        else if (d.state === 'unknown') {
          discoverLater(name, id, user, sha);
          audit(user, 'app.deploy', name, { source, status: 'unknown', sha, attempt, error: (err as Error).message });
          throw new HttpError(502, `Lost contact with the engine while asking it to publish "${name}": Apprua checks with the engine whether it started; the app is reserved until then. (${(err as Error).message})`);
        }
      }
      if (deployment) {
        // the engine took it, then stopped answering: the build may still be running. It stays open and followed.
        followUp(name, deployment, id, user, sha);
        audit(user, 'app.deploy', name, { source, status: 'unknown', sha, attempt, error: (err as Error).message });
        throw new HttpError(502, `Lost contact with the engine during the publication of "${name}": it may still be building. Apprua keeps following it; the app is reserved until the engine says it ended. (${(err as Error).message})`);
      }
      // The engine did not take the publication: close it as failed, so the history and the monitor do not wait for it forever
      getDb().prepare(`UPDATE deploys SET finished_at = datetime('now'), result = 'failed', log_excerpt = ? WHERE id = ?`)
        .run(`The engine did not answer: ${(err as Error).message}`.slice(0, 2000), id);
      audit(user, 'app.deploy', name, { source, status: 'failed', sha, attempt, error: (err as Error).message });
      throw err;
    }
    const status = r.status === 'finished' ? 'running' : r.status;
    // out of time: no result yet (the engine is still building): the publication stays open and followed
    if (status !== 'timeout') getDb().prepare(`UPDATE deploys SET finished_at = datetime('now'), result = ?, log_excerpt = ? WHERE id = ?`)
      .run(status, r.status === 'finished' ? null : r.logTail.join('\n'), id);
    // A build that failed because of a short network glitch (seen in practice) is retried once, automatically.
    if (status === 'failed' && attempt === 1 && r.logTail.some((l) => NETWORK_ERROR.test(l))) {
      audit(user, 'app.deploy_retry', name, { reason: 'network error during build' });
      continue;
    }
    if (status === 'timeout') followUp(name, deployment, id, user, sha);
    else await settle(name, status, sha);
    audit(user, 'app.deploy', name, { source, status, sha, attempt });
    return { app: name, url: app.url, status, commit: sha ?? '', logTail: status === 'running' ? undefined : r.logTail } as const;
  }
}

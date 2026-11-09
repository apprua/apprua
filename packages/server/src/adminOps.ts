// Administrator operations, shared by the /v1/admin API (used by the MCP admin tools) and the portal admin section.
import { revokeToken } from './auth.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { audit, getApp, getDb, getUser, updateApp, type App } from './db.js';
import { engine } from './engine/index.js';
import * as repos from './repos.js';
import { stopForArchive } from './appOps.js';
import { exclusive } from './publish.js';

export function appOr404(name: string): App {
  const a = getApp(name);
  if (!a) throw new HttpError(404, `App "${name}" not found.`);
  return a;
}

function parseMemoryMb(m: string): number {
  const r = /^(\d+)\s*([mg])$/i.exec(m.trim());
  if (!r) throw new HttpError(400, 'Memory must look like "512m" or "1g".');
  return Number(r[1]) * (r[2].toLowerCase() === 'g' ? 1024 : 1);
}

/** Every app (also stopped and archived) with the info an admin needs. */
export function listAllApps() {
  return getDb().prepare(`SELECT name, owner, description, url, status, persistent, cpus, memory, created_at, last_deploy_at, review_at,
    (SELECT result FROM deploys WHERE app = apps.name ORDER BY id DESC LIMIT 1) AS last_deploy_result
    FROM apps ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'stopped' THEN 1 ELSE 2 END, name`).all();
}

export async function changeOwner(by: string, name: string, newOwner: string) {
  const a = appOr404(name);
  const owner = newOwner.trim().toLowerCase();
  if (owner === a.owner) throw new HttpError(400, `${owner} is already the owner of ${name}.`);
  if (!getUser(owner)) throw new HttpError(400, `${owner} has no account on ${config.publicUrl}: create it (or ask them to sign in once), then retry.`);
  updateApp(a.name, { owner });
  if (a.engine_id) await engine().applyLabels(a.engine_id, a.name, owner);
  audit(by, 'admin.owner', a.name, { from: a.owner, to: owner });
  return { app: a.name, owner, previous_owner: a.owner };
}

export async function setLimits(by: string, name: string, cpusIn?: string, memoryIn?: string) {
  const a = appOr404(name);
  const cpus = cpusIn ?? a.cpus, memory = memoryIn ?? a.memory;
  if (!(Number(cpus) > 0 && Number(cpus) <= config.policy.maxCpus)) throw new HttpError(400, `CPUs must be between 0 and ${config.policy.maxCpus}.`);
  if (parseMemoryMb(memory) > config.policy.maxMemoryMb) throw new HttpError(400, `Memory must be at most ${config.policy.maxMemoryMb} MB.`);
  if (a.engine_id) await engine().updateApp(a.engine_id, { cpus, memory });
  // a new memory limit: "ran out of memory" is about the old one
  updateApp(a.name, { cpus, memory, ...(memory !== a.memory ? { oom_at: null } : {}) });
  audit(by, 'admin.limits', a.name, { cpus, memory });
  return { app: a.name, cpus, memory, note: 'Applied at the next deploy or restart.' };
}

export function setReview(by: string, name: string, reviewAt: string) {
  const a = appOr404(name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewAt)) throw new HttpError(400, 'review_at must be YYYY-MM-DD.');
  updateApp(a.name, { review_at: reviewAt });
  audit(by, 'admin.review', a.name, { review_at: reviewAt });
  return { app: a.name, review_at: reviewAt };
}

export async function restoreApp(by: string, name: string) {
  const a = appOr404(name);
  if (a.status === 'active') throw new HttpError(409, 'The app is already online.');
  return exclusive(a.name, async () => {
    if (a.engine_id) await engine().start(a.engine_id);
    updateApp(a.name, { status: 'active' });
    audit(by, 'admin.restore', a.name, { from: a.status });
    return { app: a.name, status: 'active' };
  });
}

/** Stops the app and hides it from the catalog; code and data are kept (restore with restoreApp). */
export async function archiveApp(by: string, name: string) {
  const a = appOr404(name);
  if (a.status === 'archived') throw new HttpError(409, 'The app is already archived.');
  // not while it is being published: the end of that publication would start it again
  return exclusive(a.name, async () => {
    if (a.engine_id) await stopForArchive(a.engine_id);
    updateApp(a.name, { status: 'archived' });
    audit(by, 'admin.archive', a.name, { owner: a.owner });
    return { app: a.name, status: 'archived' };
  });
}

/** Deletes container and data volume; the code is moved aside (repos/.deleted). Irreversible for the data. */
export async function deleteAppPermanently(by: string, name: string, confirm: string) {
  const a = appOr404(name);
  if (confirm !== a.name) throw new HttpError(400, `Permanent deletion: confirm by repeating the app name exactly ("${a.name}").`);
  return exclusive(a.name, () => deleteNow(by, a));
}

async function deleteNow(by: string, a: App) {
  if (a.engine_id) await engine().deleteApp(a.engine_id).catch((e) => { if (!String(e.message).includes('404')) throw e; });
  await repos.removeRepo(a.name);
  getDb().prepare('DELETE FROM deploys WHERE app = ?').run(a.name);
  getDb().prepare('DELETE FROM apps WHERE name = ?').run(a.name);
  audit(by, 'admin.delete', a.name, { owner: a.owner });
  return { app: a.name, deleted: true, note: 'Container and data deleted. A copy of the code is kept in the data folder (repos/.deleted).' };
}

export function listUsers() {
  return getDb().prepare(`SELECT email, name, role, token_prefix, token_expires_at, quota, created_at, revoked_at, disabled_at,
    password_hash IS NOT NULL AS has_password,
    (SELECT COUNT(*) FROM apps WHERE owner = users.email AND status != 'archived') AS active_apps
    FROM users ORDER BY email`).all();
}

export function revokeUserToken(by: string, emailIn: string) {
  const email = emailIn.toLowerCase();
  if (!getUser(email)) throw new HttpError(404, 'Unknown user.');
  revokeToken(email, by);
  return { email, revoked: true };
}

export function setQuota(by: string, emailIn: string, quota: number) {
  const email = emailIn.toLowerCase();
  if (!getUser(email)) throw new HttpError(404, 'Unknown user.');
  if (!Number.isInteger(quota) || quota < 0 || quota > 500) throw new HttpError(400, 'Quota must be an integer 0-500.');
  getDb().prepare('UPDATE users SET quota = ? WHERE email = ?').run(quota, email);
  audit(by, 'admin.quota', null, { email, quota });
  return { email, quota };
}

/** Monthly report: apps due for review, apps stopped > 60 days, inventory, failed deploys. */
export function report() {
  const db = getDb();
  return {
    generated_at: new Date().toISOString(),
    review_due: db.prepare(`SELECT name, owner, review_at FROM apps WHERE status != 'archived' AND review_at IS NOT NULL AND review_at <= date('now', '+30 days') ORDER BY review_at`).all(),
    stopped_over_60_days: db.prepare(`SELECT name, owner, last_deploy_at FROM apps WHERE status = 'stopped' AND COALESCE(last_deploy_at, created_at) <= datetime('now', '-60 days')`).all(),
    inventory: db.prepare(`SELECT name, owner, status, persistent, cpus, memory, created_at, last_deploy_at, review_at FROM apps ORDER BY name`).all(),
    failed_deploys_30d: db.prepare(`SELECT app, COUNT(*) AS n FROM deploys WHERE result != 'running' AND started_at >= datetime('now', '-30 days') GROUP BY app`).all(),
  };
}

// Addresses of the apps follow the installation: when the network changes (only this computer, the local network,
// a domain), the apps already published move to the new address at the next start of Apprua.
import { appMiddleware, appUrl, config } from './config.js';
import { deleteSetting, getDb, getSetting, setSetting, updateApp, type App } from './db.js';
import { engine } from './engine/index.js';

/** Moves every app whose address is not the one this installation gives it, and puts the login in front of every
 *  app when it changed (e.g. the first time on the local network). Returns the apps changed. */
export async function moveAppsToCurrentAddresses(log: (msg: string) => void = () => {}): Promise<string[]> {
  const apps = getDb().prepare(`SELECT * FROM apps WHERE engine_id IS NOT NULL`).all() as unknown as App[];
  const moved: string[] = [];
  const mw = appMiddleware();
  // the labels change with the login in front of the apps and with the certificate (yours or Let's Encrypt)
  const sig = mw + (config.https === 'own' ? '|own-cert' : '');
  const relabel = (getSetting('app_middleware') ?? '') !== sig;
  for (const a of apps) {
    const url = appUrl(a.name);
    if (a.url === url && !relabel) continue;
    const e = engine();
    if (a.url !== url) await e.setUrl(a.engine_id!, url);
    await e.applyLabels(a.engine_id!, a.name, a.owner);   // the engine dropped them with the old address
    if (a.status === 'active') await e.restart(a.engine_id!); // the new routing applies when the app starts again
    updateApp(a.name, { url });
    log(a.url !== url ? `app ${a.name}: ${a.url} -> ${url}` : `app ${a.name}: login in front set to "${mw || 'none'}"`);
    moved.push(a.name);
  }
  if (relabel) setSetting('app_middleware', sig);
  return moved;
}

/** At start: the engine may still be starting, so it tries again for a few minutes. */
export function scheduleAddressMove(log: (msg: string) => void, tries = 10, waitMs = 30_000): void {
  const attempt = (left: number) => {
    moveAppsToCurrentAddresses(log).then(() => republishAfterRestore(log)).catch((e) => {
      log(`moving apps to the new addresses failed: ${(e as Error).message}${left > 1 ? ' (trying again)' : ''}`);
      if (left > 1) setTimeout(() => attempt(left - 1), waitMs).unref();
    });
  };
  attempt(tries);
}

/** After a restore (install/backup.sh --restore) the engine has its data back but not the containers of the apps:
 *  every app that was online is published again from the code archive. Once per restore (APPRUA_REPUBLISH is a new
 *  value each time), not at every start. */
export async function republishAfterRestore(log: (msg: string) => void = () => {}): Promise<string[]> {
  const mark = process.env.APPRUA_REPUBLISH ?? '';
  if (!mark || getSetting('republished') === mark) return [];
  const { exclusive, runDeploy } = await import('./publish.js');
  const { headCommit } = await import('./repos.js');
  // Which apps are already done for this restore: a start that stops halfway goes on from there at the next start
  const key = `republished:${mark}`;
  const already = new Set((getSetting(key) ?? '').split(',').filter(Boolean));
  const apps = getDb().prepare(`SELECT * FROM apps WHERE engine_id IS NOT NULL AND status = 'active'`).all() as unknown as App[];
  // How many starts already tried each app: a publication that fails or runs out of time is tried again at the next
  // start, up to MAX_TRIES; then it is left as failed (the portal shows it, with the button to publish it again).
  const MAX_TRIES = 3;
  const triesKey = `republish-tries:${mark}`;
  const tries: Record<string, number> = JSON.parse(getSetting(triesKey) ?? '{}');
  const done: string[] = [];
  let left = 0;
  for (const a of apps.filter((x) => !already.has(x.name))) {
    tries[a.name] = (tries[a.name] ?? 0) + 1;
    setSetting(triesKey, JSON.stringify(tries));
    let ok = false, why = '';
    try {
      const r = await exclusive(a.name, async () => runDeploy(a.name, 'apprua-restore', 'manual', await headCommit(a.name)));
      ok = r.status === 'running';
      why = r.status;
    } catch (e) { why = (e as Error).message; }
    if (ok) {
      log(`app ${a.name}: published again after the restore`);
      already.add(a.name); setSetting(key, [...already].join(','));
      done.push(a.name);
    } else if (tries[a.name] >= MAX_TRIES) {
      log(`app ${a.name}: could not be published again after the restore (${why}), ${MAX_TRIES} times: left as failed, publish it again from the portal`);
      already.add(a.name); setSetting(key, [...already].join(','));
    } else {
      left++;
      log(`app ${a.name}: could not be published again after the restore (${why}), tried again at the next start`);
    }
  }
  if (!left) { setSetting('republished', mark); deleteSetting(key); deleteSetting(triesKey); }
  return done;
}

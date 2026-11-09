// Apps that are on but not answering: every 2 minutes Apprua asks the engine whether each app that is on is running.
// An app found stopped, crashed or missing gets down_since; the portal shows it as "Not answering" after 2 minutes
// (a restart in progress is not an alarm) and, with email, its owner gets one message after 5 minutes.
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { audit, getDb, getSetting, setSetting, updateApp, type App } from './db.js';
import { engine } from './engine/index.js';
import { t } from './i18n.js';
import { mailEnabled, sendMail } from './notify.js';

export const SHOW_AFTER_MS = 2 * 60_000;
const MAIL_AFTER_MS = 5 * 60_000;

/** "running", "running:healthy" and the like are fine; exited, dead, restarting or unknown to the engine are not. */
export const answering = (status: string | null) => !!status && /^running/.test(status) && !/unhealthy/.test(status);

/** Whether the portal shows the app as not answering (on, found down for longer than SHOW_AFTER_MS). */
export const isDown = (a: Pick<App, 'status' | 'down_since'>, now = Date.now()) =>
  a.status === 'active' && !!a.down_since && now - Date.parse(a.down_since) > SHOW_AFTER_MS;

export async function checkApps(now = Date.now()): Promise<void> {
  // apps that are on, published at least once, and not being published right now
  const apps = getDb().prepare(`SELECT * FROM apps WHERE status = 'active' AND engine_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM deploys d WHERE d.app = apps.name AND d.result IS NULL)`).all() as unknown as App[];
  for (const a of apps) {
    let status: string | null;
    try { status = await engine().runtimeStatus(a.engine_id!); } catch { return; }   // the engine does not answer: no verdict
    if (answering(status)) {
      if (a.down_since) { updateApp(a.name, { down_since: null }); audit('system', 'app.up_again', a.name, null); }
      continue;
    }
    if (!a.down_since) {
      updateApp(a.name, { down_since: new Date(now).toISOString() });
      audit('system', 'app.down', a.name, { status });
      continue;
    }
    if (mailEnabled() && now - Date.parse(a.down_since) > MAIL_AFTER_MS
        && getDb().prepare('INSERT OR IGNORE INTO notifications (key) VALUES (?)').run(`down:${a.name}:${a.down_since}`).changes > 0) {
      const L = config.defaultLang;
      await sendMail([a.owner], t(L, 'mail.down.subject', { app: a.name }),
        t(L, 'mail.down.body', { app: a.name, url: a.url, portal: config.publicUrl }) + `\n\n--\n${config.brand} · ${config.publicUrl}`)
        .catch((e) => console.error('[monitor] email', a.name, (e as Error).message));
    }
  }
}

/** How long the portal keeps saying "ran out of memory" (unless the memory or the version changes first). */
export const OOM_SHOWN_MS = 7 * 86_400_000;

/** Whether the portal shows that the app ran out of its memory recently. */
export const outOfMemory = (a: Pick<App, 'status' | 'oom_at'>, now = Date.now()) =>
  a.status !== 'archived' && !!a.oom_at && now - Date.parse(a.oom_at) < OOM_SHOWN_MS;

/** The "oom" events written by apprua-guard: one line "<ISO time> <engine id>" for each time Docker found an app
 *  over its memory limit (the app is stopped, or one of its processes, and Docker starts it again). */
export function readOomEvents(file = config.oomFile): { at: string; id: string }[] {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }   // no guard on this machine, or nothing yet
  return text.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2 && !isNaN(Date.parse(p[0])) && /^[\w-]+$/.test(p[1]))
    .map(([at, id]) => ({ at: new Date(at).toISOString(), id }));
}

/** Marks the apps that ran out of memory since the last look (a cursor in the settings), and tells the owner once. */
export async function checkMemory(file = config.oomFile): Promise<void> {
  const since = getSetting('oom_seen') ?? '';
  const events = readOomEvents(file).filter((e) => e.at > since);
  if (!events.length) return;
  setSetting('oom_seen', events.reduce((m, e) => (e.at > m ? e.at : m), since));
  for (const e of events) {
    const a = getDb().prepare(`SELECT * FROM apps WHERE engine_id = ? AND status != 'archived'`).get(e.id) as unknown as App | undefined;
    // an event older than the last version is about the old one
    if (!a || (a.oom_at && a.oom_at >= e.at) || (a.last_deploy_at && a.last_deploy_at > e.at)) continue;
    const first = !a.oom_at;
    updateApp(a.name, { oom_at: e.at });
    audit('system', 'app.out_of_memory', a.name, { memory: a.memory });
    if (first && mailEnabled()) {
      const L = config.defaultLang;
      await sendMail([a.owner], t(L, 'mail.oom.subject', { app: a.name }),
        t(L, 'mail.oom.body', { app: a.name, mem: a.memory.replace(/m$/i, ' MB').replace(/g$/i, ' GB'), portal: `${config.publicUrl}/portal/apps/${a.name}` }) + `\n\n--\n${config.brand} · ${config.publicUrl}`)
        .catch((err) => console.error('[monitor] email', a.name, (err as Error).message));
    }
  }
}

/** First check a minute after start, then every 2 minutes. */
export function scheduleMonitor(): void {
  const run = () => void Promise.all([checkApps(), checkMemory()]).catch((e) => console.error('[monitor]', (e as Error).message));
  setTimeout(run, 60_000).unref();
  setInterval(run, 2 * 60_000).unref();
}

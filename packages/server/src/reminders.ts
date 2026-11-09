// Reminders by email (only when email is configured): personal tokens about to expire and, for the "team"
// profile, app review dates (notify the owner; stop the app 30 days after an unconfirmed review date).
import { config } from './config.js';
import { audit, getDb, updateApp, type App, type User } from './db.js';
import { engine } from './engine/index.js';
import { exclusive } from './publish.js';
import { t } from './i18n.js';
import { mailEnabled, sendMail } from './notify.js';

const DAY = 86_400_000;
const daysUntil = (iso: string) => Math.ceil((Date.parse(iso) - Date.now()) / DAY);
const L = () => config.defaultLang;
const sign = () => `\n\n--\n${config.brand} · ${config.publicUrl}`;

/** Whether that reminder was already sent, without marking it. */
const sent = (key: string) => !!getDb().prepare('SELECT 1 FROM notifications WHERE key = ?').get(key);

/** Sends each reminder only once (key = what + who + threshold). */
function once(key: string): boolean {
  return getDb().prepare('INSERT OR IGNORE INTO notifications (key) VALUES (?)').run(key).changes > 0;
}

async function tokenReminders() {
  const users = getDb().prepare(`SELECT * FROM users WHERE token_hash IS NOT NULL AND token_expires_at IS NOT NULL`).all() as unknown as User[];
  for (const u of users) {
    const d = daysUntil(u.token_expires_at!);
    const step = d <= 0 ? 0 : d <= 3 ? 3 : d <= 14 ? 14 : null;
    if (step === null || !once(`token:${u.email}:${u.token_expires_at}:${step}`)) continue;
    await sendMail([u.email], t(L(), d <= 0 ? 'mail.token_expired.subject' : 'mail.token_expiring.subject'),
      t(L(), 'mail.token.body', { date: u.token_expires_at!.slice(0, 10), days: d, url: config.publicUrl }) + sign());
  }
}

async function reviewReminders() {
  if (config.policy.reviewMonths <= 0) return;
  const apps = getDb().prepare(`SELECT * FROM apps WHERE status != 'archived' AND review_at IS NOT NULL`).all() as unknown as App[];
  for (const a of apps) {
    const d = daysUntil(`${a.review_at}T00:00:00Z`);
    if (d <= -30 && a.status === 'active') {
      const key = `review:${a.name}:${a.review_at}:stop`;
      if (sent(key)) continue;
      // stopped for real first (with the same reservation as publishing): if the engine does not stop it, nothing is
      // recorded and no email goes out, and it is tried again at the next round (every 6 hours)
      if (a.engine_id) {
        try { await exclusive(a.name, () => engine().stop(a.engine_id!)); }
        catch (e) { console.error('[reminders] stop', a.name, e); continue; }
      }
      if (!once(key)) continue;
      updateApp(a.name, { status: 'stopped' });
      audit('system', 'app.review_stop', a.name, { review_at: a.review_at });
      await sendMail([a.owner], t(L(), 'mail.review_stop.subject', { app: a.name }),
        t(L(), 'mail.review_stop.body', { app: a.name, url: a.url, date: a.review_at!, portal: config.publicUrl }) + sign());
      continue;
    }
    const step = d <= 0 ? 0 : d <= 7 ? 7 : d <= 30 ? 30 : null;
    if (step === null || !once(`review:${a.name}:${a.review_at}:${step}`)) continue;
    await sendMail([a.owner], t(L(), 'mail.review.subject', { app: a.name }),
      t(L(), 'mail.review.body', { app: a.name, url: a.url, date: a.review_at!, days: d, portal: config.publicUrl, months: config.policy.reviewMonths }) + sign());
  }
}

export async function runReminders(): Promise<void> {
  if (!mailEnabled()) return;
  try { await tokenReminders(); } catch (e) { console.error('[reminders] tokens', e); }
  try { await reviewReminders(); } catch (e) { console.error('[reminders] reviews', e); }
}

/** Runs once shortly after start, then every 6 hours (each reminder is sent only once). */
export function scheduleReminders(): void {
  setTimeout(() => void runReminders(), 60_000).unref();
  setInterval(() => void runReminders(), 6 * 3_600_000).unref();
}

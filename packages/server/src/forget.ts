// Removing a person's account on request (for example under the GDPR): the account goes, and the email is replaced in
// the history of Apprua (audit rows and publications) by a random label (the rest of the history, such as IP addresses, stays as it is). Run by an administrator of the machine:
//   sudo bash install/remove-account.sh <email>    (it runs: node dist/src/cli/admin.js forget <email>)
// Apps are never removed here: the ones that still belong to the account must first get another owner, or be deleted.
import { randomBytes } from 'node:crypto';
import { audit, getDb, getUser } from './db.js';

export function forgetUser(email: string): { removed: string; label: string } {
  const e = email.trim().toLowerCase();
  const u = getUser(e);
  if (!u) throw new Error(`There is no account ${e}.`);
  const db = getDb();
  const apps = (db.prepare('SELECT name FROM apps WHERE owner = ? ORDER BY name').all(e) as { name: string }[]).map((a) => a.name);
  if (apps.length)
    throw new Error(`These apps still belong to ${e}: ${apps.join(', ')}. Give them to someone else (an administrator asks the AI app, which uses admin_change_owner) or delete them for good (Settings), then run this again.`);
  if (u.role === 'admin') {
    const others = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND email <> ? AND disabled_at IS NULL").get(e) as { n: number }).n;
    if (!others) throw new Error(`${e} is the only administrator: make someone else an administrator first.`);
  }
  const label = `removed-${randomBytes(4).toString('hex')}`;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM password_resets WHERE email = ?').run(e);
    db.prepare('UPDATE audit SET user = ? WHERE lower(user) = ?').run(label, e);
    // only values that are exactly this address (in any case): never a piece of another one (ann@ inside joann@)
    const rows = db.prepare("SELECT id, details FROM audit WHERE lower(details) LIKE '%' || ? || '%'").all(e) as { id: number; details: string }[];
    const swap = (v: unknown): unknown =>
      typeof v === 'string' ? (v.trim().toLowerCase() === e ? label : v)
        : Array.isArray(v) ? v.map(swap)
          : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v;
    const update = db.prepare('UPDATE audit SET details = ? WHERE id = ?');
    for (const r of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(r.details); } catch { continue; }   // Apprua always writes JSON here
      const next = JSON.stringify(swap(parsed));
      if (next !== r.details) update.run(next, r.id);
    }
    db.prepare('UPDATE deploys SET user = ? WHERE lower(user) = ?').run(label, e);
    db.prepare('DELETE FROM users WHERE email = ?').run(e);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  audit(null, 'user.forget', null, { account: label });
  return { removed: e, label };
}

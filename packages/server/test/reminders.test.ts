// The stop after an unconfirmed review date: recorded only when the engine really stopped the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// a mail server that hangs up at once: the reminders try to send, fail fast, and the test looks at what was recorded
const smtp = createServer((s) => s.destroy());
await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
const port = (smtp.address() as { port: number }).port;
Object.assign(process.env, {
  DATA_DIR: await mkdtemp(join(tmpdir(), 'apd-rem-')), SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_FROM: 'apprua@example.test',
});
const db = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { setEngine } = await import('../src/engine/index.js');
const { runReminders } = await import('../src/reminders.js');

test('a failed stop is not recorded and is tried again; a stop that works is recorded once', async () => {
  db.openDb(':memory:');
  config.policy.reviewMonths = 12;
  db.upsertUser('owner@example.test', 'Owner', 'user');
  db.getDb().prepare(`INSERT INTO apps (name, owner, description, url, status, build_pack, cpus, memory, engine_id, review_at)
    VALUES ('old-app', 'owner@example.test', '', 'http://old-app.localhost', 'active', 'static', '1', '512m', 'id-old', date('now', '-40 days'))`).run();
  let stops = 0, works = false;
  setEngine({ name: 'fake', stop: async () => { stops++; if (!works) throw new Error('engine not answering'); } } as never);
  const sent = () => db.getDb().prepare(`SELECT COUNT(*) AS n FROM notifications WHERE key LIKE 'review:old-app:%:stop'`).get() as { n: number };

  await runReminders();
  assert.equal(stops, 1);
  assert.equal(db.getApp('old-app')!.status, 'active', 'not marked stopped when the engine did not stop it');
  assert.equal(sent().n, 0, 'and not recorded as done');

  works = true;
  await runReminders();
  assert.equal(stops, 2, 'tried again');
  assert.equal(db.getApp('old-app')!.status, 'stopped');
  assert.equal(sent().n, 1);

  await runReminders();
  assert.equal(stops, 2, 'only once');
  smtp.close();
});

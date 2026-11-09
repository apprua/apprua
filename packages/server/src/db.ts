// App registry: users, apps, deploys, notifications, audit. SQLite (built into Node) in the data folder.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

export type Role = 'user' | 'admin';
export type AppStatus = 'active' | 'stopped' | 'archived';
/** Who can open an app (local network and internet; on "only this computer" nobody else can anyway):
 *  only the owner (and administrators), anyone with an account, or anyone. */
export type Visibility = 'private' | 'team' | 'public';
export const VISIBILITIES: Visibility[] = ['private', 'team', 'public'];

export interface User {
  email: string;
  name: string | null;
  role: Role;
  password_hash: string | null;
  token_hash: string | null;
  token_prefix: string | null;
  token_expires_at: string | null;
  quota: number | null;
  created_at: string;
  revoked_at: string | null;
  disabled_at: string | null;
  /** Last time the personal token was used by an AI app (shows "AI connected" in the portal). */
  token_used_at: string | null;
  /** Changed at every sign-out: the portal sessions and the cookies of the apps signed with the old one stop working. */
  session_gen: string | null;
}

export interface App {
  name: string;
  owner: string;
  description: string;
  /** Id of the app inside the engine (e.g. the Coolify application uuid). */
  engine_id: string | null;
  url: string;
  status: AppStatus;
  persistent: number;
  port: number | null;
  build_pack: string;
  cpus: string;
  memory: string;
  last_commit: string | null;
  created_at: string;
  last_deploy_at: string | null;
  /** Next review date (YYYY-MM-DD), or null when reviews are disabled. */
  review_at: string | null;
  visibility: Visibility;
  /** When the engine was first found not running an app that is on (cleared when it runs again): see monitor.ts. */
  down_since?: string | null;
  /** The last time the app ran out of its memory (seen by apprua-guard): cleared by a new memory limit or a new version. */
  oom_at?: string | null;
}

let db: DatabaseSync;

export function openDb(path = join(config.dataDir, 'apprua.db')): DatabaseSync {
  if (path !== ':memory:') mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      password_hash TEXT,
      token_hash TEXT UNIQUE,
      token_prefix TEXT,
      token_expires_at TEXT,
      quota INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      disabled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS apps (
      name TEXT PRIMARY KEY,
      owner TEXT NOT NULL REFERENCES users(email),
      description TEXT NOT NULL,
      engine_id TEXT,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      persistent INTEGER NOT NULL DEFAULT 0,
      port INTEGER,
      build_pack TEXT NOT NULL,
      cpus TEXT NOT NULL,
      memory TEXT NOT NULL,
      last_commit TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_deploy_at TEXT,
      review_at TEXT
    );
    CREATE TABLE IF NOT EXISTS deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app TEXT NOT NULL REFERENCES apps(name),
      user TEXT NOT NULL,
      source TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      result TEXT,
      commit_sha TEXT,
      engine_deployment TEXT,
      log_excerpt TEXT
    );
    CREATE TABLE IF NOT EXISTS notifications (
      key TEXT PRIMARY KEY,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      user TEXT,
      action TEXT NOT NULL,
      app TEXT,
      details TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- "Forgot your password?": one-time links sent by email (stored as SHA-256, valid one hour)
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL REFERENCES users(email),
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
  `);
  // Columns added after v0.1 (existing databases get them on start-up)
  const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
  if (!userCols.includes('token_used_at')) db.exec('ALTER TABLE users ADD COLUMN token_used_at TEXT');
  if (!userCols.includes('session_gen')) db.exec('ALTER TABLE users ADD COLUMN session_gen TEXT');
  // when Apprua asked the engine to publish: with no deployment id saved, the outcome is unknown (see publish.ts)
  const deployCols = (db.prepare('PRAGMA table_info(deploys)').all() as { name: string }[]).map((c) => c.name);
  if (!deployCols.includes('requested_at')) db.exec('ALTER TABLE deploys ADD COLUMN requested_at TEXT');
  const appCols = (db.prepare('PRAGMA table_info(apps)').all() as { name: string }[]).map((c) => c.name);
  if (!appCols.includes('visibility')) db.exec(`ALTER TABLE apps ADD COLUMN visibility TEXT NOT NULL DEFAULT 'team'`);
  if (!appCols.includes('down_since')) db.exec('ALTER TABLE apps ADD COLUMN down_since TEXT');
  if (!appCols.includes('oom_at')) db.exec('ALTER TABLE apps ADD COLUMN oom_at TEXT');
  return db;
}

/** Settings chosen in the portal (first-run setup), kept in the database. */
export const getSetting = (key: string): string | null =>
  (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
export const deleteSetting = (key: string): void => { getDb().prepare('DELETE FROM settings WHERE key = ?').run(key); };

export function getDb(): DatabaseSync {
  if (!db) throw new Error('database not opened');
  return db;
}

export function audit(user: string | null, action: string, app: string | null, details?: unknown): void {
  getDb()
    .prepare('INSERT INTO audit (user, action, app, details) VALUES (?, ?, ?, ?)')
    .run(user, action, app, details === undefined ? null : JSON.stringify(details));
}

export function getUser(email: string): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as User | undefined;
}

export function countUsers(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function upsertUser(email: string, name: string | null, role: Role): User {
  getDb()
    .prepare(`INSERT INTO users (email, name, role) VALUES (?, ?, ?)
              ON CONFLICT(email) DO UPDATE SET name = COALESCE(excluded.name, users.name), role = excluded.role`)
    .run(email.toLowerCase(), name, role);
  return getUser(email)!;
}

export function getApp(name: string): App | undefined {
  return getDb().prepare('SELECT * FROM apps WHERE name = ?').get(name) as App | undefined;
}

export function countActiveApps(owner: string): number {
  const r = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM apps WHERE owner = ? AND status != 'archived'`)
    .get(owner) as { n: number };
  return r.n;
}

const APP_COLUMNS = new Set(['owner', 'description', 'engine_id', 'url', 'status', 'persistent', 'port', 'build_pack', 'cpus', 'memory', 'visibility',
  'last_commit', 'last_deploy_at', 'review_at', 'down_since', 'oom_at']);

export function updateApp(name: string, fields: Partial<App>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  for (const k of keys) if (!APP_COLUMNS.has(k)) throw new Error(`unknown app column ${k}`);
  const sql = `UPDATE apps SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE name = ?`;
  getDb().prepare(sql).run(...(keys.map((k) => (fields as Record<string, unknown>)[k]) as never[]), name);
}

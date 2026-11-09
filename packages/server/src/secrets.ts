// Instance secrets generated on first start and kept in the data folder (never in the code or the image).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

interface Secrets { session: string; git: string }
let cache: Secrets | null = null;

export function secrets(): Secrets {
  if (cache) return cache;
  const file = join(config.dataDir, 'secrets.json');
  let s: Partial<Secrets> = {};
  if (existsSync(file)) s = JSON.parse(readFileSync(file, 'utf8'));
  let changed = false;
  for (const k of ['session', 'git'] as const) {
    if (!s[k]) { s[k] = randomBytes(32).toString('base64url'); changed = true; }
  }
  if (changed) {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  }
  cache = s as Secrets;
  return cache;
}

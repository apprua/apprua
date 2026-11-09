// First-run setup ("who is this Apprua for?": just me / a group of people) and the Settings page rules.
// The choices are stored in the database and applied at once, and again at every start.
import { timingSafeEqual } from 'node:crypto';
import { applyProfile, config, envSet, MEMORY_CHOICES } from './config.js';
import { deleteSetting, getSetting, setSetting } from './db.js';

export { MEMORY_CHOICES };
export type Profile = 'personal' | 'team';
/** memory: "auto" (Apprua chooses from the memory of the machine) or a size like "512m". */
export interface Rules { quota?: number; reviewMonths?: number; memory?: string }
export interface SetupChoice extends Rules { profile: Profile }

const num = (v: string | null) => (v === null || Number.isNaN(Number(v)) ? undefined : Number(v));

function storedRules(): Rules {
  return { quota: num(getSetting('quota')), reviewMonths: num(getSetting('review_months')), memory: getSetting('app_memory') ?? undefined };
}

/** At start: applies what was chosen in the setup (if anything), otherwise the profile from the environment stays. */
export function loadStoredSettings(): void {
  const p = getSetting('profile');
  if (p === 'personal' || p === 'team') applyProfile(p, storedRules());
}

function store(r: Rules): void {
  if (r.quota !== undefined) setSetting('quota', String(r.quota));
  if (r.reviewMonths !== undefined) setSetting('review_months', String(r.reviewMonths));
  if (r.memory !== undefined) setSetting('app_memory', r.memory);
}

export function saveSetup(c: SetupChoice): void {
  setSetting('profile', c.profile);
  store(c);
  applyProfile(c.profile, c);
}

/** Settings > Rules: keeps the profile, changes only the rules given. */
export function saveRules(r: Rules): void {
  setSetting('profile', config.profile);
  store(r);
  applyProfile(config.profile, storedRules());
}

/** Settings > Use: a new profile starts again from its own default rules. */
export function changeProfile(p: Profile): void {
  for (const k of ['quota', 'review_months', 'app_memory']) deleteSetting(k);
  setSetting('profile', p);
  applyProfile(p);
}

/** Rules fixed by the installation (environment variables): shown, but not changeable in the portal. */
export const lockedRules = () => ({ quota: envSet('DEFAULT_QUOTA'), reviewMonths: envSet('REVIEW_MONTHS'), memory: envSet('DEFAULT_MEMORY') });

/** Group rules from the setup form, kept within sensible limits. */
export function parseRules(quota: unknown, review: unknown): { quota: number; reviewMonths: number } {
  const q = Math.round(Number(quota));
  const r = Number(review);
  return { quota: Number.isFinite(q) && q >= 1 ? Math.min(q, 100) : 5, reviewMonths: [0, 6, 12].includes(r) ? r : 6 };
}

/** Memory for each new app, from the Settings form ("auto", or one of the choices within the maximum). */
export function parseMemory(v: unknown): string | undefined {
  const s = String(v ?? '').toLowerCase();
  if (s === 'auto') return s;
  const mb = (m: string) => Number(m.slice(0, -1)) * (m.endsWith('g') ? 1024 : 1);
  return MEMORY_CHOICES.includes(s) && mb(s) <= config.policy.maxMemoryMb ? s : undefined;
}

/** The setup page asks for the one-time code printed by the installer (when there is one). */
export function checkSetupCode(given: unknown): boolean {
  const want = config.auth.setupCode.trim().toUpperCase();
  if (!want) return true;
  const a = Buffer.from(String(given ?? '').trim().toUpperCase());
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Back to the profile of the environment (used by tests to simulate a fresh start). */
export const applyProfileReset = () => applyProfile((process.env.APPRUA_PROFILE as Profile) || 'personal');

/** The choice suggested on the first page: a portal on localhost is used by one person. */
export const suggestedProfile = (): Profile => (config.baseDomain === 'localhost' ? 'personal' : 'team');

// Apprua configuration. Everything comes from environment variables, with defaults that work
// for a single person on their own PC ("personal" profile, apps on http://<name>.localhost).
import { totalmem } from 'node:os';

/** Memory an app can get: the choices offered in Settings and on the page of each app (up to the ceiling below). */
export const MEMORY_CHOICES = ['256m', '512m', '1g', '2g', '4g', '8g', '16g', '32g'];
const mb = (m: string) => Number(m.slice(0, -1)) * (m.endsWith('g') ? 1024 : 1);

/** "Automatic" memory for each new app: the largest choice (from 512 MB, at most 2 GB) that still lets at least
 *  8 apps stay on together, after 2 GB kept for the platform. 8 GB machine: 512 MB; 16 GB: 1 GB; 32 GB: 2 GB. */
export function autoAppMemory(totalMb = totalmem() / 1048576, maxMb = 2048): string {
  const room = (totalMb - 2048) / 8;
  const fits = MEMORY_CHOICES.filter((m) => mb(m) >= 512 && mb(m) <= Math.min(room, maxMb, 2048));
  return fits[fits.length - 1] ?? '512m';
}

/** The most memory one app can get, from the memory of the machine: about half of what is left after the 2 GB
 *  kept for the platform, so one big app never takes it all. 8 GB: 2 GB; 16 GB: 4 GB; 32 GB: 8 GB; 64 GB: 16 GB. */
export function maxAppMemoryMb(totalMb = totalmem() / 1048576): number {
  const half = (totalMb - 2048) / 2;
  const fits = MEMORY_CHOICES.filter((m) => mb(m) <= half);
  return Math.max(1024, mb(fits[fits.length - 1] ?? '1g'));
}

function num(name: string, def: number): number {
  const v = process.env[name];
  return v ? Number(v) : def;
}
const str = (name: string, def = '') => process.env[name] ?? def;

/** Reads a variable that is needed only when a feature is used (so tests and the CLI start without it). */
export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

/** Who can open the portal and the apps: only this computer, the local network (a name the user's network knows),
 *  or the internet (a domain). Names and certificates are the user's: Apprua never provides or depends on a service for them. */
export type Network = 'local' | 'lan' | 'internet';
/** HTTPS: none (this computer, or the local network without a certificate), Let's Encrypt (internet), or the
 *  certificate the user gave to the installer (local network or internet). */
export type Https = 'off' | 'letsencrypt' | 'own';
const baseDomain = str('BASE_DOMAIN', 'localhost');
const onLocalhost = baseDomain === 'localhost' || baseDomain.endsWith('.localhost');
const givenNetwork = str('APPRUA_NETWORK') as Network | '';
const givenScheme = str('APP_SCHEME');
const network: Network = givenNetwork || (onLocalhost ? 'local' : givenScheme === 'http' ? 'lan' : 'internet');
// On this computer HTTPS is not needed: browsers treat localhost as secure
const https: Https = network === 'local' ? 'off'
  : (str('APPRUA_HTTPS') as Https | '') || (givenScheme === 'http' ? 'off' : network === 'internet' ? 'letsencrypt' : givenScheme === 'https' ? 'own' : 'off');
const appScheme = givenScheme || (https === 'off' ? 'http' : 'https');
const profile = str('APPRUA_PROFILE', 'personal') as 'personal' | 'team';

export const config = {
  port: num('PORT', 3000),
  gitPort: num('GIT_PORT', 3001),
  /** Page shown by the engine's proxy at app addresses where no app answers (paused, missing, starting). */
  signpostPort: num('SIGNPOST_PORT', 3002),
  dataDir: str('DATA_DIR', '/data'),
  brand: str('APPRUA_BRAND', 'Apprua'),
  profile,
  baseDomain,
  appScheme,
  network,
  https,
  /** Address of this computer on the local network (given by the installer): the names must point there. */
  lanIp: str('APPRUA_LAN_IP'),
  /** The engine's proxy on the Docker network, asked directly to read the certificate it serves. */
  proxyHost: str('APPRUA_PROXY_HOST', 'coolify-proxy'),
  /** Where apprua-guard (on the machine) writes the apps that ran out of memory: a line "<time> <engine id>" each. */
  oomFile: str('APPRUA_OOM_FILE', '/apprua-host/oom.log'),
  /** Address of this portal as users see it (used in links and same-origin checks). */
  publicUrl: str('PUBLIC_URL', `http://localhost:${num('PORT', 3000)}`).replace(/\/+$/, ''),
  /** Language of the portal when the browser does not say: "en" or "it". */
  defaultLang: str('DEFAULT_LANG', 'en') as 'en' | 'it',

  auth: {
    /** "local": accounts with email + password stored by Apprua. "proxy": trust identity headers set by a
     *  login proxy in front of the portal (e.g. oauth2-proxy with any OIDC provider), only with the shared secret. */
    mode: str('AUTH_MODE', 'local') as 'local' | 'proxy',
    proxySecret: str('AUTH_PROXY_SECRET'),
    proxySecretHeader: str('AUTH_PROXY_SECRET_HEADER', 'x-apprua-proxy-secret').toLowerCase(),
    emailHeader: str('AUTH_EMAIL_HEADER', 'x-auth-request-email').toLowerCase(),
    nameHeader: str('AUTH_NAME_HEADER', 'x-auth-request-preferred-username').toLowerCase(),
    groupsHeader: str('AUTH_GROUPS_HEADER', 'x-auth-request-groups').toLowerCase(),
    adminGroup: str('AUTH_ADMIN_GROUP'),
    /** Optional first admin created at start (used by the installer, so nobody has to race a setup page). */
    initialAdminEmail: str('INITIAL_ADMIN_EMAIL'),
    initialAdminPassword: str('INITIAL_ADMIN_PASSWORD'),
    /** One-time code asked by the first-run setup page (server installs: nobody else can take over a new portal). */
    setupCode: str('SETUP_CODE'),
    sessionDays: num('SESSION_DAYS', 14),
  },

  engine: {
    type: str('ENGINE', 'coolify') as 'coolify',
    /** Optional reverse-proxy middleware that puts a login in front of every app (team/company installs). */
    appAuthMiddleware: str('APP_AUTH_MIDDLEWARE'),
    /** The installer wrote the proxy middleware "apprua-auth" that asks Apprua's gate who can open each app
     *  (local network and internet). Ignored when APP_AUTH_MIDDLEWARE puts another login in front of the apps. */
    gate: str('APPRUA_GATE') === '1',
    autoBuildpack: str('AUTO_BUILDPACK', 'nixpacks') as 'nixpacks' | 'railpack',
  },

  /** Built-in code archive: one bare git repository per app, served read-only to the engine. */
  git: {
    /** How the engine's build containers reach Apprua's git server (Docker network name + port). */
    internalUrl: str('GIT_INTERNAL_URL', `http://apprua:${num('GIT_PORT', 3001)}`).replace(/\/+$/, ''),
  },

  policy: {
    maxArchiveBytes: num('MAX_ARCHIVE_MB', 50) * 1024 * 1024,
    maxExtractedBytes: num('MAX_EXTRACTED_MB', 300) * 1024 * 1024,
    maxFiles: num('MAX_FILES', 20000),
    defaultQuota: num('DEFAULT_QUOTA', profile === 'personal' ? 50 : 5),
    defaultCpus: str('DEFAULT_CPUS', profile === 'personal' ? '1' : '0.5'),
    defaultMemory: str('DEFAULT_MEMORY', autoAppMemory(undefined, num('MAX_MEMORY_MB', maxAppMemoryMb()))),
    /** True when the memory of new apps is chosen by Apprua from the memory of the machine. */
    memoryAuto: !process.env.DEFAULT_MEMORY,
    maxCpus: Number(str('MAX_CPUS', '2')),
    /** The most memory one app can get: MAX_MEMORY_MB, or chosen from the memory of the machine (maxAppMemoryMb). */
    maxMemoryMb: num('MAX_MEMORY_MB', maxAppMemoryMb()),
    /** Months between app reviews; 0 disables reviews, reminders and automatic stops (default for "personal"). */
    reviewMonths: num('REVIEW_MONTHS', profile === 'personal' ? 0 : 6),
    tokenDays: num('TOKEN_DAYS', 90),
    deployTimeoutMs: num('DEPLOY_TIMEOUT_MIN', 10) * 60_000,
    reservedNames: str('RESERVED_NAMES', 'auth,git,coolify,apprua,deploy,www,api,admin,mail,smtp,vpn,status,test,platform').split(','),
  },
};

export type Config = typeof config;

export const envSet = (name: string) => !!process.env[name];

/** Applies a profile, and the choices made in the setup or in Settings, to the policy.
 *  Values set explicitly in the environment always win. */
export function applyProfile(p: 'personal' | 'team', choice: { quota?: number; reviewMonths?: number; memory?: string } = {}): void {
  config.profile = p;
  const pol = config.policy;
  if (!envSet('DEFAULT_QUOTA')) pol.defaultQuota = choice.quota ?? (p === 'personal' ? 50 : 5);
  if (!envSet('DEFAULT_CPUS')) pol.defaultCpus = p === 'personal' ? '1' : '0.5';
  if (!envSet('DEFAULT_MEMORY')) {
    const fixed = choice.memory && choice.memory !== 'auto' ? choice.memory : undefined;
    pol.memoryAuto = !fixed;
    pol.defaultMemory = fixed ?? autoAppMemory(undefined, pol.maxMemoryMb);
  }
  if (!envSet('REVIEW_MONTHS')) pol.reviewMonths = choice.reviewMonths ?? (p === 'personal' ? 0 : 6);
}

/** The proxy middleware in front of every app: another login (APP_AUTH_MIDDLEWARE), Apprua's gate, or none. */
export const appMiddleware = () => config.engine.appAuthMiddleware || (config.engine.gate ? 'apprua-auth@file' : '');

/** Public address of an app. */
export const appUrl = (name: string) => `${config.appScheme}://${name}.${config.baseDomain}`;

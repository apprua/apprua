// "Check" in Settings: do the names of the network lead to this computer, and is the certificate right?
// Names (DNS) and certificates are set up by the user: Apprua only looks and says what it sees, in plain words.
// Nothing here asks a service on the internet: only the DNS of this machine and the engine's own proxy.
import { randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { checkServerIdentity, connect, type PeerCertificate } from 'node:tls';
import { config } from './config.js';
import { getSetting, setSetting } from './db.js';

export type CheckState = 'ok' | 'warn' | 'bad';
/** One line of the check: an i18n key under "net.check." and its values. */
export interface CheckLine { state: CheckState; key: string; vars?: Record<string, string | number> }

/** A random id of this installation: the device check makes sure the answer comes from this Apprua. */
export function instanceId(): string {
  let id = getSetting('instance_id');
  if (!id) { id = randomBytes(12).toString('hex'); setSetting('instance_id', id); }
  return id;
}

async function lookup(name: string, resolve: (n: string) => Promise<string[]>): Promise<string[] | null> {
  try {
    const a = await Promise.race([resolve(name), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 4000))]);
    return a.length ? [...new Set(a)].sort() : null;
  } catch {
    return null;
  }
}
const sysResolve = async (n: string) => (await dns.lookup(n, { all: true, family: 4 })).map((r) => r.address);

export interface CertInfo { subject: string; issuer: string; validTo: Date; daysLeft: number; trusted: boolean; coversPortal: boolean; coversApps: boolean; placeholder: boolean }

/** The certificate the proxy serves for the portal, asked directly to the proxy (no DNS, no internet). */
export function readCertificate(host = config.proxyHost, domain = config.baseDomain, timeoutMs = 4000): Promise<CertInfo | null> {
  return new Promise((done) => {
    const s = connect({ host, port: 443, servername: `apprua.${domain}`, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const c = s.getPeerCertificate() as PeerCertificate;
      const trusted = s.authorized;
      s.end();
      if (!c || !c.valid_to) return done(null);
      const validTo = new Date(c.valid_to);
      const name = (c.subject?.CN as string) || String(c.subjectaltname ?? '').replace(/^DNS:/, '').split(',')[0] || '';
      done({
        subject: name,
        issuer: String((c.issuer?.O as string) || (c.issuer?.CN as string) || ''),
        validTo,
        daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
        trusted,
        coversPortal: checkServerIdentity(`apprua.${domain}`, c) === undefined,
        coversApps: checkServerIdentity(`verifica.${domain}`, c) === undefined,
        // the proxy's own stand-in while Let's Encrypt has not given a certificate yet
        placeholder: /TRAEFIK DEFAULT CERT/i.test(name),
      });
    });
    s.on('error', () => done(null));
    s.on('timeout', () => { s.destroy(); done(null); });
  });
}

/** Everything the Check button looks at. `resolve` and `cert` are replaced in the tests. */
export async function networkCheck(opts: { resolve?: (n: string) => Promise<string[]>; cert?: () => Promise<CertInfo | null> } = {}): Promise<CheckLine[]> {
  const resolve = opts.resolve ?? sysResolve;
  const domain = config.baseDomain;
  const out: CheckLine[] = [];
  if (config.network === 'local') return [{ state: 'ok', key: 'local' }];

  // 1. the name of the portal
  const portal = `apprua.${domain}`;
  const here = config.network === 'lan' ? config.lanIp : '';
  const pIps = await lookup(portal, resolve);
  if (!pIps) out.push({ state: 'bad', key: 'portal.none', vars: { name: portal, ip: here || '?' } });
  else if (here && !pIps.includes(here)) out.push({ state: 'bad', key: 'portal.other', vars: { name: portal, ips: pIps.join(', '), ip: here } });
  else out.push({ state: 'ok', key: here ? 'portal.ok' : 'portal.found', vars: { name: portal, ips: pIps.join(', ') } });

  // 2. the names of the apps: a name nobody uses must lead here too (the line *.<name> in the DNS)
  const probe = `verifica-${randomBytes(3).toString('hex')}.${domain}`;
  const aIps = await lookup(probe, resolve);
  if (!aIps) out.push({ state: 'bad', key: 'apps.none', vars: { domain, ip: here || (pIps?.[0] ?? '?') } });
  else if ((here && !aIps.includes(here)) || (!here && pIps && !aIps.some((ip) => pIps.includes(ip)))) out.push({ state: 'bad', key: 'apps.other', vars: { domain, ips: aIps.join(', '), ip: here || pIps!.join(', ') } });
  else out.push({ state: 'ok', key: 'apps.ok', vars: { domain } });

  // 3. the certificate (when there is HTTPS)
  if (config.https === 'off') {
    out.push({ state: 'warn', key: 'https.off' });
    return out;
  }
  const c = await (opts.cert ?? (() => readCertificate()))();
  if (!c) out.push({ state: 'bad', key: 'cert.none' });
  else if (c.placeholder) out.push({ state: config.https === 'letsencrypt' ? 'warn' : 'bad', key: config.https === 'letsencrypt' ? 'cert.waiting' : 'cert.missing' });
  else {
    const until = c.validTo.toISOString().slice(0, 10);
    if (!c.coversPortal || !c.coversApps) out.push({ state: 'bad', key: 'cert.names', vars: { domain, name: c.subject } });
    else if (c.daysLeft < 0) out.push({ state: 'bad', key: 'cert.expired', vars: { until } });
    else if (c.daysLeft < 21 && config.https === 'own') out.push({ state: 'warn', key: 'cert.soon', vars: { until, days: c.daysLeft } });
    else out.push({ state: 'ok', key: config.https === 'own' ? 'cert.ok.own' : 'cert.ok.le', vars: { until } });
    if (!c.trusted && config.https === 'own') out.push({ state: 'warn', key: 'cert.untrusted', vars: { issuer: c.issuer || '?' } });
  }
  return out;
}

/** Your certificate, read at most once an hour for the Settings page (when it ends is the thing to keep an eye on). */
let cached: { at: number; info: CertInfo | null } | null = null;
export async function ownCertificate(): Promise<CertInfo | null> {
  if (config.https !== 'own') return null;
  if (cached && Date.now() - cached.at < 3_600_000) return cached.info;
  const info = await readCertificate(undefined, undefined, 2000);
  cached = { at: Date.now(), info };
  return info;
}

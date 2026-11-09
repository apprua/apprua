// Where the apps open: the names are the user's, Apprua checks them (DNS, certificate) and serves the certificate given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

Object.assign(process.env, { DATA_DIR: await mkdtemp(join(tmpdir(), 'apd-net-')) });
const db = await import('../src/db.js');
const { config } = await import('../src/config.js');
const net = await import('../src/network.js');
const { tlsLabels } = await import('../src/engine/coolify.js');
const sp = await import('../src/signpost.js');
db.openDb(':memory:');

const lan = (o: Partial<typeof config> = {}) => Object.assign(config, { network: 'lan', baseDomain: 'app.ufficio.lan', lanIp: '192.168.1.20', https: 'off', ...o });
const names = (map: Record<string, string[]>) => async (n: string) => {
  for (const [k, v] of Object.entries(map)) if (k === n || (k.startsWith('*.') && n.endsWith(k.slice(1)))) return v;
  throw new Error('ENOTFOUND');
};
const cert = (o: Partial<import('../src/network.js').CertInfo> = {}) => async () => ({
  subject: '*.app.ufficio.lan', issuer: 'Ufficio CA', validTo: new Date(Date.now() + 200 * 86_400_000), daysLeft: 200,
  trusted: true, coversPortal: true, coversApps: true, placeholder: false, ...o,
});
const keys = (lines: { state: string; key: string }[]) => lines.map((l) => `${l.state}:${l.key}`);

test('Check: the names of the network lead here, or it says what is missing', async () => {
  const before = { ...config };
  try {
    lan();
    assert.deepEqual(keys(await net.networkCheck({ resolve: names({ 'apprua.app.ufficio.lan': ['192.168.1.20'], '*.app.ufficio.lan': ['192.168.1.20'] }) })),
      ['ok:portal.ok', 'ok:apps.ok', 'warn:https.off']);
    // nothing in the DNS yet
    assert.deepEqual(keys(await net.networkCheck({ resolve: names({}) })), ['bad:portal.none', 'bad:apps.none', 'warn:https.off']);
    // only the portal name, pointing elsewhere; the line *.name is missing
    const r = await net.networkCheck({ resolve: names({ 'apprua.app.ufficio.lan': ['192.168.0.9'] }) });
    assert.deepEqual(keys(r), ['bad:portal.other', 'bad:apps.none', 'warn:https.off']);
    assert.deepEqual(r[0].vars, { name: 'apprua.app.ufficio.lan', ips: '192.168.0.9', ip: '192.168.1.20' });
    // only this computer: nothing to check
    Object.assign(config, { network: 'local' });
    assert.deepEqual(keys(await net.networkCheck({ resolve: names({}) })), ['ok:local']);
  } finally { Object.assign(config, before); }
});

test('Check: your certificate (names, end date, who issued it) and the one of Let\'s Encrypt', async () => {
  const before = { ...config };
  const ok = names({ 'apprua.app.ufficio.lan': ['192.168.1.20'], '*.app.ufficio.lan': ['192.168.1.20'] });
  try {
    lan({ https: 'own' });
    assert.deepEqual(keys(await net.networkCheck({ resolve: ok, cert: cert() })).slice(2), ['ok:cert.ok.own']);
    assert.deepEqual(keys(await net.networkCheck({ resolve: ok, cert: cert({ trusted: false }) })).slice(2), ['ok:cert.ok.own', 'warn:cert.untrusted']);
    assert.deepEqual(keys(await net.networkCheck({ resolve: ok, cert: cert({ daysLeft: 9 }) })).slice(2), ['warn:cert.soon']);
    assert.deepEqual(keys(await net.networkCheck({ resolve: ok, cert: cert({ daysLeft: -1 }) })).slice(2), ['bad:cert.expired']);
    assert.deepEqual(keys(await net.networkCheck({ resolve: ok, cert: cert({ coversApps: false, subject: 'apprua.app.ufficio.lan' }) })).slice(2), ['bad:cert.names']);
    assert.deepEqual(keys(await net.networkCheck({ resolve: ok, cert: cert({ placeholder: true }) })).slice(2), ['bad:cert.missing']);
    assert.deepEqual(keys(await net.networkCheck({ resolve: ok, cert: async () => null })).slice(2), ['bad:cert.none']);
    // the internet: the address of the server is not known here, the names only have to agree
    Object.assign(config, { network: 'internet', https: 'letsencrypt', lanIp: '' });
    assert.deepEqual(keys(await net.networkCheck({ resolve: names({ 'apprua.app.ufficio.lan': ['203.0.113.7'], '*.app.ufficio.lan': ['203.0.113.7'] }), cert: cert({ placeholder: true }) })),
      ['ok:portal.found', 'ok:apps.ok', 'warn:cert.waiting']);
  } finally { Object.assign(config, before); }
});

test('labels of the apps: your certificate without Let\'s Encrypt, and back', () => {
  const coolify = [
    'traefik.enable=true',
    'traefik.http.routers.http-0-abc.rule=Host(`notes.app.ufficio.lan`)',
    'traefik.http.routers.https-0-abc.rule=Host(`notes.app.ufficio.lan`)',
    'traefik.http.routers.https-0-abc.tls=true',
    'traefik.http.routers.https-0-abc.tls.certresolver=letsencrypt',
  ];
  const own = tlsLabels(coolify, 'own');
  assert.ok(!own.some((l) => l.includes('certresolver')), 'no Let\'s Encrypt with your certificate');
  assert.ok(own.includes('traefik.http.routers.https-0-abc.tls=true'), 'still https');
  assert.deepEqual(tlsLabels(own, 'letsencrypt'), coolify, 'Let\'s Encrypt again');
  assert.deepEqual(tlsLabels(coolify, 'letsencrypt'), coolify, 'nothing added twice');
  assert.deepEqual(tlsLabels(coolify, 'off'), coolify);
});

test('the device check: a made-up app name answers with the id of this installation', async () => {
  const id = net.instanceId();
  assert.equal(net.instanceId(), id, 'always the same');
  const s = sp.startSignpost(0);
  await new Promise((r) => s.once('listening', r));
  try {
    const port = (s.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/_apprua/ping`, { headers: { host: 'verifica-x1.app.ufficio.lan' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*', 'the portal page can read it');
    assert.deepEqual(await r.json(), { apprua: id });
  } finally { s.close(); }
});

test('a publication the engine marks "failed" while it starts, with no log, is waited out', async () => {
  const { CoolifyEngine } = await import('../src/engine/coolify.js');
  const e = new CoolifyEngine();
  const answers = [
    { status: 'failed', logs: '[]' },   // Coolify just started: marks the deployment in progress as failed
    { status: 'finished', logs: JSON.stringify([{ output: 'Rolling update completed.' }]) },
  ];
  (e as any).call = async () => answers.shift() ?? { status: 'finished', logs: '[]' };
  assert.equal((await e.waitDeployment('d1', 60_000)).status, 'finished');
  // a real failure has a log: reported at once
  (e as any).call = async () => ({ status: 'failed', logs: JSON.stringify([{ output: 'npm ERR! missing script: start' }]) });
  const r = await e.waitDeployment('d2', 60_000);
  assert.equal(r.status, 'failed');
  assert.ok(r.logTail.some((l) => l.includes('missing script')));
});

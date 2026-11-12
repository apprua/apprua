// Who may say which address a request came from (the X-Forwarded-For header). The limits on sign-in attempts and on
// "forgot your password?" count by address: if anyone could write that header, an app on the same Docker network
// (or a build) could talk to Apprua directly, change the header at every attempt and never be stopped.
// So only the engine's proxy is believed. Its address on the Docker network is asked to the network's DNS by name
// (APPRUA_PROXY_HOST, default coolify-proxy), at start and every 30 seconds (it changes when the proxy restarts).
import { lookup } from 'node:dns/promises';
import { config } from './config.js';

/** The proxy's addresses; null while not known yet. */
let proxyAddresses: Set<string> | null = null;
const plain = (a: string) => a.replace(/^::ffff:/i, '').toLowerCase();

/** Asks the address of the proxy again; when it cannot be found, the last one known stays. */
export async function refreshProxyAddress(host = config.proxyHost): Promise<boolean> {
  try {
    const found = await lookup(host, { all: true });
    if (!found.length) return false;
    proxyAddresses = new Set(found.map((r) => plain(r.address)));
    return true;
  } catch {
    return false;
  }
}

/** For Fastify's trustProxy: a hop is believed only when it is the proxy. While the proxy's address is not known (a
 *  setup without it, or not found yet) every hop is believed, as in the versions before: otherwise all the people
 *  would look like one address, and a few wrong passwords would stop everybody's sign-in. */
export function trustHop(address: string): boolean {
  return proxyAddresses === null || proxyAddresses.has(plain(address));
}

export function startProxyTrust(log: (m: string) => void) {
  void refreshProxyAddress().then((ok) => {
    if (!ok) log(`The proxy "${config.proxyHost}" was not found on the network: the address in X-Forwarded-For is believed from anyone until it is (APPRUA_PROXY_HOST).`);
  });
  setInterval(() => void refreshProxyAddress(), 30_000).unref();
}

/** Only for tests. */
export function forgetProxyAddress() { proxyAddresses = null; }

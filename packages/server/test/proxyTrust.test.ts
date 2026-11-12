// Only the engine's proxy may say where a request came from: an app that talks to Apprua directly cannot change its
// address at every attempt to get past the limits on sign-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const { forgetProxyAddress, refreshProxyAddress, trustHop } = await import('../src/proxyTrust.js');

const app = Fastify({ trustProxy: (address: string) => trustHop(address) });
app.get('/ip', async (req) => ({ ip: req.ip }));
const ipOf = async (remoteAddress: string, forwarded?: string) =>
  (await app.inject({ method: 'GET', url: '/ip', remoteAddress, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} })).json().ip;

test('the address of the proxy is believed, the one of anybody else is not', async () => {
  // the proxy's name, as the Docker DNS would answer it (here: this machine)
  assert.equal(await refreshProxyAddress('localhost'), true);
  assert.equal(await ipOf('127.0.0.1', '203.0.113.7'), '203.0.113.7', 'through the proxy: the person\'s address');
  assert.equal(await ipOf('::ffff:127.0.0.1', '203.0.113.7'), '203.0.113.7', 'also written as IPv6');
  // made up by the person and added to by the proxy: the address the proxy saw, never the made-up one
  assert.equal(await ipOf('127.0.0.1', '198.51.100.1, 203.0.113.7'), '203.0.113.7');
  // an app straight to Apprua: its own address, whatever it writes
  assert.equal(await ipOf('10.0.1.11', '203.0.113.99'), '10.0.1.11');
  assert.equal(await ipOf('10.0.1.11'), '10.0.1.11');
  // a name that cannot be found does not throw away the address already known
  assert.equal(await refreshProxyAddress('no-such-proxy.invalid'), false);
  assert.equal(await ipOf('10.0.1.11', '203.0.113.99'), '10.0.1.11');
});

test('while the proxy is not known, as before: every hop is believed', async () => {
  forgetProxyAddress();
  assert.equal(await ipOf('10.0.1.11', '203.0.113.7'), '203.0.113.7');
});

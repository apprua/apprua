// The connector for AI apps, served by the portal:
// - a small npm package (.tgz), so an AI app can run it with "npx -y <address>": no file to download, no path to type;
// - the single-file MCP server, for people who prefer to keep the file themselves;
// - a .mcpb extension for Claude Desktop with this installation's address pre-filled.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { config } from './config.js';
import { VERSION } from './version.js';

export { VERSION };
const MCP_DIR = process.env.MCP_DIR ?? '/app/mcp';

export interface Downloads { mcpb: Buffer; server: Buffer; tgz: Buffer; tgzName: string }
let cache: Downloads | null = null;

/** A minimal tar archive (ustar), enough for an npm package: regular files only. */
export function tarFiles(files: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  for (const [name, data] of Object.entries(files)) {
    const h = new Uint8Array(512);
    const put = (s: string, at: number) => h.set(strToU8(s), at);
    put(name, 0); put(oct(0o644, 8), 100); put(oct(0, 8), 108); put(oct(0, 8), 116);
    put(oct(data.length, 12), 124); put(oct(Math.floor(Date.UTC(2026, 0, 1) / 1000), 12), 136);
    put('        ', 148); put('0', 156); put('ustar\0', 257); put('00', 263);
    put(oct(h.reduce((s, b) => s + b, 0), 7) + ' ', 148);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((s, b) => s + b.length, 0));
  let at = 0;
  for (const b of blocks) { out.set(b, at); at += b.length; }
  return out;
}

export function downloads(): Downloads | null {
  if (cache) return cache;
  const serverPath = `${MCP_DIR}/server.mjs`, manifestPath = `${MCP_DIR}/manifest.template.json`;
  if (!existsSync(serverPath) || !existsSync(manifestPath)) return null;
  const server = readFileSync(serverPath);
  const manifest = readFileSync(manifestPath, 'utf8')
    .replaceAll('{{BRAND}}', config.brand).replaceAll('{{VERSION}}', VERSION).replaceAll('{{PUBLIC_URL}}', config.publicUrl);
  const iconPath = `${MCP_DIR}/icon.png`, licensePath = `${MCP_DIR}/LICENSE`;
  // AGPL text with the connector (the licenses of the libraries inside it are at the end of server.mjs)
  const license: Record<string, Uint8Array> = existsSync(licensePath) ? { LICENSE: new Uint8Array(readFileSync(licensePath)) } : {};
  const mcpb = Buffer.from(zipSync({
    'manifest.json': strToU8(existsSync(iconPath) ? manifest : manifest.replace(/^\s*"icon": "icon\.png",\r?\n/m, '')),
    server: { 'index.mjs': new Uint8Array(server) },
    ...(existsSync(iconPath) ? { 'icon.png': new Uint8Array(readFileSync(iconPath)) } : {}),
    ...license,
  }, { level: 9 }));
  // The name changes with the code, so "npx" never runs an old copy it kept in its cache
  const hash = `c${createHash('sha256').update(server).digest('hex').slice(0, 8)}`;   // "c": a valid semver part even if all digits
  const pkg = { name: 'apprua-mcp', version: `${VERSION}-${hash}`, description: `${config.brand} connector for AI apps (MCP)`,
    license: 'AGPL-3.0-only', type: 'module', bin: { 'apprua-mcp': 'server.mjs' }, engines: { node: '>=20' } };
  const tgz = Buffer.from(gzipSync(tarFiles({
    'package/package.json': strToU8(JSON.stringify(pkg, null, 2)),
    'package/server.mjs': new Uint8Array(server),
    ...(license.LICENSE ? { 'package/LICENSE': license.LICENSE } : {}),
  }), { level: 9 }));
  cache = { mcpb, server, tgz, tgzName: `apprua-mcp-${VERSION}-${hash}.tgz` };
  return cache;
}

/** Address the AI app downloads the connector from (null when this installation has no connector). */
export function connectorUrl(): string | null {
  const d = downloads();
  return d ? `${config.publicUrl}/connector/${d.tgzName}` : null;
}

/** Where "npx" takes the connector from: npm (the package of this version, published from GitHub with provenance), or
 *  this portal (a copy built from the source, whose version is not on npm; set by install.sh). From npm, a server
 *  taken over, or someone on a local network without HTTPS, cannot hand the PCs a different connector to run. */
let source: 'npm' | 'server' = 'npm';
export const connectorSource = () => (process.env.APPRUA_CONNECTOR_SOURCE === 'server' ? 'server' : source);

/** Once at start: is the connector of this very version on npm? If not (a release whose npm step failed, a copy built
 *  from the source, a machine with no way to npm), the AI apps take it from this portal instead of a broken command. */
export async function resolveConnectorSource(log: (m: string) => void): Promise<void> {
  if (process.env.APPRUA_CONNECTOR_SOURCE) return;
  try {
    const r = await fetch(`https://registry.npmjs.org/@apprua/mcp/${VERSION}`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
    if (r.ok) return;
    log(`connector: @apprua/mcp@${VERSION} is not on npm (${r.status}), the AI apps take it from this portal`);
  } catch (e) {
    log(`connector: npm not reachable (${(e as Error).message}), the AI apps take it from this portal`);
  }
  source = 'server';
}

/** How an AI app starts the connector: "npx" downloads it (from npm, or from the portal), the key and address go in env. */
export function connectorConfig(token: string) {
  const env = { APPRUA_URL: config.publicUrl, APPRUA_TOKEN: token };
  if (connectorSource() === 'npm') return { command: 'npx', args: ['-y', `@apprua/mcp@${VERSION}`], env };
  const url = connectorUrl() ?? `${config.publicUrl}/connector/apprua-mcp.tgz`;
  // "--package <address> apprua-mcp" is the explicit form: npx never mistakes the address for a command to run
  return { command: 'npx', args: ['-y', '--package', url, 'apprua-mcp'], env };
}

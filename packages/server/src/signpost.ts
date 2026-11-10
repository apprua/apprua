// Signpost: the page the engine's proxy shows at an app address when no app answers there.
// The proxy sends every address without a running app here (lowest priority route, see install/install.sh),
// keeping the original Host, so the page can say why: no such app, paused, archived, on its way, needs a fix, restarting.
// It runs on its own port, apart from the portal: no session, no cookies, no portal routes reachable from app addresses.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getApp, getDb } from './db.js';
import { langOf, t, type Lang } from './i18n.js';
import { instanceId } from './network.js';
import { esc, favicon, LOGO, prettyName, TOKENS } from './views.js';

export type SignKind = 'none' | 'stopped' | 'archived' | 'coming' | 'failed' | 'down';

/** The app name in an address like "notes.localhost:80", or null when it is not "<name>.<base domain>". */
export function appNameOf(host: string): string | null {
  const h = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const suffix = `.${config.baseDomain.toLowerCase()}`;
  if (!h.endsWith(suffix)) return null;
  const name = h.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? name : null;
}

/** Why nothing answers at this app's address. */
export function signKind(name: string | null): SignKind {
  const a = name ? getApp(name) : undefined;
  if (!a) return 'none';
  if (a.status === 'stopped') return 'stopped';
  if (a.status === 'archived') return 'archived';
  const last = getDb().prepare('SELECT result FROM deploys WHERE app = ? ORDER BY id DESC LIMIT 1').get(a.name) as { result: string | null } | undefined;
  if (!last || last.result === null) return 'coming';
  return last.result === 'running' ? 'down' : 'failed';
}

const ART: Record<SignKind, { img: string; alt: string }> = {
  none: { img: 'porto-notte.svg', alt: 'art.harbour' },
  stopped: { img: 'riposo.svg', alt: 'art.rest' },
  archived: { img: 'riposo.svg', alt: 'art.rest' },
  coming: { img: 'barca.svg', alt: 'art.boat' },
  failed: { img: 'da-sistemare.svg', alt: 'art.fix' },
  down: { img: 'da-sistemare.svg', alt: 'art.fix' },
};

/** Assets live under a path that apps are unlikely to use (the app is not answering anyway). */
const BASE = '/_apprua';

const CSS = `
@font-face{font-family:"Atkinson Next";src:url(${BASE}/fonts/atkinson-next-latin.woff2) format("woff2");font-weight:200 800;font-display:swap}
@font-face{font-family:"Lilita One";src:url(${BASE}/fonts/lilita-one-latin.woff2) format("woff2");font-display:swap}
${TOKENS}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:400 17px/1.55 var(--ui);min-height:100vh;display:grid;grid-template-columns:minmax(0,560px);justify-content:center;align-content:center;padding:24px 16px}
body::after{content:"";position:fixed;inset:0;pointer-events:none;background:var(--grain);opacity:.1;mix-blend-mode:multiply}
@media (prefers-color-scheme:dark){body::after{mix-blend-mode:screen;opacity:.05}}
main{min-width:0;display:grid;gap:22px}
.art{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border:2px solid var(--rule);border-radius:14px;background:#0b0b0b}
h1{margin:0;font-family:var(--display);font-weight:400;font-size:clamp(2rem,7vw,2.7rem);line-height:1;overflow-wrap:anywhere}
p{margin:0;max-width:46ch}
.acts{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:999px;border:2px solid var(--ink);color:var(--ink);font-weight:700;text-decoration:none;font-family:inherit;font-size:1rem;background:transparent;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
footer{display:flex;justify-content:space-between;align-items:center;gap:12px;color:var(--muted);font-size:.9rem}
.brand{display:inline-flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none;font-family:var(--display);font-size:1.2rem}
.brand svg{width:26px;height:26px}
footer a{color:var(--muted)}
`;

/** The page for an address, in the visitor's language. */
export function signpostPage(host: string, lang: Lang): { status: number; kind: SignKind; html: string } {
  const name = appNameOf(host);
  const kind = signKind(name);
  // an existing app is called as in the portal ("Ciao apprua"); a missing one as typed in the address
  const vars = { app: !name ? '' : kind === 'none' ? name : prettyName(name) };
  const title = t(lang, `sign.${kind}.title`, vars);
  const text = t(lang, kind === 'none' && !name ? 'sign.none.text.noname' : `sign.${kind}.text`, vars);
  // on its way or restarting: the page reloads by itself; once the app answers, the proxy sends the reload to the app
  const refresh = kind === 'coming' || kind === 'down' ? '<meta http-equiv="refresh" content="8">' : '';
  const retry = kind === 'coming' || kind === 'down' || kind === 'failed'
    ? `<button class="btn" type="button" onclick="location.reload()">${esc(t(lang, 'sign.retry'))}</button>` : '';
  const other: Lang = lang === 'it' ? 'en' : 'it';
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">${refresh}
<link rel="icon" href="${BASE}/favicon.svg?v=7" type="image/svg+xml"><style>${CSS}</style></head>
<body><main>
<img class="art" src="${BASE}/img/${ART[kind].img}" alt="${esc(t(lang, ART[kind].alt))}">
<h1>${esc(title)}</h1>
<p>${esc(text)}</p>
<div class="acts"><a class="btn primary" href="${esc(config.publicUrl)}/">${esc(t(lang, 'sign.portal'))}</a>${retry}</div>
<footer><a class="brand" href="${esc(config.publicUrl)}/">${LOGO}<span>${esc(config.brand)}</span></a><a href="?lang=${other}" hreflang="${other}">${esc(t(lang, 'nav.lang'))}</a></footer>
</main></body></html>`;
  return { status: kind === 'none' || kind === 'archived' ? 404 : 503, kind, html };
}

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '../../assets');
const cache = new Map<string, Buffer>();
function asset(path: string): { type: string; body: Buffer } | null {
  const m = /^\/_apprua\/(img|fonts)\/([a-z0-9-]+\.(svg|woff2))$/.exec(path);
  if (!m) return null;
  const file = join(ASSETS, m[1], m[2]);
  if (!cache.has(file)) {
    try { cache.set(file, readFileSync(file)); } catch { return null; }
  }
  return { type: m[3] === 'svg' ? 'image/svg+xml' : 'font/woff2', body: cache.get(file)! };
}

export function signpostHandler(req: IncomingMessage, res: ServerResponse): void {
  const send = (status: number, type: string, body: string | Buffer, cache: string) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  // An address that cannot be read (for example "//") gets an answer: an error thrown here would stop the whole server.
  let url: URL;
  try { url = new URL(req.url ?? '/', 'http://x'); } catch { return send(400, 'text/plain', 'Bad request', 'no-store'); }
  if (url.pathname === `${BASE}/favicon.svg`) return send(200, 'image/svg+xml', favicon(), 'public, max-age=86400');
  // "Check" in Settings: the browser asks a made-up app name, to see that from that device the names lead here
  if (url.pathname === `${BASE}/ping`) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return send(200, 'application/json', JSON.stringify({ apprua: instanceId() }), 'no-store');
  }
  const a = asset(url.pathname);
  if (a) return send(200, a.type, a.body, 'public, max-age=86400');
  const query = Object.fromEntries(url.searchParams);
  const lang = langOf({ query, headers: req.headers } as unknown as Parameters<typeof langOf>[0]);
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  let p: ReturnType<typeof signpostPage>;
  try {
    p = signpostPage(host, lang);
  } catch {
    p = { status: 503, kind: 'down', html: 'Not available' };
  }
  if (p.status === 503) res.setHeader('Retry-After', '10');
  send(p.status, 'text/html; charset=utf-8', p.html, 'no-store');
}

export function startSignpost(port = config.signpostPort): Server {
  const s = createServer(signpostHandler);
  s.listen(port, '0.0.0.0');
  return s;
}

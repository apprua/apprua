// The gate in front of the apps (local network and internet). The engine's proxy asks it before every request to an
// app (Traefik "forwardAuth", middleware apprua-auth written by install/install.sh): 2xx lets the request through,
// anything else goes back to the browser as it is (a redirect to sign in, or a page that says the app is private).
//
// Every app has its own cookie, valid only at its own address and only for it (see auth.ts, "the sign-in in front of
// the apps"): the portal's cookie never reaches the apps, which run code written by AI.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { gateCookie, gateUser, issuePass, portalUser, safeNext, usePass } from '../auth.js';
import { config } from '../config.js';
import { getApp, type App, type User } from '../db.js';
import { langOf, t } from '../i18n.js';
import { appNameOf } from '../signpost.js';
import { esc } from '../views.js';

export type GateAnswer = { allow: true } | { allow: false; signIn: true } | { allow: false; signIn: false; archived?: true };

/** Whether this person (or nobody signed in) can open this app. An archived app is closed to everyone, also when the
 *  engine could not stop it. */
export function canOpen(app: App, u: User | null): GateAnswer {
  if (app.status === 'archived') return { allow: false, signIn: false, archived: true };
  if (app.visibility === 'public') return { allow: true };
  if (!u) return { allow: false, signIn: true };
  if (app.visibility === 'team' || u.email === app.owner || u.role === 'admin') return { allow: true };
  return { allow: false, signIn: false };
}

const header = (req: FastifyRequest, name: string) => String(req.headers[name] ?? '').split(',')[0].trim();
/** A path of the app itself to go back to (never another address). */
const safePath = (p: unknown) => (typeof p === 'string' && /^\/(?![\/\\])/.test(p) && !/[\x00-\x1f\x7f]/.test(p) ? p : '/');
const passUrl = (target: string) => `${config.publicUrl}/_apprua/pass?next=${encodeURIComponent(target)}`;

export async function gateRoutes(app: FastifyInstance) {
  app.get('/_apprua/gate', async (req, reply) => {
    const host = header(req, 'x-forwarded-host');
    const a = getApp(appNameOf(host) ?? '');
    // not one of our apps (or not published yet): nothing to protect here
    if (!a) return reply.code(204).send();
    const origin = `${header(req, 'x-forwarded-proto') === 'https' ? 'https' : 'http'}://${host}`;
    const uri = header(req, 'x-forwarded-uri') || '/';
    reply.header('Cache-Control', 'no-store');

    // back from the portal with a code for one use: the app's own cookie, then the page that was asked for
    let asked: URL | null = null;
    try { asked = new URL(uri, origin); } catch { asked = null; }
    if (config.auth.mode !== 'proxy' && asked?.pathname === '/_apprua/enter') {
      const next = safePath(asked.searchParams.get('next'));
      const email = usePass(asked.searchParams.get('code') ?? '', a.name);
      // used or expired (a second tab, a slow page): ask the portal again, it answers at once if still signed in
      if (!email) return reply.code(302).redirect(passUrl(`${origin}${next}`));
      // a full address: the proxy would complete a short one ("/page") with the gate's own address
      return reply.code(302).header('Set-Cookie', gateCookie(a.name, email, origin.startsWith('https:'))).redirect(`${origin}${next}`);
    }

    let u: User | null = null;
    try { u = config.auth.mode === 'proxy' ? portalUser(req) : gateUser(req, a.name, origin.startsWith('https:')); } catch { u = null; }
    const answer = canOpen(a, u);
    if (answer.allow) return reply.code(204).send();
    if (answer.signIn) {
      const back = `${origin}${uri}`;
      return reply.code(302).redirect(config.auth.mode === 'proxy' ? `${config.publicUrl}/login?next=${encodeURIComponent(back)}` : passUrl(back));
    }
    const lang = langOf(req);
    const [title, text] = 'archived' in answer
      ? [t(lang, 'gate.archived.title'), t(lang, 'gate.archived.text')]
      : [t(lang, 'gate.private.title'), t(lang, 'gate.private.text', { email: u?.email ?? '' })];
    return reply.code(403).type('text/html; charset=utf-8').send(
      `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:#F1E9DA;color:#121212;font:400 17px/1.55 system-ui,sans-serif}main{max-width:520px;display:grid;gap:16px}h1{margin:0;font-size:2rem;line-height:1.1}a{color:#2234EE}@media (prefers-color-scheme:dark){body{background:#0F0F10;color:#F1E9DA}a{color:#9AA6FF}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="${esc(config.publicUrl)}/">${esc(t(lang, 'sign.portal'))}</a></p></main></body></html>`);
  });

  // On the portal's address: who is signed in may enter this app. Not signed in: the login first, then back here.
  app.get<{ Querystring: { next?: string } }>('/_apprua/pass', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const next = safeNext(req.query.next);
    const target = next ? new URL(next) : null;
    const a = target && target.origin !== new URL(config.publicUrl).origin ? getApp(appNameOf(target.host) ?? '') : undefined;
    if (!target || !a) return reply.redirect('/');
    if (config.auth.mode === 'proxy') return reply.redirect(target.toString());
    const u = portalUser(req);
    if (!u) return reply.redirect(`/login?next=${encodeURIComponent(passUrl(target.toString()))}`);
    const code = issuePass(u.email, a.name);
    return reply.redirect(`${target.origin}/_apprua/enter?code=${code}&next=${encodeURIComponent(target.pathname + target.search)}`);
  });
}

// Browser portal: first-run setup, sign in, personal token, own apps, administration. Markup lives in views.ts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { changeOwnPassword, createLocalUser, createResetToken, endSession, HttpError, issueToken, needsSetup, portalUser, randomPassword, resetTokenEmail, revokeToken, safeNext, setPassword, startSession, useResetToken, checkPassword } from '../auth.js';
import { mailEnabled, sendMail } from '../notify.js';
import { config, MEMORY_CHOICES } from '../config.js';
import { memoryMb } from '../resources.js';
import { audit, getApp, getDb, getUser, type App, type User } from '../db.js';
import { downloads } from '../downloads.js';
import { engine } from '../engine/index.js';
import { langOf, t, tMsg, type Lang } from '../i18n.js';
import * as ops from '../adminOps.js';
import * as appOps from '../appOps.js';
import { assertCanManage, nextReview } from '../publish.js';
import * as repos from '../repos.js';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { appsMemory, readResources } from '../resources.js';
import { instanceId, networkCheck, ownCertificate } from '../network.js';
import { changeProfile, checkSetupCode, lockedRules, parseMemory, parseRules, saveRules, saveSetup, suggestedProfile, type Rules } from '../setup.js';
import { accountPage, appPage, favicon, forgotPage, home, loginPage, logsCard, newPasswordNotice, notice, resetPage, settingsPage, setupChoicePage, setupPage, teamWelcome, undoNotice, prettyName, memLabel, type Publication } from '../views.js';

/** Whether the engine (Coolify) answers, checked at most once a minute (shown to everyone as a status dot). */
let engineLabel: { at: number; ok: boolean; text: string } | null = null;
async function engineStatus(): Promise<{ ok: boolean; text: string }> {
  if (engineLabel && Date.now() - engineLabel.at < 60_000) return engineLabel;
  const s = await engine().check().then((text) => ({ ok: true, text }), (e) => ({ ok: false, text: `${engine().name}: ${(e as Error).message}` }));
  engineLabel = { at: Date.now(), ...s };
  return s;
}

async function render(lang: Lang, u: User, flash = '', fresh?: { token: string; expiresAt: string }): Promise<string> {
  const db = getDb();
  const mine = db.prepare(`SELECT * FROM apps WHERE owner = ? AND status != 'archived' ORDER BY name`).all(u.email) as unknown as App[];
  // last 10 publications of each app, oldest first (history bars and summary sentence)
  const history: Record<string, Publication[]> = {};
  if (mine.length) {
    const rows = db.prepare(`SELECT app, result, started_at FROM deploys WHERE app IN (SELECT name FROM apps WHERE owner = ? AND status != 'archived') ORDER BY id DESC LIMIT 1000`)
      .all(u.email) as unknown as { app: string; result: string | null; started_at: string }[];
    for (const r of rows) { const h = (history[r.app] ??= []); if (h.length < 10) h.push({ result: r.result, at: r.started_at }); }
    for (const k of Object.keys(history)) history[k].reverse();
  }
  // all the versions of each app (publications that went through), shown in words next to the bars
  const versions: Record<string, number> = {};
  if (mine.length) {
    const rows = db.prepare(`SELECT app, COUNT(*) AS n FROM deploys WHERE result = 'running' AND app IN (SELECT name FROM apps WHERE owner = ? AND status != 'archived') GROUP BY app`)
      .all(u.email) as unknown as { app: string; n: number }[];
    for (const r of rows) versions[r.app] = Number(r.n);
  }
  const eng = await engineStatus();
  return home({
    lang, u, flash, mine, history, versions, fresh, engineOk: eng.ok,
    admin: u.role === 'admin',
  });
}

/** Refuses form posts coming from other sites (the session cookie is SameSite=Lax, this is a second lock). */
function checkSameOrigin(req: FastifyRequest) {
  const origin = String(req.headers.origin ?? '');
  if (!origin) return;
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
  try {
    const o = new URL(origin);
    if (o.origin === config.publicUrl || o.host === host) return;
  } catch { /* fall through */ }
  throw new HttpError(403, 'Cross-site request refused.');
}

export async function portalRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  const html = (req: FastifyRequest, reply: FastifyReply, s: string) => {
    const q = (req.query as Record<string, string> | undefined)?.lang;
    if (q === 'en' || q === 'it') reply.header('Set-Cookie', `apprua_lang=${q}; Path=/; SameSite=Lax; Max-Age=31536000`);
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(s);
  };
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, string>;

  /** The signed-in user, or a redirect to sign in / first-run setup. */
  function userOr(req: FastifyRequest, reply: FastifyReply): User | null {
    const u = portalUser(req);
    if (u) return u;
    void reply.redirect(needsSetup() ? '/setup' : '/login');
    return null;
  }

  app.get('/favicon.svg', async (_req, reply) => reply.type('image/svg+xml').header('Cache-Control', 'public, max-age=86400').send(favicon()));

  // Portal typeface, shipped with Apprua (no external requests: works offline and on localhost)
  const fontDir = join(dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');
  const fonts = new Map<string, Buffer>();
  app.get<{ Params: { file: string } }>('/assets/fonts/:file', async (req, reply) => {
    const f = req.params.file;
    if (!/^[a-z0-9-]+\.woff2$/.test(f)) throw new HttpError(404, 'Not found.');
    if (!fonts.has(f)) {
      try { fonts.set(f, readFileSync(join(fontDir, f))); } catch { throw new HttpError(404, 'Not found.'); }
    }
    return reply.type('font/woff2').header('Cache-Control', 'public, max-age=31536000, immutable').send(fonts.get(f));
  });

  // Illustrations of the moments (sign in, empty list, first app, needs a fix, not answering): vector scenes composed from
  // the brand kit, shipped with Apprua
  const imgDir = join(dirname(fileURLToPath(import.meta.url)), '../../../assets/img');
  const images = new Map<string, Buffer>();
  app.get<{ Params: { file: string } }>('/assets/img/:file', async (req, reply) => {
    const f = req.params.file;
    if (!/^[a-z0-9-]+\.svg$/.test(f)) throw new HttpError(404, 'Not found.');
    if (!images.has(f)) {
      try { images.set(f, readFileSync(join(imgDir, f))); } catch { throw new HttpError(404, 'Not found.'); }
    }
    return reply.type('image/svg+xml').header('Cache-Control', 'public, max-age=86400').send(images.get(f));
  });


  app.get<{ Querystring: { welcome?: string } }>('/', async (req, reply) => {
    const u = userOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    return html(req, reply, await render(lang, u, req.query.welcome === 'team' && u.role === 'admin' ? teamWelcome(lang) : ''));
  });

  // ----- first-run setup (who is it for? then the first account) and sign in (local accounts) -----

  app.get<{ Querystring: { for?: string } }>('/setup', async (req, reply) => {
    if (!needsSetup()) return reply.redirect('/');
    const lang = langOf(req);
    const f = req.query.for;
    if (f === 'me' || f === 'team') return html(req, reply, setupPage(lang, { profile: f === 'me' ? 'personal' : 'team' }));
    return html(req, reply, setupChoicePage(lang, suggestedProfile()));
  });

  app.post('/setup', async (req, reply) => {
    checkSameOrigin(req);
    const lang = langOf(req);
    if (!needsSetup()) return reply.redirect('/');
    const b = body(req);
    const profile = b.profile === 'team' ? 'team' : 'personal';
    const rules = profile === 'team' ? parseRules(b.quota, b.review) : {};
    const again = (error: string) => html(req, reply, setupPage(lang, { profile, error, email: b.email, name: b.name, ...rules }));
    if (!checkSetupCode(b.code)) { audit(null, 'setup.bad_code', null, { ip: req.ip }); return again(t(lang, 'setup.badcode')); }
    if (b.password !== b.password2) return again(t(lang, 'setup.mismatch'));
    try {
      const u = createLocalUser(String(b.email ?? ''), String(b.name ?? '').trim() || null, String(b.password ?? ''), 'admin', 'setup');
      saveSetup({ profile, ...rules });
      audit(u.email, 'setup.done', null, { profile, ...rules });
      startSession(req, reply, u.email);
      return reply.redirect(profile === 'team' ? '/?welcome=team' : '/');
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return again(tMsg(lang, e.message));
    }
  });

  app.get<{ Querystring: { next?: string } }>('/login', async (req, reply) => {
    if (config.auth.mode !== 'local') return reply.redirect('/');
    if (needsSetup()) return reply.redirect('/setup');
    const next = safeNext(req.query.next);
    // already signed in (coming from an app): go on
    const u = portalUser(req);
    if (u && next) return reply.redirect(next);
    return html(req, reply, loginPage(langOf(req), '', '', next ?? ''));
  });

  // Guessing passwords: wrong attempts are counted for the address and for the address + email (15 minutes); after
  // 10 the address waits, and at most 8 checks run at once (a burst of sign-ins cannot slow down the apps).
  const failures = new Map<string, { n: number; until: number }>();
  let checking = 0;
  app.post('/login', async (req, reply) => {
    checkSameOrigin(req);
    const lang = langOf(req);
    const b = body(req);
    const email = String(b.email ?? '').trim().toLowerCase();
    if (email.length > 254) throw new HttpError(400, 'Email too long.');   // never a key of the map below, nor an audit row
    const now = Date.now();
    if (failures.size > 10_000) for (const [k, f] of failures) if (f.until < now) failures.delete(k);
    const keys = [`${req.ip}|${email}`, `ip|${req.ip}`];
    const seen = keys.map((k) => { const f = failures.get(k); return f && f.until > now ? f.n : 0; });
    const tooMany = () => html(req, reply.code(429), loginPage(lang, t(lang, 'login.toomany'), email, safeNext(b.next) ?? ''));
    if (seen[0] >= 10 || seen[1] >= 30 || checking >= 8) return tooMany();
    if (seen[0] > 0) await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
    const u = getUser(email);
    checking++;
    let good = false;
    try { good = await checkPassword(String(b.password ?? ''), u && !u.disabled_at ? u.password_hash : null); } finally { checking--; }
    if (!u || !good) {
      for (const k of keys) failures.set(k, { n: (failures.get(k)?.until ?? 0) > now ? failures.get(k)!.n + 1 : 1, until: now + 15 * 60_000 });
      audit(email || null, 'login.failed', null, { ip: req.ip });
      return html(req, reply.code(401), loginPage(lang, t(lang, 'login.wrong'), email, safeNext(b.next) ?? ''));
    }
    failures.delete(keys[0]);
    audit(u.email, 'login', null);
    startSession(req, reply, u.email);
    return reply.redirect(safeNext(b.next) ?? '/');
  });

  app.post('/logout', async (req, reply) => {
    checkSameOrigin(req);
    endSession(req, reply);
    return reply.redirect('/login');
  });

  // ----- your account: change the password; forgot it: a link by email, or who can help -----

  app.get('/account', async (req, reply) => {
    const u = userOr(req, reply);
    if (!u) return;
    return html(req, reply, accountPage(langOf(req), u));
  });

  app.post('/account/password', async (req, reply) => {
    checkSameOrigin(req);
    const u = userOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const b = body(req);
    if (config.auth.mode !== 'local') return reply.redirect('/account');
    try {
      if (b.password !== b.password2) throw new HttpError(400, t(lang, 'setup.mismatch'));
      changeOwnPassword(u.email, String(b.current ?? ''), String(b.password ?? ''));
      startSession(req, reply, u.email);   // this device stays signed in; the others are signed out
      return html(req, reply, accountPage(lang, getUser(u.email)!, notice(t(lang, 'pw.done'))));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return html(req, reply.code(400), accountPage(lang, u, notice(tMsg(lang, e.message), true)));
    }
  });

  const forgotAsked = new Map<string, number>();
  app.get('/forgot', async (req, reply) => {
    if (config.auth.mode !== 'local') return reply.redirect('/');
    return html(req, reply, forgotPage(langOf(req), { mail: mailEnabled() }));
  });

  app.post('/forgot', async (req, reply) => {
    checkSameOrigin(req);
    if (config.auth.mode !== 'local') return reply.redirect('/');
    const lang = langOf(req);
    const email = String(body(req).email ?? '').trim().toLowerCase();
    if (email.length > 254) throw new HttpError(400, 'Email too long.');   // as at sign-in: never a key of the map, nor an audit row
    if (!mailEnabled()) return html(req, reply, forgotPage(lang, { mail: false }));
    // one link a minute from the same address or for the same account (the answer never says if the account exists)
    const now = Date.now();
    for (const [k, at] of forgotAsked) if (now - at > 60_000) forgotAsked.delete(k);
    if (forgotAsked.has(req.ip) || forgotAsked.has(email))
      return html(req, reply, forgotPage(lang, { mail: true, email, flash: notice(t(lang, 'forgot.wait'), true) }));
    forgotAsked.set(req.ip, now).set(email, now);
    const token = createResetToken(email);
    if (token) {
      const link = `${config.publicUrl}/reset?t=${token}`;
      // only to the person: the administrator gets no copy of a link that opens their account
      void sendMail([email], t(lang, 'reset.mail.subject'), t(lang, 'reset.mail.text', { email, link }), { copyAdmin: false })
        .catch((e) => console.error(`[forgot] email not sent to ${email}: ${(e as Error).message}`));
    } else {
      audit(null, 'user.password_reset_unknown', null, { email, ip: req.ip });
    }
    return html(req, reply, forgotPage(lang, { mail: true, flash: notice(t(lang, 'forgot.sent', { email })) }));
  });

  app.get<{ Querystring: { t?: string } }>('/reset', async (req, reply) => {
    const lang = langOf(req);
    const token = String(req.query.t ?? '');
    const email = token ? resetTokenEmail(token) : null;
    if (!email) return html(req, reply.code(400), forgotPage(lang, { mail: mailEnabled(), flash: notice(t(lang, 'err.reset_invalid'), true) }));
    return html(req, reply, resetPage(lang, { token, email }));
  });

  app.post('/reset', async (req, reply) => {
    checkSameOrigin(req);
    const lang = langOf(req);
    const b = body(req);
    const token = String(b.t ?? '');
    const email = resetTokenEmail(token);
    if (!email) return html(req, reply.code(400), forgotPage(lang, { mail: mailEnabled(), flash: notice(t(lang, 'err.reset_invalid'), true) }));
    try {
      if (b.password !== b.password2) throw new HttpError(400, t(lang, 'setup.mismatch'));
      useResetToken(token, String(b.password ?? ''));
      startSession(req, reply, email);
      return reply.redirect('/');
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return html(req, reply.code(400), resetPage(lang, { token, email, error: tMsg(lang, e.message) }));
    }
  });

  // ----- personal token and own apps -----

  app.post('/portal/token', async (req, reply) => {
    checkSameOrigin(req);
    const u = userOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const { token, expiresAt } = issueToken(u.email, u.email);
    return html(req, reply, await render(lang, getUser(u.email)!, '', { token, expiresAt }));
  });

  /** Owner buttons in "Your apps" (also allowed to admins). Errors are shown on the page. */
  app.post<{ Params: { name: string; action: string } }>('/portal/apps/:name/:action', async (req, reply) => {
    checkSameOrigin(req);
    const u = userOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const { name, action } = req.params;
    try {
      let msg: string;
      if (action === 'archive') { await appOps.archiveOwnApp(u, name); msg = t(lang, 'done.archive', { app: prettyName(name) }); }
      else if (action === 'confirm') {
        const a = getDb().prepare('SELECT * FROM apps WHERE name = ?').get(name) as unknown as App | undefined;
        if (!a || (a.owner !== u.email && u.role !== 'admin')) throw new HttpError(404, `App "${name}" not found among your apps.`);
        const review = nextReview();
        getDb().prepare('UPDATE apps SET review_at = ? WHERE name = ?').run(review, a.name);
        audit(u.email, 'app.review_confirm', a.name, { review_at: review });
        msg = t(lang, 'done.confirm', { app: prettyName(name), date: review ?? '' });
      } else if (action === 'see-private' || action === 'see-team' || action === 'see-public') {
        const v = action.slice(4);
        appOps.setVisibility(u, name, v);
        msg = t(lang, 'done.vis', { app: prettyName(name), who: t(lang, `vis.${v}`) });
      } else if (action === 'restart' || action === 'stop' || action === 'start') {
        await appOps.controlApp(u, name, action);
        msg = t(lang, `done.${action}`, { app: prettyName(name) });
        // pausing needs no "are you sure?": the notice offers a one-click undo
        if (action === 'stop') return html(req, reply, await render(lang, getUser(u.email)!, undoNotice(lang, msg, name)));
      } else throw new HttpError(404, 'Unknown action.');
      return html(req, reply, await render(lang, getUser(u.email)!, notice(msg)));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return html(req, reply, await render(lang, getUser(u.email)!, notice(t(lang, 'failed', { msg: tMsg(lang, e.message) }), true)));
    }
  });

  // ----- the page of one app: versions and secrets -----
  async function appPageHtml(lang: Lang, u: User, name: string, flash = ''): Promise<string> {
    const a = assertCanManage(u, getApp(name), name);
    const [versions, envKeys, eng] = await Promise.all([
      appOps.appVersions(u, name),
      appOps.listEnv(u, name).catch(() => [] as string[]),
      engineStatus(),
    ]);
    return appPage(lang, u, getApp(a.name)!, versions, envKeys, flash, eng.ok, appsMemory());
  }

  app.get<{ Params: { name: string } }>('/portal/apps/:name', async (req, reply) => {
    const u = userOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    try {
      return html(req, reply, await appPageHtml(lang, u, req.params.name));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return html(req, reply, await render(lang, u, notice(t(lang, 'failed', { msg: tMsg(lang, e.message) }), true)));
    }
  });

  /** The memory of one app (administrators): saved, and the app started again at once when it is on. */
  app.post<{ Params: { name: string } }>('/portal/apps/:name/memory', async (req, reply) => {
    checkSameOrigin(req);
    const u = adminOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const name = req.params.name;
    let flash: string;
    try {
      const m = String(body(req).memory ?? '').toLowerCase();
      if (!MEMORY_CHOICES.includes(m) || memoryMb(m) > config.policy.maxMemoryMb) throw new HttpError(400, 'Choose one of the sizes offered.');
      await ops.setLimits(u.email, name, undefined, m);
      const a = getApp(name)!;
      const on = a.status === 'active' && !!a.engine_id;
      if (on) await appOps.controlApp(u, name, 'restart');
      flash = notice(t(lang, on ? 'mem.done.on' : 'mem.done.off', { app: prettyName(a.name), mem: memLabel(m) }));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      flash = notice(t(lang, 'failed', { msg: tMsg(lang, e.message) }), true);
    }
    return html(req, reply, await appPageHtml(lang, u, name, flash));
  });

  /** A version of the code as a .zip (Windows opens it without other programs). */
  app.get<{ Params: { name: string }; Querystring: { ref?: string } }>('/portal/apps/:name/source', async (req, reply) => {
    const u = userOr(req, reply);
    if (!u) return;
    const a = assertCanManage(u, getApp(req.params.name), req.params.name);
    const ref = req.query.ref && /^[0-9a-f]{7,40}$/.test(req.query.ref) ? req.query.ref : 'main';
    if (!(await repos.headCommit(a.name))) throw new HttpError(404, 'No code stored for this app yet.');
    const dir = await mkdtemp(join(tmpdir(), 'export-'));
    const file = join(dir, 'source.zip');
    await repos.exportArchive(a.name, file, ref, 'zip');
    const sha = ref === 'main' ? (await repos.headCommit(a.name)) ?? 'main' : ref;
    audit(u.email, 'app.download', a.name, { ref: sha });
    const stream = createReadStream(file);
    stream.on('close', () => void rm(dir, { recursive: true, force: true }));
    return reply.type('application/zip').header('Content-Disposition', `attachment; filename="${a.name}-${sha.slice(0, 7)}.zip"`).send(stream);
  });

  app.post<{ Params: { name: string } }>('/portal/apps/:name/env', async (req, reply) => {
    checkSameOrigin(req);
    const u = userOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const b = body(req);
    const key = String(b.key ?? '').trim();
    let flash: string;
    try {
      await appOps.setEnv(u, req.params.name, key, String(b.value ?? ''), getApp(req.params.name)?.status === 'active');
      flash = notice(t(lang, 'env.done.set', { key, app: prettyName(req.params.name) }));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      flash = notice(t(lang, 'failed', { msg: tMsg(lang, e.message) }), true);
    }
    return html(req, reply, await appPageHtml(lang, u, req.params.name, flash));
  });

  app.post<{ Params: { name: string } }>('/portal/apps/:name/env-delete', async (req, reply) => {
    checkSameOrigin(req);
    const u = userOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const key = String(body(req).key ?? '').trim();
    let flash: string;
    try {
      await appOps.deleteEnv(u, req.params.name, key);
      flash = notice(t(lang, 'env.done.delete', { key, app: prettyName(req.params.name) }));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      flash = notice(t(lang, 'failed', { msg: tMsg(lang, e.message) }), true);
    }
    return html(req, reply, await appPageHtml(lang, u, req.params.name, flash));
  });

  app.post<{ Params: { name: string } }>('/portal/apps/:name/restore', async (req, reply) => {
    checkSameOrigin(req);
    const u = userOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    try {
      const r = await appOps.restoreVersion(u, req.params.name, String(body(req).sha ?? ''));
      // back to the list: the app shows as "publishing" until the new version is online
      return html(req, reply, await render(lang, getUser(u.email)!, notice(t(lang, 'ver.done', { app: prettyName(req.params.name), sha: r.restored_from.slice(0, 7) }))));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return html(req, reply, await appPageHtml(lang, u, req.params.name, notice(t(lang, 'failed', { msg: tMsg(lang, e.message) }), true)));
    }
  });

  app.get<{ Params: { name: string }; Querystring: { type?: string } }>('/portal/apps/:name/logs', async (req, reply) => {
    const u = userOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const type = req.query.type === 'build' ? 'build' : 'runtime';
    try {
      const r = await appOps.appLogs(u, req.params.name, type, 200);
      return html(req, reply, await render(lang, u, logsCard(lang, req.params.name, type, r.lines, r.result)));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return html(req, reply, await render(lang, u, notice(t(lang, 'failed', { msg: e.message }), true)));
    }
  });

  /** The connector as a small npm package, for "npx -y <address>". Public on purpose: the AI app downloads it
   *  without signing in. It is the open-source connector code only: no address, key or data inside. */
  app.get<{ Params: { file: string } }>('/connector/:file', async (req, reply) => {
    const d = downloads();
    if (!d) throw new HttpError(503, 'The connector is not available in this installation.');
    if (!/^apprua-mcp[\w.-]*\.tgz$/.test(req.params.file)) throw new HttpError(404, 'Unknown file.');
    return reply.type('application/gzip').header('Cache-Control', 'public, max-age=300').send(d.tgz);
  });

  /** The connector for AI apps: single file for Claude Code / JSON configs, .mcpb for Claude Desktop. */
  app.get<{ Params: { file: string } }>('/download/:file', async (req, reply) => {
    const u = userOr(req, reply);
    if (!u) return;
    const d = downloads();
    if (!d) throw new HttpError(503, 'The connector is not available in this installation.');
    const files: Record<string, [Buffer, string]> = {
      'apprua.mcpb': [d.mcpb, 'application/zip'],
      'apprua-mcp.mjs': [d.server, 'text/javascript'],
    };
    const f = files[req.params.file];
    if (!f) throw new HttpError(404, 'Unknown file.');
    return reply.type(f[1]).header('Content-Disposition', `attachment; filename="${req.params.file}"`).send(f[0]);
  });

  // ----- administration -----

  function adminOr(req: FastifyRequest, reply: FastifyReply): User | null {
    const u = userOr(req, reply);
    if (u && u.role !== 'admin') throw new HttpError(403, 'Administrators only.');
    return u;
  }

  app.post('/portal/admin/revoke', async (req, reply) => {
    checkSameOrigin(req);
    const u = adminOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const email = String(body(req).email ?? '').toLowerCase();
    revokeToken(email, u.email);
    return html(req, reply, await settingsHtml(lang, getUser(u.email)!, notice(t(lang, 'admin.revoked', { email }))));
  });

  /** A new password for a person (they forgot it): made up here, shown once to the administrator. */
  app.post('/portal/admin/password', async (req, reply) => {
    checkSameOrigin(req);
    const u = adminOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const email = String(body(req).email ?? '').toLowerCase();
    if (config.auth.mode !== 'local' || !getUser(email)) throw new HttpError(404, 'Unknown person.');
    const password = randomPassword();
    setPassword(email, password, u.email, { endKey: true });
    // the administrator who gave themselves a new password stays signed in on this device
    if (email === u.email) startSession(req, reply, u.email);
    return html(req, reply, await settingsHtml(lang, getUser(u.email)!, newPasswordNotice(lang, email, password)));
  });

  app.post('/portal/admin/users', async (req, reply) => {
    checkSameOrigin(req);
    const u = adminOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const b = body(req);
    try {
      const created = createLocalUser(String(b.email ?? ''), null, String(b.password ?? ''), b.admin === '1' ? 'admin' : 'user', u.email);
      return html(req, reply, await settingsHtml(lang, getUser(u.email)!, notice(t(lang, 'admin.added', { email: created.email }))));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return html(req, reply, await settingsHtml(lang, getUser(u.email)!, notice(t(lang, 'failed', { msg: tMsg(lang, e.message) }), true)));
    }
  });

  // ----- settings (administrators): resources, rules, who it is for -----

  /** Apps that are on for Apprua but missing or stopped in the engine (e.g. changed by hand in Coolify). */
  async function engineDrift(): Promise<{ name: string; problem: 'missing' | 'stopped' }[]> {
    const on = getDb().prepare(`SELECT name, engine_id FROM apps WHERE status = 'active' AND engine_id IS NOT NULL`).all() as { name: string; engine_id: string }[];
    const out: { name: string; problem: 'missing' | 'stopped' }[] = [];
    await Promise.all(on.map(async (a) => {
      const s = await engine().runtimeStatus(a.engine_id);
      if (s === null) out.push({ name: a.name, problem: 'missing' });
      else if (/^(exited|stopped)/.test(s)) out.push({ name: a.name, problem: 'stopped' });
    }));
    return out.sort((x, y) => x.name.localeCompare(y.name));
  }

  const settingsHtml = async (lang: Lang, u: User, flash = '', checkNet = false) => {
    const eng = await engineStatus();
    const [drift, check, cert] = await Promise.all([
      eng.ok ? engineDrift().catch(() => null) : null,
      checkNet ? networkCheck().catch(() => null) : null,
      ownCertificate().catch(() => null),
    ]);
    const net = { check, cert, id: instanceId() };
    return settingsPage(lang, u, await readResources(), flash, eng.ok, { apps: ops.listAllApps() as any[], users: ops.listUsers() as any[], engine: eng.text, drift, net });
  };

  app.get('/settings', async (req, reply) => {
    const u = adminOr(req, reply);
    if (!u) return;
    // ?check=net: the Check button of "Where the apps open" (names in the DNS, certificate, this device)
    const checkNet = (req.query as Record<string, string> | undefined)?.check === 'net';
    return html(req, reply, await settingsHtml(langOf(req), u, '', checkNet));
  });

  app.post('/settings/rules', async (req, reply) => {
    checkSameOrigin(req);
    const u = adminOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const b = body(req);
    const lk = lockedRules();
    const choice: Rules = {};
    if (config.profile === 'team') {
      const r = parseRules(b.quota, b.review);
      if (!lk.quota) choice.quota = r.quota;
      if (!lk.reviewMonths) choice.reviewMonths = r.reviewMonths;
    }
    if (!lk.memory) choice.memory = parseMemory(b.memory);
    saveRules(choice);
    audit(u.email, 'settings.rules', null, choice);
    return html(req, reply, await settingsHtml(lang, u, notice(t(lang, 'set.saved'))));
  });

  app.post('/settings/profile', async (req, reply) => {
    checkSameOrigin(req);
    const u = adminOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const p = body(req).profile === 'team' ? 'team' : 'personal';
    if (p !== config.profile) { changeProfile(p); audit(u.email, 'settings.profile', null, { profile: p }); }
    return html(req, reply, await settingsHtml(lang, u, notice(t(lang, p === 'team' ? 'set.use.done.team' : 'set.use.done.me'))));
  });

  /** Admin actions on any app; errors are shown on the page. */
  app.post<{ Params: { name: string; action: string } }>('/portal/admin/apps/:name/:action', async (req, reply) => {
    checkSameOrigin(req);
    const u = adminOr(req, reply);
    if (!u) return;
    const lang = langOf(req);
    const { name, action } = req.params;
    let msg: string;
    try {
      switch (action) {
        case 'archive': await ops.archiveApp(u.email, name); msg = t(lang, 'admin.archived', { app: name }); break;
        case 'restore': await ops.restoreApp(u.email, name); msg = t(lang, 'admin.restored', { app: name }); break;
        case 'delete': await ops.deleteAppPermanently(u.email, name, String(body(req).confirm ?? '').trim()); msg = t(lang, 'admin.deleted', { app: name }); break;
        default: throw new HttpError(404, 'Unknown action.');
      }
      return html(req, reply, await settingsHtml(lang, getUser(u.email)!, notice(msg)));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return html(req, reply, await settingsHtml(lang, getUser(u.email)!, notice(t(lang, 'failed', { msg: e.message }), true)));
    }
  });
}

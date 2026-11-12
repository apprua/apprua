import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { ensureInitialAdmin, HttpError } from './auth.js';
import { getDb, openDb } from './db.js';
import { appRoutes } from './routes/apps.js';
import { adminRoutes } from './routes/admin.js';
import { portalRoutes } from './routes/portal.js';
import { gateRoutes } from './routes/gate.js';
import { scheduleReminders } from './reminders.js';
import { scheduleMonitor } from './monitor.js';
import { startGitServer } from './repos.js';
import { secrets } from './secrets.js';
import { startSignpost } from './signpost.js';
import { scheduleAddressMove } from './addresses.js';
import { loadStoredSettings } from './setup.js';
import { VERSION } from './version.js';
import { resolveConnectorSource } from './downloads.js';
import { hideSecrets } from './logs.js';
import { resumeOpenPublications } from './publish.js';
import { startProxyTrust, trustHop } from './proxyTrust.js';

startProxyTrust((m) => console.warn(m));
openDb();
// Publications still "in progress" from before this start: those never sent to the engine are closed as failed; those
// it took, or that were sent and whose answer never came, stay open: they are followed again, or the engine is asked
// whether they started (the app stays reserved meanwhile). See resumeOpenPublications in publish.ts.
getDb().prepare(`UPDATE deploys SET finished_at = datetime('now'), result = 'failed',
  log_excerpt = COALESCE(log_excerpt, 'Apprua restarted before this publication was sent to the engine.') WHERE result IS NULL AND engine_deployment IS NULL AND requested_at IS NULL`).run();
loadStoredSettings();
secrets();
ensureInitialAdmin();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie', `req.headers["${config.auth.proxySecretHeader}"]`],
    // addresses are written without the values that open something: the "forgot your password?" link (?t=), the
    // codes for one use and the like. Whoever reads the logs cannot use them.
    serializers: { req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({ method: req.method, url: hideSecrets(req.url), host: req.hostname, remoteAddress: req.ip }) },
  },
  bodyLimit: 1024 * 1024,
  // only the engine's proxy may say where a request came from (see proxyTrust.ts)
  trustProxy: (address: string) => trustHop(address),
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, details: err.details });
  const status = (err as any).statusCode;
  if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
  req.log.error(err);
  return reply.code(500).send({ error: `Internal error in ${config.brand}. The administrator can find details in the logs.` });
});

// No page of Apprua inside a frame of another page (an app could hide the portal's buttons under its own: clickjacking)
app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Content-Security-Policy', "frame-ancestors 'none'");
  // a browser never guesses the type of what Apprua sends, and never tells other sites which page a link came from
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
});

app.get('/healthz', async () => ({ ok: true, version: VERSION }));
await app.register(multipart, { limits: { fileSize: config.policy.maxArchiveBytes, files: 1, fields: 20 } });
// Each group in its own plugin scope, so the token check of the API does not apply to the portal
await app.register(appRoutes);
await app.register(adminRoutes);
await app.register(portalRoutes);
await app.register(gateRoutes);

await resolveConnectorSource((m) => app.log.warn(m));
const followed = resumeOpenPublications();
if (followed) app.log.info(`${followed} publication(s) still open from before this start: followed until the engine says how they ended`);
await app.listen({ host: '0.0.0.0', port: config.port });
startGitServer();
startSignpost();
scheduleAddressMove((m) => app.log.info(m));
scheduleReminders();
scheduleMonitor();
console.log(`${config.brand} ready: ${config.publicUrl} (profile ${config.profile}, network ${config.network}, apps on ${config.appScheme}://<name>.${config.baseDomain})`);

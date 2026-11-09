// /v1 API used by the MCP connector (Bearer personal token).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError, requireAdmin, requireToken } from '../auth.js';
import { config } from '../config.js';
import { getApp, getDb, type App, type User } from '../db.js';
import { engine } from '../engine/index.js';
import { assertCanManage, exclusive, publish, runDeploy } from '../publish.js';
import * as repos from '../repos.js';
import * as appOps from '../appOps.js';
import { outOfMemory } from '../monitor.js';

const publicApp = (a: App) => ({
  name: a.name, owner: a.owner, description: a.description, url: a.url, status: a.status,
  persistent: !!a.persistent, build: a.build_pack, port: a.port, limits: { cpus: a.cpus, memory: a.memory },
  last_commit: a.last_commit, created_at: a.created_at, last_deploy_at: a.last_deploy_at, review_at: a.review_at,
  // the app went over its memory limit recently: an administrator can give it more (page of the app, or admin_set_limits)
  ...(outOfMemory(a) ? { out_of_memory_at: a.oom_at, out_of_memory_hint: `The app went over its ${a.memory} of memory and the system stopped it, all or in part. An administrator can give it more (up to ${config.policy.maxMemoryMb} MB) on its page in the portal, or with admin_set_limits and then restart_app; or make the app use less memory.` } : {}),
});

/** Reads a multipart upload: one "archive" file (.tar.gz) + text fields. */
async function readUpload(req: FastifyRequest): Promise<{ fields: Record<string, string>; archive: string | null; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'upload-'));
  const fields: Record<string, string> = {};
  let archive: string | null = null;
  try {
    for await (const part of req.parts({ limits: { fileSize: config.policy.maxArchiveBytes, files: 1 } })) {
      if (part.type === 'file') {
        archive = join(dir, 'app.tar.gz');
        await pipeline(part.file, createWriteStream(archive));
        if (part.file.truncated) throw new HttpError(413, `Archive larger than ${config.policy.maxArchiveBytes / 1048576} MB. Exclude big files (data, videos, node_modules).`);
      } else fields[part.fieldname] = String(part.value);
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  return { fields, archive, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const toBool = (v?: string) => v === 'true' || v === '1';
const toPort = (v?: string) => (v ? Number(v) : undefined);

export async function appRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => { (req as any).user = requireToken(req); });
  const userOf = (req: FastifyRequest) => (req as any).user as User;

  app.get('/v1/me', async (req) => {
    const u = userOf(req);
    return { email: u.email, role: u.role, token_expires_at: u.token_expires_at, quota: u.quota ?? config.policy.defaultQuota, brand: config.brand, profile: config.profile };
  });

  app.post('/v1/apps', async (req) => {
    const u = userOf(req);
    const up = await readUpload(req);
    try {
      if (!up.archive) throw new HttpError(400, 'Missing "archive" file.');
      const name = (up.fields.name ?? '').trim();
      const taken = getApp(name);
      if (taken && taken.owner !== u.email) throw new HttpError(409, `The name "${name}" is already used by someone else. Choose a different name.`);
      if (taken) throw new HttpError(409, `"${name}" already exists: use update_app to publish a new version.`);
      return await publish({
        user: u, name, description: up.fields.description, port: toPort(up.fields.port),
        persistent: toBool(up.fields.persistent), archivePath: up.archive,
      });
    } finally { await up.cleanup(); }
  });

  app.post<{ Params: { name: string } }>('/v1/apps/:name/deploy', async (req) => {
    const u = userOf(req);
    const a = assertCanManage(u, getApp(req.params.name), req.params.name);
    if (a.status === 'archived') throw new HttpError(409, `"${a.name}" is archived. Ask an administrator to restore it.`);
    if (!a.engine_id) throw new HttpError(409, 'The app was never deployed: publish it again.');
    if (!req.isMultipart()) return exclusive(a.name, async () => runDeploy(a.name, u.email, 'manual', await repos.headCommit(a.name)));
    const up = await readUpload(req);
    try {
      if (!up.archive) throw new HttpError(400, 'Missing "archive" file.');
      return await publish({
        user: u, name: a.name, description: up.fields.description || undefined, port: toPort(up.fields.port),
        persistent: toBool(up.fields.persistent), archivePath: up.archive,
        baseCommit: up.fields.base_commit || undefined, force: toBool(up.fields.force),
      });
    } finally { await up.cleanup(); }
  });

  app.get('/v1/apps', async (req) => {
    const u = userOf(req);
    const rows = getDb().prepare(`SELECT * FROM apps WHERE owner = ? AND status != 'archived' ORDER BY name`).all(u.email) as unknown as App[];
    return rows.map(publicApp);
  });

  app.get<{ Params: { name: string } }>('/v1/apps/:name', async (req) => {
    const a = assertCanManage(userOf(req), getApp(req.params.name), req.params.name);
    const last = getDb().prepare('SELECT user, source, started_at, finished_at, result, commit_sha, log_excerpt FROM deploys WHERE app = ? ORDER BY id DESC LIMIT 1').get(a.name);
    const runtime = a.engine_id ? await engine().runtimeStatus(a.engine_id) : null;
    const env_keys = a.engine_id ? await appOps.listEnv(userOf(req), a.name).catch(() => [] as string[]) : [];
    return { ...publicApp(a), runtime_status: runtime, last_deploy: last ?? null, versions: await repos.history(a.name, 10), env_keys };
  });

  /** Code of the app (latest version, or ?ref=<commit>) as .tar.gz: used by clone_app. */
  app.get<{ Params: { name: string }; Querystring: { ref?: string } }>('/v1/apps/:name/source', async (req, reply) => {
    const a = assertCanManage(userOf(req), getApp(req.params.name), req.params.name);
    const ref = req.query.ref && /^[0-9a-f]{7,40}$/.test(req.query.ref) ? req.query.ref : 'main';
    if (!(await repos.headCommit(a.name))) throw new HttpError(404, 'No code stored for this app yet.');
    const dir = await mkdtemp(join(tmpdir(), 'export-'));
    const file = join(dir, 'source.tar.gz');
    await repos.exportArchive(a.name, file, ref);
    reply.header('X-Apprua-Commit', ref === 'main' ? (await repos.headCommit(a.name)) ?? '' : ref);
    const stream = createReadStream(file);
    stream.on('close', () => void rm(dir, { recursive: true, force: true }));
    return reply.type('application/gzip').send(stream);
  });

  app.get<{ Params: { name: string }; Querystring: { type?: string; lines?: string } }>('/v1/apps/:name/logs', async (req) =>
    appOps.appLogs(userOf(req), req.params.name, req.query.type === 'build' ? 'build' : 'runtime', Number(req.query.lines ?? 100)));

  for (const action of ['restart', 'stop', 'start'] as const) {
    app.post<{ Params: { name: string } }>(`/v1/apps/:name/${action}`, async (req) => appOps.controlApp(userOf(req), req.params.name, action));
  }

  app.put<{ Params: { name: string }; Body: { key: string; value: string; restart?: boolean } }>('/v1/apps/:name/env', async (req) =>
    appOps.setEnv(userOf(req), req.params.name, req.body?.key, req.body?.value, req.body?.restart !== false));

  app.delete<{ Params: { name: string; key: string }; Querystring: { restart?: string } }>('/v1/apps/:name/env/:key', async (req) =>
    appOps.deleteEnv(userOf(req), req.params.name, req.params.key, req.query.restart !== 'false'));

  /** Puts an older version online again (it becomes the newest one) and waits for the publication. */
  app.post<{ Params: { name: string }; Body: { commit: string } }>('/v1/apps/:name/restore', async (req) =>
    appOps.restoreVersion(userOf(req), req.params.name, String(req.body?.commit ?? ''), true));

  app.put<{ Params: { name: string }; Body: { visibility: string } }>('/v1/apps/:name/visibility', async (req) =>
    appOps.setVisibility(userOf(req), req.params.name, req.body?.visibility));

  app.delete<{ Params: { name: string } }>('/v1/apps/:name', async (req) => appOps.archiveOwnApp(userOf(req), req.params.name));

  /** All active apps: administrators only. */
  app.get('/v1/catalog', async (req) => {
    requireAdmin(userOf(req));
    const rows = getDb().prepare(`SELECT * FROM apps WHERE status = 'active' ORDER BY name`).all() as unknown as App[];
    return rows.map((a) => ({ name: a.name, owner: a.owner, description: a.description, url: a.url, review_at: a.review_at }));
  });
}

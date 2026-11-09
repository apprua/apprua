// /v1/admin: thin HTTP layer over adminOps (used by the MCP admin tools and scripts with an admin token).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAdmin, requireToken } from '../auth.js';
import { getDb, type User } from '../db.js';
import * as ops from '../adminOps.js';

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    const u = requireToken(req);
    requireAdmin(u);
    (req as any).user = u;
  });
  const me = (req: FastifyRequest) => ((req as any).user as User).email;

  app.get('/v1/admin/apps', async () => ops.listAllApps());

  app.put<{ Params: { name: string }; Body: { owner: string } }>('/v1/admin/apps/:name/owner', async (req) =>
    ops.changeOwner(me(req), req.params.name, String(req.body?.owner ?? '')));

  app.put<{ Params: { name: string }; Body: { cpus?: string; memory?: string } }>('/v1/admin/apps/:name/limits', async (req) =>
    ops.setLimits(me(req), req.params.name, req.body?.cpus, req.body?.memory));

  app.put<{ Params: { name: string }; Body: { review_at: string } }>('/v1/admin/apps/:name/review', async (req) =>
    ops.setReview(me(req), req.params.name, String(req.body?.review_at ?? '')));

  app.post<{ Params: { name: string } }>('/v1/admin/apps/:name/restore', async (req) => ops.restoreApp(me(req), req.params.name));

  app.delete<{ Params: { name: string }; Querystring: { confirm?: string } }>('/v1/admin/apps/:name', async (req) =>
    ops.deleteAppPermanently(me(req), req.params.name, String(req.query.confirm ?? '')));

  app.get('/v1/admin/users', async () => ops.listUsers());

  app.post<{ Params: { email: string } }>('/v1/admin/users/:email/revoke', async (req) => ops.revokeUserToken(me(req), req.params.email));

  app.put<{ Params: { email: string }; Body: { quota: number } }>('/v1/admin/users/:email/quota', async (req) =>
    ops.setQuota(me(req), req.params.email, Number(req.body?.quota)));

  app.get('/v1/admin/report', async () => ops.report());

  app.get<{ Querystring: { limit?: string } }>('/v1/admin/audit', async (req) =>
    getDb().prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Math.min(Number(req.query.limit ?? 200), 2000)));
}

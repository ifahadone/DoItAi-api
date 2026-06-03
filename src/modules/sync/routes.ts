/**
 * Sync routes (ApiSpec §6, §7.2) — AUTHENTICATED. Registered inside the
 * `authenticate` scope (src/app.ts), so `request.user` is always set.
 *
 * Thin: validate -> requireUser -> delegate to the service.
 */
import type { FastifyInstance } from 'fastify';
import { parseOrThrow } from '@/lib/validate.js';
import { requireUser } from '@/auth/middleware.js';
import {
  SyncPushRequestSchema,
  SyncPullQuerySchema,
  type SyncPushResponse,
  type SyncPullResponse,
} from '@/contract/schemas.js';
import * as syncService from '@/modules/sync/service.js';

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  // POST /sync/push — batch mutations.
  app.post('/sync/push', async (request): Promise<SyncPushResponse> => {
    const user = requireUser(request);
    const body = parseOrThrow(SyncPushRequestSchema, request.body);
    return syncService.push(body.ops, user.id, app.clock);
  });

  // GET /sync/pull?cursor=&limit= — deltas since cursor.
  app.get('/sync/pull', async (request): Promise<SyncPullResponse> => {
    const user = requireUser(request);
    const query = parseOrThrow(SyncPullQuerySchema, request.query);
    return syncService.pull(user.id, query.cursor, query.limit);
  });
}

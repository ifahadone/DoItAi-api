/**
 * Lists (== projects) REST routes (ApiSpec §7.3) — AUTHENTICATED, intentionally
 * light. Reads are inline owner-scoped queries; writes go through the sync
 * bridge so they land in change_log like any other mutation.
 */
import type { FastifyInstance } from 'fastify';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { taskLists } from '@/db/schema.js';
import { parseOrThrow } from '@/lib/validate.js';
import { errors } from '@/lib/errors.js';
import { requireUser } from '@/auth/middleware.js';
import {
  TaskListCreateSchema,
  TaskListPatchSchema,
  IdParamSchema,
} from '@/contract/schemas.js';
import { taskListRowToPayload } from '@/modules/sync/mapping.js';
import { upsertViaSync, deleteViaSync } from '@/modules/sync/restBridge.js';

async function getOwned(ownerId: string, id: string) {
  const rows = await db
    .select()
    .from(taskLists)
    .where(and(eq(taskLists.id, id), eq(taskLists.ownerId, ownerId)))
    .limit(1);
  return rows[0];
}

export async function registerListRoutes(app: FastifyInstance): Promise<void> {
  // GET /lists
  app.get('/lists', async (request) => {
    const user = requireUser(request);
    const rows = await db
      .select()
      .from(taskLists)
      .where(and(eq(taskLists.ownerId, user.id), isNull(taskLists.deletedAt)))
      .orderBy(desc(taskLists.sortIndex))
      .limit(500);
    return { items: rows.map(taskListRowToPayload) };
  });

  // POST /lists
  app.post('/lists', async (request, reply) => {
    const user = requireUser(request);
    const { id, ...fields } = parseOrThrow(TaskListCreateSchema, request.body);
    await upsertViaSync('list', id, 0, fields, user.id, app.clock);
    const row = await getOwned(user.id, id);
    reply.code(201);
    return row ? taskListRowToPayload(row) : {};
  });

  // GET /lists/{id}
  app.get('/lists/:id', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const row = await getOwned(user.id, id);
    if (!row) throw errors.notFound('List not found');
    return taskListRowToPayload(row);
  });

  // PATCH /lists/{id}
  app.patch('/lists/:id', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const patch = parseOrThrow(TaskListPatchSchema, request.body);
    const existing = await getOwned(user.id, id);
    if (!existing) throw errors.notFound('List not found');
    await upsertViaSync('list', id, existing.serverVersion, patch, user.id, app.clock);
    const row = await getOwned(user.id, id);
    return row ? taskListRowToPayload(row) : {};
  });

  // DELETE /lists/{id}
  app.delete('/lists/:id', async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const existing = await getOwned(user.id, id);
    if (!existing) throw errors.notFound('List not found');
    await deleteViaSync('list', id, existing.serverVersion, user.id, app.clock);
    reply.code(204);
  });
}

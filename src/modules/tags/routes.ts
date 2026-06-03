/**
 * Tags REST routes (ApiSpec §7.3) — AUTHENTICATED, intentionally light. Same
 * shape as lists: inline owner-scoped reads, sync-bridge writes.
 */
import type { FastifyInstance } from 'fastify';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { tags } from '@/db/schema.js';
import { parseOrThrow } from '@/lib/validate.js';
import { errors } from '@/lib/errors.js';
import { requireUser } from '@/auth/middleware.js';
import { TagCreateSchema, TagPatchSchema, IdParamSchema } from '@/contract/schemas.js';
import { tagRowToPayload } from '@/modules/sync/mapping.js';
import { upsertViaSync, deleteViaSync } from '@/modules/sync/restBridge.js';

async function getOwned(ownerId: string, id: string) {
  const rows = await db
    .select()
    .from(tags)
    .where(and(eq(tags.id, id), eq(tags.ownerId, ownerId)))
    .limit(1);
  return rows[0];
}

export async function registerTagRoutes(app: FastifyInstance): Promise<void> {
  // GET /tags
  app.get('/tags', async (request) => {
    const user = requireUser(request);
    const rows = await db
      .select()
      .from(tags)
      .where(and(eq(tags.ownerId, user.id), isNull(tags.deletedAt)))
      .orderBy(desc(tags.createdAt))
      .limit(500);
    return { items: rows.map(tagRowToPayload) };
  });

  // POST /tags
  app.post('/tags', async (request, reply) => {
    const user = requireUser(request);
    const { id, ...fields } = parseOrThrow(TagCreateSchema, request.body);
    await upsertViaSync('tag', id, 0, fields, user.id, app.clock);
    const row = await getOwned(user.id, id);
    reply.code(201);
    return row ? tagRowToPayload(row) : {};
  });

  // PATCH /tags/{id}
  app.patch('/tags/:id', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const patch = parseOrThrow(TagPatchSchema, request.body);
    const existing = await getOwned(user.id, id);
    if (!existing) throw errors.notFound('Tag not found');
    await upsertViaSync('tag', id, existing.serverVersion, patch, user.id, app.clock);
    const row = await getOwned(user.id, id);
    return row ? tagRowToPayload(row) : {};
  });

  // DELETE /tags/{id}
  app.delete('/tags/:id', async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const existing = await getOwned(user.id, id);
    if (!existing) throw errors.notFound('Tag not found');
    await deleteViaSync('tag', id, existing.serverVersion, user.id, app.clock);
    reply.code(204);
  });
}

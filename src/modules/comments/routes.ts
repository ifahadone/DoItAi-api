/**
 * Comment + assignment routes (ApiSpec §7.7) — AUTHENTICATED. Activity feed on a task, @mentions, and
 * assign/reassign. AuthZ (commenter+ / editor+ / membership) is enforced in the service.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '@/db/client.js';
import { requireUser } from '@/auth/middleware.js';
import { parseOrThrow } from '@/lib/validate.js';
import { IdParamSchema } from '@/contract/schemas.js';
import { createComment, listComments, assignTask } from './service.js';

const CommentBodySchema = z.object({ body: z.string().min(1).max(4000) }).strict();
const AssignBodySchema = z.object({ assigneeUserId: z.string().uuid().nullable() }).strict();

export async function registerCommentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tasks/:id/comments', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const rows = await db.transaction((tx) => listComments(id, user.id, tx));
    return { comments: rows };
  });

  app.post('/tasks/:id/comments', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const body = parseOrThrow(CommentBodySchema, request.body);
    const comment = await db.transaction((tx) => createComment(id, user.id, body.body, app.clock.nowIso(), tx));
    return { comment };
  });

  app.post('/tasks/:id/assign', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const body = parseOrThrow(AssignBodySchema, request.body);
    const task = await db.transaction((tx) => assignTask(id, body.assigneeUserId, user.id, app.clock.nowIso(), tx));
    return { task: { id: task.id, assigneeUserId: task.assigneeUserId, serverVersion: task.serverVersion } };
  });
}

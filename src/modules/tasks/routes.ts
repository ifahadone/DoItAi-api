/**
 * Tasks REST routes (ApiSpec §7.3) — AUTHENTICATED worked example. Thin:
 * validate -> requireUser -> delegate. Most clients mutate via /sync/push; these
 * exist for the future web client, App Intents, and simple ops (ApiSpec §7).
 */
import type { FastifyInstance } from 'fastify';
import { parseOrThrow } from '@/lib/validate.js';
import { requireUser } from '@/auth/middleware.js';
import {
  TaskCreateSchema,
  TaskPatchSchema,
  TaskListQuerySchema,
  IdParamSchema,
} from '@/contract/schemas.js';
import * as tasksService from '@/modules/tasks/service.js';

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  // GET /tasks
  app.get('/tasks', async (request) => {
    const user = requireUser(request);
    const q = parseOrThrow(TaskListQuerySchema, request.query);
    const items = await tasksService.list({
      ownerId: user.id,
      ...(q.listId !== undefined ? { listId: q.listId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.dueBefore !== undefined ? { dueBefore: q.dueBefore } : {}),
      limit: q.limit,
    });
    return { items };
  });

  // POST /tasks
  app.post('/tasks', async (request, reply) => {
    const user = requireUser(request);
    const body = parseOrThrow(TaskCreateSchema, request.body);
    const task = await tasksService.create(user.id, body, app.clock);
    reply.code(201);
    return task;
  });

  // GET /tasks/{id}
  app.get('/tasks/:id', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    return tasksService.get(user.id, id);
  });

  // PATCH /tasks/{id}
  app.patch('/tasks/:id', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const patch = parseOrThrow(TaskPatchSchema, request.body);
    return tasksService.update(user.id, id, patch, app.clock);
  });

  // DELETE /tasks/{id}
  app.delete('/tasks/:id', async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    await tasksService.remove(user.id, id, app.clock);
    reply.code(204);
  });
}

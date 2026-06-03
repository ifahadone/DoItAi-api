/**
 * Tasks service (ApiSpec §7.3) — the worked CRUD example.
 *
 * Reads delegate to tasks/repository.ts. WRITES are expressed as single-op sync
 * pushes so REST mutations are indistinguishable from app sync: they get a
 * change_log entry, server_version bump, conflict handling, and idempotency for
 * free (DoD: "no out-of-band writes"). This keeps one write path in the system.
 */
import type { Clock } from '@/lib/clock.js';
import { errors } from '@/lib/errors.js';
import type { TaskCreate, TaskPatch } from '@/contract/schemas.js';
import { upsertViaSync, deleteViaSync } from '@/modules/sync/restBridge.js';
import * as taskRepo from '@/modules/tasks/repository.js';

/** GET /tasks/{id}. */
export async function get(ownerId: string, id: string): Promise<Record<string, unknown>> {
  const task = await taskRepo.getTask(ownerId, id);
  if (!task) throw errors.notFound('Task not found');
  return task;
}

export interface ListArgs {
  ownerId: string;
  listId?: string;
  status?: number;
  dueBefore?: string;
  limit: number;
}

/** GET /tasks. */
export async function list(args: ListArgs): Promise<Record<string, unknown>[]> {
  return taskRepo.listTasks({
    ownerId: args.ownerId,
    ...(args.listId !== undefined ? { listId: args.listId } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.dueBefore !== undefined ? { dueBefore: args.dueBefore } : {}),
    limit: args.limit,
  });
}

/** POST /tasks — create (client-supplied id; idempotent upsert). */
export async function create(
  ownerId: string,
  body: TaskCreate,
  clock: Clock,
): Promise<Record<string, unknown>> {
  const { id, ...fields } = body;
  await upsertViaSync('task', id, 0, fields, ownerId, clock);
  return get(ownerId, id);
}

/** PATCH /tasks/{id} — partial update at the current server_version. */
export async function update(
  ownerId: string,
  id: string,
  patch: TaskPatch,
  clock: Clock,
): Promise<Record<string, unknown>> {
  const version = await taskRepo.getOwnedVersion(ownerId, id);
  if (version === undefined) throw errors.notFound('Task not found');
  await upsertViaSync('task', id, version, patch, ownerId, clock);
  return get(ownerId, id);
}

/** DELETE /tasks/{id} — soft-delete (tombstone). */
export async function remove(ownerId: string, id: string, clock: Clock): Promise<void> {
  const version = await taskRepo.getOwnedVersion(ownerId, id);
  if (version === undefined) throw errors.notFound('Task not found');
  await deleteViaSync('task', id, version, ownerId, clock);
}

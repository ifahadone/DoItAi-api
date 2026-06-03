/**
 * Tasks read repository (ApiSpec §7.3). ALL SQL for direct task reads lives
 * here. WRITES (create/update/delete) intentionally do NOT live here — they go
 * through the sync engine so every mutation lands in change_log with proper
 * versioning (DoD: "no out-of-band writes"). See tasks/service.ts.
 */
import { eq, and, isNull, desc, lte } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { tasks, taskTags } from '@/db/schema.js';
import type { TaskRow } from '@/db/schema.js';
import { taskRowToPayload } from '@/modules/sync/mapping.js';

export interface ListTasksFilter {
  ownerId: string;
  listId?: string;
  status?: number;
  dueBefore?: string;
  /** Exclude tombstones by default. */
  includeDeleted?: boolean;
  limit: number;
}

async function tagIdsFor(taskId: string): Promise<string[]> {
  const rows = await db
    .select({ tagId: taskTags.tagId })
    .from(taskTags)
    .where(eq(taskTags.taskId, taskId));
  return rows.map((r) => r.tagId);
}

/** Fetch a single owned task as the wire payload, or undefined. */
export async function getTask(
  ownerId: string,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.ownerId, ownerId)))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return taskRowToPayload(row, await tagIdsFor(id));
}

/** List owned tasks with optional filters (ApiSpec §7.3). */
export async function listTasks(
  filter: ListTasksFilter,
): Promise<Record<string, unknown>[]> {
  const conds = [eq(tasks.ownerId, filter.ownerId)];
  if (!filter.includeDeleted) conds.push(isNull(tasks.deletedAt));
  if (filter.listId !== undefined) conds.push(eq(tasks.listId, filter.listId));
  if (filter.status !== undefined) conds.push(eq(tasks.status, filter.status));
  if (filter.dueBefore !== undefined) conds.push(lte(tasks.dueAt, filter.dueBefore));

  const rows: TaskRow[] = await db
    .select()
    .from(tasks)
    .where(and(...conds))
    .orderBy(desc(tasks.updatedAt))
    .limit(filter.limit);

  // N+1 on tags is acceptable for the Phase 0 worked example; batch later if hot.
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    out.push(taskRowToPayload(row, await tagIdsFor(row.id)));
  }
  return out;
}

/** Current server_version of an owned task (for building a sync op from REST). */
export async function getOwnedVersion(
  ownerId: string,
  id: string,
): Promise<number | undefined> {
  const rows = await db
    .select({ v: tasks.serverVersion, owner: tasks.ownerId })
    .from(tasks)
    .where(eq(tasks.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  if (row.owner !== ownerId) return undefined; // cross-tenant -> treat as absent
  return row.v;
}

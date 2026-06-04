/**
 * Comments + assignment (ApiSpec §7.7). Comments are created via REST (not sync push); each appends a
 * change_log entry visible to the share members, so it fans out + appears in everyone's next pull.
 * `@mentions` are extracted for activity/notification (the push itself is APNs — device-bound).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { type Tx } from '@/db/client.js';
import { comments, tasks, taskTags, type CommentRow, type TaskRow } from '@/db/schema.js';
import { errors } from '@/lib/errors.js';
import { appendChange } from '@/modules/sync/repository.js';
import { taskRowToPayload } from '@/modules/sync/mapping.js';
import { memberIdsForList, roleOnList, roleAtLeast } from '@/modules/sharing/service.js';

const MENTION_RE = /@([A-Za-z0-9_]+)/g;

/** Extract distinct @tokens from a comment body (handles to resolve + notify). */
export function extractMentions(body: string): string[] {
  return Array.from(new Set(Array.from(body.matchAll(MENTION_RE), (m) => m[1]!)));
}

function commentPayload(row: CommentRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerId: row.ownerId,
    taskId: row.taskId,
    body: row.body,
    mentions: row.mentions ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    serverVersion: row.serverVersion,
    deletedAt: row.deletedAt,
  };
}

async function taskContext(taskId: string, tx: Tx): Promise<{ listId: string | null; ownerId: string } | null> {
  const [row] = await tx.select({ listId: tasks.listId, ownerId: tasks.ownerId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row ?? null;
}

async function tagIdsFor(taskId: string, tx: Tx): Promise<string[]> {
  const rows = await tx.select({ tagId: taskTags.tagId }).from(taskTags).where(eq(taskTags.taskId, taskId));
  return rows.map((r) => r.tagId);
}

/** Visibility for a task's collaboration: the share members, or just the owner if unshared. */
async function visibleFor(listId: string | null, ownerId: string, tx: Tx): Promise<string[]> {
  if (!listId) return [ownerId];
  const members = await memberIdsForList(listId, tx);
  return members.length ? members : [ownerId];
}

export async function createComment(taskId: string, authorId: string, body: string, nowIso: string, tx: Tx): Promise<CommentRow> {
  const ctx = await taskContext(taskId, tx);
  if (!ctx) throw errors.notFound('Task not found');
  if (ctx.ownerId !== authorId) {
    const role = ctx.listId ? await roleOnList(ctx.listId, authorId, tx) : null;
    if (!role || !roleAtLeast(role, 'commenter')) throw errors.forbidden('Cannot comment on this task');
  }

  const id = randomUUID();
  const [row] = await tx
    .insert(comments)
    .values({ id, ownerId: authorId, taskId, body, mentions: extractMentions(body), createdAt: nowIso, updatedAt: nowIso })
    .returning();

  const visible = await visibleFor(ctx.listId, ctx.ownerId, tx);
  await appendChange(
    { entityType: 'comment', entityId: id, op: 'upsert', version: 1, actorUserId: authorId, visibleUserIds: visible, payload: commentPayload(row!), nowIso },
    tx,
  );
  return row!;
}

export async function listComments(taskId: string, userId: string, tx: Tx): Promise<CommentRow[]> {
  const ctx = await taskContext(taskId, tx);
  if (!ctx) throw errors.notFound('Task not found');
  if (ctx.ownerId !== userId) {
    const role = ctx.listId ? await roleOnList(ctx.listId, userId, tx) : null;
    if (!role) throw errors.forbidden('No access to this task');
  }
  return tx.select().from(comments).where(and(eq(comments.taskId, taskId), isNull(comments.deletedAt))).orderBy(asc(comments.createdAt));
}

export async function assignTask(taskId: string, assigneeUserId: string | null, actorId: string, nowIso: string, tx: Tx): Promise<TaskRow> {
  const ctx = await taskContext(taskId, tx);
  if (!ctx) throw errors.notFound('Task not found');
  if (ctx.ownerId !== actorId) {
    const role = ctx.listId ? await roleOnList(ctx.listId, actorId, tx) : null;
    if (!role || !roleAtLeast(role, 'editor')) throw errors.forbidden('Cannot assign this task');
  }
  const members = await visibleFor(ctx.listId, ctx.ownerId, tx);
  if (assigneeUserId && !members.includes(assigneeUserId)) {
    throw errors.validation('Assignee is not a member of this list');
  }

  await tx.update(tasks).set({ assigneeUserId, serverVersion: sql`${tasks.serverVersion} + 1`, updatedAt: nowIso }).where(eq(tasks.id, taskId));
  const [updated] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  await appendChange(
    { entityType: 'task', entityId: taskId, op: 'upsert', version: updated!.serverVersion, actorUserId: actorId, visibleUserIds: members, payload: taskRowToPayload(updated!, await tagIdsFor(taskId, tx)), nowIso },
    tx,
  );
  return updated!;
}

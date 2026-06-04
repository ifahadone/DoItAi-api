/**
 * Sharing & collaboration service (ApiSpec §7.7). A `share` makes a list collaborative; visibility
 * fans out via `change_log.visible_user_ids` = the share's member set (so members pull each other's
 * changes through the normal sync). All functions take a `Tx` so they compose inside the push commit
 * + the accept transaction; route handlers wrap them in `db.transaction`.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { type Tx } from '@/db/client.js';
import { shares, shareMembers, invites, taskLists, tasks, taskTags } from '@/db/schema.js';
import { errors } from '@/lib/errors.js';
import { appendChange } from '@/modules/sync/repository.js';
import { taskListRowToPayload, taskRowToPayload } from '@/modules/sync/mapping.js';

export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';
const RANK: Record<string, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };
export const isRole = (r: string): r is Role => r in RANK;
/** True if `role` is at least `min` in the hierarchy (viewer < commenter < editor < owner). */
export const roleAtLeast = (role: string, min: Role): boolean => (RANK[role] ?? -1) >= (RANK[min] ?? 0);

// MARK: - Visibility + roles

/** The visibility set for a list's entities: the list owner + every share member. */
export async function memberIdsForList(listId: string, tx: Tx): Promise<string[]> {
  const [list] = await tx
    .select({ ownerId: taskLists.ownerId, shareId: taskLists.shareId })
    .from(taskLists)
    .where(eq(taskLists.id, listId))
    .limit(1);
  if (!list) return [];
  const ids = new Set<string>([list.ownerId]);
  if (list.shareId) {
    const members = await tx.select({ userId: shareMembers.userId }).from(shareMembers).where(eq(shareMembers.shareId, list.shareId));
    for (const m of members) ids.add(m.userId);
  }
  return Array.from(ids);
}

/** The user's role on a list (via its share); 'owner' if they own the list, else their member role, else null. */
export async function roleOnList(listId: string, userId: string, tx: Tx): Promise<Role | null> {
  const [list] = await tx
    .select({ ownerId: taskLists.ownerId, shareId: taskLists.shareId })
    .from(taskLists)
    .where(eq(taskLists.id, listId))
    .limit(1);
  if (!list) return null;
  if (list.ownerId === userId) return 'owner';
  if (!list.shareId) return null;
  const [member] = await tx
    .select({ role: shareMembers.role })
    .from(shareMembers)
    .where(and(eq(shareMembers.shareId, list.shareId), eq(shareMembers.userId, userId)))
    .limit(1);
  return member ? (member.role as Role) : null;
}

// MARK: - Share lifecycle

/** Create (or return the existing) share for a list the user owns; seeds the owner as a member. */
export async function ensureShareForList(listId: string, userId: string, tx: Tx) {
  const [list] = await tx.select().from(taskLists).where(eq(taskLists.id, listId)).limit(1);
  if (!list || list.deletedAt) throw errors.notFound('List not found');
  if (list.ownerId !== userId) throw errors.forbidden('Only the list owner can share it');

  if (list.shareId) {
    const [existing] = await tx.select().from(shares).where(eq(shares.id, list.shareId)).limit(1);
    if (existing) return existing;
  }
  const shareId = randomUUID();
  const [share] = await tx
    .insert(shares)
    .values({ id: shareId, listId, ownerId: userId })
    .returning();
  await tx.update(taskLists).set({ shareId }).where(eq(taskLists.id, listId));
  await tx
    .insert(shareMembers)
    .values({ id: randomUUID(), shareId, userId, role: 'owner' })
    .onConflictDoNothing();
  return share!;
}

export async function getShareById(shareId: string, tx: Tx) {
  const [share] = await tx.select().from(shares).where(eq(shares.id, shareId)).limit(1);
  return share ?? null;
}

/** Stop sharing (owner only): delete the share (cascades members/invites) + clear the list pointer. */
export async function stopSharing(shareId: string, userId: string, tx: Tx): Promise<void> {
  const share = await getShareById(shareId, tx);
  if (!share) throw errors.notFound('Share not found');
  if (share.ownerId !== userId) throw errors.forbidden('Only the owner can stop sharing');
  await tx.update(taskLists).set({ shareId: null }).where(eq(taskLists.id, share.listId));
  await tx.delete(shares).where(eq(shares.id, shareId));
}

// MARK: - Members

export async function listMembers(shareId: string, userId: string, tx: Tx) {
  const share = await getShareById(shareId, tx);
  if (!share) throw errors.notFound('Share not found');
  const role = await roleOnList(share.listId, userId, tx);
  if (!role) throw errors.forbidden('Not a member of this share');
  return tx.select().from(shareMembers).where(eq(shareMembers.shareId, shareId));
}

export async function setMemberRole(shareId: string, memberUserId: string, role: Role, actorId: string, tx: Tx): Promise<void> {
  const share = await getShareById(shareId, tx);
  if (!share) throw errors.notFound('Share not found');
  if (share.ownerId !== actorId) throw errors.forbidden('Only the owner can change roles');
  if (memberUserId === share.ownerId) throw errors.validation('Cannot change the owner role');
  await tx.update(shareMembers).set({ role }).where(and(eq(shareMembers.shareId, shareId), eq(shareMembers.userId, memberUserId)));
}

export async function removeMember(shareId: string, memberUserId: string, actorId: string, tx: Tx): Promise<void> {
  const share = await getShareById(shareId, tx);
  if (!share) throw errors.notFound('Share not found');
  // Owner can remove anyone; a member can remove themselves (leave).
  if (share.ownerId !== actorId && memberUserId !== actorId) throw errors.forbidden('Cannot remove this member');
  if (memberUserId === share.ownerId) throw errors.validation('The owner cannot be removed');
  await tx.delete(shareMembers).where(and(eq(shareMembers.shareId, shareId), eq(shareMembers.userId, memberUserId)));
}

// MARK: - Invites

export async function createInvite(shareId: string, role: Role, createdBy: string, tx: Tx) {
  const share = await getShareById(shareId, tx);
  if (!share) throw errors.notFound('Share not found');
  if (share.ownerId !== createdBy) throw errors.forbidden('Only the owner can invite');
  const token = randomBytes(18).toString('base64url');
  const [invite] = await tx
    .insert(invites)
    .values({ token, shareId, role, createdBy })
    .returning();
  return invite!;
}

/** Accept an invite → become a member, then backfill the list's current entities for the new member. */
export async function acceptInvite(token: string, userId: string, nowIso: string, tx: Tx) {
  const [invite] = await tx.select().from(invites).where(eq(invites.token, token)).limit(1);
  if (!invite) throw errors.notFound('Invite not found');
  if (invite.revokedAt) throw errors.gone('Invite was revoked');
  if (invite.expiresAt && Date.parse(invite.expiresAt) < Date.parse(nowIso)) throw errors.gone('Invite has expired');

  const share = await getShareById(invite.shareId, tx);
  if (!share) throw errors.gone('Share no longer exists');

  await tx
    .insert(shareMembers)
    .values({ id: randomUUID(), shareId: invite.shareId, userId, role: invite.role })
    .onConflictDoNothing(); // already a member → no-op

  await backfillListForMembers(share.listId, nowIso, tx);
  return share;
}

export async function reportInvite(token: string, nowIso: string, tx: Tx): Promise<void> {
  await tx.update(invites).set({ reportedAt: nowIso, revokedAt: nowIso }).where(eq(invites.token, token));
}

// MARK: - Backfill (P5-2)

/**
 * Re-emit the list's current entities into change_log with the up-to-date member visibility set, so a
 * newly-joined member's next `sync/pull` includes them. Existing members get a harmless idempotent
 * re-emit (resolved by client-side LWW).
 */
export async function backfillListForMembers(listId: string, nowIso: string, tx: Tx): Promise<void> {
  const visible = await memberIdsForList(listId, tx);
  if (visible.length <= 1) return; // not actually shared

  const [list] = await tx.select().from(taskLists).where(eq(taskLists.id, listId)).limit(1);
  if (list && !list.deletedAt) {
    await appendChange(
      { entityType: 'list', entityId: list.id, op: 'upsert', version: list.serverVersion, actorUserId: list.ownerId, visibleUserIds: visible, payload: taskListRowToPayload(list), nowIso },
      tx,
    );
  }

  const listTasks = await tx.select().from(tasks).where(and(eq(tasks.listId, listId), isNull(tasks.deletedAt)));
  if (listTasks.length === 0) return;

  // Batch the tag ids for all tasks in one query.
  const taskIds = listTasks.map((t) => t.id);
  const tagRows = await tx.select().from(taskTags).where(inArray(taskTags.taskId, taskIds));
  const tagsByTask = new Map<string, string[]>();
  for (const row of tagRows) {
    const arr = tagsByTask.get(row.taskId) ?? [];
    arr.push(row.tagId);
    tagsByTask.set(row.taskId, arr);
  }

  for (const task of listTasks) {
    await appendChange(
      { entityType: 'task', entityId: task.id, op: 'upsert', version: task.serverVersion, actorUserId: task.ownerId, visibleUserIds: visible, payload: taskRowToPayload(task, tagsByTask.get(task.id) ?? []), nowIso },
      tx,
    );
  }
}

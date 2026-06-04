/**
 * Account data export + deletion (ApiSpec §11, GDPR / Apple account-deletion compliance).
 *
 * Export gathers every row the user owns into a portable JSON bundle. Delete purges all owned data in
 * one FK-safe transaction (idempotent — safe to re-run; e.g. retried after an Apple deletion webhook).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  users,
  taskLists,
  tags,
  tasks,
  reminders,
  checklistItems,
  routines,
  alarms,
  aiUsage,
  subscriptions,
  devices,
  refreshTokens,
  changeLog,
} from '@/db/schema.js';

export async function exportUserData(userId: string, nowIso: string): Promise<Record<string, unknown>> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const [taskRows, listRows, tagRows, reminderRows, checklistRows, routineRows, alarmRows, subRows] =
    await Promise.all([
      db.select().from(tasks).where(eq(tasks.ownerId, userId)),
      db.select().from(taskLists).where(eq(taskLists.ownerId, userId)),
      db.select().from(tags).where(eq(tags.ownerId, userId)),
      db.select().from(reminders).where(eq(reminders.ownerId, userId)),
      db.select().from(checklistItems).where(eq(checklistItems.ownerId, userId)),
      db.select().from(routines).where(eq(routines.ownerId, userId)),
      db.select().from(alarms).where(eq(alarms.ownerId, userId)),
      db.select().from(subscriptions).where(eq(subscriptions.ownerId, userId)),
    ]);

  return {
    exportedAt: nowIso,
    user: user
      ? {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          settings: user.settings,
          aiConsent: user.aiConsent,
          createdAt: user.createdAt,
        }
      : null,
    counts: {
      tasks: taskRows.length,
      lists: listRows.length,
      tags: tagRows.length,
      reminders: reminderRows.length,
      checklistItems: checklistRows.length,
      routines: routineRows.length,
      alarms: alarmRows.length,
      subscriptions: subRows.length,
    },
    tasks: taskRows,
    lists: listRows,
    tags: tagRows,
    reminders: reminderRows,
    checklistItems: checklistRows,
    routines: routineRows,
    alarms: alarmRows,
    subscriptions: subRows,
  };
}

/** Hard-delete all of a user's data + the user row, in one transaction (children before parents). */
export async function deleteUserData(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(subscriptions).where(eq(subscriptions.ownerId, userId));
    await tx.delete(aiUsage).where(eq(aiUsage.ownerId, userId));
    await tx.delete(changeLog).where(eq(changeLog.actorUserId, userId));
    await tx.delete(alarms).where(eq(alarms.ownerId, userId));
    await tx.delete(reminders).where(eq(reminders.ownerId, userId));
    await tx.delete(checklistItems).where(eq(checklistItems.ownerId, userId));
    // tasks cascades task_tags + any task-scoped children; a single statement clears self-FK subtrees.
    await tx.delete(tasks).where(eq(tasks.ownerId, userId));
    await tx.delete(routines).where(eq(routines.ownerId, userId));
    await tx.delete(tags).where(eq(tags.ownerId, userId));
    await tx.delete(taskLists).where(eq(taskLists.ownerId, userId));
    await tx.delete(devices).where(eq(devices.userId, userId));
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
    await tx.delete(users).where(and(eq(users.id, userId)));
  });
}

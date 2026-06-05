/**
 * Sync persistence (ApiSpec §6). ALL SQL for the sync engine lives here.
 *
 * Responsibilities:
 *  - load the current row + ownership for an entity (any synced type)
 *  - apply a generic upsert / soft-delete and bump server_version
 *  - manage task<->tag join rows
 *  - append to change_log and read deltas (the pull cursor)
 *  - read/write the idempotency journal
 *
 * Conflict resolution itself is NOT here — that's the pure resolver
 * (conflict.ts), called by the service. This layer only reads and writes.
 */
import { eq, and, gt, sql } from 'drizzle-orm';
import { db, type Tx } from '@/db/client.js';
import {
  tasks,
  taskLists,
  tags,
  taskTags,
  reminders,
  checklistItems,
  routines,
  alarms,
  noteFolders,
  notes,
  changeLog,
  idempotencyKeys,
} from '@/db/schema.js';
import type { EntityType, SyncPushResult } from '@/contract/schemas.js';
import {
  taskRowToPayload,
  taskListRowToPayload,
  tagRowToPayload,
  reminderRowToPayload,
  checklistItemRowToPayload,
  routineRowToPayload,
  alarmRowToPayload,
  noteFolderRowToPayload,
  noteRowToPayload,
  upsertableColumns,
} from '@/modules/sync/mapping.js';

/** A minimal, type-agnostic snapshot the conflict resolver consumes. */
export interface CurrentEntity {
  exists: boolean;
  ownerId: string | null;
  serverVersion: number;
  updatedAt: string | null;
  deleted: boolean;
  /** Wire-shaped snapshot of the current row (for serverFields on server-win). */
  payload: Record<string, unknown>;
  /** Per-field LWW metadata (tasks only); undefined for entities tracked row-level. */
  fieldMeta?: Record<string, { v: number; updatedAt: string }>;
}

const ABSENT: CurrentEntity = {
  exists: false,
  ownerId: null,
  serverVersion: 0,
  updatedAt: null,
  deleted: false,
  payload: {},
};

// --- task <-> tag join helpers ---------------------------------------------

async function loadTagIds(taskId: string, tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ tagId: taskTags.tagId })
    .from(taskTags)
    .where(eq(taskTags.taskId, taskId));
  return rows.map((r) => r.tagId);
}

/** Replace a task's tag set with `tagIds` (no-op when undefined). */
async function syncTaskTags(
  taskId: string,
  tagIds: string[] | undefined,
  tx: Tx,
): Promise<void> {
  if (tagIds === undefined) return;
  await tx.delete(taskTags).where(eq(taskTags.taskId, taskId));
  if (tagIds.length > 0) {
    await tx
      .insert(taskTags)
      .values(tagIds.map((tagId) => ({ taskId, tagId })))
      .onConflictDoNothing();
  }
}

// --- load current ----------------------------------------------------------

/** Load the current entity snapshot for conflict resolution. */
export async function loadCurrent(
  entityType: EntityType,
  entityId: string,
  tx: Tx,
): Promise<CurrentEntity> {
  if (entityType === 'task') {
    const rows = await tx.select().from(tasks).where(eq(tasks.id, entityId)).limit(1);
    const row = rows[0];
    if (!row) return ABSENT;
    const tagIds = await loadTagIds(entityId, tx);
    return {
      exists: true,
      ownerId: row.ownerId,
      serverVersion: row.serverVersion,
      updatedAt: row.updatedAt,
      deleted: row.deletedAt !== null,
      payload: taskRowToPayload(row, tagIds),
      fieldMeta: (row.fieldMeta ?? {}) as Record<string, { v: number; updatedAt: string }>,
    };
  }
  if (entityType === 'list') {
    const rows = await tx.select().from(taskLists).where(eq(taskLists.id, entityId)).limit(1);
    const row = rows[0];
    if (!row) return ABSENT;
    return {
      exists: true,
      ownerId: row.ownerId,
      serverVersion: row.serverVersion,
      updatedAt: row.updatedAt,
      deleted: row.deletedAt !== null,
      payload: taskListRowToPayload(row),
    };
  }
  if (entityType === 'reminder') {
    const rows = await tx.select().from(reminders).where(eq(reminders.id, entityId)).limit(1);
    const row = rows[0];
    if (!row) return ABSENT;
    return {
      exists: true,
      ownerId: row.ownerId,
      serverVersion: row.serverVersion,
      updatedAt: row.updatedAt,
      deleted: row.deletedAt !== null,
      payload: reminderRowToPayload(row),
    };
  }
  if (entityType === 'checklist') {
    const rows = await tx.select().from(checklistItems).where(eq(checklistItems.id, entityId)).limit(1);
    const row = rows[0];
    if (!row) return ABSENT;
    return {
      exists: true,
      ownerId: row.ownerId,
      serverVersion: row.serverVersion,
      updatedAt: row.updatedAt,
      deleted: row.deletedAt !== null,
      payload: checklistItemRowToPayload(row),
    };
  }
  if (entityType === 'routine') {
    const rows = await tx.select().from(routines).where(eq(routines.id, entityId)).limit(1);
    const row = rows[0];
    if (!row) return ABSENT;
    return {
      exists: true,
      ownerId: row.ownerId,
      serverVersion: row.serverVersion,
      updatedAt: row.updatedAt,
      deleted: row.deletedAt !== null,
      payload: routineRowToPayload(row),
    };
  }
  if (entityType === 'alarm') {
    const rows = await tx.select().from(alarms).where(eq(alarms.id, entityId)).limit(1);
    const row = rows[0];
    if (!row) return ABSENT;
    return {
      exists: true,
      ownerId: row.ownerId,
      serverVersion: row.serverVersion,
      updatedAt: row.updatedAt,
      deleted: row.deletedAt !== null,
      payload: alarmRowToPayload(row),
    };
  }
  if (entityType === 'noteFolder') {
    const rows = await tx.select().from(noteFolders).where(eq(noteFolders.id, entityId)).limit(1);
    const row = rows[0];
    if (!row) return ABSENT;
    return {
      exists: true,
      ownerId: row.ownerId,
      serverVersion: row.serverVersion,
      updatedAt: row.updatedAt,
      deleted: row.deletedAt !== null,
      payload: noteFolderRowToPayload(row),
    };
  }
  if (entityType === 'note') {
    const rows = await tx.select().from(notes).where(eq(notes.id, entityId)).limit(1);
    const row = rows[0];
    if (!row) return ABSENT;
    return {
      exists: true,
      ownerId: row.ownerId,
      serverVersion: row.serverVersion,
      updatedAt: row.updatedAt,
      deleted: row.deletedAt !== null,
      payload: noteRowToPayload(row),
    };
  }
  // tag
  const rows = await tx.select().from(tags).where(eq(tags.id, entityId)).limit(1);
  const row = rows[0];
  if (!row) return ABSENT;
  return {
    exists: true,
    ownerId: row.ownerId,
    serverVersion: row.serverVersion,
    updatedAt: row.updatedAt,
    deleted: row.deletedAt !== null,
    payload: tagRowToPayload(row),
  };
}

// --- apply upsert ----------------------------------------------------------

/**
 * Build the column update object from a validated patch, keeping only the
 * allowlisted upsertable columns for the entity type.
 */
function pickColumns(
  entityType: EntityType,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const allow = upsertableColumns[entityType];
  const out: Record<string, unknown> = {};
  for (const key of allow) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      out[key] = fields[key];
    }
  }
  return out;
}

export interface ApplyUpsertArgs {
  entityType: EntityType;
  entityId: string;
  ownerId: string;
  fields: Record<string, unknown>;
  /** server_version to write (caller computes prev+1, or 1 for a new row). */
  newVersion: number;
  nowIso: string;
  /** True when the row did not previously exist (drives INSERT vs UPDATE). */
  isNew: boolean;
  /** Updated per-field LWW metadata to persist (tasks only; merged by the service). */
  fieldMeta?: Record<string, { v: number; updatedAt: string }>;
}

/**
 * Apply an upsert and return the fresh wire payload.
 *
 * `cols` is the contract-validated patch projected to the entity's writable
 * columns (see pickColumns + the upsertableColumns allowlist). Because the keys
 * and value types are guaranteed by the Zod patch schema (which mirrors the
 * table), we cast the projection to the table's partial insert type at the
 * single boundary below rather than re-listing every column.
 */
export async function applyUpsert(args: ApplyUpsertArgs, tx: Tx): Promise<Record<string, unknown>> {
  const cols = pickColumns(args.entityType, args.fields);

  if (args.entityType === 'task') {
    const tagIds = Array.isArray(args.fields['tagIds'])
      ? (args.fields['tagIds'] as string[])
      : undefined;
    const colVals = cols as unknown as Partial<typeof tasks.$inferInsert>;

    if (args.isNew) {
      await tx.insert(tasks).values({
        ...colVals,
        id: args.entityId,
        ownerId: args.ownerId,
        title: typeof cols['title'] === 'string' ? (cols['title'] as string) : '',
        ...(args.fieldMeta ? { fieldMeta: args.fieldMeta } : {}),
        createdAt: args.nowIso,
        updatedAt: args.nowIso,
        serverVersion: args.newVersion,
        deletedAt: null,
      });
    } else {
      // An upsert never resurrects a tombstone (the resolver refuses
      // upsert-over-delete), so we don't touch deletedAt here.
      await tx
        .update(tasks)
        .set({
          ...colVals,
          ...(args.fieldMeta ? { fieldMeta: args.fieldMeta } : {}),
          updatedAt: args.nowIso,
          serverVersion: args.newVersion,
        })
        .where(eq(tasks.id, args.entityId));
    }
    await syncTaskTags(args.entityId, tagIds, tx);
    const fresh = await tx.select().from(tasks).where(eq(tasks.id, args.entityId)).limit(1);
    const freshTags = await loadTagIds(args.entityId, tx);
    return taskRowToPayload(fresh[0]!, freshTags);
  }

  if (args.entityType === 'list') {
    const colVals = cols as unknown as Partial<typeof taskLists.$inferInsert>;
    if (args.isNew) {
      await tx.insert(taskLists).values({
        ...colVals,
        id: args.entityId,
        ownerId: args.ownerId,
        name: typeof cols['name'] === 'string' ? (cols['name'] as string) : '',
        createdAt: args.nowIso,
        updatedAt: args.nowIso,
        serverVersion: args.newVersion,
        deletedAt: null,
      });
    } else {
      await tx
        .update(taskLists)
        .set({ ...colVals, updatedAt: args.nowIso, serverVersion: args.newVersion })
        .where(eq(taskLists.id, args.entityId));
    }
    const fresh = await tx.select().from(taskLists).where(eq(taskLists.id, args.entityId)).limit(1);
    return taskListRowToPayload(fresh[0]!);
  }

  if (args.entityType === 'reminder') {
    const colVals = cols as unknown as Partial<typeof reminders.$inferInsert>;
    if (args.isNew) {
      await tx.insert(reminders).values({
        ...colVals,
        id: args.entityId,
        ownerId: args.ownerId,
        taskId: cols['taskId'] as string,
        createdAt: args.nowIso,
        updatedAt: args.nowIso,
        serverVersion: args.newVersion,
        deletedAt: null,
      });
    } else {
      await tx
        .update(reminders)
        .set({ ...colVals, updatedAt: args.nowIso, serverVersion: args.newVersion })
        .where(eq(reminders.id, args.entityId));
    }
    const fresh = await tx.select().from(reminders).where(eq(reminders.id, args.entityId)).limit(1);
    return reminderRowToPayload(fresh[0]!);
  }

  if (args.entityType === 'checklist') {
    const colVals = cols as unknown as Partial<typeof checklistItems.$inferInsert>;
    if (args.isNew) {
      await tx.insert(checklistItems).values({
        ...colVals,
        id: args.entityId,
        ownerId: args.ownerId,
        taskId: cols['taskId'] as string,
        text: typeof cols['text'] === 'string' ? (cols['text'] as string) : '',
        createdAt: args.nowIso,
        updatedAt: args.nowIso,
        serverVersion: args.newVersion,
        deletedAt: null,
      });
    } else {
      await tx
        .update(checklistItems)
        .set({ ...colVals, updatedAt: args.nowIso, serverVersion: args.newVersion })
        .where(eq(checklistItems.id, args.entityId));
    }
    const fresh = await tx.select().from(checklistItems).where(eq(checklistItems.id, args.entityId)).limit(1);
    return checklistItemRowToPayload(fresh[0]!);
  }

  if (args.entityType === 'routine') {
    const colVals = cols as unknown as Partial<typeof routines.$inferInsert>;
    if (args.isNew) {
      await tx.insert(routines).values({
        ...colVals,
        id: args.entityId,
        ownerId: args.ownerId,
        createdAt: args.nowIso,
        updatedAt: args.nowIso,
        serverVersion: args.newVersion,
        deletedAt: null,
      });
    } else {
      await tx
        .update(routines)
        .set({ ...colVals, updatedAt: args.nowIso, serverVersion: args.newVersion })
        .where(eq(routines.id, args.entityId));
    }
    const fresh = await tx.select().from(routines).where(eq(routines.id, args.entityId)).limit(1);
    return routineRowToPayload(fresh[0]!);
  }

  if (args.entityType === 'alarm') {
    const colVals = cols as unknown as Partial<typeof alarms.$inferInsert>;
    if (args.isNew) {
      await tx.insert(alarms).values({
        ...colVals,
        id: args.entityId,
        ownerId: args.ownerId,
        createdAt: args.nowIso,
        updatedAt: args.nowIso,
        serverVersion: args.newVersion,
        deletedAt: null,
      });
    } else {
      await tx
        .update(alarms)
        .set({ ...colVals, updatedAt: args.nowIso, serverVersion: args.newVersion })
        .where(eq(alarms.id, args.entityId));
    }
    const fresh = await tx.select().from(alarms).where(eq(alarms.id, args.entityId)).limit(1);
    return alarmRowToPayload(fresh[0]!);
  }

  if (args.entityType === 'noteFolder') {
    const colVals = cols as unknown as Partial<typeof noteFolders.$inferInsert>;
    if (args.isNew) {
      await tx.insert(noteFolders).values({
        ...colVals,
        id: args.entityId,
        ownerId: args.ownerId,
        name: typeof cols['name'] === 'string' ? (cols['name'] as string) : '',
        createdAt: args.nowIso,
        updatedAt: args.nowIso,
        serverVersion: args.newVersion,
        deletedAt: null,
      });
    } else {
      await tx
        .update(noteFolders)
        .set({ ...colVals, updatedAt: args.nowIso, serverVersion: args.newVersion })
        .where(eq(noteFolders.id, args.entityId));
    }
    const fresh = await tx.select().from(noteFolders).where(eq(noteFolders.id, args.entityId)).limit(1);
    return noteFolderRowToPayload(fresh[0]!);
  }

  if (args.entityType === 'note') {
    const colVals = cols as unknown as Partial<typeof notes.$inferInsert>;
    if (args.isNew) {
      await tx.insert(notes).values({
        ...colVals,
        id: args.entityId,
        ownerId: args.ownerId,
        title: typeof cols['title'] === 'string' ? (cols['title'] as string) : '',
        createdAt: args.nowIso,
        updatedAt: args.nowIso,
        serverVersion: args.newVersion,
        deletedAt: null,
      });
    } else {
      await tx
        .update(notes)
        .set({ ...colVals, updatedAt: args.nowIso, serverVersion: args.newVersion })
        .where(eq(notes.id, args.entityId));
    }
    const fresh = await tx.select().from(notes).where(eq(notes.id, args.entityId)).limit(1);
    return noteRowToPayload(fresh[0]!);
  }

  // tag
  const colVals = cols as unknown as Partial<typeof tags.$inferInsert>;
  if (args.isNew) {
    await tx.insert(tags).values({
      ...colVals,
      id: args.entityId,
      ownerId: args.ownerId,
      name: typeof cols['name'] === 'string' ? (cols['name'] as string) : '',
      createdAt: args.nowIso,
      updatedAt: args.nowIso,
      serverVersion: args.newVersion,
      deletedAt: null,
    });
  } else {
    await tx
      .update(tags)
      .set({ ...colVals, updatedAt: args.nowIso, serverVersion: args.newVersion })
      .where(eq(tags.id, args.entityId));
  }
  const fresh = await tx.select().from(tags).where(eq(tags.id, args.entityId)).limit(1);
  return tagRowToPayload(fresh[0]!);
}

// --- apply delete (soft) ---------------------------------------------------

export interface ApplyDeleteArgs {
  entityType: EntityType;
  entityId: string;
  newVersion: number;
  nowIso: string;
}

/** Soft-delete (tombstone) — NEVER a hard delete on the sync path (ApiSpec §5). */
export async function applyDelete(args: ApplyDeleteArgs, tx: Tx): Promise<void> {
  const patch = { deletedAt: args.nowIso, updatedAt: args.nowIso, serverVersion: args.newVersion };
  if (args.entityType === 'task') {
    await tx.update(tasks).set(patch).where(eq(tasks.id, args.entityId));
  } else if (args.entityType === 'list') {
    await tx.update(taskLists).set(patch).where(eq(taskLists.id, args.entityId));
  } else if (args.entityType === 'tag') {
    await tx.update(tags).set(patch).where(eq(tags.id, args.entityId));
  } else if (args.entityType === 'reminder') {
    await tx.update(reminders).set(patch).where(eq(reminders.id, args.entityId));
  } else if (args.entityType === 'routine') {
    await tx.update(routines).set(patch).where(eq(routines.id, args.entityId));
  } else if (args.entityType === 'alarm') {
    await tx.update(alarms).set(patch).where(eq(alarms.id, args.entityId));
  } else if (args.entityType === 'noteFolder') {
    await tx.update(noteFolders).set(patch).where(eq(noteFolders.id, args.entityId));
  } else if (args.entityType === 'note') {
    await tx.update(notes).set(patch).where(eq(notes.id, args.entityId));
  } else {
    await tx.update(checklistItems).set(patch).where(eq(checklistItems.id, args.entityId));
  }
}

// --- change_log ------------------------------------------------------------

export interface AppendChangeArgs {
  entityType: EntityType;
  entityId: string;
  op: 'upsert' | 'delete';
  version: number;
  actorUserId: string;
  visibleUserIds: string[];
  payload: Record<string, unknown> | null;
  nowIso: string;
}

/** Append a change_log row and return its seq (as a string — BIGSERIAL). */
export async function appendChange(args: AppendChangeArgs, tx: Tx): Promise<string> {
  const rows = await tx
    .insert(changeLog)
    .values({
      entityType: args.entityType,
      entityId: args.entityId,
      op: args.op,
      version: args.version,
      actorUserId: args.actorUserId,
      visibleUserIds: args.visibleUserIds,
      payload: args.payload,
      committedAt: args.nowIso,
    })
    .returning({ seq: changeLog.seq });
  return String(rows[0]!.seq);
}

// --- pull (delta read) -----------------------------------------------------

export interface PullRow {
  seq: bigint;
  entityType: string;
  entityId: string;
  op: string;
  version: number;
  payload: Record<string, unknown> | null;
}

/**
 * Read up to `limit` changes visible to `userId` with seq > `afterSeq`, ordered
 * by seq (ApiSpec §6.2). Visibility is expressed as the array-CONTAINS form
 * `visible_user_ids @> ARRAY[userId]`, which is semantically identical to the
 * spec's `userId = ANY(visible_user_ids)` but is the form the GIN index on
 * `visible_user_ids` can actually serve (GIN supports @>, &&, <@ — not = ANY).
 * We fetch `limit + 1` to compute `hasMore` without a separate count.
 */
export async function readChanges(
  userId: string,
  afterSeq: bigint,
  limit: number,
): Promise<PullRow[]> {
  const rows = await db
    .select({
      seq: changeLog.seq,
      entityType: changeLog.entityType,
      entityId: changeLog.entityId,
      op: changeLog.op,
      version: changeLog.version,
      payload: changeLog.payload,
    })
    .from(changeLog)
    .where(
      and(
        gt(changeLog.seq, afterSeq),
        sql`${changeLog.visibleUserIds} @> ARRAY[${userId}]::uuid[]`,
      ),
    )
    .orderBy(changeLog.seq)
    .limit(limit + 1);

  return rows.map((r) => ({
    seq: r.seq as bigint,
    entityType: r.entityType,
    entityId: r.entityId,
    op: r.op,
    version: r.version,
    payload: (r.payload as Record<string, unknown> | null) ?? null,
  }));
}

// --- idempotency journal ---------------------------------------------------

/** Return the stored result for a previously-seen opId, if any (ApiSpec §6.3). */
export async function findIdempotent(
  opId: string,
  userId: string,
  tx: Tx,
): Promise<SyncPushResult | undefined> {
  const rows = await tx
    .select({ responseHash: idempotencyKeys.responseHash, userId: idempotencyKeys.userId })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.opId, opId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  // Scope to the same user: a different user replaying an opId must not read it.
  if (row.userId !== userId) return undefined;
  return row.responseHash as unknown as SyncPushResult;
}

/** Record an op's result for safe replay. Returns false if the opId already existed. */
export async function recordIdempotent(
  opId: string,
  userId: string,
  result: SyncPushResult,
  nowIso: string,
  tx: Tx,
): Promise<boolean> {
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({
      opId,
      userId,
      responseHash: result as unknown as Record<string, unknown>,
      createdAt: nowIso,
    })
    .onConflictDoNothing({ target: idempotencyKeys.opId })
    .returning({ opId: idempotencyKeys.opId });
  return inserted.length > 0;
}

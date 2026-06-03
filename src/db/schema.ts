/**
 * Drizzle schema (PostgreSQL 16) — mirrors the contract (src/contract/schemas.ts)
 * and ApiSpec §5 DDL 1:1.
 *
 * Phase 0 table subset:
 *   users, devices, refresh_tokens, task_lists, tags, tasks, task_tags,
 *   change_log, idempotency_keys.
 *
 * Sync convention for every synced entity (ApiSpec §5): id (client UUID),
 * owner_id, created_at, updated_at, server_version (default 1), deleted_at
 * (soft-delete tombstone — never hard-deleted on the sync path).
 *
 * Note: `tasks.routine_instance_of` and `tasks.recurrence_parent_id` reference
 * tables (routines) that arrive in later phases; in Phase 0 they are plain
 * uuid columns WITHOUT a FK so the migration is self-contained. FKs get added
 * when those tables land (expand→migrate→contract, ApiSpec §13).
 */
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  smallint,
  bigserial,
  timestamp,
  jsonb,
  customType,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { RecurrenceRule, Location } from '@/contract/schemas.js';

// --- custom types -----------------------------------------------------------

/** `bytea` for the SHA-256 refresh-token hash (ApiSpec §5.1). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/** `uuid[]` for change_log.visible_user_ids (GIN-indexed fan-out, ApiSpec §5.2). */
const uuidArray = customType<{ data: string[]; driverData: string }>({
  dataType() {
    return 'uuid[]';
  },
});

/** Shared timestamptz helpers. */
const tsNow = () =>
  timestamp({ withTimezone: true, mode: 'string' }).notNull().defaultNow();
const tsNull = () => timestamp({ withTimezone: true, mode: 'string' });

// ============================================================================
// users
// ============================================================================
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  appleSub: text('apple_sub').notNull().unique(),
  email: text('email'),
  displayName: text('display_name').notNull().default(''),
  settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
  aiConsent: boolean('ai_consent').notNull().default(false),
  createdAt: tsNow(),
  updatedAt: tsNow(),
  deletedAt: tsNull(),
});

// ============================================================================
// devices
// ============================================================================
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    apnsToken: text('apns_token'),
    platform: text('platform').notNull().default('ios'),
    appVersion: text('app_version'),
    pushPrefs: jsonb('push_prefs').notNull().default(sql`'{}'::jsonb`),
    lastSeenAt: tsNull(),
    createdAt: tsNow(),
    revokedAt: tsNull(),
  },
  (t) => [index('devices_user_idx').on(t.userId)],
);

// ============================================================================
// refresh_tokens (rotating, single-use; ApiSpec §4.2)
// ============================================================================
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    tokenHash: bytea('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    createdAt: tsNow(),
    revokedAt: tsNull(),
    replacedBy: uuid('replaced_by'), // rotation chain (reuse detection)
  },
  (t) => [
    index('refresh_tokens_user_idx').on(t.userId),
    // Fast lookup by hash on refresh/rotate.
    uniqueIndex('refresh_tokens_hash_uidx').on(t.tokenHash),
  ],
);

// ============================================================================
// task_lists
// ============================================================================
export const taskLists = pgTable(
  'task_lists',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    colorHex: text('color_hex').notNull().default('#8E8E93'),
    icon: text('icon').notNull().default('list.bullet'),
    sortIndex: integer('sort_index').notNull().default(0),
    shareId: uuid('share_id'),
    createdAt: tsNow(),
    updatedAt: tsNow(),
    serverVersion: integer('server_version').notNull().default(1),
    deletedAt: tsNull(),
  },
  (t) => [index('task_lists_owner_idx').on(t.ownerId)],
);

// ============================================================================
// tags
// ============================================================================
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    colorHex: text('color_hex').notNull().default('#8E8E93'),
    createdAt: tsNow(),
    updatedAt: tsNow(),
    serverVersion: integer('server_version').notNull().default(1),
    deletedAt: tsNull(),
  },
  (t) => [index('tags_owner_idx').on(t.ownerId)],
);

// ============================================================================
// tasks
// ============================================================================
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    listId: uuid('list_id').references(() => taskLists.id, { onDelete: 'set null' }),
    parentTaskId: uuid('parent_task_id'),
    title: text('title').notNull(),
    notes: text('notes'),
    status: smallint('status').notNull().default(0),
    priority: smallint('priority').notNull().default(0),
    rank: integer('rank').notNull().default(0),
    energy: smallint('energy'),
    dueAt: tsNull(),
    scheduledStart: tsNull(),
    scheduledEnd: tsNull(),
    estimatedMinutes: integer('estimated_minutes'),
    actualMinutes: integer('actual_minutes'),
    isAllDay: boolean('is_all_day').notNull().default(false),
    recurrence: jsonb('recurrence').$type<RecurrenceRule | null>(),
    recurrenceParentId: uuid('recurrence_parent_id'),
    routineInstanceOf: uuid('routine_instance_of'),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id),
    location: jsonb('location').$type<Location | null>(),
    url: text('url'),
    // Per-field {version, updatedAt} map for field-level LWW (ApiSpec §6.1).
    // Phase 0 uses ROW-level LWW, but the column exists so Phase 2 can light up
    // field-level merge without a migration.
    fieldMeta: jsonb('field_meta').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    completedAt: tsNull(),
    archived: boolean('archived').notNull().default(false),
    serverVersion: integer('server_version').notNull().default(1),
    deletedAt: tsNull(),
  },
  (t) => [
    index('tasks_owner_updated_idx').on(t.ownerId, t.updatedAt),
    index('tasks_list_idx').on(t.listId).where(sql`${t.deletedAt} IS NULL`),
    index('tasks_owner_status_due_idx')
      .on(t.ownerId, t.status, t.dueAt)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

// ============================================================================
// task_tags (M:N tasks <-> tags; ApiSpec §5.3)
// ============================================================================
export const taskTags = pgTable(
  'task_tags',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.tagId] }),
    index('task_tags_tag_idx').on(t.tagId),
  ],
);

// ============================================================================
// change_log (the sync journal + cursor source; ApiSpec §5.2)
// ============================================================================
export const changeLog = pgTable(
  'change_log',
  {
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(), // opaque monotonic cursor
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    op: text('op').notNull(), // 'upsert' | 'delete'
    version: integer('version').notNull(), // entity server_version after the change
    actorUserId: uuid('actor_user_id').notNull(),
    visibleUserIds: uuidArray('visible_user_ids').notNull(),
    payload: jsonb('payload'), // full row snapshot for upsert; null for delete
    committedAt: tsNow(),
  },
  (t) => [
    // GIN index for `:userId = ANY(visible_user_ids)` fan-out (ApiSpec §5.2).
    index('change_log_visible_gin').using('gin', t.visibleUserIds),
    index('change_log_seq_idx').on(t.seq),
  ],
);

// ============================================================================
// idempotency_keys (per-op dedupe of retried mutations; ApiSpec §5.3, §6.3)
// ============================================================================
export const idempotencyKeys = pgTable('idempotency_keys', {
  opId: uuid('op_id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Stored result of the original op, replayed verbatim on retry (status 'duplicate').
  responseHash: jsonb('response_hash').notNull(),
  createdAt: tsNow(),
});

// ============================================================================
// reminders (a task's nudges; ApiSpec §5.7). Synced like any other entity.
// ============================================================================
export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: smallint('kind').notNull().default(0), // 0 absolute,1 relativeToDue,2 location,3 recurring
    fireAt: tsNull(),
    offsetMinutes: integer('offset_minutes'),
    region: jsonb('region'),
    interruption: smallint('interruption').notNull().default(1), // 0 passive,1 active,2 timeSensitive,3 critical
    notificationId: text('notification_id'),
    createdAt: tsNow(),
    updatedAt: tsNow(),
    serverVersion: integer('server_version').notNull().default(1),
    deletedAt: tsNull(),
  },
  (t) => [index('reminders_task_idx').on(t.taskId)],
);

// ============================================================================
// checklist_items (lightweight sub-items of a task; ApiSpec §5.1). Synced.
// ============================================================================
export const checklistItems = pgTable(
  'checklist_items',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    done: boolean('done').notNull().default(false),
    ord: integer('ord').notNull().default(0),
    createdAt: tsNow(),
    updatedAt: tsNow(),
    serverVersion: integer('server_version').notNull().default(1),
    deletedAt: tsNull(),
  },
  (t) => [index('checklist_items_task_idx').on(t.taskId)],
);

// --- Inferred row types (handy in repositories/services) -------------------
export type UserRow = typeof users.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type TaskListRow = typeof taskLists.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ReminderRow = typeof reminders.$inferSelect;
export type ChecklistItemRow = typeof checklistItems.$inferSelect;
export type ChangeLogRow = typeof changeLog.$inferSelect;
export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;

/** Convenience grouping for the Drizzle client `schema` option. */
export const schema = {
  users,
  devices,
  refreshTokens,
  taskLists,
  tags,
  tasks,
  taskTags,
  reminders,
  checklistItems,
  changeLog,
  idempotencyKeys,
};

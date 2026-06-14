/**
 * THE CONTRACT — the single source of truth for HTTP I/O shapes.
 *
 * These Zod schemas are reused to (a) validate every HTTP body/query at the
 * edge, (b) derive TypeScript types, and (c) generate the OpenAPI 3.1 doc
 * (src/openapi/openapi.ts). Drizzle tables (src/db/schema.ts) mirror these
 * 1:1, and the iOS SwiftData models mirror them too (ApiSpec §3, §5, §6).
 *
 * Wire conventions (ApiSpec §3):
 *  - Timestamps are RFC3339 UTC strings (`z.string().datetime()`); `timestamptz`
 *    in the DB.
 *  - Entity ids are client-generated UUIDv4 strings.
 *  - Enums are INTEGERS over the wire (status/priority/energy), validated to
 *    their allowed set.
 *  - New fields are nullable/optional (additive contract evolution, ApiSpec §13).
 */
import { z } from 'zod';

// --- Primitive reusable schemas --------------------------------------------

/** Client-generated UUIDv4 (ApiSpec §6). */
export const zUuid = z.string().uuid();

/** RFC3339 UTC timestamp string (ApiSpec §3). `offset:true` tolerates `+00:00`. */
export const zTimestamp = z.string().datetime({ offset: true });

export const zColorHex = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'expected hex color like #RRGGBB');

// --- Integer enums (ApiSpec §5) --------------------------------------------

/** Task.status — 0 inbox, 1 scheduled, 2 inProgress, 3 done, 4 cancelled. */
export const TaskStatus = {
  inbox: 0,
  scheduled: 1,
  inProgress: 2,
  done: 3,
  cancelled: 4,
} as const;
export const zTaskStatus = z
  .number()
  .int()
  .refine((n): n is 0 | 1 | 2 | 3 | 4 => n >= 0 && n <= 4, {
    message: 'status must be one of 0..4 (inbox,scheduled,inProgress,done,cancelled)',
  });

/** Task.priority — 0 none, 1 p4, 2 p3, 3 p2, 4 p1. */
export const TaskPriority = { none: 0, p4: 1, p3: 2, p2: 3, p1: 4 } as const;
export const zTaskPriority = z
  .number()
  .int()
  .refine((n): n is 0 | 1 | 2 | 3 | 4 => n >= 0 && n <= 4, {
    message: 'priority must be one of 0..4 (none,p4,p3,p2,p1)',
  });

/** Task.energy — 0 low, 1 med, 2 high (nullable). */
export const TaskEnergy = { low: 0, med: 1, high: 2 } as const;
export const zTaskEnergy = z
  .number()
  .int()
  .refine((n): n is 0 | 1 | 2 => n >= 0 && n <= 2, {
    message: 'energy must be one of 0..2 (low,med,high)',
  });

// --- RecurrenceRule (json) -------------------------------------------------

export const zRecurrenceFreq = z.enum(['daily', 'weekly', 'monthly', 'yearly']);

/**
 * RFC-5545 subset (ApiSpec §5.3). Stored in `tasks.recurrence` JSONB.
 * `byWeekday`: 0..6, `byMonthDay`: 1..31 (negatives allowed for "last N").
 */
export const RecurrenceRuleSchema = z
  .object({
    freq: zRecurrenceFreq,
    interval: z.number().int().positive(),
    byWeekday: z.array(z.number().int().min(0).max(6)).nullable().default(null),
    byMonthDay: z.array(z.number().int().min(-31).max(31)).nullable().default(null),
    count: z.number().int().positive().nullable().default(null),
    until: zTimestamp.nullable().default(null),
  })
  .strict();
export type RecurrenceRule = z.infer<typeof RecurrenceRuleSchema>;

/** Task.location — { lat, lon, name } (nullable). */
export const LocationSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    name: z.string().nullable().default(null),
  })
  .strict();
export type Location = z.infer<typeof LocationSchema>;

// --- Sync convention fields (every synced entity; ApiSpec §5) --------------
// Server-authoritative fields a client reads but never sets directly on the
// sync path. We model them as part of the full entity (returned by pull / REST
// GET); the WRITE shapes below omit/override them.
const syncMetaShape = {
  createdAt: zTimestamp,
  updatedAt: zTimestamp,
  serverVersion: z.number().int().positive(),
  deletedAt: zTimestamp.nullable(),
};

// ============================================================================
// Task
// ============================================================================

/** Full Task as returned by the server (pull payload / REST GET). */
export const TaskSchema = z
  .object({
    id: zUuid,
    ownerId: zUuid,
    listId: zUuid.nullable(),
    parentTaskId: zUuid.nullable(),
    title: z.string().min(1),
    notes: z.string().nullable(),
    status: zTaskStatus,
    priority: zTaskPriority,
    rank: z.number().int(),
    energy: zTaskEnergy.nullable(),
    dueAt: zTimestamp.nullable(),
    scheduledStart: zTimestamp.nullable(),
    scheduledEnd: zTimestamp.nullable(),
    estimatedMinutes: z.number().int().nonnegative().nullable(),
    actualMinutes: z.number().int().nonnegative().nullable(),
    isAllDay: z.boolean(),
    recurrence: RecurrenceRuleSchema.nullable(),
    recurrenceParentId: zUuid.nullable(),
    routineInstanceOf: zUuid.nullable(),
    assigneeUserId: zUuid.nullable(),
    location: LocationSchema.nullable(),
    url: z.string().url().nullable(),
    tagIds: z.array(zUuid),
    completedAt: zTimestamp.nullable(),
    archived: z.boolean(),
    ...syncMetaShape,
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;

/**
 * Task CREATE body for the direct REST route (POST /tasks). `id` is supplied by
 * the client (idempotent upsert). Server-managed meta is omitted. Sensible
 * defaults mirror the DB defaults.
 */
export const TaskCreateSchema = z
  .object({
    id: zUuid,
    listId: zUuid.nullable().default(null),
    parentTaskId: zUuid.nullable().default(null),
    title: z.string().min(1),
    notes: z.string().nullable().default(null),
    status: zTaskStatus.default(TaskStatus.inbox),
    priority: zTaskPriority.default(TaskPriority.none),
    rank: z.number().int().default(0),
    energy: zTaskEnergy.nullable().default(null),
    dueAt: zTimestamp.nullable().default(null),
    scheduledStart: zTimestamp.nullable().default(null),
    scheduledEnd: zTimestamp.nullable().default(null),
    estimatedMinutes: z.number().int().nonnegative().nullable().default(null),
    actualMinutes: z.number().int().nonnegative().nullable().default(null),
    isAllDay: z.boolean().default(false),
    recurrence: RecurrenceRuleSchema.nullable().default(null),
    recurrenceParentId: zUuid.nullable().default(null),
    routineInstanceOf: zUuid.nullable().default(null),
    assigneeUserId: zUuid.nullable().default(null),
    location: LocationSchema.nullable().default(null),
    url: z.string().url().nullable().default(null),
    tagIds: z.array(zUuid).default([]),
    completedAt: zTimestamp.nullable().default(null),
    archived: z.boolean().default(false),
  })
  .strict();
export type TaskCreate = z.infer<typeof TaskCreateSchema>;

/**
 * Task PATCH body (partial). Every writable field optional; `id` is in the URL.
 * Used by REST PATCH /tasks/{id} and as the shape of a sync op's `fields` patch.
 */
export const TaskPatchSchema = TaskCreateSchema.partial().omit({ id: true });
export type TaskPatch = z.infer<typeof TaskPatchSchema>;

/** Query params for GET /tasks (ApiSpec §7.3). */
export const TaskListQuerySchema = z
  .object({
    listId: zUuid.optional(),
    status: z.coerce.number().int().pipe(zTaskStatus).optional(),
    dueBefore: zTimestamp.optional(),
    limit: z.coerce.number().int().positive().max(200).default(200),
  })
  .strict();
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;

/** URL param `{id}` schema reused by REST item routes. */
export const IdParamSchema = z.object({ id: zUuid }).strict();
export type IdParam = z.infer<typeof IdParamSchema>;

// ============================================================================
// TaskList
// ============================================================================

export const TaskListSchema = z
  .object({
    id: zUuid,
    ownerId: zUuid,
    name: z.string().min(1),
    colorHex: zColorHex,
    icon: z.string().min(1), // SF Symbol name
    sortIndex: z.number().int(),
    shareId: zUuid.nullable(),
    ...syncMetaShape,
  })
  .strict();
export type TaskList = z.infer<typeof TaskListSchema>;

export const TaskListCreateSchema = z
  .object({
    id: zUuid,
    name: z.string().min(1),
    colorHex: zColorHex.default('#8E8E93'),
    icon: z.string().min(1).default('list.bullet'),
    sortIndex: z.number().int().default(0),
    shareId: zUuid.nullable().default(null),
  })
  .strict();
export type TaskListCreate = z.infer<typeof TaskListCreateSchema>;

export const TaskListPatchSchema = TaskListCreateSchema.partial().omit({ id: true });
export type TaskListPatch = z.infer<typeof TaskListPatchSchema>;

// ============================================================================
// Keeper: note folders + notes (synced). Added feature — not in the original ApiSpec; see DevelopmentPlan §10.5.
// ============================================================================
export const NoteFolderCreateSchema = z
  .object({
    id: zUuid,
    name: z.string().min(1),
    colorHex: zColorHex.default('#8E8E93'),
    icon: z.string().min(1).default('folder'),
    sortIndex: z.number().int().default(0),
  })
  .strict();
export type NoteFolderCreate = z.infer<typeof NoteFolderCreateSchema>;
export const NoteFolderPatchSchema = NoteFolderCreateSchema.partial().omit({ id: true });
export type NoteFolderPatch = z.infer<typeof NoteFolderPatchSchema>;

export const NoteCreateSchema = z
  .object({
    id: zUuid,
    folderId: zUuid.nullable().default(null),
    title: z.string().min(1),
    body: z.string().default(''),
    pinned: z.boolean().default(false),
  })
  .strict();
export type NoteCreate = z.infer<typeof NoteCreateSchema>;
export const NotePatchSchema = NoteCreateSchema.partial().omit({ id: true });
export type NotePatch = z.infer<typeof NotePatchSchema>;

// ============================================================================
// Tag
// ============================================================================

export const TagSchema = z
  .object({
    id: zUuid,
    ownerId: zUuid,
    name: z.string().min(1),
    colorHex: zColorHex,
    ...syncMetaShape,
  })
  .strict();
export type Tag = z.infer<typeof TagSchema>;

export const TagCreateSchema = z
  .object({
    id: zUuid,
    name: z.string().min(1),
    colorHex: zColorHex.default('#8E8E93'),
  })
  .strict();
export type TagCreate = z.infer<typeof TagCreateSchema>;

export const TagPatchSchema = TagCreateSchema.partial().omit({ id: true });
export type TagPatch = z.infer<typeof TagPatchSchema>;

// ============================================================================
// Auth contract (ApiSpec §4)
// ============================================================================

export const DeviceInfoSchema = z
  .object({
    deviceId: zUuid,
    platform: z.string().default('ios'),
    appVersion: z.string().nullable().default(null),
    apnsToken: z.string().nullable().default(null),
  })
  .strict();
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

/** `POST /devices` body — register/refresh this device's push token + prefs (ApiSpec §7.6, §10). */
export const DeviceRegisterSchema = z
  .object({
    id: zUuid, // client-generated, stable device id (same as the auth deviceId)
    apnsToken: z.string().nullable().default(null),
    platform: z.string().default('ios'),
    appVersion: z.string().nullable().default(null),
    pushPrefs: z.record(z.unknown()).default({}),
  })
  .strict();
export type DeviceRegister = z.infer<typeof DeviceRegisterSchema>;

/** Device as returned by the API. The raw APNs token is never echoed back (only `hasApnsToken`). */
export const DeviceSchema = z.object({
  id: zUuid,
  platform: z.string(),
  appVersion: z.string().nullable(),
  pushPrefs: z.record(z.unknown()),
  hasApnsToken: z.boolean(),
  lastSeenAt: zTimestamp.nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const AppleSignInSchema = z
  .object({
    identityToken: z.string().min(1),
    authorizationCode: z.string().min(1).nullable().default(null),
    nonce: z.string().min(1).nullable().default(null),
    deviceInfo: DeviceInfoSchema,
  })
  .strict();
export type AppleSignIn = z.infer<typeof AppleSignInSchema>;

export const RefreshSchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();
export type RefreshRequest = z.infer<typeof RefreshSchema>;

export const LogoutSchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();
export type LogoutRequest = z.infer<typeof LogoutSchema>;

/** Token bundle returned by /auth/apple and /auth/refresh. */
export const TokenPairSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().positive(), // access token TTL in seconds
    userId: zUuid,
    deviceId: zUuid,
  })
  .strict();
export type TokenPair = z.infer<typeof TokenPairSchema>;

// ============================================================================
// Reminder + Checklist-item entities (synced; ApiSpec §5.1, §5.7)
// ============================================================================

export const ReminderCreateSchema = z
  .object({
    id: zUuid,
    taskId: zUuid,
    kind: z.number().int().min(0).max(3).default(0), // absolute|relativeToDue|location|recurring
    fireAt: zTimestamp.nullable().default(null),
    offsetMinutes: z.number().int().nullable().default(null),
    region: z.record(z.unknown()).nullable().default(null),
    interruption: z.number().int().min(0).max(3).default(1), // passive|active|timeSensitive|critical
    notificationId: z.string().nullable().default(null),
  })
  .strict();
export type ReminderCreate = z.infer<typeof ReminderCreateSchema>;
export const ReminderPatchSchema = ReminderCreateSchema.partial().omit({ id: true });
export type ReminderPatch = z.infer<typeof ReminderPatchSchema>;

export const ChecklistItemCreateSchema = z
  .object({
    id: zUuid,
    taskId: zUuid,
    text: z.string().min(1),
    done: z.boolean().default(false),
    ord: z.number().int().default(0),
  })
  .strict();
export type ChecklistItemCreate = z.infer<typeof ChecklistItemCreateSchema>;
export const ChecklistItemPatchSchema = ChecklistItemCreateSchema.partial().omit({ id: true });
export type ChecklistItemPatch = z.infer<typeof ChecklistItemPatchSchema>;

// ============================================================================
// Routine + Alarm entities (synced; ApiSpec §5.2, §5.6, §7.4–§7.5)
// ============================================================================

/** One embedded routine step. */
export const RoutineStepSchema = z
  .object({
    title: z.string().default(''),
    minutes: z.number().int().nonnegative().default(0),
    ord: z.number().int().default(0),
    hasAlarm: z.boolean().default(false),
  })
  .strict();
export type RoutineStep = z.infer<typeof RoutineStepSchema>;

/**
 * A routine template (or, with `isHabit: true`, a tracked habit). Streak fields are NOT writable
 * here — the server owns streak math (POST /habits/{id}/log); they round-trip in the row payload only.
 */
export const RoutineCreateSchema = z
  .object({
    id: zUuid,
    name: z.string().default(''),
    colorHex: z.string().default('#4F46E5'),
    anchorTime: z.string().nullable().default(null), // "HH:mm" wall-clock
    recurrence: z.record(z.unknown()).nullable().default(null), // { weekdays | days | everyNDays }
    chained: z.boolean().default(false),
    isHabit: z.boolean().default(false),
    graceDays: z.number().int().nonnegative().default(0),
    steps: z.array(RoutineStepSchema).default([]),
  })
  .strict();
export type RoutineCreate = z.infer<typeof RoutineCreateSchema>;
export const RoutinePatchSchema = RoutineCreateSchema.partial().omit({ id: true });
export type RoutinePatch = z.infer<typeof RoutinePatchSchema>;

/** A time-critical alarm (the client owns delivery; ApiSpec §5.6). */
export const AlarmCreateSchema = z
  .object({
    id: zUuid,
    taskId: zUuid.nullable().default(null),
    fireAt: zTimestamp.nullable().default(null),
    type: z.number().int().min(0).max(3).default(0), // wake|taskStart|routineStep|leaveBy
    soundName: z.string().nullable().default(null),
    snoozeMinutes: z.number().int().nullable().default(null),
    usesLiveActivity: z.boolean().default(false),
  })
  .strict();
export type AlarmCreate = z.infer<typeof AlarmCreateSchema>;
export const AlarmPatchSchema = AlarmCreateSchema.partial().omit({ id: true });
export type AlarmPatch = z.infer<typeof AlarmPatchSchema>;

// ============================================================================
// Sync contract (ApiSpec §6)
// ============================================================================

export const zEntityType = z.enum([
  'task',
  'list',
  'tag',
  'reminder',
  'checklist',
  'routine',
  'alarm',
  'comment',
  'noteFolder',
  'note',
]);
export type EntityType = z.infer<typeof zEntityType>;

export const zSyncOp = z.enum(['upsert', 'delete']);
export type SyncOp = z.infer<typeof zSyncOp>;

/** Per-op push result status (ApiSpec §6.1). */
export const zPushStatus = z.enum(['applied', 'merged', 'conflict', 'rejected', 'duplicate']);
export type PushStatus = z.infer<typeof zPushStatus>;

/** A single mutation in a push batch (ApiSpec §6.1). */
export const SyncPushOpSchema = z
  .object({
    opId: zUuid, // client UUID; dedupe key for retries
    entityType: zEntityType,
    entityId: zUuid, // client-generated entity id
    op: zSyncOp,
    baseVersion: z.number().int().nonnegative(), // server_version client last saw; 0 for new
    clientUpdatedAt: zTimestamp,
    // Changed fields only (a patch). null/absent for deletes. Validated against
    // the per-entity patch schema inside the service (depends on entityType).
    fields: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .strict();
export type SyncPushOp = z.infer<typeof SyncPushOpSchema>;

export const SyncPushRequestSchema = z
  .object({
    ops: z.array(SyncPushOpSchema).min(1).max(500),
  })
  .strict();
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

export const SyncPushResultSchema = z
  .object({
    opId: zUuid,
    entityId: zUuid,
    status: zPushStatus,
    serverVersion: z.number().int().nonnegative().nullable(),
    // Present on 'merged': the fields the server kept (client should adopt them).
    serverFields: z.record(z.string(), z.unknown()).nullable(),
    // change_log seq that advances the pull cursor; null when nothing committed.
    committedSeq: z.string().nullable(),
    // Human/machine detail on 'conflict' / 'rejected'.
    reason: z.string().nullable().default(null),
  })
  .strict();
export type SyncPushResult = z.infer<typeof SyncPushResultSchema>;

export const SyncPushResponseSchema = z
  .object({
    results: z.array(SyncPushResultSchema),
  })
  .strict();
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;

/** Pull query (ApiSpec §6.2). `limit` capped at 500. */
export const SyncPullQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(500).default(500),
  })
  .strict();
export type SyncPullQuery = z.infer<typeof SyncPullQuerySchema>;

export const SyncChangeSchema = z
  .object({
    entityType: zEntityType,
    entityId: zUuid,
    op: zSyncOp,
    version: z.number().int().positive(),
    payload: z.record(z.string(), z.unknown()).nullable(), // full row for upsert; null for delete
    seq: z.string(), // stringified BIGSERIAL
  })
  .strict();
export type SyncChange = z.infer<typeof SyncChangeSchema>;

export const SyncPullResponseSchema = z
  .object({
    changes: z.array(SyncChangeSchema),
    nextCursor: z.string().nullable(), // base64(maxSeq); null at end
    hasMore: z.boolean(),
  })
  .strict();
export type SyncPullResponse = z.infer<typeof SyncPullResponseSchema>;

// --- Patch schema lookup by entity type (used by the sync service) ---------
export const patchSchemaByEntity = {
  task: TaskPatchSchema,
  list: TaskListPatchSchema,
  tag: TagPatchSchema,
  reminder: ReminderPatchSchema,
  checklist: ChecklistItemPatchSchema,
  routine: RoutinePatchSchema,
  alarm: AlarmPatchSchema,
  // Comments are created via REST (POST /tasks/:id/comments), never via sync push — this empty patch
  // makes the type total; the sync commit also rejects 'comment' ops outright.
  comment: z.object({}).strict(),
  noteFolder: NoteFolderPatchSchema,
  note: NotePatchSchema,
} as const satisfies Record<EntityType, z.ZodTypeAny>;

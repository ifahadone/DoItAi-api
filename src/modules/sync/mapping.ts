/**
 * Entity <-> DB mapping for the generic sync engine.
 *
 * The sync push/pull paths are entity-agnostic: they work over a small registry
 * that, for each `entityType`, knows the Drizzle table, how to turn a stored row
 * into the wire `payload` (camelCase, RFC3339 strings — matching the contract),
 * and how to turn a validated patch into a column-update object.
 *
 * Keeping this in one place means adding the next synced entity (checklist,
 * routine, …) is a single registry entry, not edits across the engine.
 */
import type {
  TaskRow,
  TaskListRow,
  TagRow,
  ReminderRow,
  ChecklistItemRow,
  RoutineRow,
  AlarmRow,
} from '@/db/schema.js';
import type { EntityType } from '@/contract/schemas.js';

/**
 * Normalize a Postgres `timestamptz` text value (Drizzle `mode: 'string'` returns
 * e.g. "2026-06-03 18:35:54.561+00") to RFC3339 ("2026-06-03T18:35:54.561Z") —
 * the format the contract promises and clients parse (ApiSpec §3). Null-safe.
 */
function iso(s: string | null | undefined): string | null {
  return s == null ? null : new Date(s).toISOString();
}

/**
 * Serialize a Task row into the wire shape (contract `Task`). The DB column
 * `field_meta` is internal and intentionally NOT emitted.
 */
export function taskRowToPayload(
  row: TaskRow,
  tagIds: string[],
): Record<string, unknown> {
  return {
    id: row.id,
    ownerId: row.ownerId,
    listId: row.listId,
    parentTaskId: row.parentTaskId,
    title: row.title,
    notes: row.notes,
    status: row.status,
    priority: row.priority,
    rank: row.rank,
    energy: row.energy,
    dueAt: iso(row.dueAt),
    scheduledStart: iso(row.scheduledStart),
    scheduledEnd: iso(row.scheduledEnd),
    estimatedMinutes: row.estimatedMinutes,
    actualMinutes: row.actualMinutes,
    isAllDay: row.isAllDay,
    recurrence: row.recurrence ?? null,
    recurrenceParentId: row.recurrenceParentId,
    routineInstanceOf: row.routineInstanceOf,
    assigneeUserId: row.assigneeUserId,
    location: row.location ?? null,
    url: row.url,
    tagIds,
    completedAt: iso(row.completedAt),
    archived: row.archived,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    serverVersion: row.serverVersion,
    deletedAt: iso(row.deletedAt),
  };
}

export function taskListRowToPayload(row: TaskListRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    colorHex: row.colorHex,
    icon: row.icon,
    sortIndex: row.sortIndex,
    shareId: row.shareId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    serverVersion: row.serverVersion,
    deletedAt: iso(row.deletedAt),
  };
}

export function tagRowToPayload(row: TagRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    colorHex: row.colorHex,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    serverVersion: row.serverVersion,
    deletedAt: iso(row.deletedAt),
  };
}

export function reminderRowToPayload(row: ReminderRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerId: row.ownerId,
    taskId: row.taskId,
    kind: row.kind,
    fireAt: iso(row.fireAt),
    offsetMinutes: row.offsetMinutes,
    region: row.region ?? null,
    interruption: row.interruption,
    notificationId: row.notificationId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    serverVersion: row.serverVersion,
    deletedAt: iso(row.deletedAt),
  };
}

export function checklistItemRowToPayload(row: ChecklistItemRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerId: row.ownerId,
    taskId: row.taskId,
    text: row.text,
    done: row.done,
    ord: row.ord,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    serverVersion: row.serverVersion,
    deletedAt: iso(row.deletedAt),
  };
}

export function routineRowToPayload(row: RoutineRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    colorHex: row.colorHex,
    anchorTime: row.anchorTime,
    recurrence: row.recurrence ?? null,
    chained: row.chained,
    isHabit: row.isHabit,
    streakCurrent: row.streakCurrent,
    streakLongest: row.streakLongest,
    graceDays: row.graceDays,
    steps: row.steps ?? [],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    serverVersion: row.serverVersion,
    deletedAt: iso(row.deletedAt),
  };
}

export function alarmRowToPayload(row: AlarmRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerId: row.ownerId,
    taskId: row.taskId,
    fireAt: iso(row.fireAt),
    type: row.type,
    soundName: row.soundName,
    snoozeMinutes: row.snoozeMinutes,
    usesLiveActivity: row.usesLiveActivity,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    serverVersion: row.serverVersion,
    deletedAt: iso(row.deletedAt),
  };
}

/**
 * Patch-field allowlist per entity: only these keys map to columns on upsert.
 * `tagIds` is handled out-of-band (join table) for tasks, so it is NOT here.
 * The set mirrors the writable fields of each *CreateSchema in the contract.
 */
export const upsertableColumns: Record<EntityType, readonly string[]> = {
  task: [
    'listId',
    'parentTaskId',
    'title',
    'notes',
    'status',
    'priority',
    'rank',
    'energy',
    'dueAt',
    'scheduledStart',
    'scheduledEnd',
    'estimatedMinutes',
    'actualMinutes',
    'isAllDay',
    'recurrence',
    'recurrenceParentId',
    'routineInstanceOf',
    'assigneeUserId',
    'location',
    'url',
    'completedAt',
    'archived',
  ],
  list: ['name', 'colorHex', 'icon', 'sortIndex', 'shareId'],
  tag: ['name', 'colorHex'],
  reminder: ['taskId', 'kind', 'fireAt', 'offsetMinutes', 'region', 'interruption', 'notificationId'],
  checklist: ['taskId', 'text', 'done', 'ord'],
  // streakCurrent/streakLongest are server-owned (POST /habits/{id}/log) — NOT client-writable.
  routine: ['name', 'colorHex', 'anchorTime', 'recurrence', 'chained', 'isHabit', 'graceDays', 'steps'],
  alarm: ['taskId', 'fireAt', 'type', 'soundName', 'snoozeMinutes', 'usesLiveActivity'],
};

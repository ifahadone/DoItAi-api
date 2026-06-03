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
import type { TaskRow, TaskListRow, TagRow } from '@/db/schema.js';
import type { EntityType } from '@/contract/schemas.js';

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
    dueAt: row.dueAt,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
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
    completedAt: row.completedAt,
    archived: row.archived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    serverVersion: row.serverVersion,
    deletedAt: row.deletedAt,
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    serverVersion: row.serverVersion,
    deletedAt: row.deletedAt,
  };
}

export function tagRowToPayload(row: TagRow): Record<string, unknown> {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    colorHex: row.colorHex,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    serverVersion: row.serverVersion,
    deletedAt: row.deletedAt,
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
};

/**
 * Contract round-trip tests for the Zod schemas (src/contract/schemas.ts) — the
 * single source of truth (ApiSpec §3). Verifies a full Task survives parse, that
 * integer enums are bounded, RFC3339 timestamps are enforced, nested
 * Recurrence/Location validate, and create/patch defaults behave.
 *
 * NOTE: authored but NOT executed here (no node_modules). Run with `npm test`.
 */
import { describe, it, expect } from 'vitest';
import {
  TaskSchema,
  TaskCreateSchema,
  TaskPatchSchema,
  TaskStatus,
  TaskPriority,
  RecurrenceRuleSchema,
  SyncPushOpSchema,
  SyncPullResponseSchema,
} from '@/contract/schemas.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const TS = '2026-06-03T08:30:00.000Z';

/** A fully-populated Task as the server would return it. */
function fullTask() {
  return {
    id: UUID_A,
    ownerId: UUID_B,
    listId: UUID_C,
    parentTaskId: null,
    title: 'Lunch with Sam',
    notes: 'bring the deck',
    status: TaskStatus.scheduled,
    priority: TaskPriority.p2,
    rank: 100,
    energy: 1,
    dueAt: TS,
    scheduledStart: TS,
    scheduledEnd: '2026-06-03T09:30:00.000Z',
    estimatedMinutes: 60,
    actualMinutes: null,
    isAllDay: false,
    recurrence: {
      freq: 'weekly' as const,
      interval: 1,
      byWeekday: [2, 4],
      byMonthDay: null,
      count: null,
      until: null,
    },
    recurrenceParentId: null,
    routineInstanceOf: null,
    assigneeUserId: null,
    location: { lat: 37.77, lon: -122.41, name: 'Cafe' },
    url: 'https://example.com/menu',
    tagIds: [UUID_C],
    completedAt: null,
    archived: false,
    createdAt: TS,
    updatedAt: TS,
    serverVersion: 3,
    deletedAt: null,
  };
}

describe('TaskSchema — full round-trip', () => {
  it('parses a fully-populated Task and preserves every field', () => {
    const input = fullTask();
    const parsed = TaskSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  it('re-parsing the parsed object is stable (idempotent)', () => {
    const parsed = TaskSchema.parse(fullTask());
    const reparsed = TaskSchema.parse(parsed);
    expect(reparsed).toEqual(parsed);
  });

  it('rejects an out-of-range status', () => {
    const bad = { ...fullTask(), status: 7 };
    expect(TaskSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an out-of-range priority', () => {
    const bad = { ...fullTask(), priority: -1 };
    expect(TaskSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-RFC3339 timestamp', () => {
    const bad = { ...fullTask(), dueAt: '2026-06-03 08:30:00' };
    expect(TaskSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-UUID id', () => {
    const bad = { ...fullTask(), id: 'not-a-uuid' };
    expect(TaskSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown extra keys (strict)', () => {
    const bad = { ...fullTask(), surprise: true };
    expect(TaskSchema.safeParse(bad).success).toBe(false);
  });
});

describe('TaskCreateSchema — defaults', () => {
  it('fills sensible defaults from a minimal body', () => {
    const parsed = TaskCreateSchema.parse({ id: UUID_A, title: 'Minimal' });
    expect(parsed.status).toBe(TaskStatus.inbox);
    expect(parsed.priority).toBe(TaskPriority.none);
    expect(parsed.rank).toBe(0);
    expect(parsed.isAllDay).toBe(false);
    expect(parsed.archived).toBe(false);
    expect(parsed.tagIds).toEqual([]);
    expect(parsed.listId).toBeNull();
  });

  it('requires a non-empty title', () => {
    expect(TaskCreateSchema.safeParse({ id: UUID_A, title: '' }).success).toBe(false);
  });
});

describe('TaskPatchSchema — partial', () => {
  it('accepts a single-field patch', () => {
    const parsed = TaskPatchSchema.parse({ title: 'just the title' });
    expect(parsed).toEqual({ title: 'just the title' });
  });

  it('accepts an empty patch object', () => {
    expect(TaskPatchSchema.parse({})).toEqual({});
  });

  it('rejects an id in the patch body (id is path-only)', () => {
    expect(TaskPatchSchema.safeParse({ id: UUID_A }).success).toBe(false);
  });
});

describe('RecurrenceRuleSchema', () => {
  it('accepts a valid weekly rule', () => {
    const r = RecurrenceRuleSchema.parse({ freq: 'weekly', interval: 2, byWeekday: [0, 6] });
    expect(r.interval).toBe(2);
    expect(r.byMonthDay).toBeNull(); // default
    expect(r.count).toBeNull();
  });

  it('rejects interval < 1', () => {
    expect(RecurrenceRuleSchema.safeParse({ freq: 'daily', interval: 0 }).success).toBe(false);
  });

  it('rejects an unknown freq', () => {
    expect(RecurrenceRuleSchema.safeParse({ freq: 'fortnightly', interval: 1 }).success).toBe(false);
  });

  it('rejects a weekday out of 0..6', () => {
    expect(
      RecurrenceRuleSchema.safeParse({ freq: 'weekly', interval: 1, byWeekday: [9] }).success,
    ).toBe(false);
  });
});

describe('Sync envelopes', () => {
  it('parses a push op and defaults fields to null', () => {
    const op = SyncPushOpSchema.parse({
      opId: UUID_A,
      entityType: 'task',
      entityId: UUID_B,
      op: 'delete',
      baseVersion: 4,
      clientUpdatedAt: TS,
    });
    expect(op.fields).toBeNull();
    expect(op.baseVersion).toBe(4);
  });

  it('rejects a negative baseVersion', () => {
    const bad = {
      opId: UUID_A,
      entityType: 'task',
      entityId: UUID_B,
      op: 'upsert',
      baseVersion: -1,
      clientUpdatedAt: TS,
      fields: { title: 'x' },
    };
    expect(SyncPushOpSchema.safeParse(bad).success).toBe(false);
  });

  it('parses a pull response with a tombstone change', () => {
    const resp = SyncPullResponseSchema.parse({
      changes: [
        { entityType: 'task', entityId: UUID_A, op: 'upsert', version: 5, payload: { id: UUID_A }, seq: '91432' },
        { entityType: 'task', entityId: UUID_B, op: 'delete', version: 3, payload: null, seq: '91440' },
      ],
      nextCursor: 'kFnAkQ==',
      hasMore: false,
    });
    expect(resp.changes).toHaveLength(2);
    expect(resp.changes[1]!.payload).toBeNull();
  });
});

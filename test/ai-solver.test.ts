import { describe, it, expect } from 'vitest';
import { solveSchedule, type SolverTask, type TimeSlot } from '@/modules/ai/solver.js';

const slot = (startIso: string, endIso: string): TimeSlot => ({ startIso, endIso });
const task = (id: string, durationMinutes: number, extra: Partial<SolverTask> = {}): SolverTask => ({
  id,
  title: id,
  durationMinutes,
  priority: 'none',
  ...extra,
});

describe('solveSchedule', () => {
  it('places a single task at the slot start', () => {
    const r = solveSchedule({
      tasks: [task('a', 30)],
      freeSlots: [slot('2026-06-04T09:00:00.000Z', '2026-06-04T12:00:00.000Z')],
      bufferMinutes: 0,
    });
    expect(r.unscheduled).toHaveLength(0);
    expect(r.blocks[0]).toMatchObject({
      taskId: 'a',
      startIso: '2026-06-04T09:00:00.000Z',
      endIso: '2026-06-04T09:30:00.000Z',
    });
  });

  it('orders by priority then packs with a buffer', () => {
    const r = solveSchedule({
      tasks: [task('low', 30, { priority: 'p4' }), task('urgent', 30, { priority: 'p1' })],
      freeSlots: [slot('2026-06-04T09:00:00.000Z', '2026-06-04T12:00:00.000Z')],
      bufferMinutes: 15,
    });
    // urgent (p1) placed first at 09:00, then low after a 15m buffer at 09:45.
    expect(r.blocks.map((b) => b.taskId)).toEqual(['urgent', 'low']);
    expect(r.blocks[0].startIso).toBe('2026-06-04T09:00:00.000Z');
    expect(r.blocks[1].startIso).toBe('2026-06-04T09:45:00.000Z');
  });

  it('honors an explicit AI ranking over the default priority order', () => {
    const r = solveSchedule({
      tasks: [task('low', 30, { priority: 'p4' }), task('urgent', 30, { priority: 'p1' })],
      freeSlots: [slot('2026-06-04T09:00:00.000Z', '2026-06-04T12:00:00.000Z')],
      bufferMinutes: 0,
      order: ['low', 'urgent'], // AI says do 'low' first
    });
    expect(r.blocks.map((b) => b.taskId)).toEqual(['low', 'urgent']);
  });

  it('marks a task unscheduled when it cannot fit before its deadline', () => {
    const r = solveSchedule({
      tasks: [task('a', 120, { dueIso: '2026-06-04T10:00:00.000Z' })], // needs 2h but only 1h before due
      freeSlots: [slot('2026-06-04T09:00:00.000Z', '2026-06-04T18:00:00.000Z')],
      bufferMinutes: 0,
    });
    expect(r.blocks).toHaveLength(0);
    expect(r.unscheduled[0]).toMatchObject({ taskId: 'a' });
    expect(r.unscheduled[0].reason).toMatch(/deadline/);
  });

  it('marks a task unscheduled when no slot is long enough', () => {
    const r = solveSchedule({
      tasks: [task('big', 90)],
      freeSlots: [slot('2026-06-04T09:00:00.000Z', '2026-06-04T10:00:00.000Z')], // only 60m
      bufferMinutes: 0,
    });
    expect(r.blocks).toHaveLength(0);
    expect(r.unscheduled).toHaveLength(1);
  });

  it('picks the earliest fitting slot, not the first in array order', () => {
    const r = solveSchedule({
      tasks: [task('a', 30)],
      freeSlots: [
        slot('2026-06-04T14:00:00.000Z', '2026-06-04T15:00:00.000Z'), // later, listed first
        slot('2026-06-04T09:00:00.000Z', '2026-06-04T10:00:00.000Z'), // earlier, listed second
      ],
      bufferMinutes: 0,
    });
    expect(r.blocks[0].startIso).toBe('2026-06-04T09:00:00.000Z');
  });

  it('spills a second task into the next slot when the first is full', () => {
    const r = solveSchedule({
      tasks: [task('a', 45), task('b', 45)],
      freeSlots: [
        slot('2026-06-04T09:00:00.000Z', '2026-06-04T09:50:00.000Z'), // fits one 45m, not two
        slot('2026-06-04T10:00:00.000Z', '2026-06-04T11:00:00.000Z'),
      ],
      bufferMinutes: 0,
    });
    expect(r.unscheduled).toHaveLength(0);
    expect(r.blocks[0].startIso).toBe('2026-06-04T09:00:00.000Z');
    expect(r.blocks[1].startIso).toBe('2026-06-04T10:00:00.000Z'); // spilled to slot 2
  });

  it('skips zero-duration tasks with a reason', () => {
    const r = solveSchedule({
      tasks: [task('a', 0)],
      freeSlots: [slot('2026-06-04T09:00:00.000Z', '2026-06-04T12:00:00.000Z')],
      bufferMinutes: 0,
    });
    expect(r.blocks).toHaveLength(0);
    expect(r.unscheduled[0].reason).toMatch(/duration/i);
  });
});

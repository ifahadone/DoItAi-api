/**
 * Deterministic auto-scheduling constraint solver (ApiSpec §9.3, AppSpec §5.10.2).
 *
 * The AI only *ranks/interprets intent* — this solver does the placement. Given a set of open tasks
 * and the day's free slots, it greedily places each task (in the resolved order) into the earliest
 * free slot that fits its duration without crossing the slot edge, the task's deadline, or a buffer.
 * Framework-free and pure, so the whole feature degrades to rules-based scheduling when AI is off, and
 * the placement is explainable + unit-testable.
 */

export type Priority = 'none' | 'p4' | 'p3' | 'p2' | 'p1';

const PRIORITY_RANK: Record<Priority, number> = { none: 0, p4: 1, p3: 2, p2: 3, p1: 4 };
const PRIORITY_LABEL: Record<Priority, string> = {
  none: 'No priority',
  p4: 'Low priority',
  p3: 'Medium priority',
  p2: 'High priority',
  p1: 'Urgent',
};

export interface SolverTask {
  id: string;
  title: string;
  durationMinutes: number;
  priority: Priority;
  /** Hard deadline (ISO). A block must END at or before this. Null/undefined = no deadline. */
  dueIso?: string | null;
}

export interface TimeSlot {
  startIso: string;
  endIso: string;
}

export interface ScheduleSolverInput {
  tasks: SolverTask[];
  freeSlots: TimeSlot[];
  bufferMinutes: number;
  /** Optional AI ranking: task ids in the order to attempt placement. Unlisted tasks follow, ordered
   *  by the deterministic default key. */
  order?: string[] | undefined;
}

export interface ProposedBlock {
  taskId: string;
  title: string;
  startIso: string;
  endIso: string;
  reason: string;
}

export interface UnscheduledTask {
  taskId: string;
  title: string;
  reason: string;
}

export interface ScheduleSolverResult {
  blocks: ProposedBlock[];
  unscheduled: UnscheduledTask[];
}

/** Resolve placement order: AI-ranked ids first (in the given order), then the rest by default key. */
function orderTasks(tasks: SolverTask[], order?: string[]): SolverTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ranked: SolverTask[] = [];
  const seen = new Set<string>();
  for (const id of order ?? []) {
    const t = byId.get(id);
    if (t && !seen.has(id)) {
      ranked.push(t);
      seen.add(id);
    }
  }
  const rest = tasks
    .filter((t) => !seen.has(t.id))
    .sort((a, b) => {
      // priority desc, then earliest deadline, then shortest, then id (stable).
      if (PRIORITY_RANK[b.priority] !== PRIORITY_RANK[a.priority]) {
        return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
      }
      const da = a.dueIso ? Date.parse(a.dueIso) : Infinity;
      const db = b.dueIso ? Date.parse(b.dueIso) : Infinity;
      if (da !== db) return da - db;
      if (a.durationMinutes !== b.durationMinutes) return a.durationMinutes - b.durationMinutes;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  return [...ranked, ...rest];
}

const toIso = (ms: number): string => new Date(ms).toISOString();

export function solveSchedule(input: ScheduleSolverInput): ScheduleSolverResult {
  const bufferMs = Math.max(0, input.bufferMinutes) * 60_000;
  const slots = input.freeSlots
    .map((s) => ({ start: Date.parse(s.startIso), end: Date.parse(s.endIso) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const blocks: ProposedBlock[] = [];
  const unscheduled: UnscheduledTask[] = [];

  for (const task of orderTasks(input.tasks, input.order)) {
    if (task.durationMinutes <= 0) {
      unscheduled.push({ taskId: task.id, title: task.title, reason: 'No duration estimate' });
      continue;
    }
    const durMs = task.durationMinutes * 60_000;
    const deadline = task.dueIso ? Date.parse(task.dueIso) : Infinity;

    // Earliest free slot whose window fits the duration before the deadline.
    let best: { slot: { start: number; end: number }; end: number } | null = null;
    for (const slot of slots) {
      const end = slot.start + durMs;
      if (end <= slot.end && end <= deadline) {
        if (!best || slot.start < best.slot.start) best = { slot, end };
      }
    }

    if (best) {
      blocks.push({
        taskId: task.id,
        title: task.title,
        startIso: toIso(best.slot.start),
        endIso: toIso(best.end),
        reason: reasonFor(task, deadline, best.slot.start),
      });
      best.slot.start = best.end + bufferMs; // consume the placed window + the buffer
    } else {
      unscheduled.push({
        taskId: task.id,
        title: task.title,
        reason:
          deadline !== Infinity
            ? 'No free slot long enough before its deadline'
            : 'No free slot long enough today',
      });
    }
  }

  return { blocks, unscheduled };
}

function reasonFor(task: SolverTask, deadline: number, startMs: number): string {
  if (deadline !== Infinity && deadline - (startMs + task.durationMinutes * 60_000) < 2 * 60 * 60_000) {
    return `${PRIORITY_LABEL[task.priority]} · close to its deadline`;
  }
  return `${PRIORITY_LABEL[task.priority]} · earliest open slot`;
}

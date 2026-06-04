/**
 * AI proposal schemas (ApiSpec §9). Each data-producing endpoint forces a tool call whose
 * `input_schema` is generated from one of these Zod schemas, and the response is re-validated by the
 * same schema. The client always PREVIEWS the proposal before anything writes (human-in-the-loop).
 */
import { z } from 'zod';

// --- /ai/parse : NL quick-add → task fields (§9.2) ---------------------------
export const ParsedTaskSchema = z
  .object({
    title: z.string().min(1),
    start: z.string().datetime().nullable(),
    durationMinutes: z.number().int().positive().nullable(),
    due: z.string().datetime().nullable(),
    priority: z.enum(['none', 'p4', 'p3', 'p2', 'p1']),
    tags: z.array(z.string()),
    listHint: z.string().nullable(),
  })
  .strict();
export type ParsedTask = z.infer<typeof ParsedTaskSchema>;

export const ParseRequestSchema = z
  .object({
    text: z.string().min(1).max(1000),
    /** Client's current time so "tomorrow 9am" resolves relative to the user (consented context). */
    nowIso: z.string().datetime().optional(),
    timezone: z.string().max(64).optional(),
    /** Existing list names so the model can suggest a `listHint`. */
    lists: z.array(z.string().max(120)).max(200).optional(),
    /** Existing tag names so the model reuses them rather than inventing near-duplicates. */
    tags: z.array(z.string().max(120)).max(500).optional(),
  })
  .strict();
export type ParseRequest = z.infer<typeof ParseRequestSchema>;

// --- /ai/schedule : AI ranks intent, the solver places (§9.3) ----------------
export const PrioritySchema = z.enum(['none', 'p4', 'p3', 'p2', 'p1']);

export const ScheduleTaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    durationMinutes: z.number().int().positive(),
    priority: PrioritySchema.default('none'),
    dueIso: z.string().datetime().nullable().optional(),
  })
  .strict();

export const TimeSlotSchema = z
  .object({ startIso: z.string().datetime(), endIso: z.string().datetime() })
  .strict();

export const ScheduleRequestSchema = z
  .object({
    tasks: z.array(ScheduleTaskSchema).min(1).max(100),
    freeSlots: z.array(TimeSlotSchema).max(100),
    bufferMinutes: z.number().int().min(0).max(120).default(5),
    /** Free-text scheduling intent ("mornings for deep work"). Empty ⇒ pure rules (no model call). */
    intent: z.string().max(500).optional(),
  })
  .strict();
export type ScheduleRequest = z.infer<typeof ScheduleRequestSchema>;

/** The AI ranking tool output: task ids in the order the model recommends attempting placement. */
export const RankingSchema = z.object({ order: z.array(z.string()) }).strict();

// --- /ai/search : NL query → structured filter the client runs locally (§9.1) ---
export const SearchFilterSchema = z
  .object({
    /** Free-text the client matches against title/notes (null = no text constraint). */
    text: z.string().nullable(),
    priorities: z.array(PrioritySchema),
    tags: z.array(z.string()),
    listHint: z.string().nullable(),
    dueBefore: z.string().datetime().nullable(),
    dueAfter: z.string().datetime().nullable(),
    includeCompleted: z.boolean(),
  })
  .strict();
export type SearchFilter = z.infer<typeof SearchFilterSchema>;

export const SearchRequestSchema = z
  .object({
    query: z.string().min(1).max(500),
    nowIso: z.string().datetime().optional(),
  })
  .strict();
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

// --- /ai/routine-suggest : detect repeated tasks → routine suggestion (§9.1) ---
export const RecurrenceSuggestionSchema = z
  .object({
    /** ISO weekdays 1=Sun..7=Sat the routine recurs on (null when it's everyNDays). */
    weekdays: z.array(z.number().int().min(1).max(7)).nullable(),
    everyNDays: z.number().int().positive().nullable(),
  })
  .strict();

export const RoutineSuggestionSchema = z
  .object({
    name: z.string().min(1),
    steps: z.array(z.object({ title: z.string().min(1), minutes: z.number().int().positive() }).strict()),
    recurrence: RecurrenceSuggestionSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const RoutineSuggestionsSchema = z
  .object({ suggestions: z.array(RoutineSuggestionSchema) })
  .strict();
export type RoutineSuggestions = z.infer<typeof RoutineSuggestionsSchema>;

export const RoutineSuggestRequestSchema = z
  .object({
    /** Recent (ideally completed) tasks for the model to mine for a recurring pattern. */
    tasks: z
      .array(
        z
          .object({
            title: z.string().min(1).max(500),
            completedAtIso: z.string().datetime().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type RoutineSuggestRequest = z.infer<typeof RoutineSuggestRequestSchema>;

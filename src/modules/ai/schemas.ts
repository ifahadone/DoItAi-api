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

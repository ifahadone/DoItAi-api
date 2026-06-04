/**
 * AI proxy routes (ApiSpec §7.8, §9) — AUTHENTICATED + consent-gated + budget-metered.
 *
 * Every endpoint: requireUser → requireAiConsent (403 if not consented) → assertWithinBudget (429 if
 * over) → run the model via the structured/streaming helpers → record token usage. With no API key
 * configured the client is null and we fail closed (503 `ai_unavailable`) so the app uses its
 * on-device/rules fallback (ApiSpec §9.6). AI never writes the data layer — it returns a proposal the
 * client previews and then writes via the normal `sync/push`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUser } from '@/auth/middleware.js';
import { parseOrThrow } from '@/lib/validate.js';
import { errors } from '@/lib/errors.js';
import { getAiClient, MODEL_BY_TIER, type AiClient } from './client.js';
import { requireAiConsent, type ConsentedUser } from './consent.js';
import { assertWithinBudget, recordUsage } from './usage.js';
import { runStructured } from './structured.js';
import { solveSchedule, type SolverTask } from './solver.js';
import {
  ParsedTaskSchema,
  ParseRequestSchema,
  ScheduleRequestSchema,
  RankingSchema,
  SearchFilterSchema,
  SearchRequestSchema,
  RoutineSuggestionsSchema,
  RoutineSuggestRequestSchema,
} from './schemas.js';

interface AiContext {
  userId: string;
  user: ConsentedUser;
  /** Null when no API key is configured. Endpoints that always call the model throw; those with a
   *  rules-only path (schedule without intent) proceed without it. */
  client: AiClient | null;
}

/** The shared guard: auth + consent + budget. (The client is nullable — see `AiContext`.) */
async function aiContext(request: FastifyRequest, nowIso: string): Promise<AiContext> {
  const { id: userId } = requireUser(request);
  const user = await requireAiConsent(userId);
  await assertWithinBudget(userId, nowIso);
  return { userId, user, client: getAiClient() };
}

/** Assert a configured client, else fail closed (503) so the app uses its on-device/rules fallback. */
function requireClient(client: AiClient | null): AiClient {
  if (!client) throw errors.aiUnavailable('AI is not configured on the server');
  return client;
}

const PARSE_SYSTEM = [
  'You convert a short natural-language task phrase into structured task fields for a to-do app.',
  'Rules:',
  '- title: the task itself, with date/time/priority/tag tokens removed.',
  '- start: ISO-8601 datetime if the phrase names a specific start time, else null.',
  '- durationMinutes: positive integer if a duration is stated (e.g. "for 30m"), else null.',
  '- due: ISO-8601 datetime if a deadline/due is stated, else null. Resolve relative dates against the provided current time.',
  '- priority: one of none|p4|p3|p2|p1. Map "!p1".."!p4" and words like "urgent"→p1; default none.',
  '- tags: bare tag names (no "#"). Prefer reusing the provided existing tags over inventing near-duplicates.',
  '- listHint: the best-matching provided list name, or null.',
  'Return ONLY the emit_task tool call. Do not write prose.',
].join('\n');

const SCHEDULE_SYSTEM = [
  'You rank a list of tasks for the day given the user\'s scheduling intent.',
  'Return the task ids in the order they should be attempted for placement — most-preferred first.',
  'Honor the intent (e.g. "mornings for deep work" ⇒ put deep-focus tasks first so they land earliest).',
  'You do NOT assign times; a deterministic solver places them into free slots afterward.',
  'Include every provided id exactly once. Return ONLY the rank_tasks tool call.',
].join('\n');

const SEARCH_SYSTEM = [
  'You convert a natural-language task search into a structured filter the app runs locally.',
  '- text: the free-text to match (title/notes), or null if the query is fully captured by the other fields.',
  '- priorities: any priorities the query implies (e.g. "urgent"→["p1"]); else [].',
  '- tags: bare tag names mentioned; else [].',
  '- listHint: a list name if the query names one, else null.',
  '- dueBefore/dueAfter: ISO datetimes if the query implies a window (resolve relative dates against the current time); else null.',
  '- includeCompleted: true only if the query asks for done/completed items.',
  'Return ONLY the emit_filter tool call.',
].join('\n');

const ROUTINE_SUGGEST_SYSTEM = [
  'You look at a list of recently completed tasks and detect recurring patterns worth turning into a routine.',
  'For each strong pattern, suggest a routine: a name, ordered steps (title + estimated minutes), a recurrence',
  '(weekdays 1=Sun..7=Sat, OR everyNDays), and a confidence 0..1.',
  'Only suggest routines you are reasonably confident about. If nothing recurs, return an empty suggestions array.',
  'Return ONLY the emit_suggestions tool call.',
].join('\n');

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  // POST /ai/parse — NL quick-add → task fields (fast tier, structured tool call). §9.2
  app.post('/ai/parse', async (request) => {
    const nowIso = app.clock.nowIso();
    const ctx = await aiContext(request, nowIso);
    const client = requireClient(ctx.client);
    const userId = ctx.userId;
    const body = parseOrThrow(ParseRequestSchema, request.body);

    const stableContextParts: string[] = [];
    if (body.lists?.length) stableContextParts.push(`Existing lists: ${body.lists.join(', ')}`);
    if (body.tags?.length) stableContextParts.push(`Existing tags: ${body.tags.join(', ')}`);
    const stableContext = stableContextParts.length ? stableContextParts.join('\n') : undefined;

    const userParts = [`Current time: ${body.nowIso ?? nowIso}`];
    if (body.timezone) userParts.push(`Timezone: ${body.timezone}`);
    userParts.push(`Phrase: ${body.text}`);

    const { value, usage } = await runStructured(client, {
      tier: 'fast',
      system: PARSE_SYSTEM,
      toolName: 'emit_task',
      toolDescription: 'Emit the structured fields parsed from the task phrase.',
      schema: ParsedTaskSchema,
      stableContext,
      userContent: userParts.join('\n'),
      maxTokens: 512,
    });

    await recordUsage(userId, 'parse', MODEL_BY_TIER.fast, usage, nowIso);
    return { task: value };
  });

  // POST /ai/schedule — AI ranks intent, the deterministic solver places (§9.3). With no intent, it
  // skips the model entirely and returns a pure rules-based plan (graceful degradation).
  app.post('/ai/schedule', async (request) => {
    const nowIso = app.clock.nowIso();
    const { userId, client } = await aiContext(request, nowIso);
    const body = parseOrThrow(ScheduleRequestSchema, request.body);

    const solverTasks: SolverTask[] = body.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      durationMinutes: t.durationMinutes,
      priority: t.priority,
      dueIso: t.dueIso ?? null,
    }));

    let order: string[] | undefined;
    const intent = body.intent?.trim();
    if (intent) {
      const aiClient = requireClient(client);
      const taskLines = body.tasks
        .map((t) => `- ${t.id}: "${t.title}" (${t.priority}${t.dueIso ? `, due ${t.dueIso}` : ''})`)
        .join('\n');
      const { value, usage } = await runStructured(aiClient, {
        tier: 'mid',
        system: SCHEDULE_SYSTEM,
        toolName: 'rank_tasks',
        toolDescription: 'Emit the task ids in the recommended placement order.',
        schema: RankingSchema,
        userContent: `Intent: ${intent}\n\nTasks:\n${taskLines}`,
        maxTokens: 512,
      });
      // Keep only known ids (the solver re-appends any the model dropped, by its default key).
      const known = new Set(body.tasks.map((t) => t.id));
      order = value.order.filter((id) => known.has(id));
      await recordUsage(userId, 'schedule', MODEL_BY_TIER.mid, usage, nowIso);
    }

    const plan = solveSchedule({
      tasks: solverTasks,
      freeSlots: body.freeSlots,
      bufferMinutes: body.bufferMinutes,
      order,
    });
    return { ...plan, ranked: order !== undefined };
  });

  // POST /ai/search — NL query → a structured filter the client runs locally (fast tier). §9.1
  app.post('/ai/search', async (request) => {
    const nowIso = app.clock.nowIso();
    const ctx = await aiContext(request, nowIso);
    const client = requireClient(ctx.client);
    const body = parseOrThrow(SearchRequestSchema, request.body);

    const { value, usage } = await runStructured(client, {
      tier: 'fast',
      system: SEARCH_SYSTEM,
      toolName: 'emit_filter',
      toolDescription: 'Emit the structured filter for the search query.',
      schema: SearchFilterSchema,
      userContent: `Current time: ${body.nowIso ?? nowIso}\nQuery: ${body.query}`,
      maxTokens: 384,
    });
    await recordUsage(ctx.userId, 'search', MODEL_BY_TIER.fast, usage, nowIso);
    return { filter: value };
  });

  // POST /ai/routine-suggest — detect repeated tasks → routine suggestions (mid tier). §9.1
  app.post('/ai/routine-suggest', async (request) => {
    const nowIso = app.clock.nowIso();
    const ctx = await aiContext(request, nowIso);
    const client = requireClient(ctx.client);
    const body = parseOrThrow(RoutineSuggestRequestSchema, request.body);

    const taskLines = body.tasks
      .map((t) => `- ${t.title}${t.completedAtIso ? ` (done ${t.completedAtIso})` : ''}`)
      .join('\n');
    const { value, usage } = await runStructured(client, {
      tier: 'mid',
      system: ROUTINE_SUGGEST_SYSTEM,
      toolName: 'emit_suggestions',
      toolDescription: 'Emit zero or more routine suggestions mined from the tasks.',
      schema: RoutineSuggestionsSchema,
      userContent: `Recent tasks:\n${taskLines}`,
      maxTokens: 1024,
    });
    await recordUsage(ctx.userId, 'routine-suggest', MODEL_BY_TIER.mid, usage, nowIso);
    return value; // { suggestions: [...] }
  });
}

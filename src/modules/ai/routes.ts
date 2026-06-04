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
import { ParsedTaskSchema, ParseRequestSchema } from './schemas.js';

interface AiContext {
  userId: string;
  user: ConsentedUser;
  client: AiClient;
}

/** The shared guard: auth + consent + budget + a configured client (else fail closed). */
async function aiContext(request: FastifyRequest, nowIso: string): Promise<AiContext> {
  const { id: userId } = requireUser(request);
  const user = await requireAiConsent(userId);
  await assertWithinBudget(userId, nowIso);
  const client = getAiClient();
  if (!client) {
    throw errors.aiUnavailable('AI is not configured on the server');
  }
  return { userId, user, client };
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

export async function registerAiRoutes(app: FastifyInstance): Promise<void> {
  // POST /ai/parse — NL quick-add → task fields (fast tier, structured tool call). §9.2
  app.post('/ai/parse', async (request) => {
    const nowIso = app.clock.nowIso();
    const { userId, client } = await aiContext(request, nowIso);
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
}

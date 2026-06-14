/**
 * AI usage metering + budget enforcement (ApiSpec §9.6). One `ai_usage` row per call meters tokens
 * (and cache hits, to audit caching). The per-user monthly token budget is checked BEFORE each call;
 * over budget ⇒ 429 `ai_budget_exceeded` and the client falls back to on-device/rules.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { aiUsage } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { errors } from '@/lib/errors.js';
import { getRedis } from '@/redis/client.js';
import type { AiUsage } from './client.js';

/** Short-window request throttle (separate from the monthly token budget) so a runaway client can't
 *  hammer the paid LLM. Per-user and per-IP fixed 60s windows via Redis INCR/EXPIRE. No-ops when Redis
 *  is absent (local/test) — the monthly budget remains the backstop. */
const AI_REQUESTS_PER_MIN = 20;
export async function assertAiRateLimit(userId: string, ip: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  for (const { key, max } of [
    { key: `airl:u:${userId}`, max: AI_REQUESTS_PER_MIN },
    { key: `airl:ip:${ip}`, max: AI_REQUESTS_PER_MIN * 2 },
  ]) {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 60);
    if (n > max) throw errors.rateLimited(`AI rate limit reached (max ${max}/min). Try again shortly.`);
  }
}

/** Sum of input+output tokens this user has spent since the start of the current UTC month. */
export async function monthlyTokens(userId: string, nowIso: string): Promise<number> {
  const monthStart = startOfUtcMonth(nowIso);
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.ownerId, userId), gte(aiUsage.createdAt, monthStart)));
  return Number(row?.total ?? 0);
}

/** Throw 429 `ai_budget_exceeded` if the user is already at/over budget. Call BEFORE the AI request. */
export async function assertWithinBudget(userId: string, nowIso: string): Promise<void> {
  const used = await monthlyTokens(userId, nowIso);
  if (used >= env.AI_MONTHLY_TOKEN_BUDGET) {
    throw errors.aiBudgetExceeded(
      `Monthly AI token budget (${env.AI_MONTHLY_TOKEN_BUDGET}) reached`,
    );
  }
}

/** Record one AI call's token usage (best-effort metering; never blocks the response). */
export async function recordUsage(
  userId: string,
  endpoint: string,
  model: string,
  usage: AiUsage,
  nowIso: string,
): Promise<void> {
  await db.insert(aiUsage).values({
    id: randomUUID(),
    ownerId: userId,
    endpoint,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    createdAt: nowIso,
  });
}

function startOfUtcMonth(nowIso: string): string {
  const d = new Date(nowIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

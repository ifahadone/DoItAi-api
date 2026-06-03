/**
 * Shared Redis client (ApiSpec §8, §11) — used later for WS pub/sub fan-out,
 * BullMQ queues, and rate-limit buckets. Phase 0 boots WITHOUT Redis; once
 * REDIS_URL is configured the client connects lazily and `/ready` health-checks it.
 *
 * Kept optional: `getRedis()` returns null when REDIS_URL is unset, so callers
 * degrade gracefully rather than crash (the app must run without Redis).
 */
import { Redis } from 'ioredis';
import { env, redisEnabled } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

let client: Redis | null = null;

/** The shared Redis client, created lazily. Returns null when Redis is disabled. */
export function getRedis(): Redis | null {
  if (!redisEnabled || env.REDIS_URL === undefined) return null;
  if (client === null) {
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      connectTimeout: 8_000,
      // Don't let a Redis blip take the process down; surface as logs + degraded health.
      enableReadyCheck: true,
    });
    client.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis error'));
  }
  return client;
}

/** Ping Redis with a bounded timeout. False when disabled or unreachable. */
export async function pingRedis(timeoutMs = 3_000): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pong = await Promise.race([
      r.ping(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error('redis ping timeout')), timeoutMs);
      }),
    ]);
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Graceful shutdown — quit the client if it was created. */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}

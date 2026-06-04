/**
 * Realtime pub/sub bus (ApiSpec §8). The socket layer (`ws.ts`) subscribes per-channel; committers
 * publish `sync.bump` (and small collab events) to `user:{id}` / `share:{id}` channels.
 *
 * Single-instance: a local EventEmitter is the whole bus. Horizontally-scaled: when Redis is
 * configured, publishes go through Redis pub/sub so a change on instance A reaches sockets on instance
 * B — every instance's subscriber forwards received messages to its local handlers. The durable truth
 * still flows through `sync/pull`, so a missed message is harmless (a missed bump just delays a pull).
 */
import { EventEmitter } from 'node:events';
import { getRedis } from '@/redis/client.js';
import { logger } from '@/lib/logger.js';

const local = new EventEmitter();
local.setMaxListeners(0);

let redisSub: ReturnType<NonNullable<ReturnType<typeof getRedis>>['duplicate']> | null = null;
const redisChannels = new Set<string>();

/** Lazily create the Redis subscriber connection + subscribe it to a channel (cross-instance fan-out). */
async function ensureRedisSubscribed(channel: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  if (!redisSub) {
    redisSub = redis.duplicate();
    redisSub.on('message', (ch: string, payload: string) => local.emit(ch, payload));
    redisSub.on('error', (err: unknown) => logger.warn({ err }, 'realtime redis subscriber error'));
  }
  if (!redisChannels.has(channel)) {
    redisChannels.add(channel);
    await redisSub.subscribe(channel);
  }
}

/** Publish a message to a channel. */
export async function publish(channel: string, message: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify(message);
  const redis = getRedis();
  if (redis) {
    // Goes to every instance's subscriber (incl. this one's, if it has sockets here).
    await redis.publish(channel, payload).catch((err) => logger.warn({ err }, 'realtime publish failed'));
  } else {
    local.emit(channel, payload);
  }
}

/** Subscribe a handler to a channel. Returns an unsubscribe fn. */
export async function subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
  await ensureRedisSubscribed(channel);
  local.on(channel, handler);
  return () => local.off(channel, handler);
}

/** Notify users that there are changes ≥ `cursor` — they should pull (the authoritative path). */
export async function publishBump(userIds: string[], cursor: string): Promise<void> {
  const unique = Array.from(new Set(userIds));
  await Promise.all(
    unique.map((userId) =>
      publish(`user:${userId}`, { type: 'sync.bump', channel: `user:${userId}`, data: { cursor } }),
    ),
  );
}

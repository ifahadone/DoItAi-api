/**
 * WebSocket endpoint (ApiSpec §8). Auth on connect via `?ticket=<jwt>` or the
 * `Sec-WebSocket-Protocol: bearer,<jwt>` subprotocol. Each socket auto-subscribes to its own
 * `user:{id}` channel and may `subscribe` to `share:{id}` channels it belongs to. The socket only
 * relays lightweight nudges (`sync.bump`) + small collab events; durable truth flows through sync/pull.
 */
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { shares, shareMembers } from '@/db/schema.js';
import { verifyAccessToken } from '@/auth/tokens.js';
import { issueAccessToken } from '@/auth/tokens.js';
import { requireUser } from '@/auth/middleware.js';
import { logger } from '@/lib/logger.js';
import { subscribe } from './bus.js';

/** Extract the access token from `?ticket=` or the `bearer,<jwt>` subprotocol. */
function tokenFromRequest(req: FastifyRequest): string | null {
  const ticket = (req.query as { ticket?: string } | undefined)?.ticket;
  if (ticket) return ticket;
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    const parts = proto.split(',').map((p) => p.trim());
    const i = parts.indexOf('bearer');
    if (i >= 0 && parts[i + 1]) return parts[i + 1]!;
  }
  return null;
}

async function isShareMember(shareId: string, userId: string): Promise<boolean> {
  const [share] = await db.select({ ownerId: shares.ownerId }).from(shares).where(eq(shares.id, shareId)).limit(1);
  if (!share) return false;
  if (share.ownerId === userId) return true;
  const [member] = await db
    .select({ id: shareMembers.id })
    .from(shareMembers)
    .where(and(eq(shareMembers.shareId, shareId), eq(shareMembers.userId, userId)))
    .limit(1);
  return Boolean(member);
}

/** Register the `/ws` socket (no auth hook — auth happens in the handler). */
export async function registerWebSocketRoutes(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  app.get('/ws', { websocket: true }, async (socket, req) => {
    const token = tokenFromRequest(req);
    let userId: string;
    try {
      const claims = await verifyAccessToken(token ?? '');
      userId = claims.sub;
    } catch {
      socket.close(1008, 'unauthenticated');
      return;
    }

    const send = (obj: Record<string, unknown>) => {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* socket closing */
      }
    };

    const unsubs: Array<() => void> = [];
    unsubs.push(await subscribe(`user:${userId}`, (payload) => socket.send(payload)));
    send({ type: 'ready', channel: `user:${userId}` });

    const shareSubs = new Map<string, () => void>();
    socket.on('message', (raw: Buffer) => {
      void (async () => {
        let env: { type?: string; channel?: string };
        try {
          env = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (env.type === 'ping') {
          send({ type: 'pong' });
        } else if (env.type === 'subscribe' && env.channel?.startsWith('share:')) {
          const shareId = env.channel.slice('share:'.length);
          if (!shareSubs.has(env.channel) && (await isShareMember(shareId, userId))) {
            const off = await subscribe(env.channel, (payload) => socket.send(payload));
            shareSubs.set(env.channel, off);
            send({ type: 'subscribed', channel: env.channel });
          }
        } else if (env.type === 'unsubscribe' && env.channel) {
          shareSubs.get(env.channel)?.();
          shareSubs.delete(env.channel);
        }
      })();
    });

    // Heartbeat: ping every 30 s; the ws library drops sockets that stop responding.
    const heartbeat = setInterval(() => {
      try {
        socket.ping();
      } catch {
        /* closing */
      }
    }, 30_000);

    socket.on('close', () => {
      clearInterval(heartbeat);
      for (const off of unsubs) off();
      for (const off of shareSubs.values()) off();
    });
    socket.on('error', (err: unknown) => logger.warn({ err }, 'ws socket error'));
  });
}

/** Authenticated: mint a short-lived ticket for `?ticket=` connects (avoids tokens in proxy logs). */
export async function registerWsTicketRoute(app: FastifyInstance): Promise<void> {
  app.post('/ws/ticket', async (request) => {
    const user = requireUser(request);
    const ticket = await issueAccessToken({ sub: user.id, did: user.deviceId }, app.clock);
    return { ticket };
  });
}

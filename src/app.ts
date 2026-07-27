/**
 * buildApp — assembles the Fastify instance: request-id + logging, the typed
 * error handler (envelope), the injected Clock, health/ready, the OpenAPI doc,
 * the UNAUTHENTICATED `/auth/*` routes, and the AUTHENTICATED `/api/v1/*`
 * surface guarded by the `authenticate` preHandler.
 *
 * Auth scoping (ApiSpec §3 "Auth on everything except /auth/*, /health, /ready"):
 * Fastify plugins create encapsulation contexts. We register the authenticated
 * modules inside a child context that adds `authenticate` as an `onRequest`
 * hook; `/auth/*`, `/health`, `/ready`, and the OpenAPI doc are registered in
 * the parent context with no auth hook.
 */
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyError,
} from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { redisEnabled, env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { toErrorEnvelope, errors, AppError } from '@/lib/errors.js';
import { systemClock, type Clock } from '@/lib/clock.js';
import { pingDb } from '@/db/client.js';
import { pingRedis } from '@/redis/client.js';
import { authenticate } from '@/auth/middleware.js';
import { registerAuthRoutes } from '@/auth/routes.js';
import { registerSyncRoutes } from '@/modules/sync/routes.js';
import { registerTaskRoutes } from '@/modules/tasks/routes.js';
import { registerListRoutes } from '@/modules/lists/routes.js';
import { registerTagRoutes } from '@/modules/tags/routes.js';
import { registerDeviceRoutes } from '@/modules/devices/routes.js';
import { registerHabitRoutes } from '@/modules/habits/routes.js';
import { registerAiRoutes } from '@/modules/ai/routes.js';
import { registerBillingRoutes, registerBillingWebhook } from '@/modules/billing/routes.js';
import { registerAccountRoutes } from '@/modules/account/routes.js';
import { registerSharingRoutes } from '@/modules/sharing/routes.js';
import { registerCommentRoutes } from '@/modules/comments/routes.js';
import { registerWebSocketRoutes, registerWsTicketRoute } from '@/realtime/ws.js';
import { buildOpenApiDocument } from '@/openapi/openapi.js';

const API_PREFIX = '/api/v1';

// Decorate the instance with the injected clock (deterministic in tests).
declare module 'fastify' {
  interface FastifyInstance {
    clock: Clock;
  }
}

export interface BuildAppOptions {
  /** Override the clock for tests. Defaults to the system clock. */
  clock?: Clock;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger,
    // Echo a caller-provided X-Request-Id, else generate one (ApiSpec §3).
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    },
    disableRequestLogging: false,
    bodyLimit: 5 * 1024 * 1024, // 5 MB — generous for sync batches
  });

  app.decorate('clock', opts.clock ?? systemClock);

  // CORS: restrict to a configured allowlist when set (a web/admin client exists); otherwise reflect
  // any origin — harmless for the native app, which sends no Origin header (NFR-SEC).
  await app.register(cors, { origin: env.CORS_ALLOWED_ORIGINS ?? true });

  // Per-IP fixed-window rate limit on every route (skipped in tests, which fire many requests in-process).
  // AI routes keep their own per-user token budget on top of this. Single-instance/in-memory — the
  // scale-out path is a Redis-backed limiter, but this closes the enumeration/spam gap for a single node.
  if (env.NODE_ENV !== 'test') {
    const hits = new Map<string, { count: number; resetAt: number }>();
    const windowMs = env.RATE_LIMIT_WINDOW_MS;
    const max = env.RATE_LIMIT_MAX;
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/health' || request.url === '/ready') return; // don't throttle probes
      const now = Date.now();
      // Opportunistic cleanup so the map can't grow unbounded under IP churn.
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      const key = request.ip || 'unknown';
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return;
      }
      entry.count += 1;
      if (entry.count > max) {
        reply.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
        throw errors.rateLimited('Too many requests. Please slow down and try again shortly.');
      }
    });
  }

  // Always surface the request id so clients can quote it in bug reports.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // --- Typed error handler -> envelope (ApiSpec §3, §21) --------------------
  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // Fastify's own body-parse / schema errors come through with a `statusCode`;
    // normalize the common 400/413 to our validation envelope.
    const maybe = err as { statusCode?: number; message?: string };
    let toRender: unknown = err;
    if (
      !(err instanceof AppError) &&
      typeof maybe.statusCode === 'number' &&
      maybe.statusCode >= 400 &&
      maybe.statusCode < 500
    ) {
      // Treat framework 4xx (e.g. malformed JSON body) as a validation error.
      toRender = errors.validation(maybe.message ?? 'Bad request');
    }

    const { status, body } = toErrorEnvelope(toRender, request.id);
    if (status >= 500) {
      request.log.error({ err }, 'request failed');
    } else {
      request.log.info({ code: body.error.code, status }, 'request error');
    }
    reply.code(status).send(body);
  });

  // 404 -> typed envelope.
  app.setNotFoundHandler((request, reply) => {
    const { status, body } = toErrorEnvelope(errors.notFound('Route not found'), request.id);
    reply.code(status).send(body);
  });

  // --- Unauthenticated ops endpoints ---------------------------------------
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    const [dbOk, redisOk] = await Promise.all([
      pingDb(),
      redisEnabled ? pingRedis() : Promise.resolve(null),
    ]);
    const ready = dbOk; // DB gates readiness; Redis is reported but optional until Phase 5.
    const payload = {
      status: ready ? 'ready' : 'degraded',
      checks: {
        db: dbOk ? 'ok' : 'down',
        redis: redisOk === null ? 'disabled' : redisOk ? 'ok' : 'down',
      },
    };
    reply.code(ready ? 200 : 503);
    return payload;
  });

  // --- OpenAPI doc (unauthenticated; ApiSpec §3) ---------------------------
  app.get(`${API_PREFIX}/openapi.json`, async () => buildOpenApiDocument());

  // --- Unauthenticated auth routes under the API prefix --------------------
  await app.register(
    async (instance) => {
      await registerAuthRoutes(instance);
      // Apple's App Store Server Notifications V2 webhook — unauthenticated (trust = the JWS signature).
      await registerBillingWebhook(instance);
    },
    { prefix: API_PREFIX },
  );

  // --- Authenticated surface: child context with the auth hook -------------
  await app.register(
    async (instance) => {
      // Every route in this encapsulated context requires a valid access token.
      instance.addHook('onRequest', authenticate);
      await registerSyncRoutes(instance);
      await registerTaskRoutes(instance);
      await registerListRoutes(instance);
      await registerTagRoutes(instance);
      await registerDeviceRoutes(instance);
      await registerHabitRoutes(instance);
      await registerAiRoutes(instance);
      await registerBillingRoutes(instance);
      await registerAccountRoutes(instance);
      await registerSharingRoutes(instance);
      await registerCommentRoutes(instance);
      await registerWsTicketRoute(instance);
    },
    { prefix: API_PREFIX },
  );

  // --- Realtime socket: /api/v1/ws (auth happens in the handler, not via the onRequest hook) -------
  await app.register(
    async (instance) => {
      await registerWebSocketRoutes(instance);
    },
    { prefix: API_PREFIX },
  );

  // Widen back to the documented return type. Passing a concrete pino
  // `loggerInstance` specializes Fastify's logger generic; consumers want the
  // general FastifyInstance. The cast is sound (pino's Logger satisfies
  // FastifyBaseLogger at runtime) — the mismatch is only structural strictness
  // under exactOptionalPropertyTypes.
  return app as unknown as FastifyInstance;
}

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
import { redisEnabled } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { toErrorEnvelope, errors, AppError } from '@/lib/errors.js';
import { systemClock, type Clock } from '@/lib/clock.js';
import { pingDb } from '@/db/client.js';
import { authenticate } from '@/auth/middleware.js';
import { registerAuthRoutes } from '@/auth/routes.js';
import { registerSyncRoutes } from '@/modules/sync/routes.js';
import { registerTaskRoutes } from '@/modules/tasks/routes.js';
import { registerListRoutes } from '@/modules/lists/routes.js';
import { registerTagRoutes } from '@/modules/tags/routes.js';
import { registerDeviceRoutes } from '@/modules/devices/routes.js';
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

  await app.register(cors, { origin: true });

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
    const dbOk = await pingDb();
    const ready = dbOk; // Redis is optional in Phase 0; not gating readiness.
    const payload = {
      status: ready ? 'ready' : 'degraded',
      checks: {
        db: dbOk ? 'ok' : 'down',
        redis: redisEnabled ? 'configured' : 'disabled',
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

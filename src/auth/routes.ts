/**
 * Auth routes (ApiSpec §4, §7.1) — UNAUTHENTICATED surface. Registered outside
 * the `authenticate` preHandler scope (see src/app.ts).
 *
 * Routes are THIN: validate (Zod) -> delegate to the service -> shape response.
 * The injected `Clock` comes from `app.clock` (decorated in src/app.ts) so token
 * lifetimes are deterministic in tests.
 */
import type { FastifyInstance } from 'fastify';
import { parseOrThrow } from '@/lib/validate.js';
import {
  AppleSignInSchema,
  RefreshSchema,
  LogoutSchema,
  AppleNotificationSchema,
  type TokenPair,
} from '@/contract/schemas.js';
import * as authService from '@/auth/service.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // POST /auth/apple — exchange Apple identity token for our tokens.
  app.post('/auth/apple', async (request, reply): Promise<TokenPair> => {
    const body = parseOrThrow(AppleSignInSchema, request.body);
    const pair = await authService.signInWithApple(body, app.clock);
    reply.code(200);
    return pair;
  });

  // POST /auth/refresh — rotate access/refresh.
  app.post('/auth/refresh', async (request): Promise<TokenPair> => {
    const body = parseOrThrow(RefreshSchema, request.body);
    return authService.refresh(body, app.clock);
  });

  // POST /auth/logout — revoke this device's refresh token.
  app.post('/auth/logout', async (request, reply): Promise<void> => {
    const body = parseOrThrow(LogoutSchema, request.body);
    await authService.logout(body, app.clock);
    reply.code(204);
  });

  // POST /auth/apple/notifications — Apple server-to-server notification (NFR-SEC-260). Verifies the
  // signed payload and purges the account on account-delete / consent-revoked. Unauthenticated (Apple
  // calls it); acks 200 idempotently so Apple doesn't retry.
  app.post('/auth/apple/notifications', async (request, reply): Promise<{ ok: true }> => {
    const body = parseOrThrow(AppleNotificationSchema, request.body);
    await authService.handleAppleNotification(body.payload);
    reply.code(200);
    return { ok: true };
  });
}

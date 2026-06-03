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
}

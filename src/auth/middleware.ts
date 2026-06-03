/**
 * Auth preHandler (ApiSpec §4.3). Verifies the access JWT from
 * `Authorization: Bearer <jwt>` and sets `request.user = { id, deviceId }`.
 * Throws `unauthenticated` (-> 401 envelope) on any failure; the global error
 * handler renders it.
 *
 * Registration strategy (see src/app.ts): this runs as a route-level / scoped
 * preHandler on the authenticated `/api/v1` surface. `/auth/*`, `/health`,
 * `/ready`, and the OpenAPI doc are registered OUTSIDE that scope.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { errors } from '@/lib/errors.js';
import { verifyAccessToken } from '@/auth/tokens.js';

/** The authenticated principal attached to every protected request. */
export interface AuthUser {
  id: string;
  deviceId: string;
}

// Augment Fastify's request with our typed user.
declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

export async function authenticate(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization;
  if (!header) {
    throw errors.unauthenticated('Missing Authorization header');
  }
  const match = BEARER_RE.exec(header);
  if (!match || !match[1]) {
    throw errors.unauthenticated('Malformed Authorization header; expected "Bearer <token>"');
  }
  const claims = await verifyAccessToken(match[1]);
  request.user = { id: claims.sub, deviceId: claims.did };
}

/**
 * Read the authenticated user or throw. Use in handlers so `request.user` is
 * narrowed to non-undefined without sprinkling `!`.
 */
export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.user) {
    throw errors.unauthenticated();
  }
  return request.user;
}

/**
 * Account routes (ApiSpec §11) — AUTHENTICATED.
 * - `POST /account/export` returns the user's full data bundle (GDPR portability).
 * - `DELETE /account` purges all of the user's data + the account (idempotent).
 */
import type { FastifyInstance } from 'fastify';
import { requireUser } from '@/auth/middleware.js';
import { exportUserData, deleteUserData } from './service.js';

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.post('/account/export', async (request) => {
    const user = requireUser(request);
    return exportUserData(user.id, app.clock.nowIso());
  });

  app.delete('/account', async (request, reply) => {
    const user = requireUser(request);
    await deleteUserData(user.id);
    reply.code(204);
  });
}

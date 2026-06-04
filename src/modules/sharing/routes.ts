/**
 * Sharing & collaboration routes (ApiSpec §7.7) — AUTHENTICATED. Each handler runs its service call in
 * a transaction (the accept path also backfills the list for the new member). AuthZ is enforced in the
 * service (owner-only for share/invite/role changes; membership for reads).
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { shareMembers } from '@/db/schema.js';
import { requireUser } from '@/auth/middleware.js';
import { parseOrThrow } from '@/lib/validate.js';
import { errors } from '@/lib/errors.js';
import { IdParamSchema } from '@/contract/schemas.js';
import {
  ensureShareForList,
  getShareById,
  stopSharing,
  listMembers,
  setMemberRole,
  removeMember,
  createInvite,
  acceptInvite,
  reportInvite,
  roleOnList,
  isRole,
  type Role,
} from './service.js';

const RoleSchema = z.enum(['editor', 'commenter', 'viewer']); // owner role is implicit, not assignable
const InviteBodySchema = z.object({ role: RoleSchema.default('editor') }).strict();
const RoleBodySchema = z.object({ role: RoleSchema }).strict();
const TokenParamSchema = z.object({ token: z.string().min(1).max(128) }).strict();
const MemberParamSchema = z.object({ id: z.string().uuid(), userId: z.string().uuid() }).strict();

export async function registerSharingRoutes(app: FastifyInstance): Promise<void> {
  // POST /lists/:id/share — start sharing a list (owner only).
  app.post('/lists/:id/share', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const share = await db.transaction((tx) => ensureShareForList(id, user.id, tx));
    return { share };
  });

  // GET /shares/:id — share + members (any member).
  app.get('/shares/:id', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    return db.transaction(async (tx) => {
      const share = await getShareById(id, tx);
      if (!share) throw errors.notFound('Share not found');
      if (!(await roleOnList(share.listId, user.id, tx))) throw errors.forbidden('Not a member');
      const members = await tx.select().from(shareMembers).where(eq(shareMembers.shareId, id));
      return { share, members };
    });
  });

  // DELETE /shares/:id — stop sharing (owner only). 204.
  app.delete('/shares/:id', async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    await db.transaction((tx) => stopSharing(id, user.id, tx));
    reply.code(204);
  });

  // POST /shares/:id/invites — create a tokenized invite (owner only).
  app.post('/shares/:id/invites', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const body = parseOrThrow(InviteBodySchema, request.body ?? {});
    const invite = await db.transaction((tx) => createInvite(id, body.role, user.id, tx));
    return { token: invite.token, role: invite.role, acceptPath: `/api/v1/invites/${invite.token}/accept` };
  });

  // POST /invites/:token/accept — join the share + backfill current state.
  app.post('/invites/:token/accept', async (request) => {
    const user = requireUser(request);
    const { token } = parseOrThrow(TokenParamSchema, request.params);
    const nowIso = app.clock.nowIso();
    const share = await db.transaction((tx) => acceptInvite(token, user.id, nowIso, tx));
    return { share }; // the client then pulls to receive the shared entities
  });

  // POST /invites/:token/report — abuse report on a public invite link.
  app.post('/invites/:token/report', async (request, reply) => {
    requireUser(request);
    const { token } = parseOrThrow(TokenParamSchema, request.params);
    await db.transaction((tx) => reportInvite(token, app.clock.nowIso(), tx));
    reply.code(204);
  });

  // GET /shares/:id/members — list members (any member).
  app.get('/shares/:id/members', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const members = await db.transaction((tx) => listMembers(id, user.id, tx));
    return { members };
  });

  // PATCH /shares/:id/members/:userId — change a member's role (owner only).
  app.patch('/shares/:id/members/:userId', async (request) => {
    const user = requireUser(request);
    const { id, userId } = parseOrThrow(MemberParamSchema, request.params);
    const body = parseOrThrow(RoleBodySchema, request.body);
    const role = body.role as Role;
    if (!isRole(role)) throw errors.validation('Invalid role');
    await db.transaction((tx) => setMemberRole(id, userId, role, user.id, tx));
    return { ok: true };
  });

  // DELETE /shares/:id/members/:userId — remove a member (owner) or leave (self).
  app.delete('/shares/:id/members/:userId', async (request, reply) => {
    const user = requireUser(request);
    const { id, userId } = parseOrThrow(MemberParamSchema, request.params);
    await db.transaction((tx) => removeMember(id, userId, user.id, tx));
    reply.code(204);
  });
}

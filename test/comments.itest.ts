/**
 * Comments + assignment integration tests (DevelopmentPlan P5-3). A shared task: a member comments
 * (with an @mention) → it fans out to others via change_log + lists via REST; assignment fans out.
 * Run: DATABASE_URL=postgres://doit:doit@localhost:5432/doit npm run test:integration
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { pool, closeDb } from '@/db/client.js';

let app: FastifyInstance;
const NOW = '2026-06-04T12:00:00.000Z';

async function signIn(sub: string): Promise<{ accessToken: string; userId: string }> {
  const token = await new SignJWT({ sub, email: `${sub}@example.com` })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(new TextEncoder().encode('stub-not-verified'));
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/apple',
    payload: { identityToken: token, authorizationCode: null, nonce: null, deviceInfo: { deviceId: randomUUID(), appVersion: 'itest' } } });
  return res.json();
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const push = (t: string, ops: unknown[]) =>
  app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { ...auth(t), 'idempotency-key': randomUUID() }, payload: { ops } });
const pull = (t: string) => app.inject({ method: 'GET', url: '/api/v1/sync/pull?limit=200', headers: auth(t) });
const upsert = (entityType: string, entityId: string, fields: Record<string, unknown>) =>
  ({ opId: randomUUID(), entityType, entityId, op: 'upsert', baseVersion: 0, clientUpdatedAt: NOW, fields });

/** A shares a list+task and invites B with `role`; returns ids + B's token. */
async function sharedTask(role: string) {
  const a = await signIn(`a-${randomUUID()}`);
  const b = await signIn(`b-${randomUUID()}`);
  const listId = randomUUID();
  const taskId = randomUUID();
  await push(a.accessToken, [upsert('list', listId, { name: 'Team' }), upsert('task', taskId, { title: 'Job', listId })]);
  const shareId = (await app.inject({ method: 'POST', url: `/api/v1/lists/${listId}/share`, headers: auth(a.accessToken) })).json().share.id;
  const token = (await app.inject({ method: 'POST', url: `/api/v1/shares/${shareId}/invites`, headers: auth(a.accessToken), payload: { role } })).json().token;
  await app.inject({ method: 'POST', url: `/api/v1/invites/${token}/accept`, headers: auth(b.accessToken) });
  return { a, b, listId, taskId, shareId };
}

beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('non-local DB');
  await pool.query('TRUNCATE users, devices, refresh_tokens, task_lists, tasks, task_tags, shares, share_members, invites, comments, change_log RESTART IDENTITY CASCADE');
});

describe('comments & assignment', () => {
  it('a member comment (with @mention) fans out + lists; owner sees it', async () => {
    const { a, b, taskId } = await sharedTask('editor');
    const res = await app.inject({ method: 'POST', url: `/api/v1/tasks/${taskId}/comments`, headers: auth(b.accessToken), payload: { body: 'Looks good @alice — shipping' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().comment.mentions).toEqual(['alice']);

    // A pulls → the comment fanned out via change_log.
    const aChanges = (await pull(a.accessToken)).json().changes as Array<{ entityType: string; payload?: Record<string, unknown> }>;
    const commentChange = aChanges.find((c) => c.entityType === 'comment');
    expect(commentChange, 'owner should receive the comment via fan-out').toBeTruthy();
    expect(commentChange!.payload!.body).toContain('Looks good');

    // A also lists comments via REST.
    const list = await app.inject({ method: 'GET', url: `/api/v1/tasks/${taskId}/comments`, headers: auth(a.accessToken) });
    expect(list.json().comments).toHaveLength(1);
  });

  it('a viewer cannot comment, a commenter can', async () => {
    const viewer = await sharedTask('viewer');
    const blocked = await app.inject({ method: 'POST', url: `/api/v1/tasks/${viewer.taskId}/comments`, headers: auth(viewer.b.accessToken), payload: { body: 'hi' } });
    expect(blocked.statusCode).toBe(403);

    const commenter = await sharedTask('commenter');
    const ok = await app.inject({ method: 'POST', url: `/api/v1/tasks/${commenter.taskId}/comments`, headers: auth(commenter.b.accessToken), payload: { body: 'hi' } });
    expect(ok.statusCode).toBe(200);
  });

  it('assignment sets the assignee + fans out to the assignee', async () => {
    const { a, b, taskId } = await sharedTask('editor');
    const res = await app.inject({ method: 'POST', url: `/api/v1/tasks/${taskId}/assign`, headers: auth(a.accessToken), payload: { assigneeUserId: b.userId } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().task.assigneeUserId).toBe(b.userId);

    // B pulls → sees the task assigned to them.
    const bChanges = (await pull(b.accessToken)).json().changes as Array<{ entityType: string; entityId: string; payload?: Record<string, unknown> }>;
    const taskChange = bChanges.filter((c) => c.entityType === 'task' && c.entityId === taskId).pop();
    expect(taskChange!.payload!.assigneeUserId).toBe(b.userId);
  });

  it('cannot assign to a non-member', async () => {
    const { a, taskId } = await sharedTask('editor');
    const stranger = await signIn(`x-${randomUUID()}`);
    const res = await app.inject({ method: 'POST', url: `/api/v1/tasks/${taskId}/assign`, headers: auth(a.accessToken), payload: { assigneeUserId: stranger.userId } });
    expect(res.statusCode).toBe(400);
  });
});

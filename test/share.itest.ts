/**
 * Sharing & collaboration integration tests (DevelopmentPlan P5-1/P5-2). The end-to-end flow:
 * A creates a list+task → shares + invites → B accepts → B pulls A's data (backfill) → B edits →
 * A pulls B's edit (bidirectional fan-out via change_log.visible_user_ids).
 * Run: DATABASE_URL=postgres://doit:doit@localhost:5432/doit npm run test:integration
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { pool, closeDb } from '@/db/client.js';

let app: FastifyInstance;

async function signIn(sub: string): Promise<{ accessToken: string; userId: string }> {
  const token = await new SignJWT({ sub, email: `${sub}@example.com` })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(new TextEncoder().encode('stub-not-verified'));
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/apple',
    payload: { identityToken: token, authorizationCode: null, nonce: null, deviceInfo: { deviceId: randomUUID(), appVersion: 'itest' } },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const NOW = '2026-06-04T12:00:00.000Z';
const LATER = '2026-06-04T13:00:00.000Z'; // a later edit must beat the create under field-level LWW
const push = (token: string, ops: unknown[]) =>
  app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, payload: { ops } });
const pull = (token: string) =>
  app.inject({ method: 'GET', url: '/api/v1/sync/pull?limit=200', headers: { authorization: `Bearer ${token}` } });
const op = (entityType: string, entityId: string, fields: Record<string, unknown>, baseVersion = 0, when = NOW) =>
  ({ opId: randomUUID(), entityType, entityId, op: 'upsert', baseVersion, clientUpdatedAt: when, fields });

function changesOf(body: { changes: Array<{ entityType: string; entityId: string; payload?: Record<string, unknown> }> }) {
  return body.changes;
}

beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('Refusing to TRUNCATE: DATABASE_URL is not local.');
  await pool.query('TRUNCATE users, devices, refresh_tokens, task_lists, tasks, task_tags, shares, share_members, invites, change_log RESTART IDENTITY CASCADE');
});

describe('sharing', () => {
  it('A shares a list → B accepts → B pulls A\'s data → B edits → A sees it', async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const b = await signIn(`b-${randomUUID()}`);

    // A creates a list + a task in it.
    const listId = randomUUID();
    const taskId = randomUUID();
    const created = await push(a.accessToken, [
      op('list', listId, { name: 'Team list' }),
      op('task', taskId, { title: 'Shared task', listId }),
    ]);
    expect(created.statusCode, created.body).toBe(200);

    // Before sharing, B sees nothing.
    expect(changesOf((await pull(b.accessToken)).json())).toHaveLength(0);

    // A shares the list + creates an invite.
    const shareRes = await app.inject({ method: 'POST', url: `/api/v1/lists/${listId}/share`, headers: { authorization: `Bearer ${a.accessToken}` } });
    expect(shareRes.statusCode, shareRes.body).toBe(200);
    const shareId = shareRes.json().share.id;
    const inviteRes = await app.inject({ method: 'POST', url: `/api/v1/shares/${shareId}/invites`, headers: { authorization: `Bearer ${a.accessToken}` }, payload: { role: 'editor' } });
    expect(inviteRes.statusCode, inviteRes.body).toBe(200);
    const token = inviteRes.json().token;

    // B accepts → backfill fans the list + task to B.
    const accept = await app.inject({ method: 'POST', url: `/api/v1/invites/${token}/accept`, headers: { authorization: `Bearer ${b.accessToken}` } });
    expect(accept.statusCode, accept.body).toBe(200);

    // B pulls → sees A's list + task.
    const bChanges = changesOf((await pull(b.accessToken)).json());
    const bTask = bChanges.find((c) => c.entityType === 'task' && c.entityId === taskId);
    expect(bTask, 'B should receive the shared task via backfill').toBeTruthy();
    expect(bTask!.payload!.title).toBe('Shared task');
    expect(bChanges.some((c) => c.entityType === 'list' && c.entityId === listId)).toBe(true);

    // B (editor) edits the task → it fans back to A (LATER timestamp beats A's create under LWW).
    const edit = await push(b.accessToken, [op('task', taskId, { title: 'Edited by B' }, 1, LATER)]);
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json().results[0].status, edit.body).not.toBe('rejected');

    const aChanges = changesOf((await pull(a.accessToken)).json());
    const aTaskEdit = aChanges.filter((c) => c.entityType === 'task' && c.entityId === taskId).pop();
    expect(aTaskEdit!.payload!.title, 'A should see B\'s edit').toBe('Edited by B');
  });

  it('stop sharing removes B\'s future visibility', async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const b = await signIn(`b-${randomUUID()}`);
    const listId = randomUUID();
    await push(a.accessToken, [op('list', listId, { name: 'L' }), op('task', randomUUID(), { title: 'T', listId })]);
    const shareId = (await app.inject({ method: 'POST', url: `/api/v1/lists/${listId}/share`, headers: { authorization: `Bearer ${a.accessToken}` } })).json().share.id;
    const token = (await app.inject({ method: 'POST', url: `/api/v1/shares/${shareId}/invites`, headers: { authorization: `Bearer ${a.accessToken}` }, payload: {} })).json().token;
    await app.inject({ method: 'POST', url: `/api/v1/invites/${token}/accept`, headers: { authorization: `Bearer ${b.accessToken}` } });

    // Owner stops sharing.
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/shares/${shareId}`, headers: { authorization: `Bearer ${a.accessToken}` } });
    expect(del.statusCode).toBe(204);

    // A's NEW edit no longer fans out to B.
    const newTask = randomUUID();
    await push(a.accessToken, [op('task', newTask, { title: 'Private now', listId })]);
    const bChanges = changesOf((await pull(b.accessToken)).json());
    expect(bChanges.some((c) => c.entityId === newTask)).toBe(false);
  });

  it('a viewer member can read but NOT write (authZ by role)', async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const b = await signIn(`b-${randomUUID()}`);
    const listId = randomUUID();
    const taskId = randomUUID();
    await push(a.accessToken, [op('list', listId, { name: 'L' }), op('task', taskId, { title: 'Read only', listId })]);
    const shareId = (await app.inject({ method: 'POST', url: `/api/v1/lists/${listId}/share`, headers: { authorization: `Bearer ${a.accessToken}` } })).json().share.id;
    // Invite B as a VIEWER.
    const token = (await app.inject({ method: 'POST', url: `/api/v1/shares/${shareId}/invites`, headers: { authorization: `Bearer ${a.accessToken}` }, payload: { role: 'viewer' } })).json().token;
    await app.inject({ method: 'POST', url: `/api/v1/invites/${token}/accept`, headers: { authorization: `Bearer ${b.accessToken}` } });

    // B can READ the task (backfill).
    expect(changesOf((await pull(b.accessToken)).json()).some((c) => c.entityId === taskId)).toBe(true);
    // But B's WRITE is rejected.
    const write = await push(b.accessToken, [op('task', taskId, { title: 'B tried to edit' }, 1, LATER)]);
    expect(write.json().results[0].status).toBe('rejected');
  });

  it('a non-owner cannot share or invite', async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const b = await signIn(`b-${randomUUID()}`);
    const listId = randomUUID();
    await push(a.accessToken, [op('list', listId, { name: 'L' })]);
    const share = await app.inject({ method: 'POST', url: `/api/v1/lists/${listId}/share`, headers: { authorization: `Bearer ${b.accessToken}` } });
    expect(share.statusCode).toBe(403); // B doesn't own the list
  });
});

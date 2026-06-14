/**
 * Account export + delete integration tests (DevelopmentPlan P6-2). Seeds owned rows, exports them,
 * deletes the account, and verifies the purge is complete + idempotent.
 * Run: DATABASE_URL=postgres://doit:doit@localhost:5432/doit npm run test:integration
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { db, pool, closeDb } from '@/db/client.js';
import { tasks, taskLists, tags, subscriptions, users, notes, noteFolders, comments, shares, shareMembers, invites } from '@/db/schema.js';

let app: FastifyInstance;

async function signIn(sub: string): Promise<string> {
  const token = await new SignJWT({ sub, email: `${sub}@example.com` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode('stub-not-verified'));
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/apple',
    payload: { identityToken: token, authorizationCode: null, nonce: null, deviceInfo: { deviceId: randomUUID(), appVersion: 'itest' } },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function seed(userId: string) {
  const nowIso = new Date(0).toISOString();
  const [list] = await db.insert(taskLists).values({ id: randomUUID(), ownerId: userId, name: 'Work', createdAt: nowIso, updatedAt: nowIso }).returning();
  await db.insert(tags).values({ id: randomUUID(), ownerId: userId, name: 'urgent', createdAt: nowIso, updatedAt: nowIso });
  await db.insert(tasks).values({ id: randomUUID(), ownerId: userId, title: 'A task', listId: list.id, createdAt: nowIso, updatedAt: nowIso });
  await db.insert(subscriptions).values({ id: randomUUID(), ownerId: userId, originalTransactionId: `otx-${userId}`, latestTransactionId: 'tx', productId: 'doit.pro.monthly', createdAt: nowIso, updatedAt: nowIso });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closeDb();
});
beforeEach(async () => {
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('Refusing to TRUNCATE: DATABASE_URL is not local.');
  await pool.query('TRUNCATE users, devices, refresh_tokens, task_lists, tags, tasks, task_tags, subscriptions, change_log, notes, note_folders, comments, shares, share_members, invites RESTART IDENTITY CASCADE');
});

describe('account', () => {
  it('exports the full owned data bundle', async () => {
    const { accessToken, userId } = await signIn(`u-${randomUUID()}`);
    await seed(userId);
    const res = await app.inject({ method: 'POST', url: '/api/v1/account/export', headers: { authorization: `Bearer ${accessToken}` } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.user.id).toBe(userId);
    expect(body.counts).toMatchObject({ tasks: 1, lists: 1, tags: 1, subscriptions: 1 });
    expect(body.tasks[0].title).toBe('A task');
  });

  it('deletes all owned data + the account, and is idempotent', async () => {
    const { accessToken, userId } = await signIn(`u-${randomUUID()}`);
    await seed(userId);

    const del = await app.inject({ method: 'DELETE', url: '/api/v1/account', headers: { authorization: `Bearer ${accessToken}` } });
    expect(del.statusCode, del.body).toBe(204);

    // Everything owned is gone.
    const remaining = await db.select().from(tasks).where(eq(tasks.ownerId, userId));
    expect(remaining).toHaveLength(0);
    const subsLeft = await db.select().from(subscriptions).where(eq(subscriptions.ownerId, userId));
    expect(subsLeft).toHaveLength(0);
    const userLeft = await db.select().from(users).where(eq(users.id, userId));
    expect(userLeft).toHaveLength(0);

    // Re-running the delete is a no-op (no rows, no error).
    const del2 = await app.inject({ method: 'DELETE', url: '/api/v1/account', headers: { authorization: `Bearer ${accessToken}` } });
    expect(del2.statusCode).toBe(204);
  });

  it('deletes an account that owns notes, comments, shares, and assigned tasks (FK-safe)', async () => {
    const me = await signIn(`u-${randomUUID()}`) as unknown as { accessToken: string; userId: string };
    const mate = await signIn(`m-${randomUUID()}`) as unknown as { accessToken: string; userId: string };
    const nowIso = new Date(0).toISOString();

    // Keeper: a folder + a note in it.
    const [folder] = await db.insert(noteFolders).values({ id: randomUUID(), ownerId: me.userId, name: 'Ideas', createdAt: nowIso, updatedAt: nowIso }).returning();
    await db.insert(notes).values({ id: randomUUID(), ownerId: me.userId, folderId: folder.id, title: 'n', body: 'b', createdAt: nowIso, updatedAt: nowIso });

    // My list + task + my comment on it.
    const [list] = await db.insert(taskLists).values({ id: randomUUID(), ownerId: me.userId, name: 'L', createdAt: nowIso, updatedAt: nowIso }).returning();
    const [task] = await db.insert(tasks).values({ id: randomUUID(), ownerId: me.userId, title: 't', listId: list.id, createdAt: nowIso, updatedAt: nowIso }).returning();
    await db.insert(comments).values({ id: randomUUID(), ownerId: me.userId, taskId: task.id, body: 'hi', createdAt: nowIso, updatedAt: nowIso });

    // My share of my list, with mate as a member, plus an invite I created.
    const [share] = await db.insert(shares).values({ id: randomUUID(), listId: list.id, ownerId: me.userId, createdAt: nowIso }).returning();
    await db.insert(shareMembers).values({ id: randomUUID(), shareId: share.id, userId: mate.userId, role: 'editor', joinedAt: nowIso });
    await db.insert(invites).values({ token: `tok-${randomUUID()}`, shareId: share.id, role: 'editor', createdBy: me.userId, createdAt: nowIso });

    // I'm a member of mate's share; and mate has a task ASSIGNED to me.
    const [mlist] = await db.insert(taskLists).values({ id: randomUUID(), ownerId: mate.userId, name: 'ML', createdAt: nowIso, updatedAt: nowIso }).returning();
    const [mshare] = await db.insert(shares).values({ id: randomUUID(), listId: mlist.id, ownerId: mate.userId, createdAt: nowIso }).returning();
    await db.insert(shareMembers).values({ id: randomUUID(), shareId: mshare.id, userId: me.userId, role: 'viewer', joinedAt: nowIso });
    const [assigned] = await db.insert(tasks).values({ id: randomUUID(), ownerId: mate.userId, title: 'assigned', listId: mlist.id, assigneeUserId: me.userId, createdAt: nowIso, updatedAt: nowIso }).returning();

    // The previously-broken path: this must NOT raise a foreign-key violation.
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/account', headers: { authorization: `Bearer ${me.accessToken}` } });
    expect(del.statusCode, del.body).toBe(204);

    // My account + owned data are gone.
    expect(await db.select().from(users).where(eq(users.id, me.userId))).toHaveLength(0);
    expect(await db.select().from(notes).where(eq(notes.ownerId, me.userId))).toHaveLength(0);
    expect(await db.select().from(noteFolders).where(eq(noteFolders.ownerId, me.userId))).toHaveLength(0);
    expect(await db.select().from(comments).where(eq(comments.ownerId, me.userId))).toHaveLength(0);
    expect(await db.select().from(shares).where(eq(shares.ownerId, me.userId))).toHaveLength(0);

    // Mate survives; their task's assignee was nulled (not deleted).
    expect(await db.select().from(users).where(eq(users.id, mate.userId))).toHaveLength(1);
    const [mateTask] = await db.select().from(tasks).where(eq(tasks.id, assigned.id));
    expect(mateTask).toBeTruthy();
    expect(mateTask?.assigneeUserId).toBeNull();
  });
});

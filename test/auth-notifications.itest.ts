/**
 * Apple server-to-server notification integration tests (NFR-SEC-260). A signed `account-delete` /
 * `consent-revoked` notification purges the user (FK-safe); email events + unknown subjects are acked
 * without action. Stub verification (APPLE_STUB_VERIFICATION) lets us mint the payload locally.
 * Run: DATABASE_URL=postgres://doit:doit@localhost:5432/doit npm run test:integration
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { db, pool, closeDb } from '@/db/client.js';
import { users, tasks, taskLists } from '@/db/schema.js';

let app: FastifyInstance;

async function signIn(sub: string): Promise<{ accessToken: string; userId: string }> {
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

/** Mint a stub notification JWT whose `events` claim is the Apple JSON string. */
async function notification(type: string, sub: string): Promise<string> {
  return new SignJWT({ events: JSON.stringify({ type, sub, email: `${sub}@example.com`, event_time: 0 }) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode('stub-not-verified'));
}

async function seedTask(userId: string): Promise<void> {
  const nowIso = new Date(0).toISOString();
  const [list] = await db.insert(taskLists).values({ id: randomUUID(), ownerId: userId, name: 'L', createdAt: nowIso, updatedAt: nowIso }).returning();
  await db.insert(tasks).values({ id: randomUUID(), ownerId: userId, title: 'T', listId: list.id, createdAt: nowIso, updatedAt: nowIso });
}

function post(payload: string) {
  return app.inject({ method: 'POST', url: '/api/v1/auth/apple/notifications', payload: { payload } });
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

describe('apple server-to-server notifications', () => {
  it('account-delete purges the user and their data', async () => {
    const sub = `apl-${randomUUID()}`;
    const { userId } = await signIn(sub);
    await seedTask(userId);

    const res = await post(await notification('account-delete', sub));
    expect(res.statusCode, res.body).toBe(200);

    expect((await db.select().from(users).where(eq(users.appleSub, sub))).length).toBe(0);
    expect((await db.select().from(tasks).where(eq(tasks.ownerId, userId))).length).toBe(0);
  });

  it('consent-revoked also purges the user', async () => {
    const sub = `apl-${randomUUID()}`;
    await signIn(sub);
    const res = await post(await notification('consent-revoked', sub));
    expect(res.statusCode, res.body).toBe(200);
    expect((await db.select().from(users).where(eq(users.appleSub, sub))).length).toBe(0);
  });

  it('email events are acked without deleting the user', async () => {
    const sub = `apl-${randomUUID()}`;
    await signIn(sub);
    const res = await post(await notification('email-disabled', sub));
    expect(res.statusCode, res.body).toBe(200);
    expect((await db.select().from(users).where(eq(users.appleSub, sub))).length).toBe(1);
  });

  it('an unknown subject is acked idempotently', async () => {
    const res = await post(await notification('account-delete', `unknown-${randomUUID()}`));
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a malformed payload is rejected', async () => {
    const res = await post('not-a-jwt');
    expect(res.statusCode).toBe(401);
  });
});

/**
 * Phase 0 walking-skeleton integration tests (DevelopmentPlan P0-F / P0-E).
 *
 * Exercises the real loop against a live Postgres via Fastify `inject`:
 *   auth (Apple stub) → push (create) → pull (second device) → conflict (LWW)
 *   → idempotency (replay) → cross-tenant isolation.
 *
 * Run: `npm run test:integration` (after `docker compose up -d && npm run db:migrate`).
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { pool, closeDb } from '@/db/client.js';

/** A decodable (unverified, stub-mode) Apple identity token carrying `sub`. */
async function stubAppleToken(sub: string): Promise<string> {
  return new SignJWT({ sub, email: `${sub}@example.com` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('stub-not-verified'));
}

let app: FastifyInstance;

async function signIn(sub: string): Promise<{ accessToken: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/apple',
    payload: {
      identityToken: await stubAppleToken(sub),
      authorizationCode: null,
      nonce: null,
      deviceInfo: { deviceId: randomUUID(), appVersion: 'itest' },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

function push(token: string, ops: unknown[]) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    payload: { ops },
  });
}

function pull(token: string, cursor?: string) {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=100` : '?limit=100';
  return app.inject({
    method: 'GET',
    url: `/api/v1/sync/pull${qs}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

const OLD = new Date('2020-01-01T00:00:00.000Z').toISOString();

function createTaskOp(entityId: string, title: string, opId = randomUUID()) {
  return {
    opId,
    entityType: 'task',
    entityId,
    op: 'upsert',
    baseVersion: 0,
    clientUpdatedAt: new Date().toISOString(),
    fields: { title, status: 1, priority: 3, rank: 0, isAllDay: false },
  };
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
  await pool.query(
    'TRUNCATE users, devices, refresh_tokens, task_lists, tags, tasks, task_tags, change_log, idempotency_keys RESTART IDENTITY CASCADE',
  );
});

describe('auth', () => {
  it('exchanges an Apple identity token for tokens and is idempotent per apple_sub', async () => {
    const a = await signIn('apple-user-A');
    expect(a.accessToken).toBeTruthy();
    expect(a.userId).toBeTruthy();
    // Same Apple user signing in again resolves to the SAME account.
    const again = await signIn('apple-user-A');
    expect(again.userId).toBe(a.userId);
  });

  it('rejects an unauthenticated sync call', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync/pull?limit=10' });
    expect(res.statusCode).toBe(401);
  });
});

describe('the sync loop', () => {
  it('push(create) on device A → pull on device B sees the task', async () => {
    const a = await signIn('apple-user-A');
    const taskId = randomUUID();

    const pushRes = await push(a.accessToken, [createTaskOp(taskId, 'Buy milk')]);
    expect(pushRes.statusCode).toBe(200);
    const result = pushRes.json().results[0];
    expect(result.status).toBe('applied');
    expect(result.serverVersion).toBe(1);

    // "Device B" = the same account, a fresh cursor (null).
    const pullRes = await pull(a.accessToken);
    expect(pullRes.statusCode).toBe(200);
    const body = pullRes.json();
    const change = body.changes.find((c: { entityId: string }) => c.entityId === taskId);
    expect(change).toBeTruthy();
    expect(change.op).toBe('upsert');
    expect(change.version).toBe(1);
    expect(change.payload.title).toBe('Buy milk');
    expect(body.nextCursor).toBeTruthy();
  });

  it('a delta pull from the latest cursor returns nothing new', async () => {
    const a = await signIn('apple-user-A');
    await push(a.accessToken, [createTaskOp(randomUUID(), 'T1')]);
    const first = pull ? await pull(a.accessToken) : undefined;
    const cursor = first!.json().nextCursor as string;

    const second = await pull(a.accessToken, cursor);
    expect(second.statusCode).toBe(200);
    expect(second.json().changes).toHaveLength(0);
  });

  it('resolves a stale concurrent edit as merged (server wins LWW)', async () => {
    const a = await signIn('apple-user-A');
    const taskId = randomUUID();
    await push(a.accessToken, [createTaskOp(taskId, 'Original')]); // → v1, server updated_at = now

    // A stale client edits from baseVersion 0 with an OLD timestamp ⇒ server's row wins.
    const stale = await push(a.accessToken, [
      {
        opId: randomUUID(),
        entityType: 'task',
        entityId: taskId,
        op: 'upsert',
        baseVersion: 0,
        clientUpdatedAt: OLD,
        fields: { title: 'stale — should lose' },
      },
    ]);
    expect(stale.statusCode).toBe(200);
    expect(stale.json().results[0].status).toBe('merged');
  });

  it('dedupes a replayed opId (idempotency)', async () => {
    const a = await signIn('apple-user-A');
    const taskId = randomUUID();
    const op = createTaskOp(taskId, 'Once');

    const first = await push(a.accessToken, [op]);
    expect(first.json().results[0].status).toBe('applied');

    const replay = await push(a.accessToken, [op]); // same opId
    expect(replay.json().results[0].status).toBe('duplicate');
  });

  it('field-level conflict: concurrent edits to DIFFERENT fields both survive', async () => {
    const a = await signIn('apple-user-A');
    const taskId = randomUUID();
    const tCreate = '2026-01-01T00:00:00.000Z';
    const tTitle = '2026-02-01T00:00:00.000Z';
    const tNotes = '2026-03-01T00:00:00.000Z';

    // Create (v1) with title + notes.
    const create = await push(a.accessToken, [
      {
        opId: randomUUID(), entityType: 'task', entityId: taskId, op: 'upsert',
        baseVersion: 0, clientUpdatedAt: tCreate,
        fields: { title: 'Original', notes: 'original notes', status: 1, priority: 0, rank: 0, isAllDay: false },
      },
    ]);
    expect(create.json().results[0].status).toBe('applied');

    // Client A edits TITLE only, from the current version (fast path → v2).
    const editTitle = await push(a.accessToken, [
      { opId: randomUUID(), entityType: 'task', entityId: taskId, op: 'upsert',
        baseVersion: 1, clientUpdatedAt: tTitle, fields: { title: 'A edited title' } },
    ]);
    expect(editTitle.json().results[0].status).toBe('applied');
    expect(editTitle.json().results[0].serverVersion).toBe(2);

    // Client B (offline since v1) edits NOTES only — a STALE baseVersion 1, but a different field.
    const editNotes = await push(a.accessToken, [
      { opId: randomUUID(), entityType: 'task', entityId: taskId, op: 'upsert',
        baseVersion: 1, clientUpdatedAt: tNotes, fields: { notes: 'B edited notes' } },
    ]);
    expect(editNotes.json().results[0].status).toBe('merged'); // diverged base → field-level merge

    // The latest server snapshot must carry BOTH A's title and B's notes.
    const changes = pull
      ? (await pull(a.accessToken)).json().changes.filter((c: { entityId: string }) => c.entityId === taskId)
      : [];
    const latest = changes[changes.length - 1];
    expect(latest.payload.title).toBe('A edited title');
    expect(latest.payload.notes).toBe('B edited notes');
  });
});

describe('cross-tenant isolation (ApiSpec §4.3 — application-level gate)', () => {
  it("user B cannot see or modify user A's task", async () => {
    const a = await signIn('apple-user-A');
    const b = await signIn('apple-user-B');
    expect(a.userId).not.toBe(b.userId);

    const taskId = randomUUID();
    await push(a.accessToken, [createTaskOp(taskId, "A's private task")]);

    // B's pull must NOT include A's task (change_log.visible_user_ids = [A]).
    const bPull = await pull(b.accessToken);
    const leaked = bPull.json().changes.find((c: { entityId: string }) => c.entityId === taskId);
    expect(leaked).toBeUndefined();

    // B trying to write A's entity is rejected (ownership check), never applied.
    const bWrite = await push(b.accessToken, [
      {
        opId: randomUUID(),
        entityType: 'task',
        entityId: taskId,
        op: 'upsert',
        baseVersion: 1,
        clientUpdatedAt: new Date().toISOString(),
        fields: { title: 'hijack' },
      },
    ]);
    expect(bWrite.json().results[0].status).toBe('rejected');
  });
});

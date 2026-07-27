/**
 * Direct REST CRUD + authorization tests for /tasks, /lists, /tags (ApiSpec §7.3). Complements the
 * sync-bridge tests by exercising the HTTP layer: status codes, schema-validation 400s, 404s, and
 * cross-tenant ownership isolation (a user can never read/mutate another user's rows).
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
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode('stub-not-verified'));
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/apple',
    payload: {
      identityToken: token,
      authorizationCode: null,
      nonce: null,
      deviceInfo: { deviceId: randomUUID(), appVersion: 'itest' },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

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
  await pool.query(
    'TRUNCATE users, devices, refresh_tokens, task_lists, tags, tasks, task_tags, subscriptions, change_log, notes, note_folders, comments, shares, share_members, invites RESTART IDENTITY CASCADE',
  );
});

describe('tasks REST routes', () => {
  it('creates, lists, reads, patches and deletes a task', async () => {
    const { accessToken } = await signIn(`u-${randomUUID()}`);
    const id = randomUUID();

    const created = await app.inject({
      method: 'POST', url: '/api/v1/tasks', headers: auth(accessToken),
      payload: { id, title: 'Write the spec' },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().id).toBe(id);

    const list = await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: auth(accessToken) });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((t: { id: string }) => t.id)).toContain(id);

    const read = await app.inject({ method: 'GET', url: `/api/v1/tasks/${id}`, headers: auth(accessToken) });
    expect(read.statusCode).toBe(200);
    expect(read.json().title).toBe('Write the spec');

    const patched = await app.inject({
      method: 'PATCH', url: `/api/v1/tasks/${id}`, headers: auth(accessToken),
      payload: { title: 'Write the spec (v2)' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().title).toBe('Write the spec (v2)');

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/tasks/${id}`, headers: auth(accessToken) });
    expect(del.statusCode).toBe(204);

    // DELETE is a soft-delete (tombstone) for offline sync; the active list must no longer surface it.
    const listAfter = await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: auth(accessToken) });
    expect(listAfter.json().items.map((t: { id: string }) => t.id)).not.toContain(id);
  });

  it('rejects an invalid create body with 400', async () => {
    const { accessToken } = await signIn(`u-${randomUUID()}`);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/tasks', headers: auth(accessToken), payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tasks' });
    expect(res.statusCode).toBe(401);
  });

  it('isolates tenants: user B cannot read, patch or delete user A\'s task', async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const b = await signIn(`b-${randomUUID()}`);
    const id = randomUUID();
    await app.inject({
      method: 'POST', url: '/api/v1/tasks', headers: auth(a.accessToken), payload: { id, title: 'A private task' },
    });

    expect((await app.inject({ method: 'GET', url: `/api/v1/tasks/${id}`, headers: auth(b.accessToken) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/tasks/${id}`, headers: auth(b.accessToken), payload: { title: 'hijack' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/tasks/${id}`, headers: auth(b.accessToken) })).statusCode).toBe(404);

    // A's task is untouched.
    const stillThere = await app.inject({ method: 'GET', url: `/api/v1/tasks/${id}`, headers: auth(a.accessToken) });
    expect(stillThere.statusCode).toBe(200);
    expect(stillThere.json().title).toBe('A private task');
  });
});

describe('lists + tags REST routes', () => {
  it('creates a list and a tag and lists them back', async () => {
    const { accessToken } = await signIn(`u-${randomUUID()}`);
    const listId = randomUUID();
    const tagId = randomUUID();

    const listCreate = await app.inject({
      method: 'POST', url: '/api/v1/lists', headers: auth(accessToken),
      payload: { id: listId, name: 'Work' },
    });
    expect(listCreate.statusCode, listCreate.body).toBe(201);

    const tagCreate = await app.inject({
      method: 'POST', url: '/api/v1/tags', headers: auth(accessToken),
      payload: { id: tagId, name: 'urgent' },
    });
    expect(tagCreate.statusCode, tagCreate.body).toBe(201);

    const lists = await app.inject({ method: 'GET', url: '/api/v1/lists', headers: auth(accessToken) });
    expect(lists.json().items.map((l: { id: string }) => l.id)).toContain(listId);
    const tags = await app.inject({ method: 'GET', url: '/api/v1/tags', headers: auth(accessToken) });
    expect(tags.json().items.map((t: { id: string }) => t.id)).toContain(tagId);
  });
});

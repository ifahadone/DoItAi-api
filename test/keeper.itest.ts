/**
 * Keeper integration tests (notes + note folders, synced like any entity). Round-trip push/pull,
 * sparse patch, soft-delete tombstone, and owner-only visibility.
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
const LATER = '2026-06-04T13:00:00.000Z';

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
const op = (entityType: string, entityId: string, fields: Record<string, unknown>, baseVersion = 0, at = NOW) =>
  ({ opId: randomUUID(), entityType, entityId, op: 'upsert', baseVersion, clientUpdatedAt: at, fields });

type Change = { entityType: string; entityId: string; op: string; payload: Record<string, unknown> | null };
const changesFor = async (t: string) => (await pull(t)).json().changes as Change[];

beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('Refusing to TRUNCATE: DATABASE_URL is not local.');
  await pool.query('TRUNCATE users, devices, refresh_tokens, task_lists, tags, tasks, task_tags, note_folders, notes, routines, change_log RESTART IDENTITY CASCADE');
});

describe('keeper: note folders + notes (synced)', () => {
  it('round-trips a folder + a note through push/pull', async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const folderId = randomUUID();
    const noteId = randomUUID();
    const res = await push(a.accessToken, [
      op('noteFolder', folderId, { name: 'Work', colorHex: '#2E7DF6', icon: 'briefcase.fill', sortIndex: 1 }),
      op('note', noteId, { folderId, title: 'Q3 plan', body: 'Ship Keeper', pinned: true }),
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual(['applied', 'applied']);

    const changes = await changesFor(a.accessToken);
    const folder = changes.find((c) => c.entityId === folderId)!;
    const note = changes.find((c) => c.entityId === noteId)!;
    expect(folder.entityType).toBe('noteFolder');
    expect(folder.payload!.name).toBe('Work');
    expect(folder.payload!.icon).toBe('briefcase.fill');
    expect(folder.payload!.sortIndex).toBe(1);
    expect(note.entityType).toBe('note');
    expect(note.payload!.folderId).toBe(folderId);
    expect(note.payload!.title).toBe('Q3 plan');
    expect(note.payload!.body).toBe('Ship Keeper');
    expect(note.payload!.pinned).toBe(true);
  });

  it('applies a sparse patch (edit body + pin), preserving untouched fields', async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const noteId = randomUUID();
    await push(a.accessToken, [op('note', noteId, { title: 'Draft', body: 'v1' })]);
    const patch = await push(a.accessToken, [op('note', noteId, { body: 'v2', pinned: true }, 1, LATER)]);
    expect(patch.json().results[0].status).toBe('applied');

    const note = (await changesFor(a.accessToken)).filter((c) => c.entityId === noteId).pop()!;
    expect(note.payload!.body).toBe('v2');
    expect(note.payload!.pinned).toBe(true);
    expect(note.payload!.title).toBe('Draft'); // untouched field preserved
  });

  it('soft-deletes a note (tombstone via sync)', async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const noteId = randomUUID();
    await push(a.accessToken, [op('note', noteId, { title: 'Temp', body: 'bye' })]);
    const del = await push(a.accessToken, [
      { opId: randomUUID(), entityType: 'note', entityId: noteId, op: 'delete', baseVersion: 1, clientUpdatedAt: NOW },
    ]);
    expect(del.json().results[0].status).toBe('applied');

    const deleted = (await changesFor(a.accessToken)).filter((c) => c.entityId === noteId).pop()!;
    expect(deleted.op).toBe('delete');
    expect(deleted.payload).toBeNull();
  });

  it("does not leak a user's notes to another user (owner-only)", async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const b = await signIn(`b-${randomUUID()}`);
    const noteId = randomUUID();
    await push(a.accessToken, [op('note', noteId, { title: 'Private', body: 'secret' })]);
    const bChanges = await changesFor(b.accessToken);
    expect(bChanges.find((c) => c.entityId === noteId)).toBeUndefined();
  });
});

// Batch 8: Keeper task-note linking + routine suspend/archive (app+API schema items).
describe('batch 8: note→task link + routine paused/archived (synced)', () => {
  it('round-trips a note linked to a task via taskId', async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const taskId = randomUUID();
    const noteId = randomUUID();
    // Task first so the notes.task_id FK resolves, then the linked note.
    const res = await push(a.accessToken, [
      op('task', taskId, { title: 'Write spec' }),
      op('note', noteId, { title: 'Spec notes', body: 'outline', taskId }),
    ]);
    expect(res.statusCode).toBe(200);
    const note = (await changesFor(a.accessToken)).filter((c) => c.entityId === noteId).pop()!;
    expect(note.payload!.taskId).toBe(taskId);

    // Unlink via sparse patch → taskId becomes null, other fields preserved.
    await push(a.accessToken, [op('note', noteId, { taskId: null }, 1, LATER)]);
    const after = (await changesFor(a.accessToken)).filter((c) => c.entityId === noteId).pop()!;
    expect(after.payload!.taskId).toBeNull();
    expect(after.payload!.title).toBe('Spec notes');
  });

  it('round-trips routine paused/archived flags (default false, patchable)', async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const routineId = randomUUID();
    await push(a.accessToken, [op('routine', routineId, { name: 'Morning' })]);
    const created = (await changesFor(a.accessToken)).filter((c) => c.entityId === routineId).pop()!;
    expect(created.payload!.paused).toBe(false);
    expect(created.payload!.archived).toBe(false);

    await push(a.accessToken, [op('routine', routineId, { paused: true, archived: true }, 1, LATER)]);
    const patched = (await changesFor(a.accessToken)).filter((c) => c.entityId === routineId).pop()!;
    expect(patched.payload!.paused).toBe(true);
    expect(patched.payload!.archived).toBe(true);
    expect(patched.payload!.name).toBe('Morning'); // untouched field preserved
  });
});

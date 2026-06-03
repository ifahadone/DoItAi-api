/**
 * Unit tests for the PURE conflict resolver (src/modules/sync/conflict.ts).
 *
 * Covers every branch of the row-level LWW table (ApiSpec §6.1):
 *   - fast-path applied (baseVersion == serverVersion)
 *   - merged, client wins (diverged base, client newer)
 *   - merged, server wins (diverged base, server newer-or-equal) -> serverFields
 *   - structural delete-vs-upsert (delete wins -> conflict)
 *   - live delete (applied tombstone) + idempotent re-delete
 *   - client-ahead-of-server guard (conflict)
 *   - new-row create (absent current)
 *
 * The 'duplicate' status is an idempotency-layer concern (service + DB), not the
 * resolver's, so it is exercised in the integration suite (Phase 1), noted here.
 *
 * NOTE: these tests were authored but NOT executed in this environment (no
 * node_modules / no `npm install`). Run with `npm test` after install.
 */
import { describe, it, expect } from 'vitest';
import { resolve, type CurrentRecord, type Patch } from '@/modules/sync/conflict.js';

const T0 = '2026-06-03T08:00:00.000Z';
const T1 = '2026-06-03T09:00:00.000Z'; // newer than T0
const T2 = '2026-06-03T10:00:00.000Z'; // newest

/** A live server record at version `v`, last updated at `updatedAt`. */
function live(v: number, updatedAt: string, fields: Record<string, unknown> = {}): CurrentRecord {
  return { serverVersion: v, updatedAt, deleted: false, fields };
}
function absent(): CurrentRecord {
  return { serverVersion: 0, updatedAt: null, deleted: false, fields: {} };
}
function tombstone(v: number, updatedAt: string): CurrentRecord {
  return { serverVersion: v, updatedAt, deleted: true, fields: { deletedAt: updatedAt } };
}
function upsert(fields: Record<string, unknown>): Patch {
  return { op: 'upsert', fields };
}
const del: Patch = { op: 'delete', fields: {} };

describe('conflict.resolve — fast path (applied)', () => {
  it('applies the patch wholesale when baseVersion === serverVersion', () => {
    const r = resolve({
      current: live(3, T0, { title: 'old' }),
      patch: upsert({ title: 'new' }),
      baseVersion: 3,
      clientUpdatedAt: T1,
    });
    expect(r.status).toBe('applied');
    expect(r.apply).toEqual({ kind: 'upsert', fields: { title: 'new' } });
    expect(r.serverFields).toBeNull();
    expect(r.bumpVersion).toBe(true);
  });

  it('creates a brand-new row (absent current, baseVersion 0)', () => {
    const r = resolve({
      current: absent(),
      patch: upsert({ title: 'fresh' }),
      baseVersion: 0,
      clientUpdatedAt: T0,
    });
    expect(r.status).toBe('applied');
    expect(r.apply).toEqual({ kind: 'upsert', fields: { title: 'fresh' } });
    expect(r.bumpVersion).toBe(true);
  });
});

describe('conflict.resolve — diverged base (merged, LWW)', () => {
  it('client wins wholesale when client is newer than server', () => {
    const r = resolve({
      current: live(5, T0, { title: 'server' }),
      patch: upsert({ title: 'client' }),
      baseVersion: 3, // < 5: someone else wrote first
      clientUpdatedAt: T2, // newer than server T0
    });
    expect(r.status).toBe('merged');
    expect(r.apply).toEqual({ kind: 'upsert', fields: { title: 'client' } });
    expect(r.serverFields).toBeNull();
    expect(r.bumpVersion).toBe(true);
  });

  it('server wins wholesale when server is newer; returns serverFields', () => {
    const serverFields = { title: 'server-newer' };
    const r = resolve({
      current: live(5, T2, serverFields),
      patch: upsert({ title: 'client-older' }),
      baseVersion: 3,
      clientUpdatedAt: T0, // older than server T2
    });
    expect(r.status).toBe('merged');
    expect(r.apply).toEqual({ kind: 'noop' });
    expect(r.serverFields).toEqual(serverFields);
    expect(r.bumpVersion).toBe(false);
  });

  it('server wins on a tie (clientUpdatedAt === server.updatedAt)', () => {
    const r = resolve({
      current: live(5, T1, { title: 'server' }),
      patch: upsert({ title: 'client' }),
      baseVersion: 2,
      clientUpdatedAt: T1, // equal -> server wins (>=)
    });
    expect(r.status).toBe('merged');
    expect(r.apply).toEqual({ kind: 'noop' });
    expect(r.serverFields).toEqual({ title: 'server' });
  });
});

describe('conflict.resolve — structural (delete vs upsert)', () => {
  it('delete wins: upsert over a tombstone -> conflict, no write', () => {
    const r = resolve({
      current: tombstone(4, T1),
      patch: upsert({ title: 'resurrect?' }),
      baseVersion: 4,
      clientUpdatedAt: T2, // even though client is newer, delete wins
    });
    expect(r.status).toBe('conflict');
    expect(r.apply).toEqual({ kind: 'noop' });
    expect(r.bumpVersion).toBe(false);
    expect(r.reason).toMatch(/delete_wins/);
    expect(r.serverFields).toEqual({ deletedAt: T1 });
  });

  it('deletes a live row -> applied tombstone', () => {
    const r = resolve({
      current: live(2, T0),
      patch: del,
      baseVersion: 2,
      clientUpdatedAt: T1,
    });
    expect(r.status).toBe('applied');
    expect(r.apply).toEqual({ kind: 'delete' });
    expect(r.bumpVersion).toBe(true);
  });

  it('re-deletes a tombstone idempotently -> applied noop, no version bump', () => {
    const r = resolve({
      current: tombstone(2, T0),
      patch: del,
      baseVersion: 2,
      clientUpdatedAt: T1,
    });
    expect(r.status).toBe('applied');
    expect(r.apply).toEqual({ kind: 'noop' });
    expect(r.bumpVersion).toBe(false);
  });

  it('delete wins even when the client base is stale', () => {
    const r = resolve({
      current: live(9, T0),
      patch: del,
      baseVersion: 1, // very stale, but delete still applies
      clientUpdatedAt: T2,
    });
    expect(r.status).toBe('applied');
    expect(r.apply).toEqual({ kind: 'delete' });
  });
});

describe('conflict.resolve — client-ahead guard', () => {
  it('rejects as conflict when baseVersion > serverVersion (impossible state)', () => {
    const r = resolve({
      current: live(2, T0),
      patch: upsert({ title: 'x' }),
      baseVersion: 5, // claims to have seen a newer version than the server has
      clientUpdatedAt: T2,
    });
    expect(r.status).toBe('conflict');
    expect(r.apply).toEqual({ kind: 'noop' });
    expect(r.reason).toMatch(/stale_server/);
  });
});

describe('conflict.resolve — purity', () => {
  it('does not mutate its inputs', () => {
    const current = live(3, T0, { title: 'server' });
    const patch = upsert({ title: 'client' });
    const snapCurrent = structuredClone(current);
    const snapPatch = structuredClone(patch);
    resolve({ current, patch, baseVersion: 3, clientUpdatedAt: T1 });
    expect(current).toEqual(snapCurrent);
    expect(patch).toEqual(snapPatch);
  });

  it('is deterministic for identical inputs', () => {
    const args = {
      current: live(5, T2, { title: 's' }),
      patch: upsert({ title: 'c' }),
      baseVersion: 3,
      clientUpdatedAt: T0,
    };
    const a = resolve(structuredClone(args));
    const b = resolve(structuredClone(args));
    expect(a).toEqual(b);
  });
});

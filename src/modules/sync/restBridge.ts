/**
 * REST-over-sync bridge. Lets the lighter modules (lists, tags) and the tasks
 * worked example mutate through the SAME write path as /sync/push, so every
 * REST write produces a change_log entry with proper versioning + idempotency
 * (DoD: "no out-of-band writes"). Read helpers stay per-module.
 */
import type { Clock } from '@/lib/clock.js';
import { newUuid } from '@/lib/ids.js';
import { errors } from '@/lib/errors.js';
import type { EntityType, SyncPushOp, SyncPushResult } from '@/contract/schemas.js';
import * as syncService from '@/modules/sync/service.js';

/** Throw the right HTTP error if a single-op push didn't apply cleanly. */
export function assertApplied(result: SyncPushResult): void {
  switch (result.status) {
    case 'applied':
    case 'merged':
    case 'duplicate':
      return;
    case 'conflict':
      throw errors.conflict(result.reason ?? 'Version/structural conflict', {
        serverVersion: result.serverVersion,
        serverFields: result.serverFields,
      });
    case 'rejected':
      throw errors.validation(result.reason ?? 'Operation rejected');
    default:
      throw errors.internal('Unknown push status');
  }
}

/** Upsert an entity via a one-op push (create or full/partial update). */
export async function upsertViaSync(
  entityType: EntityType,
  entityId: string,
  baseVersion: number,
  fields: Record<string, unknown>,
  ownerId: string,
  clock: Clock,
): Promise<SyncPushResult> {
  const op: SyncPushOp = {
    opId: newUuid(),
    entityType,
    entityId,
    op: 'upsert',
    baseVersion,
    clientUpdatedAt: clock.nowIso(),
    fields,
  };
  const { results } = await syncService.push([op], ownerId, clock);
  const result = results[0]!;
  assertApplied(result);
  return result;
}

/** Soft-delete an entity via a one-op push. */
export async function deleteViaSync(
  entityType: EntityType,
  entityId: string,
  baseVersion: number,
  ownerId: string,
  clock: Clock,
): Promise<SyncPushResult> {
  const op: SyncPushOp = {
    opId: newUuid(),
    entityType,
    entityId,
    op: 'delete',
    baseVersion,
    clientUpdatedAt: clock.nowIso(),
    fields: null,
  };
  const { results } = await syncService.push([op], ownerId, clock);
  const result = results[0]!;
  assertApplied(result);
  return result;
}

/**
 * Sync service (ApiSpec §6) — orchestration only. SQL is in repository.ts; the
 * conflict decision is the pure resolve() in conflict.ts.
 *
 * PUSH: each op is processed in its OWN transaction so a per-op conflict or
 * rejection doesn't roll back the rest of the batch (results are independent,
 * same order as the request). Per-op steps:
 *   1. idempotency  — replay stored result if opId already applied
 *   2. authorize    — owner-only writes in Phase 0 (shares arrive in Phase 5)
 *   3. validate     — the patch against the entity's contract patch schema
 *   4. resolve      — pure row-level LWW
 *   5. apply        — upsert/delete, bump server_version
 *   6. change_log   — append, capturing the cursor seq
 *   7. record       — persist the result under opId
 *
 * PULL: decode the opaque cursor, read visible deltas, encode nextCursor.
 */
import type { Clock } from '@/lib/clock.js';
import { db } from '@/db/client.js';
import { logger } from '@/lib/logger.js';
import { decodeCursor, encodeCursor } from '@/lib/ids.js';
import {
  patchSchemaByEntity,
  type SyncPushOp,
  type SyncPushResult,
  type SyncPushResponse,
  type SyncPullResponse,
  type SyncChange,
  type EntityType,
  type SyncOp,
} from '@/contract/schemas.js';
import { resolve, type CurrentRecord, type Patch } from '@/modules/sync/conflict.js';
import * as repo from '@/modules/sync/repository.js';

/** Internal signal: a patch failed schema validation (-> per-op 'rejected'). */
class PatchInvalid extends Error {}

/** Validate an op's `fields` against the entity's patch schema. */
function validatePatch(
  entityType: EntityType,
  fields: Record<string, unknown> | null,
): Record<string, unknown> {
  if (fields === null) return {};
  const schema = patchSchemaByEntity[entityType];
  const result = schema.safeParse(fields);
  if (!result.success) {
    const flat = result.error.flatten();
    throw new PatchInvalid(JSON.stringify(flat.fieldErrors));
  }
  return result.data as Record<string, unknown>;
}

/** Build the visible_user_ids for a change. Phase 0: owner only (no shares). */
function visibleUserIds(ownerId: string): string[] {
  return [ownerId];
}

/**
 * Process a single push op in its own transaction. Never throws for expected
 * per-op outcomes (conflict/rejected/duplicate) — those are returned as results.
 */
async function processOp(
  op: SyncPushOp,
  userId: string,
  clock: Clock,
): Promise<SyncPushResult> {
  // Result skeleton.
  const base = (over: Partial<SyncPushResult>): SyncPushResult => ({
    opId: op.opId,
    entityId: op.entityId,
    status: 'rejected',
    serverVersion: null,
    serverFields: null,
    committedSeq: null,
    reason: null,
    ...over,
  });

  try {
    return await db.transaction(async (tx) => {
      // 1) Idempotency — replay if we've already applied this opId.
      const prior = await repo.findIdempotent(op.opId, userId, tx);
      if (prior) {
        return { ...prior, status: 'duplicate' as const };
      }

      // 2) Validate the patch (upsert only).
      let cleanFields: Record<string, unknown> = {};
      if (op.op === 'upsert') {
        try {
          cleanFields = validatePatch(op.entityType, op.fields);
        } catch (e) {
          if (e instanceof PatchInvalid) {
            const rejected = base({ status: 'rejected', reason: `invalid_patch: ${e.message}` });
            await repo.recordIdempotent(op.opId, userId, rejected, clock.nowIso(), tx);
            return rejected;
          }
          throw e;
        }
      }

      // 3) Load current + authorize ownership.
      const current = await repo.loadCurrent(op.entityType, op.entityId, tx);
      if (current.exists && current.ownerId !== userId) {
        // Cross-tenant: never confirm existence. Reject the op.
        const rejected = base({ status: 'rejected', reason: 'forbidden: not owner' });
        await repo.recordIdempotent(op.opId, userId, rejected, clock.nowIso(), tx);
        return rejected;
      }

      // 4) Resolve (pure).
      const currentRecord: CurrentRecord = {
        serverVersion: current.serverVersion,
        updatedAt: current.updatedAt,
        deleted: current.deleted,
        fields: current.payload,
      };
      const patch: Patch = { op: op.op, fields: cleanFields };
      const decision = resolve({
        current: currentRecord,
        patch,
        baseVersion: op.baseVersion,
        clientUpdatedAt: op.clientUpdatedAt,
        // Field-level LWW for tasks (ApiSpec §6.1); row-level for entities without per-field meta.
        ...(op.entityType === 'task' ? { fieldMeta: current.fieldMeta } : {}),
      });

      // Structural / version conflict: nothing written, but it's a real result.
      if (decision.status === 'conflict') {
        const conflict = base({
          status: 'conflict',
          serverVersion: current.serverVersion,
          serverFields: decision.serverFields,
          reason: decision.reason,
        });
        await repo.recordIdempotent(op.opId, userId, conflict, clock.nowIso(), tx);
        return conflict;
      }

      // Server won a merge (noop write) — return its fields; record & done.
      if (decision.apply.kind === 'noop' && decision.status === 'merged') {
        const merged = base({
          status: 'merged',
          serverVersion: current.serverVersion,
          serverFields: decision.serverFields,
        });
        await repo.recordIdempotent(op.opId, userId, merged, clock.nowIso(), tx);
        return merged;
      }

      // Idempotent re-delete (applied noop): just acknowledge.
      if (decision.apply.kind === 'noop') {
        const applied = base({ status: 'applied', serverVersion: current.serverVersion });
        await repo.recordIdempotent(op.opId, userId, applied, clock.nowIso(), tx);
        return applied;
      }

      // 5) Apply the accepted write.
      const newVersion = decision.bumpVersion
        ? current.serverVersion + 1
        : current.serverVersion;
      const ownerId = current.exists ? (current.ownerId as string) : userId;
      let changeOp: SyncOp;
      let payload: Record<string, unknown> | null;

      if (decision.apply.kind === 'delete') {
        await repo.applyDelete(
          {
            entityType: op.entityType,
            entityId: op.entityId,
            newVersion,
            nowIso: clock.nowIso(),
          },
          tx,
        );
        changeOp = 'delete';
        payload = null;
      } else {
        // upsert — advance per-field LWW metadata for tasks (every field we actually wrote).
        const appliedFields = decision.apply.fields;
        let nextFieldMeta: Record<string, { v: number; updatedAt: string }> | undefined;
        if (op.entityType === 'task') {
          nextFieldMeta = { ...(current.fieldMeta ?? {}) };
          for (const key of Object.keys(appliedFields)) {
            nextFieldMeta[key] = { v: newVersion, updatedAt: op.clientUpdatedAt };
          }
        }
        payload = await repo.applyUpsert(
          {
            entityType: op.entityType,
            entityId: op.entityId,
            ownerId,
            fields: appliedFields,
            newVersion,
            nowIso: clock.nowIso(),
            isNew: !current.exists,
            ...(nextFieldMeta ? { fieldMeta: nextFieldMeta } : {}),
          },
          tx,
        );
        changeOp = 'upsert';
      }

      // 6) change_log append (captures the cursor seq).
      const seq = await repo.appendChange(
        {
          entityType: op.entityType,
          entityId: op.entityId,
          op: changeOp,
          version: newVersion,
          actorUserId: userId,
          visibleUserIds: visibleUserIds(ownerId),
          payload,
          nowIso: clock.nowIso(),
        },
        tx,
      );

      const result = base({
        status: decision.status === 'merged' ? 'merged' : 'applied',
        serverVersion: newVersion,
        serverFields: decision.serverFields,
        committedSeq: seq,
      });

      // 7) Record idempotent result.
      await repo.recordIdempotent(op.opId, userId, result, clock.nowIso(), tx);
      return result;
    });
  } catch (err) {
    // Unexpected failure for THIS op only — surface as rejected, keep the batch.
    // Log server-side (no detail on the wire).
    logger.error({ err, opId: op.opId, entityId: op.entityId }, 'sync op failed');
    return base({ status: 'rejected', reason: 'internal_error' });
  }
}

/** Handle a push batch. Results map 1:1 to ops, in order. */
export async function push(
  ops: SyncPushOp[],
  userId: string,
  clock: Clock,
): Promise<SyncPushResponse> {
  const results: SyncPushResult[] = [];
  for (const op of ops) {
    // Sequential: ordering matters (a create then update of the same entity in
    // one batch must apply in order); also bounds DB concurrency per request.
    // eslint-disable-next-line no-await-in-loop
    results.push(await processOp(op, userId, clock));
  }
  return { results };
}

/** Handle a pull. Decodes the cursor, reads visible deltas, encodes nextCursor. */
export async function pull(
  userId: string,
  cursor: string | undefined,
  limit: number,
): Promise<SyncPullResponse> {
  const afterSeq = decodeCursor(cursor);
  const rows = await repo.readChanges(userId, afterSeq, limit);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const changes: SyncChange[] = page.map((r) => ({
    entityType: r.entityType as EntityType,
    entityId: r.entityId,
    op: r.op as SyncOp,
    version: r.version,
    payload: r.payload,
    seq: String(r.seq),
  }));

  const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : null;
  const nextCursor = lastSeq !== null ? encodeCursor(lastSeq) : (cursor ?? null);

  return { changes, nextCursor, hasMore };
}

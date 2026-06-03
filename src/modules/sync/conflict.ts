/**
 * PURE, framework-free conflict resolver (ApiSpec §6.1, §17 "pure cores").
 *
 * Phase 0 ships ROW-LEVEL last-writer-wins (the simpler of the two strategies
 * the spec lists as a tunable in §20.1). Field-level LWW with `field_meta` is a
 * Phase 2 upgrade for `tasks`; the shape here is forward-compatible (the
 * resolver already receives `fieldMeta`).
 *
 * No imports, no clock, no DB — every input is passed in, so this is trivially
 * unit-testable and deterministic. Timestamps are compared as RFC3339 strings
 * parsed to epoch ms.
 *
 * Decision table (per op):
 *
 *   structural (delete vs upsert mismatch):
 *     - current deleted, patch is upsert  -> 'conflict' (delete wins; resurrect refused)
 *     - current live,    op is delete      -> 'applied'  (tombstone it)
 *     - both delete                        -> 'applied'  (idempotent re-delete)
 *
 *   value upsert, baseVersion === current.serverVersion (fast path):
 *     -> 'applied'  (apply the whole patch)
 *
 *   value upsert, baseVersion <  current.serverVersion (someone wrote first):
 *     - clientUpdatedAt  >  current.updatedAt -> client wins wholesale -> 'merged'
 *                                                (serverFields = null; client patch applied)
 *     - clientUpdatedAt <= current.updatedAt  -> server wins wholesale -> 'merged'
 *                                                (serverFields = current snapshot; patch dropped)
 *
 *   value upsert, baseVersion >  current.serverVersion (client ahead of server):
 *     -> 'conflict' (impossible under normal flow; never silently apply)
 */

/** Outcome statuses the resolver can return (subset of the push statuses). */
export type ResolutionStatus = 'applied' | 'merged' | 'conflict';

/** The server's current view of the row, as the resolver needs it. */
export interface CurrentRecord {
  /** Current server_version. For a brand-new (absent) row, pass 0. */
  serverVersion: number;
  /** Current updated_at as an RFC3339 string. For an absent row, pass null. */
  updatedAt: string | null;
  /** True if the row is currently a tombstone (deleted_at set). */
  deleted: boolean;
  /**
   * Current field values (server snapshot). Returned in `serverFields` when the
   * server wins a merge so the client can adopt them. May be a partial view.
   */
  fields: Record<string, unknown>;
}

/** The client's proposed change. */
export interface Patch {
  /** 'upsert' applies `fields`; 'delete' tombstones the row. */
  op: 'upsert' | 'delete';
  /** Changed fields only (ignored for delete). */
  fields: Record<string, unknown>;
}

/** Per-field metadata for future field-level LWW (unused by row-level Phase 0). */
export type FieldMeta = Record<string, { v: number; updatedAt: string }>;

export interface ResolveInput {
  current: CurrentRecord;
  patch: Patch;
  /** server_version the client believed it was editing (0 for a fresh create). */
  baseVersion: number;
  /** client's updated_at for this change, RFC3339 string. */
  clientUpdatedAt: string;
  /** Reserved for field-level LWW (Phase 2). Accepted now for forward-compat. */
  fieldMeta?: FieldMeta;
}

export interface ResolveResult {
  status: ResolutionStatus;
  /** What the caller should write. For 'merged' server-wins, this is empty. */
  apply:
    | { kind: 'upsert'; fields: Record<string, unknown> }
    | { kind: 'delete' }
    | { kind: 'noop' };
  /** Present (non-null) only when the SERVER won a merge — fields the client must adopt. */
  serverFields: Record<string, unknown> | null;
  /** Whether server_version should be bumped (true for any accepted write). */
  bumpVersion: boolean;
  /** Machine/human reason, primarily for 'conflict'. */
  reason: string | null;
}

/** Parse an RFC3339 timestamp to epoch ms; NaN-safe (absent -> -Infinity). */
function toMs(ts: string | null | undefined): number {
  if (!ts) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Resolve one mutation against the server's current record. Pure: same inputs
 * always yield the same result.
 */
export function resolve(input: ResolveInput): ResolveResult {
  const { current, patch, baseVersion, clientUpdatedAt } = input;

  // --- Structural: delete vs upsert ----------------------------------------
  if (patch.op === 'delete') {
    if (current.deleted) {
      // Idempotent re-delete. Nothing to change, but treat as applied so the
      // client's outbox op resolves cleanly.
      return {
        status: 'applied',
        apply: { kind: 'noop' },
        serverFields: null,
        bumpVersion: false,
        reason: null,
      };
    }
    // Live row being deleted: delete wins, always (ApiSpec §6.1 "delete wins").
    return {
      status: 'applied',
      apply: { kind: 'delete' },
      serverFields: null,
      bumpVersion: true,
      reason: null,
    };
  }

  // patch.op === 'upsert' from here on.
  if (current.deleted) {
    // Client tries to upsert a row the server has tombstoned. Delete wins;
    // surface a structural conflict rather than silently resurrecting.
    return {
      status: 'conflict',
      apply: { kind: 'noop' },
      serverFields: { deletedAt: current.fields['deletedAt'] ?? null },
      bumpVersion: false,
      reason: 'delete_wins: server tombstoned this entity; upsert refused',
    };
  }

  // --- Value upsert on a live row ------------------------------------------
  if (baseVersion === current.serverVersion) {
    // Fast path: client edited the version it last saw. Apply wholesale.
    return {
      status: 'applied',
      apply: { kind: 'upsert', fields: patch.fields },
      serverFields: null,
      bumpVersion: true,
      reason: null,
    };
  }

  if (baseVersion > current.serverVersion) {
    // Client claims to have seen a version newer than the server has. This
    // shouldn't happen in a correct client; never apply blindly.
    return {
      status: 'conflict',
      apply: { kind: 'noop' },
      serverFields: null,
      bumpVersion: false,
      reason: `stale_server: baseVersion ${baseVersion} > serverVersion ${current.serverVersion}`,
    };
  }

  // baseVersion < current.serverVersion: someone else wrote first → merge.
  const clientMs = toMs(clientUpdatedAt);

  // FIELD-LEVEL LWW when per-field metadata is supplied (tasks, ApiSpec §6.1):
  // decide each patched field independently against the time the SERVER last
  // wrote THAT field. Concurrent edits to *different* fields therefore both
  // survive; only edits to the SAME field race (last-writer-wins).
  if (input.fieldMeta) {
    const meta = input.fieldMeta;
    const clientWins: Record<string, unknown> = {};
    const serverWins: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch.fields)) {
      const fieldMs = toMs(meta[key]?.updatedAt);
      if (clientMs > fieldMs) {
        clientWins[key] = value; // client's edit is newer → it wins this field
      } else {
        serverWins[key] = current.fields[key]; // server's value is newer-or-equal → keep it
      }
    }
    if (Object.keys(clientWins).length === 0) {
      // Every patched field lost to the server. Hand back the authoritative values.
      return {
        status: 'merged',
        apply: { kind: 'noop' },
        serverFields: serverWins,
        bumpVersion: false,
        reason: null,
      };
    }
    return {
      status: 'merged',
      apply: { kind: 'upsert', fields: clientWins },
      // Non-null only when the server actually kept some fields the client tried to change.
      serverFields: Object.keys(serverWins).length > 0 ? serverWins : null,
      bumpVersion: true,
      reason: null,
    };
  }

  // ROW-LEVEL LWW fallback (entities without field metadata, e.g. lists/tags).
  const serverMs = toMs(current.updatedAt);
  if (clientMs > serverMs) {
    // Client newer → client wins wholesale (still 'merged': base diverged).
    return {
      status: 'merged',
      apply: { kind: 'upsert', fields: patch.fields },
      serverFields: null,
      bumpVersion: true,
      reason: null,
    };
  }
  // Server newer-or-equal → server wins wholesale; hand the client the row to adopt.
  return {
    status: 'merged',
    apply: { kind: 'noop' },
    serverFields: current.fields,
    bumpVersion: false,
    reason: null,
  };
}

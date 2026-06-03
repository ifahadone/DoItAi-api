/**
 * ID + cursor helpers.
 *
 * Entity ids are CLIENT-generated UUIDv4 (ApiSpec §6) — the server only
 * validates shape and never mints entity ids on the sync path. The server
 * DOES mint ids for server-owned rows (users, devices, refresh_tokens,
 * idempotency journal) and opaque refresh tokens.
 */
import { randomUUID, randomBytes, createHash } from 'node:crypto';

/** Mint a UUIDv4 (server-owned rows only). */
export function newUuid(): string {
  return randomUUID();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True if `s` is a syntactically valid UUID. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** Generate an opaque, high-entropy refresh token (base64url, ~256 bits). */
export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 of a token, returned as a Buffer for storage in a `bytea` column. */
export function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

// --- Sync cursor codec (pure; ApiSpec §6.2) --------------------------------
// The pull cursor is opaque base64 of the change_log.seq (a BIGSERIAL). We keep
// it as a string end-to-end to avoid JS 53-bit integer limits on large seqs.

/** Encode a change_log seq (string or bigint) into the opaque base64 cursor. */
export function encodeCursor(seq: bigint | number | string): string {
  const asStr = typeof seq === 'bigint' ? seq.toString() : String(seq);
  if (!/^\d+$/.test(asStr)) {
    throw new Error(`encodeCursor: seq must be a non-negative integer, got "${asStr}"`);
  }
  return Buffer.from(asStr, 'utf8').toString('base64');
}

/**
 * Decode the opaque cursor back to a seq as a bigint. A missing/empty cursor
 * means "from the beginning" -> 0n. Throws on malformed input.
 */
export function decodeCursor(cursor: string | undefined | null): bigint {
  if (cursor === undefined || cursor === null || cursor === '') return 0n;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    throw new Error('decodeCursor: cursor is not valid base64');
  }
  if (!/^\d+$/.test(decoded)) {
    throw new Error('decodeCursor: cursor does not decode to an integer');
  }
  return BigInt(decoded);
}

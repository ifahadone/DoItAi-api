/**
 * Auth persistence (ApiSpec §4, §5). ALL SQL for auth lives here — services
 * call these; no SQL in tokens.ts / routes.ts (layering rule).
 */
import { eq, and, isNull } from 'drizzle-orm';
import { db, type Tx, type Database } from '@/db/client.js';
import { users, devices, refreshTokens } from '@/db/schema.js';
import type { UserRow, DeviceRow, RefreshTokenRow } from '@/db/schema.js';
import { newUuid } from '@/lib/ids.js';

type Conn = Database | Tx;

// --- users ------------------------------------------------------------------

export async function findUserByAppleSub(
  appleSub: string,
  conn: Conn = db,
): Promise<UserRow | undefined> {
  const rows = await conn.select().from(users).where(eq(users.appleSub, appleSub)).limit(1);
  return rows[0];
}

export interface UpsertUserInput {
  appleSub: string;
  email: string | null;
  nowIso: string;
}

/**
 * Upsert by apple_sub (ApiSpec §4.1 step 5). On first sign-in inserts; on
 * return sign-in keeps the existing row (only backfills email if we were
 * missing one — Apple omits email after the first auth).
 */
export async function upsertUserByAppleSub(
  input: UpsertUserInput,
  conn: Conn = db,
): Promise<UserRow> {
  const existing = await findUserByAppleSub(input.appleSub, conn);
  if (existing) {
    if (!existing.email && input.email) {
      const updated = await conn
        .update(users)
        .set({ email: input.email, updatedAt: input.nowIso })
        .where(eq(users.id, existing.id))
        .returning();
      return updated[0] ?? existing;
    }
    return existing;
  }
  const inserted = await conn
    .insert(users)
    .values({
      id: newUuid(),
      appleSub: input.appleSub,
      email: input.email,
      displayName: '',
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    })
    .returning();
  // returning() always yields the row on insert.
  return inserted[0] as UserRow;
}

// --- devices ----------------------------------------------------------------

export interface UpsertDeviceInput {
  deviceId: string;
  userId: string;
  platform: string;
  appVersion: string | null;
  apnsToken: string | null;
  nowIso: string;
}

/** Register/refresh a device (client-generated device id; ApiSpec §7.6). */
export async function upsertDevice(
  input: UpsertDeviceInput,
  conn: Conn = db,
): Promise<DeviceRow> {
  const rows = await conn
    .insert(devices)
    .values({
      id: input.deviceId,
      userId: input.userId,
      platform: input.platform,
      appVersion: input.appVersion,
      apnsToken: input.apnsToken,
      lastSeenAt: input.nowIso,
      createdAt: input.nowIso,
    })
    .onConflictDoUpdate({
      target: devices.id,
      set: {
        userId: input.userId,
        platform: input.platform,
        appVersion: input.appVersion,
        apnsToken: input.apnsToken,
        lastSeenAt: input.nowIso,
        revokedAt: null,
      },
    })
    .returning();
  return rows[0] as DeviceRow;
}

// --- refresh tokens ---------------------------------------------------------

export interface InsertRefreshTokenInput {
  userId: string;
  deviceId: string | null;
  tokenHash: Buffer;
  expiresAt: string;
  nowIso: string;
}

export async function insertRefreshToken(
  input: InsertRefreshTokenInput,
  conn: Conn = db,
): Promise<RefreshTokenRow> {
  const id = newUuid();
  const rows = await conn
    .insert(refreshTokens)
    .values({
      id,
      userId: input.userId,
      deviceId: input.deviceId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: input.nowIso,
    })
    .returning();
  return rows[0] as RefreshTokenRow;
}

export async function findRefreshTokenByHash(
  tokenHash: Buffer,
  conn: Conn = db,
): Promise<RefreshTokenRow | undefined> {
  const rows = await conn
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0];
}

/** Mark a single refresh token revoked (logout / rotation). */
export async function revokeRefreshToken(
  id: string,
  opts: { replacedBy?: string; nowIso: string },
  conn: Conn = db,
): Promise<void> {
  await conn
    .update(refreshTokens)
    .set({
      revokedAt: opts.nowIso,
      ...(opts.replacedBy ? { replacedBy: opts.replacedBy } : {}),
    })
    .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)));
}

/**
 * Revoke the entire active token family for a user — used on refresh-token
 * REUSE detection (ApiSpec §4.2 "reuse detection ⇒ revoke the whole chain").
 * Phase 0 keeps it simple: revoke ALL of a user's currently-active refresh
 * tokens. (A finer-grained chain walk can replace this later without changing
 * the call site.)
 */
export async function revokeAllForUser(
  userId: string,
  nowIso: string,
  conn: Conn = db,
): Promise<void> {
  await conn
    .update(refreshTokens)
    .set({ revokedAt: nowIso })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

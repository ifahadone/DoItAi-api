/**
 * Token issuance + verification + refresh rotation (ApiSpec §4.2).
 *
 *  - Access JWT: ES256, 15 min, claims { sub=userId, did=deviceId }, signed with
 *    JWT_PRIVATE_KEY. Stateless (not stored). Verified with JWT_PUBLIC_KEY.
 *  - Refresh token: opaque random (base64url). SHA-256 hash stored in
 *    refresh_tokens. Single-use & rotating: each refresh issues a new token and
 *    revokes the presented one (`replaced_by`). Presenting an already-revoked
 *    token ⇒ REUSE ⇒ revoke the whole family.
 *
 * Crypto keys are imported lazily from PEM once, then cached.
 */
import { SignJWT, jwtVerify, importPKCS8, importSPKI, type JWTPayload } from 'jose';
import { env } from '@/config/env.js';
import { errors } from '@/lib/errors.js';
import type { Clock } from '@/lib/clock.js';
import { newOpaqueToken, sha256 } from '@/lib/ids.js';
import { db, type Tx, type Database } from '@/db/client.js';
import type { TokenPair } from '@/contract/schemas.js';
import * as repo from '@/auth/repository.js';

// jose v5 returns Web Crypto `CryptoKey` (a global in Node 22+) from
// importPKCS8/importSPKI. We alias it locally for readability.
type Key = CryptoKey;

const ALG = 'ES256';
const ISSUER = 'doit-api';
const AUDIENCE = 'doit-app';

/** Access token lifetime: 15 minutes (ApiSpec §4.2). */
export const ACCESS_TTL_SECONDS = 15 * 60;
/** Refresh token lifetime: 60 days (ApiSpec §4.2). */
export const REFRESH_TTL_SECONDS = 60 * 24 * 60 * 60;

let privateKeyPromise: Promise<Key> | null = null;
let publicKeyPromise: Promise<Key> | null = null;

function getPrivateKey(): Promise<Key> {
  privateKeyPromise ??= importPKCS8(env.JWT_PRIVATE_KEY, ALG);
  return privateKeyPromise;
}
function getPublicKey(): Promise<Key> {
  publicKeyPromise ??= importSPKI(env.JWT_PUBLIC_KEY, ALG);
  return publicKeyPromise;
}

export interface AccessClaims {
  /** userId */
  sub: string;
  /** deviceId */
  did: string;
}

/** Sign a 15-minute access JWT. */
export async function issueAccessToken(claims: AccessClaims, clock: Clock): Promise<string> {
  const nowSec = Math.floor(clock.nowMs() / 1000);
  return new SignJWT({ did: claims.did })
    .setProtectedHeader({ alg: ALG, kid: env.JWT_KID, typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ACCESS_TTL_SECONDS)
    .sign(await getPrivateKey());
}

/** Verify an access JWT; returns the claims or throws `unauthenticated`. */
export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  let payload: JWTPayload;
  try {
    const res = await jwtVerify(token, await getPublicKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALG],
    });
    payload = res.payload;
  } catch {
    throw errors.unauthenticated('Invalid or expired access token');
  }
  const sub = typeof payload.sub === 'string' ? payload.sub : null;
  const did = typeof payload['did'] === 'string' ? (payload['did'] as string) : null;
  if (!sub || !did) {
    throw errors.unauthenticated('Access token missing required claims');
  }
  return { sub, did };
}

type Conn = Database | Tx;

/** Issue + persist a fresh refresh token; returns the plaintext (shown once). */
async function mintRefreshToken(
  userId: string,
  deviceId: string | null,
  clock: Clock,
  conn: Conn,
): Promise<{ plaintext: string; id: string }> {
  const plaintext = newOpaqueToken(32);
  const tokenHash = sha256(plaintext);
  const expiresAt = new Date(clock.nowMs() + REFRESH_TTL_SECONDS * 1000).toISOString();
  const row = await repo.insertRefreshToken(
    { userId, deviceId, tokenHash, expiresAt, nowIso: clock.nowIso() },
    conn,
  );
  return { plaintext, id: row.id };
}

/** Build the wire token bundle for a freshly minted access+refresh pair. */
function toPair(
  accessToken: string,
  refreshToken: string,
  userId: string,
  deviceId: string,
): TokenPair {
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TTL_SECONDS,
    userId,
    deviceId,
  };
}

/**
 * Issue a brand-new access+refresh pair (post Apple sign-in). Runs in `conn`
 * (the caller's transaction) so user upsert + device + token are atomic.
 */
export async function issueTokenPair(
  args: { userId: string; deviceId: string },
  clock: Clock,
  conn: Conn = db,
): Promise<TokenPair> {
  const accessToken = await issueAccessToken({ sub: args.userId, did: args.deviceId }, clock);
  const { plaintext } = await mintRefreshToken(args.userId, args.deviceId, clock, conn);
  return toPair(accessToken, plaintext, args.userId, args.deviceId);
}

/**
 * Rotate: validate the presented refresh token, revoke it, issue a new pair.
 * Reuse detection: if the presented token is already revoked (or unknown), the
 * whole family is revoked and we 401 (ApiSpec §4.2).
 */
export async function rotateRefreshToken(
  presented: string,
  clock: Clock,
): Promise<TokenPair> {
  const presentedHash = sha256(presented);

  return db.transaction(async (tx) => {
    const row = await repo.findRefreshTokenByHash(presentedHash, tx);

    if (!row) {
      // Unknown token — cannot identify a family to revoke. Reject.
      throw errors.unauthenticated('Refresh token not recognized');
    }

    // REUSE: a single-use token presented after it was already revoked/rotated.
    if (row.revokedAt !== null) {
      await repo.revokeAllForUser(row.userId, clock.nowIso(), tx);
      throw errors.unauthenticated('Refresh token reuse detected; session revoked');
    }

    // Expired.
    if (new Date(row.expiresAt).getTime() <= clock.nowMs()) {
      await repo.revokeRefreshToken(row.id, { nowIso: clock.nowIso() }, tx);
      throw errors.unauthenticated('Refresh token expired');
    }

    // Orphaned: the device was removed (ON DELETE SET NULL). We can't bind a new
    // access token to a device, and our middleware requires `did`. Revoke and
    // force a fresh sign-in (which re-registers the device).
    if (row.deviceId === null) {
      await repo.revokeRefreshToken(row.id, { nowIso: clock.nowIso() }, tx);
      throw errors.unauthenticated('Device no longer registered; sign in again');
    }
    const deviceId = row.deviceId;

    // Happy path: mint replacement, then revoke the presented token pointing at it.
    const replacement = await mintRefreshToken(row.userId, deviceId, clock, tx);
    await repo.revokeRefreshToken(
      row.id,
      { replacedBy: replacement.id, nowIso: clock.nowIso() },
      tx,
    );

    const accessToken = await issueAccessToken({ sub: row.userId, did: deviceId }, clock);
    return toPair(accessToken, replacement.plaintext, row.userId, deviceId);
  });
}

/** Logout this device: revoke the presented refresh token (idempotent). */
export async function revokePresentedToken(presented: string, clock: Clock): Promise<void> {
  const presentedHash = sha256(presented);
  await db.transaction(async (tx) => {
    const row = await repo.findRefreshTokenByHash(presentedHash, tx);
    if (row && row.revokedAt === null) {
      await repo.revokeRefreshToken(row.id, { nowIso: clock.nowIso() }, tx);
    }
    // Unknown/already-revoked token: treat logout as success (idempotent).
  });
}

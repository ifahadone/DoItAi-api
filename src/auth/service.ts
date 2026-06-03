/**
 * Auth service — orchestrates the Apple sign-in flow (ApiSpec §4.1) and
 * delegates token rotation/revocation to tokens.ts. Business logic only; SQL is
 * in repository.ts, crypto/token mechanics in tokens.ts.
 */
import type { Clock } from '@/lib/clock.js';
import { db } from '@/db/client.js';
import type { AppleSignIn, RefreshRequest, LogoutRequest, TokenPair } from '@/contract/schemas.js';
import { verifyAppleIdentityToken } from '@/auth/apple.js';
import * as repo from '@/auth/repository.js';
import { issueTokenPair, rotateRefreshToken, revokePresentedToken } from '@/auth/tokens.js';

/**
 * POST /auth/apple. Verify the Apple identity token, upsert user + device, and
 * issue our token pair — all atomic.
 */
export async function signInWithApple(body: AppleSignIn, clock: Clock): Promise<TokenPair> {
  const identity = await verifyAppleIdentityToken(body.identityToken, body.nonce);

  return db.transaction(async (tx) => {
    const user = await repo.upsertUserByAppleSub(
      { appleSub: identity.sub, email: identity.email, nowIso: clock.nowIso() },
      tx,
    );

    await repo.upsertDevice(
      {
        deviceId: body.deviceInfo.deviceId,
        userId: user.id,
        platform: body.deviceInfo.platform,
        appVersion: body.deviceInfo.appVersion,
        apnsToken: body.deviceInfo.apnsToken,
        nowIso: clock.nowIso(),
      },
      tx,
    );

    return issueTokenPair({ userId: user.id, deviceId: body.deviceInfo.deviceId }, clock, tx);
  });
}

/** POST /auth/refresh. Rotate the presented refresh token. */
export async function refresh(body: RefreshRequest, clock: Clock): Promise<TokenPair> {
  return rotateRefreshToken(body.refreshToken, clock);
}

/** POST /auth/logout. Revoke this device's refresh token (idempotent). */
export async function logout(body: LogoutRequest, clock: Clock): Promise<void> {
  await revokePresentedToken(body.refreshToken, clock);
}

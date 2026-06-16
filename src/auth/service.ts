/**
 * Auth service — orchestrates the Apple sign-in flow (ApiSpec §4.1) and
 * delegates token rotation/revocation to tokens.ts. Business logic only; SQL is
 * in repository.ts, crypto/token mechanics in tokens.ts.
 */
import type { Clock } from '@/lib/clock.js';
import { db } from '@/db/client.js';
import type { AppleSignIn, RefreshRequest, LogoutRequest, TokenPair } from '@/contract/schemas.js';
import { verifyAppleIdentityToken } from '@/auth/apple.js';
import { verifyAppleNotification, isAccountTerminationEvent } from '@/auth/notifications.js';
import * as repo from '@/auth/repository.js';
import { issueTokenPair, rotateRefreshToken, revokePresentedToken } from '@/auth/tokens.js';
import { deleteUserData } from '@/modules/account/service.js';

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

/**
 * POST /auth/apple/notifications (NFR-SEC-260). Verify Apple's signed server-to-server notification
 * and, for `account-delete` / `consent-revoked`, purge the user's account (FK-safe; cascades the
 * user row + refresh tokens). Unknown subjects and email events are acknowledged idempotently so
 * Apple doesn't retry. Returns the handled event type for diagnostics.
 */
export async function handleAppleNotification(payloadJwt: string): Promise<{ handled: string }> {
  const event = await verifyAppleNotification(payloadJwt);
  if (isAccountTerminationEvent(event.type)) {
    const user = await repo.findUserByAppleSub(event.sub);
    if (user) await deleteUserData(user.id);
  }
  return { handled: event.type };
}

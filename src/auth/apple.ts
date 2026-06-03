/**
 * Sign in with Apple — identity-token verification (ApiSpec §4.1).
 *
 * Verifies the Apple identity JWT against Apple's JWKS
 * (https://appleid.apple.com/auth/keys) using `jose`:
 *   - signature (RS256, key by `kid`)
 *   - iss === https://appleid.apple.com
 *   - aud === <app bundle id>  (from env)
 *   - exp / nbf (clock skew tolerated by jose)
 *   - nonce (when the client supplied one — replay protection)
 * Returns the stable `sub` (+ email if present).
 *
 * The JWKS fetch happens at REQUEST time (jose caches & rotates it), not at
 * import time — so this file is inert until a real /auth/apple call.
 *
 * Non-prod escape hatch: when env.APPLE_STUB_VERIFICATION is true AND we are not
 * in production, the token is DECODED but NOT verified, and its `sub` is trusted
 * as-is. This lets you exercise the flow without an Apple round-trip. The env
 * loader hard-forbids the stub in production.
 */
import { createRemoteJWKSet, jwtVerify, decodeJwt, type JWTPayload } from 'jose';
import { env, isProd } from '@/config/env.js';
import { errors } from '@/lib/errors.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

/** Lazily-created, cached remote key set (jose handles caching + rotation). */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (jwks === null) {
    jwks = createRemoteJWKSet(APPLE_JWKS_URL, {
      // Bound the network call so a slow Apple can't hang a request.
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
    });
  }
  return jwks;
}

export interface AppleIdentity {
  /** Apple's stable user id (the `sub` claim) — our `users.apple_sub`. */
  sub: string;
  /** Email, when Apple includes it (first sign-in, or if not hidden). */
  email: string | null;
  /** Whether Apple marked the email verified. */
  emailVerified: boolean;
}

/** True when the dev stub is active (never in production). */
export function appleStubActive(): boolean {
  return env.APPLE_STUB_VERIFICATION && !isProd;
}

function extractEmail(payload: JWTPayload): { email: string | null; emailVerified: boolean } {
  const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : null;
  const ev = payload['email_verified'];
  // Apple sends email_verified as the string "true"/"false" or a boolean.
  const emailVerified = ev === true || ev === 'true';
  return { email, emailVerified };
}

/**
 * Verify an Apple identity token and return the identity. `expectedNonce`, when
 * provided, must match the token's `nonce` claim (replay protection).
 *
 * Throws an `unauthenticated` AppError on any failure (never leaks crypto detail
 * to the client).
 */
export async function verifyAppleIdentityToken(
  identityToken: string,
  expectedNonce?: string | null,
): Promise<AppleIdentity> {
  // --- dev/test stub --------------------------------------------------------
  if (appleStubActive()) {
    let payload: JWTPayload;
    try {
      payload = decodeJwt(identityToken);
    } catch {
      throw errors.unauthenticated('Apple token is not a decodable JWT (stub mode)');
    }
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) throw errors.unauthenticated('Apple token missing sub (stub mode)');
    const { email, emailVerified } = extractEmail(payload);
    return { sub, email, emailVerified };
  }

  // --- real verification ----------------------------------------------------
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(identityToken, getJwks(), {
      issuer: APPLE_ISSUER,
      audience: env.APPLE_BUNDLE_ID,
      // jose enforces exp/nbf with a small default tolerance.
    });
    payload = result.payload;
  } catch {
    // Signature / iss / aud / exp failure — uniform 401, no detail leak.
    throw errors.unauthenticated('Apple identity token verification failed');
  }

  if (expectedNonce != null && expectedNonce !== '') {
    if (payload['nonce'] !== expectedNonce) {
      throw errors.unauthenticated('Apple identity token nonce mismatch');
    }
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : null;
  if (!sub) {
    throw errors.unauthenticated('Apple identity token missing sub');
  }

  const { email, emailVerified } = extractEmail(payload);
  return { sub, email, emailVerified };
}

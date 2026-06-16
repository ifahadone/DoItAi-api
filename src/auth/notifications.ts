/**
 * Sign in with Apple — server-to-server notifications (ApiSpec §4.1, §7.1; NFR-SEC-260).
 *
 * Apple POSTs `{ payload: "<signed JWT>" }`. The JWT is signed by Apple and verifiable against the
 * SAME JWKS as identity tokens (https://appleid.apple.com/auth/keys, iss https://appleid.apple.com,
 * aud = our bundle id). Its `events` claim is itself a JSON string:
 *   { type, sub, email?, is_private_email?, event_time }
 * where `type` is one of `email-enabled` | `email-disabled` | `consent-revoked` | `account-delete`.
 *
 * We act on `account-delete` and `consent-revoked` (the user disconnected Sign in with Apple) by
 * purging the account; email events are acknowledged without action.
 *
 * Stub escape hatch mirrors `apple.ts`: when `APPLE_STUB_VERIFICATION` is on (forbidden in prod by the
 * env loader) the JWT is DECODED but NOT verified, so the flow is testable without an Apple round-trip.
 */
import { createRemoteJWKSet, jwtVerify, decodeJwt, type JWTPayload } from 'jose';
import { env, isProd } from '@/config/env.js';
import { errors } from '@/lib/errors.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (jwks === null) {
    jwks = createRemoteJWKSet(APPLE_JWKS_URL, { timeoutDuration: 5_000, cooldownDuration: 30_000 });
  }
  return jwks;
}

export interface AppleNotificationEvent {
  /** `email-enabled` | `email-disabled` | `consent-revoked` | `account-delete`. */
  type: string;
  /** Apple's stable user id (`users.apple_sub`). */
  sub: string;
  email: string | null;
}

/** Whether the event means the account should be purged (deleted or consent revoked). */
export function isAccountTerminationEvent(type: string): boolean {
  return type === 'account-delete' || type === 'consent-revoked';
}

function parseEvents(payload: JWTPayload): AppleNotificationEvent {
  const raw = payload['events'];
  if (typeof raw !== 'string') throw errors.unauthenticated('Apple notification missing events');
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw errors.unauthenticated('Apple notification events is not JSON');
  }
  const type = typeof evt['type'] === 'string' ? (evt['type'] as string) : null;
  const sub = typeof evt['sub'] === 'string' ? (evt['sub'] as string) : null;
  if (type === null || sub === null) {
    throw errors.unauthenticated('Apple notification event missing type/sub');
  }
  const email = typeof evt['email'] === 'string' ? (evt['email'] as string) : null;
  return { type, sub, email };
}

/** Verify (or, in stub mode, decode) the notification JWT and return its event. */
export async function verifyAppleNotification(payloadJwt: string): Promise<AppleNotificationEvent> {
  if (env.APPLE_STUB_VERIFICATION && !isProd) {
    let payload: JWTPayload;
    try {
      payload = decodeJwt(payloadJwt);
    } catch {
      throw errors.unauthenticated('Apple notification is not a decodable JWT (stub mode)');
    }
    return parseEvents(payload);
  }

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(payloadJwt, getJwks(), {
      issuer: APPLE_ISSUER,
      audience: env.APPLE_BUNDLE_ID,
    });
    payload = result.payload;
  } catch {
    throw errors.unauthenticated('Apple notification verification failed');
  }
  return parseEvents(payload);
}

/**
 * StoreKit 2 transaction verification (ApiSpec §12). The client sends Apple-signed JWS transactions;
 * the server decodes + verifies them and is the source of truth for the Pro entitlement.
 *
 * Mirrors the Apple-sign-in stub pattern (src/auth/apple.ts): when `BILLING_STUB_VERIFICATION` is on
 * AND we're not in production, the JWS is DECODED but its signature is NOT verified (the loader
 * hard-forbids the stub in production). In production it verifies the JWS against the leaf certificate
 * from the `x5c` header.
 *
 * ⚠️ Launch-hardening TODO: pin the Apple **root** by verifying the `x5c` chain terminates at Apple's
 * G3 root CA (fingerprint check) before trusting the leaf. Flagged for the security pass.
 */
import { decodeJwt, decodeProtectedHeader, importX509, jwtVerify, type JWTPayload } from 'jose';
import { env } from '@/config/env.js';
import { errors } from '@/lib/errors.js';

export interface DecodedTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDateMs: number | null;
  expiresDateMs: number | null;
  revocationDateMs: number | null;
  environment: string;
  autoRenew: boolean;
}

export interface DecodedNotification {
  notificationType: string;
  subtype: string | null;
  /** The inner JWSTransaction (itself a JWS) for the affected subscription, if present. */
  signedTransactionInfo: string | null;
}

const isProd = (): boolean => env.NODE_ENV === 'production';
const useStub = (): boolean => env.BILLING_STUB_VERIFICATION && !isProd();

/** Decode (stub) or verify-and-decode (prod) one Apple JWS. */
async function decodeOrVerify(jws: string): Promise<JWTPayload> {
  if (useStub()) {
    try {
      return decodeJwt(jws);
    } catch {
      throw errors.validation('Not a decodable JWS (billing stub mode)');
    }
  }
  let header;
  try {
    header = decodeProtectedHeader(jws);
  } catch {
    throw errors.validation('Malformed JWS header');
  }
  const x5c = (header.x5c as string[] | undefined) ?? [];
  if (x5c.length === 0) throw errors.validation('JWS missing x5c certificate chain');
  const leafPem = `-----BEGIN CERTIFICATE-----\n${x5c[0]}\n-----END CERTIFICATE-----`;
  const key = await importX509(leafPem, 'ES256');
  try {
    const { payload } = await jwtVerify(jws, key);
    return payload;
  } catch {
    throw errors.validation('JWS signature verification failed');
  }
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return null;
}

export async function verifySignedTransaction(jws: string): Promise<DecodedTransaction> {
  const payload = (await decodeOrVerify(jws)) as Record<string, unknown>;
  const decoded: DecodedTransaction = {
    transactionId: String(payload.transactionId ?? ''),
    originalTransactionId: String(payload.originalTransactionId ?? ''),
    bundleId: String(payload.bundleId ?? ''),
    productId: String(payload.productId ?? ''),
    purchaseDateMs: num(payload.purchaseDate),
    expiresDateMs: num(payload.expiresDate),
    revocationDateMs: num(payload.revocationDate),
    environment: String(payload.environment ?? 'Production'),
    autoRenew: payload.autoRenew === undefined ? true : Boolean(payload.autoRenew),
  };
  if (!decoded.originalTransactionId || !decoded.productId) {
    throw errors.validation('Transaction missing originalTransactionId/productId');
  }
  if (env.APPLE_BUNDLE_ID && decoded.bundleId && decoded.bundleId !== env.APPLE_BUNDLE_ID) {
    throw errors.forbidden('Transaction bundle id does not match this app');
  }
  return decoded;
}

export async function verifyNotification(jws: string): Promise<DecodedNotification> {
  const payload = (await decodeOrVerify(jws)) as Record<string, unknown>;
  const data = (payload.data as Record<string, unknown> | undefined) ?? {};
  return {
    notificationType: String(payload.notificationType ?? ''),
    subtype: payload.subtype ? String(payload.subtype) : null,
    signedTransactionInfo: data.signedTransactionInfo ? String(data.signedTransactionInfo) : null,
  };
}

/**
 * StoreKit 2 transaction verification (ApiSpec §12). The client sends Apple-signed JWS transactions;
 * the server decodes + verifies them and is the source of truth for the Pro entitlement.
 *
 * Mirrors the Apple-sign-in stub pattern (src/auth/apple.ts): when `BILLING_STUB_VERIFICATION` is on
 * AND we're not in production, the JWS is DECODED but its signature is NOT verified (the loader
 * hard-forbids the stub in production). In production it verifies the JWS against the leaf certificate
 * from the `x5c` header.
 *
 * Production also pins the chain to Apple's Root CA — G3: every certificate must be signed by the next,
 * and the chain must terminate at Apple's published root (SHA-256 fingerprint below), so a forged leaf
 * from a different/compromised CA can't be trusted.
 */
import { decodeJwt, decodeProtectedHeader, importX509, jwtVerify, type JWTPayload } from 'jose';
import { X509Certificate } from 'node:crypto';
import { env } from '@/config/env.js';
import { errors } from '@/lib/errors.js';

/**
 * SHA-256 fingerprint of **Apple Root CA - G3** (self-signed root; C=US, O=Apple Inc.). Source of
 * truth: https://www.apple.com/certificateauthority/AppleRootCA-G3.cer. StoreKit 2 / App Store Server
 * notification JWS chains terminate here. Override via `APPLE_ROOT_CA_G3_SHA256` only to rotate.
 */
const APPLE_ROOT_CA_G3_SHA256 =
  '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';

/**
 * Verify an Apple `x5c` chain: each cert is signed by the next, and the root matches the pinned
 * Apple Root CA - G3 fingerprint. Throws a validation error on any break. Returns the verified leaf.
 */
export function verifyAppleChain(x5c: string[]): X509Certificate {
  if (x5c.length < 2) throw errors.validation('Apple JWS x5c chain too short to pin the root');
  let certs: X509Certificate[];
  try {
    certs = x5c.map((b64) => new X509Certificate(Buffer.from(b64, 'base64')));
  } catch {
    throw errors.validation('Apple JWS x5c contains an unparseable certificate');
  }
  // Each certificate must be cryptographically signed by the next one up the chain.
  for (let i = 0; i < certs.length - 1; i++) {
    const child = certs[i];
    const issuer = certs[i + 1];
    if (!child || !issuer || !child.verify(issuer.publicKey)) {
      throw errors.validation('Apple JWS chain: certificate not signed by its issuer');
    }
  }
  const root = certs[certs.length - 1];
  const leaf = certs[0];
  if (!root || !leaf) throw errors.validation('Apple JWS chain: empty after parse');
  const pinned = (process.env.APPLE_ROOT_CA_G3_SHA256 ?? APPLE_ROOT_CA_G3_SHA256).toUpperCase();
  if (root.fingerprint256.toUpperCase() !== pinned) {
    throw errors.validation('Apple JWS chain does not terminate at the pinned Apple Root CA - G3');
  }
  return leaf;
}

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
  // Pin the chain to Apple's Root CA - G3 before trusting the leaf (throws on any break).
  verifyAppleChain(x5c);
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

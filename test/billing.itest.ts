/**
 * Billing route integration tests (DevelopmentPlan P6-1). Exercises the StoreKit flow end-to-end
 * against a live local Postgres, in BILLING stub mode (transactions are decoded, not Apple-verified —
 * the prod path needs real Apple-signed JWS). Run:
 *   BILLING_STUB_VERIFICATION=true DATABASE_URL=postgres://doit:doit@localhost:5432/doit \
 *     npm run test:integration
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { pool, closeDb } from '@/db/client.js';

const KEY = new TextEncoder().encode('stub-not-verified');

async function jws(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(KEY);
}

/** A StoreKit JWSTransaction (stub-decodable). */
function transaction(over: Record<string, unknown> = {}) {
  return {
    transactionId: randomUUID(),
    originalTransactionId: 'otx-001',
    bundleId: 'app.doit.DoIT',
    productId: 'doit.pro.monthly',
    purchaseDate: Date.parse('2026-06-01T00:00:00.000Z'),
    expiresDate: Date.parse('2026-07-01T00:00:00.000Z'),
    environment: 'Sandbox',
    ...over,
  };
}

let app: FastifyInstance;

async function signIn(sub: string): Promise<string> {
  const token = await jws({ sub, email: `${sub}@example.com` });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/apple',
    payload: { identityToken: token, authorizationCode: null, nonce: null, deviceInfo: { deviceId: randomUUID(), appVersion: 'itest' } },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().accessToken;
}

const receipt = (token: string, signedTransaction: string) =>
  app.inject({ method: 'POST', url: '/api/v1/billing/receipt', headers: { authorization: `Bearer ${token}` }, payload: { signedTransaction } });
const status = (token: string) =>
  app.inject({ method: 'GET', url: '/api/v1/billing/status', headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await closeDb();
});
beforeEach(async () => {
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('Refusing to TRUNCATE: DATABASE_URL is not local.');
  await pool.query('TRUNCATE users, devices, refresh_tokens, subscriptions RESTART IDENTITY CASCADE');
});

describe('billing', () => {
  it('validates a receipt → grants Pro; status reflects it', async () => {
    const token = await signIn(`u-${randomUUID()}`);
    expect((await status(token)).json().pro).toBe(false); // before any purchase

    const r = await receipt(token, await jws(transaction()));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().pro).toBe(true);
    expect(r.json().productId).toBe('doit.pro.monthly');

    expect((await status(token)).json().pro).toBe(true);
  });

  it('an expired transaction does not grant Pro', async () => {
    const token = await signIn(`u-${randomUUID()}`);
    const r = await receipt(token, await jws(transaction({ expiresDate: Date.parse('2020-01-01T00:00:00.000Z') })));
    expect(r.statusCode).toBe(200);
    expect(r.json().pro).toBe(false);
  });

  it('a renewal (same original tx, later expiry) extends the entitlement', async () => {
    const token = await signIn(`u-${randomUUID()}`);
    await receipt(token, await jws(transaction({ expiresDate: Date.parse('2026-06-15T00:00:00.000Z') })));
    const renewed = await receipt(token, await jws(transaction({ transactionId: randomUUID(), expiresDate: Date.parse('2027-06-15T00:00:00.000Z') })));
    expect(renewed.json().expiresAt).toBe('2027-06-15T00:00:00.000Z'); // upserted by original_transaction_id
  });

  it('a refund (revocationDate) revokes Pro', async () => {
    const token = await signIn(`u-${randomUUID()}`);
    await receipt(token, await jws(transaction()));
    const refunded = await receipt(token, await jws(transaction({ transactionId: randomUUID(), revocationDate: Date.parse('2026-06-03T00:00:00.000Z') })));
    expect(refunded.json().pro).toBe(false);
  });

  it('App Store Server Notification updates the owning user without auth', async () => {
    const token = await signIn(`u-${randomUUID()}`);
    await receipt(token, await jws(transaction({ expiresDate: Date.parse('2026-06-10T00:00:00.000Z') })));

    // Apple POSTs a renewal notification (unauthenticated; trust = the JWS).
    const innerTx = await jws(transaction({ transactionId: randomUUID(), expiresDate: Date.parse('2028-01-01T00:00:00.000Z') }));
    const signedPayload = await jws({ notificationType: 'DID_RENEW', data: { signedTransactionInfo: innerTx } });
    const webhook = await app.inject({ method: 'POST', url: '/api/v1/billing/notifications', payload: { signedPayload } });
    expect(webhook.statusCode, webhook.body).toBe(200);

    expect((await status(token)).json().expiresAt).toBe('2028-01-01T00:00:00.000Z');
  });
});

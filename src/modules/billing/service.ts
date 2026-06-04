/**
 * Billing service (ApiSpec §12). Upserts subscriptions from verified transactions and derives the Pro
 * entitlement. Entitlement is computed (never a stored mutable flag) so it's always correct: a user is
 * Pro if any subscription is unrevoked and either non-expiring or not yet expired.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { subscriptions, type SubscriptionRow } from '@/db/schema.js';
import type { DecodedTransaction } from './verify.js';

export interface Entitlement {
  pro: boolean;
  productId: string | null;
  expiresAt: string | null;
  environment: string | null;
}

const msToIso = (ms: number | null): string | null => (ms != null ? new Date(ms).toISOString() : null);

/** Normalize a timestamp string to RFC3339 (Drizzle `mode:'string'` reads back Postgres's own format,
 *  e.g. `2027-06-15 00:00:00+00` — the wire contract is RFC3339 with `T`/`Z`). */
const toRfc3339 = (value: string | null): string | null =>
  value != null ? new Date(value).toISOString() : null;

/** Pure: derive the Pro entitlement from a user's subscription rows. */
export function computeEntitlement(subs: SubscriptionRow[], nowIso: string): Entitlement {
  const now = Date.parse(nowIso);
  const active = subs.filter(
    (s) => s.revokedAt == null && (s.expiresAt == null || Date.parse(s.expiresAt) > now),
  );
  if (active.length === 0) return { pro: false, productId: null, expiresAt: null, environment: null };
  // Surface the longest-lived active entitlement.
  const best = active.reduce((a, b) => {
    const ax = a.expiresAt ? Date.parse(a.expiresAt) : Infinity;
    const bx = b.expiresAt ? Date.parse(b.expiresAt) : Infinity;
    return ax >= bx ? a : b;
  });
  return {
    pro: true,
    productId: best.productId,
    expiresAt: toRfc3339(best.expiresAt),
    environment: best.environment,
  };
}

/** Upsert a subscription from a verified transaction (keyed by Apple's stable original tx id). */
export async function applyTransaction(
  userId: string,
  decoded: DecodedTransaction,
  nowIso: string,
): Promise<void> {
  const values = {
    latestTransactionId: decoded.transactionId,
    productId: decoded.productId,
    purchaseAt: msToIso(decoded.purchaseDateMs),
    expiresAt: msToIso(decoded.expiresDateMs),
    revokedAt: msToIso(decoded.revocationDateMs),
    autoRenew: decoded.autoRenew,
    environment: decoded.environment,
    updatedAt: nowIso,
  };
  await db
    .insert(subscriptions)
    .values({
      id: randomUUID(),
      ownerId: userId,
      originalTransactionId: decoded.originalTransactionId,
      createdAt: nowIso,
      ...values,
    })
    .onConflictDoUpdate({ target: subscriptions.originalTransactionId, set: values });
}

export async function entitlementFor(userId: string, nowIso: string): Promise<Entitlement> {
  const subs = await db.select().from(subscriptions).where(eq(subscriptions.ownerId, userId));
  return computeEntitlement(subs, nowIso);
}

/** Find the user who owns a subscription (for webhook attribution). */
export async function ownerOfSubscription(originalTransactionId: string): Promise<string | null> {
  const [row] = await db
    .select({ ownerId: subscriptions.ownerId })
    .from(subscriptions)
    .where(eq(subscriptions.originalTransactionId, originalTransactionId))
    .limit(1);
  return row?.ownerId ?? null;
}

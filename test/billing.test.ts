import { describe, it, expect } from 'vitest';
import { computeEntitlement } from '@/modules/billing/service.js';
import type { SubscriptionRow } from '@/db/schema.js';

const NOW = '2026-06-04T00:00:00.000Z';

function sub(partial: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    id: 'id',
    ownerId: 'owner',
    originalTransactionId: 'otx',
    latestTransactionId: 'tx',
    productId: 'doit.pro.monthly',
    purchaseAt: '2026-05-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    autoRenew: true,
    environment: 'Production',
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

describe('computeEntitlement', () => {
  it('no subscriptions ⇒ not Pro', () => {
    expect(computeEntitlement([], NOW)).toEqual({ pro: false, productId: null, expiresAt: null, environment: null });
  });

  it('a future-dated subscription ⇒ Pro', () => {
    const e = computeEntitlement([sub({ expiresAt: '2026-07-01T00:00:00.000Z' })], NOW);
    expect(e.pro).toBe(true);
    expect(e.productId).toBe('doit.pro.monthly');
    expect(e.expiresAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('an expired subscription ⇒ not Pro', () => {
    expect(computeEntitlement([sub({ expiresAt: '2026-05-01T00:00:00.000Z' })], NOW).pro).toBe(false);
  });

  it('a revoked (refunded) subscription ⇒ not Pro even if not expired', () => {
    const e = computeEntitlement(
      [sub({ expiresAt: '2026-07-01T00:00:00.000Z', revokedAt: '2026-06-02T00:00:00.000Z' })],
      NOW,
    );
    expect(e.pro).toBe(false);
  });

  it('a non-expiring subscription ⇒ Pro', () => {
    expect(computeEntitlement([sub({ expiresAt: null })], NOW).pro).toBe(true);
  });

  it('surfaces the longest-lived active subscription', () => {
    const e = computeEntitlement(
      [
        sub({ originalTransactionId: 'a', productId: 'monthly', expiresAt: '2026-06-10T00:00:00.000Z' }),
        sub({ originalTransactionId: 'b', productId: 'annual', expiresAt: '2027-01-01T00:00:00.000Z' }),
      ],
      NOW,
    );
    expect(e.pro).toBe(true);
    expect(e.productId).toBe('annual');
  });
});

/**
 * Billing routes (ApiSpec §7, §12).
 *
 * - `POST /billing/receipt` (auth): verify a StoreKit 2 signed transaction → upsert subscription →
 *   return the entitlement. The client calls this after a purchase / on app launch (`Transaction.currentEntitlements`).
 * - `GET /billing/status` (auth): the entitlement the app gates Pro features on.
 * - `POST /billing/notifications` (UNauth, Apple-signed): App Store Server Notifications V2 keep the
 *   entitlement current (renew/refund/expire) without polling. Verified by the JWS signature, not a
 *   user token.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '@/auth/middleware.js';
import { parseOrThrow } from '@/lib/validate.js';
import { verifySignedTransaction, verifyNotification } from './verify.js';
import { applyTransaction, entitlementFor, ownerOfSubscription } from './service.js';

const ReceiptSchema = z.object({ signedTransaction: z.string().min(1) }).strict();
const NotificationSchema = z.object({ signedPayload: z.string().min(1) }).strict();

/** Authenticated billing endpoints (entitlement is per-user). */
export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/billing/receipt', async (request) => {
    const user = requireUser(request);
    const body = parseOrThrow(ReceiptSchema, request.body);
    const nowIso = app.clock.nowIso();
    const decoded = await verifySignedTransaction(body.signedTransaction);
    await applyTransaction(user.id, decoded, nowIso);
    return entitlementFor(user.id, nowIso);
  });

  app.get('/billing/status', async (request) => {
    const user = requireUser(request);
    return entitlementFor(user.id, app.clock.nowIso());
  });
}

/** Apple's webhook (App Store Server Notifications V2). Unauthenticated; trust comes from the JWS. */
export async function registerBillingWebhook(app: FastifyInstance): Promise<void> {
  app.post('/billing/notifications', async (request, reply) => {
    const body = parseOrThrow(NotificationSchema, request.body);
    const notification = await verifyNotification(body.signedPayload);
    if (notification.signedTransactionInfo) {
      const decoded = await verifySignedTransaction(notification.signedTransactionInfo);
      // Attribute to the user who already owns this subscription (the client posts the first receipt).
      const ownerId = await ownerOfSubscription(decoded.originalTransactionId);
      if (ownerId) await applyTransaction(ownerId, decoded, app.clock.nowIso());
    }
    reply.code(200);
    return { ok: true };
  });
}

/**
 * Device registration routes (ApiSpec §7.6, §10) — AUTHENTICATED.
 *
 * Devices are a direct (non-synced) resource: the client registers/refreshes its
 * APNs token + push prefs so the server can drive collaboration / silent-sync
 * pushes later (Phase 5+). Upsert by the client-generated device id; the raw APNs
 * token is stored but never echoed back.
 */
import type { FastifyInstance } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { devices } from '@/db/schema.js';
import { parseOrThrow } from '@/lib/validate.js';
import { requireUser } from '@/auth/middleware.js';
import { DeviceRegisterSchema, IdParamSchema, type Device } from '@/contract/schemas.js';

function toDevice(row: typeof devices.$inferSelect): Device {
  return {
    id: row.id,
    platform: row.platform,
    appVersion: row.appVersion,
    pushPrefs: (row.pushPrefs as Record<string, unknown>) ?? {},
    hasApnsToken: row.apnsToken != null && row.apnsToken !== '',
    lastSeenAt: row.lastSeenAt,
  };
}

export async function registerDeviceRoutes(app: FastifyInstance): Promise<void> {
  // POST /devices — register or refresh this device (idempotent upsert by id).
  app.post('/devices', async (request) => {
    const user = requireUser(request);
    const body = parseOrThrow(DeviceRegisterSchema, request.body);
    const now = app.clock.nowIso();

    await db
      .insert(devices)
      .values({
        id: body.id,
        userId: user.id,
        apnsToken: body.apnsToken,
        platform: body.platform,
        appVersion: body.appVersion,
        pushPrefs: body.pushPrefs,
        lastSeenAt: now,
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: devices.id,
        set: {
          apnsToken: body.apnsToken,
          platform: body.platform,
          appVersion: body.appVersion,
          pushPrefs: body.pushPrefs,
          lastSeenAt: now,
          revokedAt: null,
          userId: user.id,
        },
        // Never let one user hijack another user's device id.
        setWhere: eq(devices.userId, user.id),
      });

    const rows = await db
      .select()
      .from(devices)
      .where(and(eq(devices.id, body.id), eq(devices.userId, user.id)))
      .limit(1);
    return rows[0] ? toDevice(rows[0]) : {};
  });

  // GET /devices — this user's registered devices.
  app.get('/devices', async (request) => {
    const user = requireUser(request);
    const rows = await db
      .select()
      .from(devices)
      .where(eq(devices.userId, user.id))
      .orderBy(desc(devices.lastSeenAt))
      .limit(100);
    return { items: rows.map(toDevice) };
  });

  // DELETE /devices/{id} — revoke (soft) this device and drop its token.
  app.delete('/devices/:id', async (request, reply) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    await db
      .update(devices)
      .set({ revokedAt: app.clock.nowIso(), apnsToken: null })
      .where(and(eq(devices.id, id), eq(devices.userId, user.id)));
    reply.code(204);
  });
}

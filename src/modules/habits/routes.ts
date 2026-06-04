/**
 * Habit routes (ApiSpec §7.4) — AUTHENTICATED.
 *
 * `POST /habits/{id}/log` records a completion for a habit (a routine with `is_habit`) and recomputes
 * its streak authoritatively (the server owns streak math across devices). The recompute is appended
 * to the change_log so every device pulls the new streak + completions via sync.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { routines } from '@/db/schema.js';
import { parseOrThrow } from '@/lib/validate.js';
import { requireUser } from '@/auth/middleware.js';
import { errors } from '@/lib/errors.js';
import { IdParamSchema } from '@/contract/schemas.js';
import { computeStreak } from '@/modules/habits/streak.js';
import { routineRowToPayload } from '@/modules/sync/mapping.js';
import { appendChange } from '@/modules/sync/repository.js';

const LogHabitSchema = z
  .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
  .strict();

export async function registerHabitRoutes(app: FastifyInstance): Promise<void> {
  app.post('/habits/:id/log', async (request) => {
    const user = requireUser(request);
    const { id } = parseOrThrow(IdParamSchema, request.params);
    const body = parseOrThrow(LogHabitSchema, request.body ?? {});
    const nowIso = app.clock.nowIso();
    const today = body.date ?? nowIso.slice(0, 10);

    return db.transaction(async (tx) => {
      const rows = await tx.select().from(routines).where(eq(routines.id, id)).limit(1);
      const row = rows[0];
      if (!row || row.deletedAt !== null || row.ownerId !== user.id) {
        throw errors.notFound('Habit not found');
      }

      const prior = Array.isArray(row.completions) ? (row.completions as string[]) : [];
      const completions = [...new Set([...prior, today])].sort();
      const { current, longest } = computeStreak(completions, row.graceDays, today);
      const newVersion = row.serverVersion + 1;

      await tx
        .update(routines)
        .set({
          completions,
          streakCurrent: current,
          streakLongest: Math.max(longest, row.streakLongest),
          updatedAt: nowIso,
          serverVersion: newVersion,
        })
        .where(eq(routines.id, id));

      const fresh = await tx.select().from(routines).where(eq(routines.id, id)).limit(1);
      const payload = routineRowToPayload(fresh[0]!);

      // Propagate the server-computed streak to every device via sync.
      await appendChange(
        {
          entityType: 'routine',
          entityId: id,
          op: 'upsert',
          version: newVersion,
          actorUserId: user.id,
          visibleUserIds: [user.id],
          payload,
          nowIso,
        },
        tx,
      );

      return { routine: payload };
    });
  });
}

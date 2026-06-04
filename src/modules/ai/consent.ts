/**
 * AI consent gate (ApiSpec §9.6). Every AI endpoint checks `users.ai_consent`; absent ⇒ 403
 * `ai_consent_required`. Returns the user's settings (working hours, quiet hours, preferences) so the
 * endpoint can build the per-user stable context.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { users } from '@/db/schema.js';
import { errors } from '@/lib/errors.js';

export interface ConsentedUser {
  id: string;
  settings: Record<string, unknown>;
}

export async function requireAiConsent(userId: string): Promise<ConsentedUser> {
  const [row] = await db
    .select({ aiConsent: users.aiConsent, settings: users.settings })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw errors.notFound('User not found');
  if (!row.aiConsent) throw errors.aiConsentRequired();
  return { id: userId, settings: (row.settings as Record<string, unknown>) ?? {} };
}

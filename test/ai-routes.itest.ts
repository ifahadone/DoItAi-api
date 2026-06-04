/**
 * AI proxy route integration tests (DevelopmentPlan P4-1/P4-2). Exercises POST /ai/parse end-to-end
 * against a live local Postgres via Fastify `inject`, with a FAKE AiClient injected (no API key / no
 * network). Proves: the consent gate (403), the structured happy path, and usage metering.
 *
 * Run: `DATABASE_URL=postgres://doit:doit@localhost:5432/doit npm run test:integration`.
 */
import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { db, pool, closeDb } from '@/db/client.js';
import { users, aiUsage } from '@/db/schema.js';
import { setAiClient, type AiClient, type ToolCallRequest, type ToolCallResult } from '@/modules/ai/client.js';

async function stubAppleToken(sub: string): Promise<string> {
  return new SignJWT({ sub, email: `${sub}@example.com` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('stub-not-verified'));
}

let app: FastifyInstance;

async function signIn(sub: string): Promise<{ accessToken: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/apple',
    payload: {
      identityToken: await stubAppleToken(sub),
      authorizationCode: null,
      nonce: null,
      deviceInfo: { deviceId: randomUUID(), appVersion: 'itest' },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

function parse(token: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/ai/parse',
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

/** Fake AI returning a canned parsed task; records the tool-call requests it received. */
class FakeAiClient implements AiClient {
  readonly calls: ToolCallRequest[] = [];
  constructor(private readonly input: unknown) {}
  async toolCall(req: ToolCallRequest): Promise<ToolCallResult> {
    this.calls.push(req);
    return {
      input: this.input,
      usage: { inputTokens: 30, outputTokens: 12, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
  }
  async *stream(): AsyncIterable<never> {
    throw new Error('not used');
  }
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

afterEach(() => setAiClient(undefined));

beforeEach(async () => {
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new Error('Refusing to TRUNCATE: DATABASE_URL is not local.');
  }
  await pool.query('TRUNCATE users, devices, refresh_tokens, ai_usage RESTART IDENTITY CASCADE');
});

describe('POST /ai/parse', () => {
  it('403 ai_consent_required when the user has not consented', async () => {
    const { accessToken } = await signIn(`u-${randomUUID()}`);
    const res = await parse(accessToken, { text: 'Buy milk tomorrow' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ai_consent_required');
  });

  it('parses + meters usage when consented (fake model)', async () => {
    const { accessToken, userId } = await signIn(`u-${randomUUID()}`);
    await db.update(users).set({ aiConsent: true }).where(eq(users.id, userId));

    const fake = new FakeAiClient({
      title: 'Call the dentist',
      start: null,
      durationMinutes: null,
      due: '2026-06-05T09:00:00.000Z',
      priority: 'p2',
      tags: ['health'],
      listHint: 'Personal',
    });
    setAiClient(fake);

    const res = await parse(accessToken, {
      text: 'Call the dentist tomorrow 9am #health !p2',
      nowIso: '2026-06-04T08:00:00.000Z',
      lists: ['Personal', 'Work'],
      tags: ['health', 'errands'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().task.priority).toBe('p2');
    expect(res.json().task.tags).toEqual(['health']);

    // The model saw the volatile phrase and the cached per-user context.
    expect(fake.calls[0].userContent).toContain('Call the dentist');
    expect(fake.calls[0].stableContext).toContain('Personal');

    // Usage was metered.
    const [{ n }] = await db
      .select({ n: sql<string>`count(*)` })
      .from(aiUsage)
      .where(eq(aiUsage.ownerId, userId));
    expect(Number(n)).toBe(1);
  });

  it('400 validation_error on a malformed request body', async () => {
    const { accessToken, userId } = await signIn(`u-${randomUUID()}`);
    await db.update(users).set({ aiConsent: true }).where(eq(users.id, userId));
    setAiClient(new FakeAiClient({}));
    const res = await parse(accessToken, { text: '' }); // empty text fails min(1)
    expect(res.statusCode).toBe(400);
  });
});

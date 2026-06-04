/**
 * WebSocket realtime e2e (DevelopmentPlan P5-4). Connects a real socket (auth via ?ticket=), pushes a
 * change over HTTP, and asserts a `sync.bump` arrives on the socket — the realtime nudge path (§8).
 * Run (in-process bus, deterministic): REDIS_URL= DATABASE_URL=postgres://doit:doit@localhost:5432/doit npm run test:integration
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { pool, closeDb } from '@/db/client.js';

let app: FastifyInstance;
let baseUrl: string;
let wsUrl: string;

beforeAll(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
  wsUrl = `ws://127.0.0.1:${port}/api/v1/ws`;
});
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('non-local DB');
  await pool.query('TRUNCATE users, devices, refresh_tokens, tasks, change_log RESTART IDENTITY CASCADE');
});

async function signIn(sub: string): Promise<{ accessToken: string; userId: string }> {
  const token = await new SignJWT({ sub, email: `${sub}@example.com` })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().sign(new TextEncoder().encode('stub-not-verified'));
  const res = await fetch(`${baseUrl}/auth/apple`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identityToken: token, authorizationCode: null, nonce: null, deviceInfo: { deviceId: randomUUID(), appVersion: 'itest' } }),
  });
  return res.json();
}

function waitFor(ws: WebSocket, match: (m: { type?: string; data?: { cursor?: string } }) => boolean, timeoutMs = 5000): Promise<{ type?: string; data?: { cursor?: string } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', handler); reject(new Error('ws message timeout')); }, timeoutMs);
    const handler = (ev: MessageEvent) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (match(msg)) { clearTimeout(timer); ws.removeEventListener('message', handler); resolve(msg); }
    };
    ws.addEventListener('message', handler);
  });
}

describe('websocket realtime', () => {
  it('delivers a sync.bump to a connected socket after a push', async () => {
    const a = await signIn(`a-${randomUUID()}`);
    const ws = new WebSocket(`${wsUrl}?ticket=${a.accessToken}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('ws open failed')));
    });
    await waitFor(ws, (m) => m.type === 'ready');

    const bump = waitFor(ws, (m) => m.type === 'sync.bump');
    await fetch(`${baseUrl}/sync/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.accessToken}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ ops: [{ opId: randomUUID(), entityType: 'task', entityId: randomUUID(), op: 'upsert', baseVersion: 0, clientUpdatedAt: '2026-06-04T12:00:00.000Z', fields: { title: 'Realtime' } }] }),
    });
    const msg = await bump;
    expect(msg.data?.cursor, 'bump should carry the cursor').toBeTruthy();
    ws.close();
  });

  it('rejects an unauthenticated socket', async () => {
    const ws = new WebSocket(`${wsUrl}?ticket=not-a-real-token`);
    const closed = await new Promise<number>((resolve) => {
      ws.addEventListener('close', (ev) => resolve(ev.code));
      ws.addEventListener('error', () => resolve(1006));
    });
    expect(closed).not.toBe(1000); // not a normal close → rejected
  });
});

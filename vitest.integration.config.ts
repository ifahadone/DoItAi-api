/**
 * Integration tests (ApiSpec §18). These hit a REAL Postgres (the loop: auth →
 * push → pull → conflict → idempotency → cross-tenant isolation), so they are
 * kept OUT of the default pure-unit `npm test` and run via `npm run test:integration`.
 *
 * Prereqs: `docker compose up -d && npm run db:migrate` (and a `.env` — the app's
 * env loader picks it up). Files are named `*.itest.ts` so the unit config's
 * `*.test.ts` glob never collects them.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': resolve(root, 'src') },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.itest.ts'],
    globals: false,
    fileParallelism: false, // one shared DB — run serially
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});

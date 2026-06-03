/**
 * Vitest config. Phase 0 unit tests (the pure conflict resolver + contract
 * round-trip) need NO database — they run anywhere. Integration tests that hit
 * real Postgres (Testcontainers, ApiSpec §18) arrive in Phase 1; when added,
 * gate them behind a separate `test:integration` project.
 *
 * The `@/*` path alias is resolved here so tests import the same way as src.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(root, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Pure-core unit tests only in Phase 0; no global DB setup.
    globals: false,
    clearMocks: true,
  },
});

/**
 * drizzle-kit configuration (ApiSpec §16 — migrations run as a gated pre-deploy
 * step via `drizzle-kit migrate`). Migrations live in ./drizzle.
 *
 * Intentionally standalone: it reads ONLY DATABASE_URL from the environment and
 * does NOT import the full Zod env module. That keeps the migrate step runnable
 * with just a DB URL present (you should not need JWT/Apple/APNs secrets merely
 * to apply a migration), and lets the config work in a runtime image that ships
 * `dist/` without `src/`.
 *
 * `npm run db:generate` diffs src/db/schema.ts against the last snapshot and
 * writes a new migration. `npm run db:migrate` applies pending migrations.
 *
 * NOTE: ./drizzle/0000_init.sql was authored by hand to match src/db/schema.ts
 * (the generator needs deps/network the scaffolding run lacked). Once deps are
 * installed, `db:generate` against a DB already at 0000 should be a no-op.
 */
import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('drizzle.config: DATABASE_URL is required to run drizzle-kit');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});

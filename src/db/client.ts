/**
 * Drizzle + node-postgres client. A single shared pool for the process
 * (ApiSpec §16 — pool sizing matters behind a serverless-ish PaaS; tune
 * `max` per platform / PgBouncer).
 *
 * Defense-in-depth note (ApiSpec §4.3, §14): production also wants Postgres
 * Row-Level Security keyed off `SET app.user_id`. That is enabled in a later
 * phase; the `withUser` helper below is the seam where per-transaction
 * `SET LOCAL app.user_id` will be issued. Application-level ownership checks
 * (the repositories) remain the primary gate in Phase 0.
 */
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { env } from '@/config/env.js';
import { schema } from '@/db/schema.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// `casing: 'snake_case'` maps camelCase model properties (createdAt, serverVersion,
// appleSub, …) to the snake_case columns the migration created (created_at, …), so
// runtime queries match the DDL. Keep this in sync with drizzle.config.ts.
export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema, casing: 'snake_case' });

export type Database = typeof db;
/** A transaction handle as passed to Drizzle's `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Run `fn` inside a transaction with `app.user_id` set for the connection, so
 * Postgres RLS policies (added later) scope rows to the caller. In Phase 0 RLS
 * is not yet enabled, but issuing the GUC now is harmless and keeps the seam.
 */
export async function withUser<T>(
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/** Liveness probe for /ready (ApiSpec §7.10, §15). */
export async function pingDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Graceful shutdown hook. */
export async function closeDb(): Promise<void> {
  await pool.end();
}

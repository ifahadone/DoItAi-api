/**
 * Process entrypoint: build the app, start listening, and shut down gracefully
 * (ApiSpec §16 — "graceful shutdown drains" connections; close the DB pool).
 *
 * Phase 0 boots WITHOUT Redis. The server listens as soon as the HTTP stack is
 * ready; /ready reports DB health for the platform probe.
 */
import { env } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { buildApp } from '@/app.js';
import { closeDb } from '@/db/client.js';
import { closeRedis } from '@/redis/client.js';

async function main(): Promise<void> {
  const app = await buildApp();

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    logger.info({ host: env.HOST, port: env.PORT, env: env.NODE_ENV }, 'DoIT API listening');
  } catch (err) {
    logger.fatal({ err }, 'failed to start');
    await closeDb().catch(() => undefined);
    process.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await app.close(); // stops accepting, drains in-flight + sockets
      await closeDb();
      await closeRedis();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      void shutdown(sig);
    });
  }

  // Last-resort guards so a stray rejection/exception is logged, not silent.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    void shutdown('uncaughtException');
  });
}

void main();

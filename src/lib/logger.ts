/**
 * pino structured logger (ApiSpec §15). JSON in production; pretty transport is
 * intentionally NOT wired here to avoid an extra dependency — pipe through
 * `pino-pretty` in dev if desired (`npm run dev | npx pino-pretty`).
 *
 * Redaction keeps tokens/PII out of logs (ApiSpec §14, §15: "No PII or tokens").
 */
import { pino, type LoggerOptions } from 'pino';
import { env, isProd } from '@/config/env.js';

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  // Strip secrets/PII anywhere they might appear in logged objects.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      '*.identityToken',
      '*.authorizationCode',
      '*.refreshToken',
      '*.accessToken',
      '*.token',
      '*.tokenHash',
      '*.apns_token',
      '*.apnsToken',
      '*.password',
      'email',
      '*.email',
    ],
    censor: '[redacted]',
  },
  base: { service: 'doit-api', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
};

export const logger = pino(options);

export type Logger = typeof logger;

/** Marker so we remember to add a pretty transport only outside prod if wanted. */
export const prettyPrintAvailable = !isProd;

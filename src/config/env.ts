/**
 * Typed, Zod-validated process.env. Imported once at boot; fails FAST with a
 * readable error if anything required is missing or malformed (ApiSpec §16,
 * "12-factor; a Zod-validated env schema fails fast at boot").
 *
 * Phase 0 contract: the app MUST boot without Redis. REDIS_URL is therefore
 * optional and the rest of the app treats `env.REDIS_URL === undefined` as
 * "Redis disabled".
 */
import { z } from 'zod';

// Load a local `.env` in non-production so `npm run dev`, tests, and one-off
// scripts pick up config without a process manager. No-op if the file is absent
// (production gets its environment from the platform's secret store). Runs before
// we read process.env below.
if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile();
  } catch {
    // No .env present — rely on the ambient environment.
  }
}

/** PEM keys may arrive with literal "\n" sequences (single-line env vars). Normalize. */
const pem = () =>
  z
    .string()
    .min(1)
    .transform((s) => s.replace(/\\n/g, '\n'));

/** Coerce common truthy/falsy string spellings into a boolean. */
const boolish = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const EnvSchema = z
  .object({
    // Runtime
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // Database
    DATABASE_URL: z.string().url().or(z.string().startsWith('postgres')),

    // Redis — OPTIONAL in Phase 0. Empty string is treated as "unset".
    REDIS_URL: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() !== '' ? v : undefined)),

    // Our JWTs (ES256)
    JWT_PRIVATE_KEY: pem(),
    JWT_PUBLIC_KEY: pem(),
    JWT_KID: z.string().min(1).default('doit-es256'),

    // Sign in with Apple
    APPLE_BUNDLE_ID: z.string().min(1),
    APPLE_TEAM_ID: z.string().min(1).optional(),
    APPLE_KEY_ID: z.string().optional(),
    APPLE_CLIENT_SECRET_PRIVATE_KEY: z.string().optional(),
    APPLE_STUB_VERIFICATION: boolish(false),

    // Anthropic (Phase 4)
    ANTHROPIC_API_KEY: z.string().optional(),

    // APNs (Phase 1+)
    APNS_KEY_ID: z.string().optional(),
    APNS_TEAM_ID: z.string().optional(),
    APNS_BUNDLE_ID: z.string().optional(),
    APNS_AUTH_KEY: z.string().optional(),
    APNS_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  })
  .superRefine((val, ctx) => {
    // Safety rail: stub Apple verification must never be active in production.
    if (val.NODE_ENV === 'production' && val.APPLE_STUB_VERIFICATION === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APPLE_STUB_VERIFICATION'],
        message: 'APPLE_STUB_VERIFICATION must be false when NODE_ENV=production',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    const lines = Object.entries(flat.fieldErrors)
      .map(([k, errs]) => `  - ${k}: ${(errs ?? []).join('; ')}`)
      .join('\n');
    // eslint-disable-next-line no-console -- boot-time fatal, before logger exists
    console.error(
      `\n[config] Invalid environment. Fix these and restart:\n${lines}\n` +
        (flat.formErrors.length ? `  - ${flat.formErrors.join('; ')}\n` : ''),
    );
    process.exit(1);
  }
  return parsed.data;
}

/** The validated, immutable environment. Import this, never `process.env` directly. */
export const env: Env = loadEnv();

/** Convenience flags. */
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const redisEnabled = env.REDIS_URL !== undefined;

/**
 * Zod-at-the-edge helpers. Every HTTP body/query is parsed through these so a
 * schema failure becomes a uniform `validation_error` envelope with a
 * `details.fieldErrors` map (ApiSpec §3).
 */
import type { z } from 'zod';
import { errors } from '@/lib/errors.js';

/** Parse `data` with `schema`, or throw a `validation_error` AppError. */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const flat = result.error.flatten();
    throw errors.validation('Request validation failed', {
      fieldErrors: flat.fieldErrors,
      formErrors: flat.formErrors,
    });
  }
  return result.data;
}

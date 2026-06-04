/**
 * Typed error envelope (ApiSpec §3, §21).
 *
 * Every error response is exactly:
 *   { "error": { "code", "message", "details?", "requestId" } }
 *
 * `code` is a machine-readable enum the client switches on. HTTP status is
 * derived from the code so routes/services only throw `AppError` and never
 * hand-craft status codes.
 */

/** Machine-readable error codes (ApiSpec §21). */
export const ErrorCode = {
  validation_error: 'validation_error',
  unauthenticated: 'unauthenticated',
  forbidden: 'forbidden',
  not_found: 'not_found',
  conflict: 'conflict',
  gone: 'gone',
  ai_consent_required: 'ai_consent_required',
  ai_budget_exceeded: 'ai_budget_exceeded',
  ai_unavailable: 'ai_unavailable',
  rate_limited: 'rate_limited',
  internal: 'internal',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** code -> default HTTP status (ApiSpec §3 status table). */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  ai_consent_required: 403,
  ai_budget_exceeded: 429,
  ai_unavailable: 503,
  rate_limited: 429,
  internal: 500,
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

/**
 * The one error type the app throws. The global error handler (src/app.ts)
 * turns it into the envelope above with the right status.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;
  /** Distinguishes intentional, client-facing errors from unexpected crashes. */
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = opts.details;
    // 5xx are not exposed verbatim (avoid leaking internals); 4xx are client-facing.
    this.expose = this.statusCode < 500;
    Error.captureStackTrace?.(this, AppError);
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.expose ? this.message : 'Internal server error',
        ...(this.details !== undefined && this.expose ? { details: this.details } : {}),
        requestId,
      },
    };
  }
}

// --- Ergonomic constructors -------------------------------------------------
export const errors = {
  validation: (message = 'Validation failed', details?: unknown) =>
    new AppError(ErrorCode.validation_error, message, { details }),
  unauthenticated: (message = 'Authentication required') =>
    new AppError(ErrorCode.unauthenticated, message),
  forbidden: (message = 'Forbidden') => new AppError(ErrorCode.forbidden, message),
  notFound: (message = 'Not found', details?: unknown) =>
    new AppError(ErrorCode.not_found, message, { details }),
  conflict: (message = 'Conflict', details?: unknown) =>
    new AppError(ErrorCode.conflict, message, { details }),
  gone: (message = 'Gone') => new AppError(ErrorCode.gone, message),
  aiConsentRequired: (message = 'AI features require consent') =>
    new AppError(ErrorCode.ai_consent_required, message),
  aiBudgetExceeded: (message = 'Monthly AI budget exceeded') =>
    new AppError(ErrorCode.ai_budget_exceeded, message),
  aiUnavailable: (message = 'AI is unavailable; fall back to on-device/manual', details?: unknown) =>
    new AppError(ErrorCode.ai_unavailable, message, { details }),
  rateLimited: (message = 'Rate limited') => new AppError(ErrorCode.rate_limited, message),
  internal: (message = 'Internal server error', cause?: unknown) =>
    new AppError(ErrorCode.internal, message, { cause }),
};

/** Build the envelope for an arbitrary thrown value (used by the global handler). */
export function toErrorEnvelope(err: unknown, requestId: string): {
  status: number;
  body: ErrorEnvelope;
} {
  if (err instanceof AppError) {
    return { status: err.statusCode, body: err.toEnvelope(requestId) };
  }
  const internal = errors.internal('Internal server error', err);
  return { status: internal.statusCode, body: internal.toEnvelope(requestId) };
}

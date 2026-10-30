import { HttpException } from '@nestjs/common';

/**
 * Uniform error envelope (API_CONTRACTS §conventions):
 *   { error: { code, message, correlation_id, details? } }
 * Codes are stable strings; no stack traces or secrets in responses.
 */

export type ErrorCode =
  | 'validation_failed'
  | 'unauthorized'
  | 'permission_denied'
  | 'tenant_mismatch'
  | 'not_found'
  /** 409 — a valid request the domain refuses as-is: reply on a resolved
   *  case, a reused Idempotency-Key, a channel-mismatched handoff queue */
  | 'conflict'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'internal_error';

const CODE_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  permission_denied: 403,
  tenant_mismatch: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  provider_unavailable: 503,
  internal_error: 500,
};

/** Thrown anywhere; rendered by ErrorEnvelopeFilter into the uniform envelope. */
export class AppException extends HttpException {
  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(
      {
        code,
        message: message ?? code,
        ...(details !== undefined ? { details } : {}),
        __appException: true,
      },
      CODE_STATUS[code] ?? 500,
    );
  }
}

/** Best-effort mapping for framework/third-party exceptions by status. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'validation_failed';
    case 401:
      return 'unauthorized';
    case 403:
      return 'permission_denied';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    case 503:
      return 'provider_unavailable';
    default:
      return status >= 500 ? 'internal_error' : 'validation_failed';
  }
}

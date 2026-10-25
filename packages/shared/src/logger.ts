import { stdTimeFunctions, type LoggerOptions } from 'pino';

/**
 * One log-options builder for every process (api, worker) — ADR-008 §1.
 * Redaction lives here so no app can drift from SECURITY.md §7: logs never
 * carry secrets (passwords, auth headers, cookies, tokens) — and by
 * convention never message bodies or PII beyond tenant-safe identifiers.
 */

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Fail-fast level resolution (ENVIRONMENT_VARIABLES rule): invalid value
 * throws naming the VARIABLE, never printing the configured value.
 */
export function resolveLogLevel(
  raw: string | undefined,
  fallback: LogLevel = 'info',
): LogLevel {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid value for environment variable LOG_LEVEL (expected one of: ${LOG_LEVELS.join(', ')})`,
    );
  }
  return value as LogLevel;
}

/** SECURITY §7 redaction paths (pino/fast-redact syntax, covered by specs). */
export const REDACT_PATHS = [
  // credentials + secrets wherever they appear in log payloads
  'password',
  '*.password',
  'password_hash',
  '*.password_hash',
  'secret',
  '*.secret',
  'api_key',
  '*.api_key',
  'token',
  '*.token',
  'refresh_token',
  '*.refresh_token',
  'access_token',
  '*.access_token',
  // transport-level headers (request/response logging)
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'set-cookie',
  '*.set-cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
] as const;

export interface PinoBaseOptions {
  level?: LogLevel;
  /** shows up on every line as `service` (api / worker) */
  service?: string;
  /** request-context enrichment (correlation_id, tenant_id, user_id) — ADR-008 §2 */
  mixin?: () => Record<string, unknown>;
}

/** Shared pino options: level + service base + redaction + ISO timestamps. */
export function buildPinoOptions(options: PinoBaseOptions = {}): LoggerOptions {
  return {
    level: options.level ?? 'info',
    base: { service: options.service ?? 'api' },
    timestamp: stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    ...(options.mixin ? { mixin: options.mixin } : {}),
  };
}

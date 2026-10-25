import type { LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';

/**
 * Nest `LoggerService` backed by pino (ADR-008 §1) — replaces Nest's
 * plain-text console logger so boot/module logs are structured JSON with the
 * same level control and redaction as everything else. The pino instance is
 * shared with Fastify's request logging (single stream, single options).
 */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('trace', message, optionalParams);
  }

  /** pino's fatal is reserved for the bootstrap failure path. */
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('fatal', message, optionalParams);
  }

  private emit(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    params: unknown[],
  ): void {
    // Nest appends the logger `context` as the trailing string param
    const optional = [...params];
    let context: string | undefined;
    if (optional.length > 0 && typeof optional[optional.length - 1] === 'string') {
      context = optional.pop() as string;
    }
    const payload: Record<string, unknown> = {};
    if (context) payload['context'] = context;
    if (optional.length > 0) {
      payload['detail'] = optional.length === 1 ? optional[0] : optional;
    }
    this.logger[level](
      payload,
      typeof message === 'string' ? message : safeString(message),
    );
  }
}

function safeString(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

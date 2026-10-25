import { Injectable, NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  runInCorrelation,
  sanitizeCorrelationId,
} from './correlation';

const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Ingress correlation (ADR-008 §2): sanitize/accept or mint the id, echo it
 * on the response header, and run the rest of the request inside the
 * AsyncLocalStorage store so every log line / audit row / outbox event can
 * pick it up without plumbing.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(
    req: IncomingMessage & { headers?: Record<string, unknown> },
    res: ServerResponse & {
      setHeader?: (name: string, value: string) => unknown;
      header?: (name: string, value: string) => unknown;
    },
    next: () => void,
  ): void {
    const correlationId = sanitizeCorrelationId(
      req.headers?.[CORRELATION_HEADER],
    );

    // echo on success AND error responses (set before any handler runs)
    try {
      if (typeof res.setHeader === 'function') {
        res.setHeader('X-Correlation-ID', correlationId);
      } else if (typeof res.header === 'function') {
        res.header('X-Correlation-ID', correlationId);
      }
    } catch {
      // headers already sent in an edge case — body still carries the id
    }

    runInCorrelation({ correlationId }, next);
  }
}

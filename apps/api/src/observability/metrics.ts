import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AppException } from '../common/errors';
import { HttpException } from '@nestjs/common';

/**
 * Prometheus-compatible metrics baseline (ADR-008 §3).
 * Labels carry route TEMPLATES only (`/v1/audit-events`, never concrete
 * ids) — bounded cardinality, no identifier leakage.
 */

export type HttpLabelNames = 'method' | 'route' | 'status';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequests: Counter<HttpLabelNames>;

  readonly httpDuration: Histogram<'method' | 'route'>;

  constructor() {
    // process_cpu_*, process_resident_memory_bytes, nodejs_* baselines
    collectDefaultMetrics({ register: this.registry });

    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests handled by the API, by method/route/status',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });

    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds, by method/route',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
  }

  recordHttp(method: string, route: string, status: number, seconds: number): void {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, seconds);
  }

  metricsText(): Promise<string> {
    return this.registry.metrics();
  }
}

/** Fastify route template (e.g. `/v1/audit-events`); 'unmatched' for 404s. */
export function routeLabel(request: FastifyRequest): string {
  const url = (request as { routeOptions?: { url?: unknown } }).routeOptions
    ?.url;
  return typeof url === 'string' && url !== '' ? url : 'unmatched';
}

/** Records success AND error outcomes (ADR-008 §3). */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const route = routeLabel(request);
    // never count the scraper itself
    if (route === '/metrics') return next.handle();

    const start = process.hrtime.bigint();
    const record = (status: number): void => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.recordHttp(request.method ?? 'GET', route, status, seconds);
    };

    return next.handle().pipe(
      tap({
        next: () => {
          const reply = http.getResponse<{ statusCode?: number }>();
          record(reply.statusCode ?? 200);
        },
        error: (err: unknown) => record(statusOfError(err)),
      }),
    );
  }
}

function statusOfError(err: unknown): number {
  if (err instanceof AppException || err instanceof HttpException) {
    return err.getStatus();
  }
  return 500;
}

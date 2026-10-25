import { ExecutionContext, HttpException } from '@nestjs/common';
import type { CallHandler } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { AppException } from '../common/errors';
import {
  MetricsInterceptor,
  MetricsService,
  routeLabel,
} from './metrics';

function fakeContext(
  request: Partial<FastifyRequest>,
  reply: { statusCode?: number } = {},
): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
}

const fakeHandler = (value: unknown = { ok: true }): CallHandler => ({
  handle: () => of(value),
});

describe('routeLabel (cardinality-safe templates)', () => {
  it('uses the fastify route template', () => {
    expect(
      routeLabel({ routeOptions: { url: '/v1/audit-events' } } as FastifyRequest),
    ).toBe('/v1/audit-events');
  });

  it('falls back to unmatched when no route matched', () => {
    expect(routeLabel({} as FastifyRequest)).toBe('unmatched');
    expect(routeLabel({ routeOptions: {} } as FastifyRequest)).toBe('unmatched');
  });
});

describe('MetricsService (ADR-008 §3)', () => {
  it('exposes http counters, duration histogram and process baselines', async () => {
    const service = new MetricsService();
    service.recordHttp('GET', '/health', 200, 0.004);
    const text = await service.metricsText();
    expect(text).toContain(
      'http_requests_total{method="GET",route="/health",status="200"} 1',
    );
    expect(text).toContain('http_request_duration_seconds_bucket');
    // prom-client default process metrics
    expect(text).toMatch(/process_[a-z_]+_total|process_resident_memory_bytes/);
    expect(text).toContain('nodejs_');
  });
});

describe('MetricsInterceptor (success + error paths)', () => {
  it('records successful requests with the reply status', async () => {
    const service = new MetricsService();
    const spy = vi.spyOn(service, 'recordHttp');
    const interceptor = new MetricsInterceptor(service);

    await lastValueFrom(
      interceptor.intercept(
        fakeContext({ method: 'POST', routeOptions: { url: '/v1/auth/login' } }, { statusCode: 201 }),
        fakeHandler(),
      ),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe('POST');
    expect(spy.mock.calls[0]![1]).toBe('/v1/auth/login');
    expect(spy.mock.calls[0]![2]).toBe(201);
    expect(spy.mock.calls[0]![3]).toBeGreaterThanOrEqual(0);
  });

  it('records AppException / HttpException statuses and 500 fallback', async () => {
    const service = new MetricsService();
    const spy = vi.spyOn(service, 'recordHttp');
    const interceptor = new MetricsInterceptor(service);
    const ctx = fakeContext({ method: 'GET', routeOptions: { url: '/x' } });

    await expect(
      lastValueFrom(
        interceptor.intercept(
          ctx,
          { handle: () => throwError(() => new AppException('permission_denied')) },
        ),
      ),
    ).rejects.toThrow();
    await expect(
      lastValueFrom(
        interceptor.intercept(
          ctx,
          { handle: () => throwError(() => new HttpException('bad', 429)) },
        ),
      ),
    ).rejects.toThrow();
    await expect(
      lastValueFrom(
        interceptor.intercept(
          ctx,
          { handle: () => throwError(() => new Error('boom')) },
        ),
      ),
    ).rejects.toThrow();

    const statuses = spy.mock.calls.map((c) => c[2]);
    expect(statuses).toEqual([403, 429, 500]);
  });

  it('never counts the scraper itself (/metrics)', async () => {
    const service = new MetricsService();
    const spy = vi.spyOn(service, 'recordHttp');
    const interceptor = new MetricsInterceptor(service);
    await lastValueFrom(
      interceptor.intercept(
        fakeContext({ method: 'GET', routeOptions: { url: '/metrics' } }),
        fakeHandler('prom text'),
      ),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes non-http contexts through untouched', async () => {
    const service = new MetricsService();
    const spy = vi.spyOn(service, 'recordHttp');
    const interceptor = new MetricsInterceptor(service);
    const ctx = { getType: () => 'rpc' } as unknown as ExecutionContext;
    await lastValueFrom(interceptor.intercept(ctx, fakeHandler()));
    expect(spy).not.toHaveBeenCalled();
  });
});

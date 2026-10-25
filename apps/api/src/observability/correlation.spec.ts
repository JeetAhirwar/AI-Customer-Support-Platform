import { describe, expect, it } from 'vitest';
import {
  correlationLogMixin,
  getCorrelationContext,
  getCorrelationId,
  runInCorrelation,
  sanitizeCorrelationId,
  setCorrelationContext,
} from './correlation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE = /^[A-Za-z0-9._:-]+$/;

describe('sanitizeCorrelationId (ADR-008 §2)', () => {
  it('accepts printable bounded ids and trims them', () => {
    expect(sanitizeCorrelationId('my-trace-42')).toBe('my-trace-42');
    expect(sanitizeCorrelationId('  corr_1.2:abc  ')).toBe('corr_1.2:abc');
    expect(sanitizeCorrelationId('A'.repeat(128))).toHaveLength(128);
  });

  it('mints a UUID for everything else (injection/oversize/non-string)', () => {
    expect(sanitizeCorrelationId(undefined)).toMatch(UUID);
    expect(sanitizeCorrelationId('')).toMatch(UUID);
    expect(sanitizeCorrelationId('   ')).toMatch(UUID);
    expect(sanitizeCorrelationId(['a', 'b'])).toMatch(UUID);
    expect(sanitizeCorrelationId({ evil: true })).toMatch(UUID);
    // CRLF / header injection attempts
    const injected = sanitizeCorrelationId('abc\r\nX-Injected: 1');
    expect(injected).toMatch(UUID);
    expect(injected).not.toContain('\n');
    // oversized junk
    expect(sanitizeCorrelationId('x'.repeat(129))).toMatch(UUID);
    // spaces/control chars are not printable-id material
    expect(sanitizeCorrelationId('has spaces here')).toMatch(UUID);
  });
});

describe('correlation context (async-local storage)', () => {
  it('exposes the id inside runInCorrelation and nothing outside', async () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(getCorrelationContext()).toBeUndefined();

    const seen = await runInCorrelation({ correlationId: 'req-1' }, async () => {
      expect(getCorrelationId()).toBe('req-1');
      // survives async hops (await inside the request)
      await new Promise((r) => setTimeout(r, 5));
      expect(getCorrelationId()).toBe('req-1');
      return getCorrelationId();
    });
    expect(seen).toBe('req-1');
    expect(getCorrelationId()).toBeUndefined();
  });

  it('setCorrelationContext enriches the store (guard) and no-ops outside', () => {
    runInCorrelation({ correlationId: 'req-2' }, () => {
      setCorrelationContext({ tenantId: 'tenant-x', userId: 'user-y' });
      expect(getCorrelationContext()).toEqual({
        correlationId: 'req-2',
        tenantId: 'tenant-x',
        userId: 'user-y',
      });
    });
    // outside a request: never throws, never leaks
    expect(() => setCorrelationContext({ tenantId: 'nope' })).not.toThrow();
    expect(getCorrelationContext()).toBeUndefined();
  });

  it('correlationLogMixin emits only known safe fields', () => {
    expect(correlationLogMixin()).toEqual({});
    runInCorrelation({ correlationId: 'req-3' }, () => {
      expect(correlationLogMixin()).toEqual({ correlation_id: 'req-3' });
      setCorrelationContext({ tenantId: 't', userId: 'u' });
      expect(correlationLogMixin()).toEqual({
        correlation_id: 'req-3',
        tenant_id: 't',
        user_id: 'u',
      });
    });
  });

  it('mixin values are always header-safe strings', () => {
    runInCorrelation({ correlationId: 'safe:1_2' }, () => {
      const mixin = correlationLogMixin();
      expect(String(mixin['correlation_id'])).toMatch(SAFE);
    });
  });
});

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Correlation context (ADR-008 §2): one id threads ingress → logs → error
 * envelope → audit rows → outbox events. The store is TELEMETRY ONLY — it is
 * never consulted for authorization (authz stays JWT + RLS, ADR-003).
 */
export interface CorrelationContext {
  correlationId: string;
  tenantId?: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/**
 * Accepts only printable, bounded ids (`[A-Za-z0-9._:-]{1,128}`) — anything
 * else (CRLF injection, oversized, arrays, non-strings) becomes a fresh UUID.
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:\-]{1,128}$/;

export function sanitizeCorrelationId(raw: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (SAFE_CORRELATION_ID.test(trimmed)) return trimmed;
  }
  return randomUUID();
}

export function runInCorrelation<T>(
  ctx: CorrelationContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export function getCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

/** Context id or undefined (callers fall back to the sanitized header/uuid). */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Merges verified identity into the request store (JWT guard) — enrichment
 * for logs only; no-op outside a request context.
 */
export function setCorrelationContext(fields: {
  tenantId?: string;
  userId?: string;
}): void {
  const store = storage.getStore();
  if (!store) return;
  if (fields.tenantId) store.tenantId = fields.tenantId;
  if (fields.userId) store.userId = fields.userId;
}

/** pino `mixin`: enriches EVERY log line inside a request (ADR-008 §2). */
export function correlationLogMixin(): Record<string, unknown> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  return {
    correlation_id: ctx.correlationId,
    ...(ctx.tenantId ? { tenant_id: ctx.tenantId } : {}),
    ...(ctx.userId ? { user_id: ctx.userId } : {}),
  };
}

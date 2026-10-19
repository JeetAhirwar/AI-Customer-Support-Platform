import { describe, expect, it, vi } from 'vitest';
import { AppException } from '../common/errors';
import { AuditController } from './audit.controller';
import type { AuditService } from './audit.service';

/**
 * Audit controller unit — query validation + response shape. Guard/role
 * behavior is pinned by rbac/roles.guard.spec.ts; end-to-end HTTP codes are
 * exercised by the live smoke script.
 */

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no-error';
  } catch (err) {
    return err instanceof AppException
      ? String((err.getResponse() as { code?: string }).code)
      : `unexpected:${err}`;
  }
}

describe('AuditController', () => {
  const list = vi.fn().mockResolvedValue({ events: [], nextCursor: null });
  const controller = new AuditController({ list } as unknown as AuditService);
  const req = { user: { sub: 'user-1', tid: 'tenant-1' } } as never;
  const anon = { user: { sub: 'user-1' } } as never;

  it('maps rows to the API shape (snake_case, ISO timestamps, next_cursor)', async () => {
    list.mockResolvedValueOnce({
      events: [
        {
          id: 'e1',
          actor_type: 'user',
          actor_id: 'u1',
          action: 'auth.login',
          target_type: 'session',
          target_id: 's1',
          outcome: 'success',
          correlation_id: null,
          metadata: { ip: '127.0.0.1' },
          occurred_at: new Date('2026-10-19T10:00:00.000Z'),
        },
      ],
      nextCursor: '2026-10-19T10:00:00.000Z|e1',
    });

    const res = await controller.list({}, req);
    expect(res.next_cursor).toBe('2026-10-19T10:00:00.000Z|e1');
    expect(res.events[0]).toMatchObject({
      id: 'e1',
      action: 'auth.login',
      outcome: 'success',
      occurred_at: '2026-10-19T10:00:00.000Z',
    });
    expect(list).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ limit: 50 }));
  });

  it('rejects a missing active tenant with permission_denied', async () => {
    expect(await codeOf(() => controller.list({}, anon))).toBe('permission_denied');
  });

  it('validates limit', async () => {
    expect(await codeOf(() => controller.list({ limit: '0' }, req))).toBe('validation_failed');
    expect(await codeOf(() => controller.list({ limit: '101' }, req))).toBe('validation_failed');
    expect(await codeOf(() => controller.list({ limit: 'abc' }, req))).toBe('validation_failed');
  });

  it('validates the cursor format', async () => {
    expect(
      await codeOf(() => controller.list({ cursor: 'offset=42' }, req)),
    ).toBe('validation_failed');
    expect(
      await codeOf(() =>
        controller.list(
          { cursor: '2026-10-19T10:00:00.000Z|not-a-uuid' },
          req,
        ),
      ),
    ).toBe('validation_failed');
  });

  it('validates enum + uuid + date filters', async () => {
    expect(
      await codeOf(() => controller.list({ outcome: 'maybe' }, req)),
    ).toBe('validation_failed');
    expect(
      await codeOf(() => controller.list({ actor_id: 'nope' }, req)),
    ).toBe('validation_failed');
    expect(
      await codeOf(() => controller.list({ from: 'yesterday' }, req)),
    ).toBe('validation_failed');
  });

  it('passes a valid cursor and filters through to the service', async () => {
    await controller.list(
      {
        cursor: '2026-10-19T10:00:00.000Z|11111111-1111-1111-1111-111111111111',
        action: 'auth.login',
        outcome: 'success',
        actor_id: '11111111-1111-1111-1111-111111111111',
        from: '2026-10-01T00:00:00.000Z',
        limit: '25',
      },
      req,
    );
    expect(list).toHaveBeenLastCalledWith(
      'tenant-1',
      expect.objectContaining({
        limit: 25,
        action: 'auth.login',
        outcome: 'success',
        actorId: '11111111-1111-1111-1111-111111111111',
        cursor: {
          occurredAt: new Date('2026-10-19T10:00:00.000Z'),
          id: '11111111-1111-1111-1111-111111111111',
        },
        from: new Date('2026-10-01T00:00:00.000Z'),
      }),
    );
  });
});

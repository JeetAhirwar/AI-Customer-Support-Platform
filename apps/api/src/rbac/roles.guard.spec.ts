import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AppException } from '../common/errors';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { RolesGuard } from './roles.guard';
import type { TenancyService } from '../tenancy/tenancy.service';

function ctxFor(opts: {
  required?: string[];
  permissions?: string[];
  user?: { sub?: string; tid?: string };
}): {
  guard: RolesGuard;
  context: ExecutionContext;
  request: Record<string, unknown>;
  resolveMembership: ReturnType<typeof vi.fn>;
} {
  const resolveMembership = vi.fn();
  const reflector = {
    // two decorators share one reflector: answer each key independently,
    // exactly as Nest's Reflector does with getAllAndOverride
    getAllAndOverride: vi.fn((key: string) =>
      key === PERMISSIONS_KEY ? opts.permissions : opts.required,
    ),
  } as unknown as Reflector;
  const tenancy = { resolveMembership } as unknown as TenancyService;
  const request: Record<string, unknown> = { user: opts.user };
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
  return { guard: new RolesGuard(reflector, tenancy), context, request, resolveMembership };
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no-error';
  } catch (err) {
    return err instanceof AppException
      ? String((err.getResponse() as { code?: string }).code)
      : `unexpected:${err}`;
  }
}

describe('RolesGuard', () => {
  it('passes when the route declares no roles', async () => {
    const { guard, context, resolveMembership } = ctxFor({ required: [] });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolveMembership).not.toHaveBeenCalled();
  });

  it('denies when the token has no tenant context', async () => {
    const { guard, context } = ctxFor({
      required: ['admin'],
      user: { sub: 'user-1' }, // no tid
    });
    expect(await asyncCodeOf(() => guard.canActivate(context))).toBe(
      'permission_denied',
    );
  });

  it('denies when the user has no membership in the token tenant (Gate A)', async () => {
    const { guard, context, resolveMembership } = ctxFor({
      required: ['admin'],
      user: { sub: 'user-a', tid: 'tenant-2' }, // cross-tenant probe
    });
    resolveMembership.mockResolvedValue(null);
    expect(await asyncCodeOf(() => guard.canActivate(context))).toBe(
      'permission_denied',
    );
  });

  it('allows an allowed role and attaches the membership', async () => {
    const { guard, context, request, resolveMembership } = ctxFor({
      required: ['admin', 'owner'],
      user: { sub: 'user-1', tid: 'tenant-1' },
    });
    resolveMembership.mockResolvedValue({
      membership_id: 'm-1',
      tenant_id: 'tenant-1',
      role: 'admin',
      permission_keys: ['cases.manage'],
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    const membership = request.membership as { role?: string };
    expect(membership.role).toBe('admin');
  });

  it('denies a role that is not in the allowed list', async () => {
    const { guard, context, resolveMembership } = ctxFor({
      required: ['owner'],
      user: { sub: 'user-1', tid: 'tenant-1' },
    });
    resolveMembership.mockResolvedValue({
      membership_id: 'm-1',
      tenant_id: 'tenant-1',
      role: 'agent',
      permission_keys: ['cases.view'],
    });
    expect(await asyncCodeOf(() => guard.canActivate(context))).toBe(
      'permission_denied',
    );
  });

  it('allows a permissions-only route and still attaches the membership', async () => {
    const { guard, context, request, resolveMembership } = ctxFor({
      permissions: ['cases.view'],
      user: { sub: 'user-1', tid: 'tenant-1' },
    });
    resolveMembership.mockResolvedValue({
      membership_id: 'm-1',
      tenant_id: 'tenant-1',
      role: 'viewer',
      permission_keys: ['cases.view'],
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    const membership = request.membership as { permission_keys?: string[] };
    expect(membership.permission_keys).toEqual(['cases.view']);
  });

  it('default-denies a permission key the role does not hold', async () => {
    const { guard, context, resolveMembership } = ctxFor({
      permissions: ['cases.reply'],
      user: { sub: 'user-1', tid: 'tenant-1' },
    });
    resolveMembership.mockResolvedValue({
      membership_id: 'm-1',
      tenant_id: 'tenant-1',
      role: 'viewer', // viewer = read-only in the seeded catalog
      permission_keys: ['cases.view'],
    });
    expect(await asyncCodeOf(() => guard.canActivate(context))).toBe(
      'permission_denied',
    );
  });

  it('requires EVERY declared permission (AND semantics)', async () => {
    const membership = {
      membership_id: 'm-1',
      tenant_id: 'tenant-1',
      role: 'agent',
      permission_keys: ['cases.view'],
    };
    const both = {
      required: ['agent'],
      permissions: ['cases.view', 'cases.reply'],
      user: { sub: 'user-1', tid: 'tenant-1' },
    };
    const partial = ctxFor(both);
    partial.resolveMembership.mockResolvedValue(membership);
    expect(await asyncCodeOf(() => partial.guard.canActivate(partial.context))).toBe(
      'permission_denied',
    );

    const full = ctxFor(both);
    full.resolveMembership.mockResolvedValue({
      ...membership,
      permission_keys: ['cases.view', 'cases.reply'],
    });
    await expect(full.guard.canActivate(full.context)).resolves.toBe(true);
  });

  it('checks the role first when both decorators are present', async () => {
    const { guard, context, resolveMembership } = ctxFor({
      required: ['owner'],
      permissions: ['cases.reply'],
      user: { sub: 'user-1', tid: 'tenant-1' },
    });
    resolveMembership.mockResolvedValue({
      membership_id: 'm-1',
      tenant_id: 'tenant-1',
      role: 'agent', // right permission, wrong role
      permission_keys: ['cases.reply'],
    });
    expect(await asyncCodeOf(() => guard.canActivate(context))).toBe(
      'permission_denied',
    );
    expect(resolveMembership).toHaveBeenCalledTimes(1);
  });

  it('skips membership resolution when neither decorator is present', async () => {
    const { guard, context, resolveMembership } = ctxFor({
      required: [],
      permissions: [],
      user: { sub: 'user-1', tid: 'tenant-1' },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolveMembership).not.toHaveBeenCalled();
  });
});

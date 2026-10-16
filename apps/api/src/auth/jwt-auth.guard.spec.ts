import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppException } from '../common/errors';
import { resetConfigCache } from '../config/env';
import { JwtAuthGuard } from './jwt-auth.guard';
import { signAccessToken } from './tokens';

const ENV_BACKUP: Record<string, string | undefined> = {};

function ctxFor(opts: {
  isPublic?: boolean;
  authorization?: string;
}): { guard: JwtAuthGuard; context: ExecutionContext; request: Record<string, unknown> } {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(opts.isPublic ?? false),
  } as unknown as Reflector;
  const request: Record<string, unknown> = {
    headers: opts.authorization !== undefined ? { authorization: opts.authorization } : {},
  };
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
  return { guard: new JwtAuthGuard(reflector), context, request };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'no-error';
  } catch (err) {
    return err instanceof AppException
      ? String((err.getResponse() as { code?: string }).code)
      : `unexpected:${err}`;
  }
}

beforeEach(() => {
  for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_ACCESS_TTL', 'JWT_REFRESH_TTL']) {
    ENV_BACKUP[k] = process.env[k];
  }
  process.env.JWT_ACCESS_SECRET = 'guard-test-access-secret-0123456789';
  process.env.JWT_REFRESH_SECRET = 'guard-test-refresh-secret-0123456789';
  process.env.JWT_ACCESS_TTL = '900';
  process.env.JWT_REFRESH_TTL = '30d';
  resetConfigCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(ENV_BACKUP)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
});

describe('JwtAuthGuard', () => {
  it('skips authentication on @Public routes', () => {
    const { guard, context } = ctxFor({ isPublic: true });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a missing Authorization header (unauthorized)', () => {
    const { guard, context } = ctxFor({});
    expect(codeOf(() => guard.canActivate(context))).toBe('unauthorized');
  });

  it('rejects a wrong scheme', () => {
    const { guard, context } = ctxFor({ authorization: 'Basic dXNlcjpwYXNz' });
    expect(codeOf(() => guard.canActivate(context))).toBe('unauthorized');
  });

  it('accepts a valid Bearer token and attaches verified claims', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@example.test' });
    const { guard, context, request } = ctxFor({ authorization: `Bearer ${token}` });
    expect(guard.canActivate(context)).toBe(true);
    expect((request.user as { sub?: string }).sub).toBe('user-1');
  });

  it('passes through tid/role claims for downstream guards', () => {
    const token = signAccessToken({
      sub: 'user-1',
      email: 'a@example.test',
      tid: 'tenant-1',
      role: 'admin',
    });
    const { guard, context, request } = ctxFor({ authorization: `Bearer ${token}` });
    guard.canActivate(context);
    const user = request.user as { tid?: string; role?: string };
    expect(user.tid).toBe('tenant-1');
    expect(user.role).toBe('admin');
  });

  it('rejects a tampered token (unauthorized)', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@example.test' });
    const { guard, context } = ctxFor({
      authorization: `Bearer ${token.slice(0, -3)}aaa`,
    });
    expect(codeOf(() => guard.canActivate(context))).toBe('unauthorized');
  });
});

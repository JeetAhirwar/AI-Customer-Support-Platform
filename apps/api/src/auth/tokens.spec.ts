import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache } from '../config/env';
import {
  hashRefreshToken,
  mintRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './tokens';

const ENV_BACKUP: Record<string, string | undefined> = {};
const KEYS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_TTL',
  'JWT_REFRESH_TTL',
] as const;

beforeEach(() => {
  for (const k of KEYS) ENV_BACKUP[k] = process.env[k];
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdef';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef';
  process.env.JWT_ACCESS_TTL = '900';
  process.env.JWT_REFRESH_TTL = '30d';
  resetConfigCache();
});

afterEach(() => {
  for (const k of KEYS) {
    if (ENV_BACKUP[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_BACKUP[k];
  }
  resetConfigCache();
  vi.useRealTimers();
});

describe('access tokens (JWT HS256)', () => {
  it('signs and verifies a round trip', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@example.test' });
    expect(verifyAccessToken(token)).toEqual({
      sub: 'user-1',
      email: 'a@example.test',
    });
  });

  it('rejects a tampered token', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@example.test' });
    const tampered = `${token.slice(0, -2)}xx`;
    expect(() => verifyAccessToken(tampered)).toThrow();
  });

  it('rejects a token signed with the wrong secret', () => {
    const forged = jwt.sign(
      { sub: 'user-1', email: 'a@example.test', iss: 'aicsp-api' },
      'attacker-secret',
      { algorithm: 'HS256', expiresIn: 900 },
    );
    expect(() => verifyAccessToken(forged)).toThrow();
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const token = signAccessToken({ sub: 'user-1', email: 'a@example.test' });
    vi.advanceTimersByTime(901_000); // past JWT_ACCESS_TTL=900s
    expect(() => verifyAccessToken(token)).toThrow(/expired/i);
  });
});

describe('refresh tokens (opaque)', () => {
  it('mints a high-entropy token with a stable sha256 hash', () => {
    const a = mintRefreshToken();
    expect(a.token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(a.token)).toBe(a.hash);
    expect(a.token).not.toContain('+'); // url-safe
  });

  it('never mints duplicates', () => {
    const a = mintRefreshToken();
    const b = mintRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});

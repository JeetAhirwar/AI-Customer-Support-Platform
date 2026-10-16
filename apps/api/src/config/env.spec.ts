import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, parseTtlToSeconds, resetConfigCache } from './env';

const KEYS = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_TTL',
  'JWT_REFRESH_TTL',
] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  resetConfigCache();
});

describe('parseTtlToSeconds', () => {
  it('parses units', () => {
    expect(parseTtlToSeconds('900')).toBe(900);
    expect(parseTtlToSeconds('15m')).toBe(900);
    expect(parseTtlToSeconds('12h')).toBe(43_200);
    expect(parseTtlToSeconds('30d')).toBe(2_592_000);
  });

  it('rejects malformed input', () => {
    expect(() => parseTtlToSeconds('15 min')).toThrow();
    expect(() => parseTtlToSeconds('-5')).toThrow();
    expect(() => parseTtlToSeconds('')).toThrow();
  });
});

describe('loadConfig (fail-fast contract)', () => {
  it('throws listing missing variable NAMES only — never values', () => {
    for (const k of KEYS) delete process.env[k];
    // point at nothing so repo .env cannot satisfy the check
    process.env.DATABASE_URL = '';
    const attempt = (): unknown => loadConfig({} as NodeJS.ProcessEnv);
    expect(attempt).toThrow(/DATABASE_URL/);
    try {
      attempt();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).toContain('JWT_REFRESH_TTL');
      expect(message).not.toContain('postgres://'); // no values leaked
    }
  });

  it('parses a complete environment into typed config', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://example/test',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL: '30d',
      API_PORT: '4000',
    } as NodeJS.ProcessEnv);
    expect(cfg.jwtAccessTtlSec).toBe(900);
    expect(cfg.jwtRefreshTtlSec).toBe(2_592_000);
    expect(cfg.apiPort).toBe(4000);
  });
});

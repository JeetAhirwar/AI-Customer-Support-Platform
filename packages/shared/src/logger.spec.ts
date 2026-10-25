import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import {
  REDACT_PATHS,
  buildPinoOptions,
  resolveLogLevel,
} from './logger';

function capture(options: Parameters<typeof buildPinoOptions>[0]): {
  /** parses the captured chunks on each call — lazily, after the log line */
  lines: () => Record<string, unknown>[];
  logger: pino.Logger;
} {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(String(chunk));
      cb();
    },
  });
  const logger = pino(buildPinoOptions(options), sink);
  const lines = (): Record<string, unknown>[] =>
    chunks
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { lines, logger };
}

describe('resolveLogLevel (fail-fast contract)', () => {
  it('defaults to info and accepts case-insensitive valid levels', () => {
    expect(resolveLogLevel(undefined)).toBe('info');
    expect(resolveLogLevel('')).toBe('info');
    expect(resolveLogLevel('DEBUG')).toBe('debug');
    expect(resolveLogLevel(' silent ')).toBe('silent');
  });

  it('rejects invalid values naming LOG_LEVEL only — never the value', () => {
    expect(() => resolveLogLevel('loud')).toThrow(/LOG_LEVEL/);
    expect(() => resolveLogLevel('loud')).not.toThrow(/loud/);
    expect(() => resolveLogLevel('verbose')).toThrow(/expected one of/);
  });
});

describe('buildPinoOptions (ADR-008 §1)', () => {
  it('sets level, service base and ISO timestamps', async () => {
    const { lines, logger } = capture({ level: 'warn', service: 'api' });
    logger.info('hidden at warn level');
    logger.warn('visible');
    const out = lines();
    expect(out).toHaveLength(1);
    // pino numeric levels: warn = 40
    expect(out[0]).toMatchObject({ level: 40, service: 'api', msg: 'visible' });
    expect(String(out[0]!['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T/); // isoTime
  });

  it('redacts credentials, auth headers and cookies (SECURITY §7)', async () => {
    const { lines, logger } = capture({ level: 'info', service: 'api' });
    logger.info(
      {
        password: 'topsecret1',
        user: { password: 'nestedsecret2' },
        password_hash: '$argon2id$whatever',
        authorization: 'Bearer abc.def.ghi',
        cookie: 'refresh=xyz',
        req: { headers: { authorization: 'Bearer leak', cookie: 'a=b' } },
        access_token: 'leak-token',
        api_key: 'leak-key',
        detail: 'login attempt',
      },
      'login',
    );
    const text = JSON.stringify(lines());
    expect(text).not.toContain('topsecret1');
    expect(text).not.toContain('nestedsecret2');
    expect(text).not.toContain('argon2id$whatever');
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('refresh=xyz');
    expect(text).not.toContain('Bearer leak');
    expect(text).not.toContain('a=b');
    expect(text).not.toContain('leak-token');
    expect(text).not.toContain('leak-key');
    expect(text).toContain('[redacted]');
    expect(text).toContain('login attempt');
  });

  it('exposes a stable redaction path list', () => {
    expect(REDACT_PATHS).toContain('password');
    expect(REDACT_PATHS).toContain('req.headers.authorization');
  });

  it('applies the mixin enrichment', async () => {
    const { lines, logger } = capture({
      level: 'info',
      service: 'api',
      mixin: () => ({ correlation_id: 'corr-7', tenant_id: 't-1' }),
    });
    logger.info('line');
    expect(lines()[0]).toMatchObject({
      correlation_id: 'corr-7',
      tenant_id: 't-1',
    });
  });
});

import * as fs from 'fs';
import * as path from 'path';

/**
 * Startup configuration (contract: Documentation/ENVIRONMENT_VARIABLES.md).
 * Fail-fast validation lists missing variable NAMES only — never values.
 */

export interface AppConfig {
  nodeEnv: string;
  apiPort: number;
  apiHost: string;
  databaseUrl: string;
  databasePoolMax: number;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessTtlSec: number;
  jwtRefreshTtlSec: number;
}

/** Names required for the auth/DB slice of Phase 2. */
const REQUIRED_NAMES = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_TTL',
  'JWT_REFRESH_TTL',
] as const;

/** Loads repo-root .env into a process env (local dev convenience; real envs win). */
export function loadDotEnvInto(env: NodeJS.ProcessEnv = process.env): void {
  const envPath = path.resolve(__dirname, '../../../../.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

/** Parses TTLs like `900`, `15m`, `12h`, `30d` into seconds. */
export function parseTtlToSeconds(raw: string): number {
  const match = /^(\d+)([smhd])?$/.exec(raw.trim());
  if (!match) throw new Error(`invalid TTL format: expected e.g. 900, 15m, 12h, 30d`);
  const value = Number(match[1]);
  switch (match[2]) {
    case 'm':
      return value * 60;
    case 'h':
      return value * 3600;
    case 'd':
      return value * 86400;
    case 's':
    case undefined:
      return value;
    default:
      throw new Error('invalid TTL unit');
  }
}

/** Validates env and returns typed config. Throws listing missing NAMES only. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isMissing = (name: string): boolean => !env[name] || env[name]!.trim() === '';
  // local dev convenience: fill the real process env from repo-root .env
  // (injected test envs stay authoritative — no file magic)
  if (env === process.env && REQUIRED_NAMES.some(isMissing)) loadDotEnvInto(env);

  const missing = REQUIRED_NAMES.filter(isMissing);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    apiPort: Number(env.API_PORT ?? 3000),
    apiHost: env.API_HOST ?? '127.0.0.1',
    databaseUrl: env.DATABASE_URL!,
    databasePoolMax:
      Number.isFinite(Number(env.DATABASE_POOL_MAX)) && env.DATABASE_POOL_MAX
        ? Number(env.DATABASE_POOL_MAX)
        : 10,
    jwtAccessSecret: env.JWT_ACCESS_SECRET!,
    jwtRefreshSecret: env.JWT_REFRESH_SECRET!,
    jwtAccessTtlSec: parseTtlToSeconds(env.JWT_ACCESS_TTL!),
    jwtRefreshTtlSec: parseTtlToSeconds(env.JWT_REFRESH_TTL!),
  };
}

let cached: AppConfig | null = null;

/** Memoized config accessor (lazy — import-time has no side effects). */
export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test hook: clear memoized config after mutating env. */
export function resetConfigCache(): void {
  cached = null;
}

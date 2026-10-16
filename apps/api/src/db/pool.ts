import { Pool } from 'pg';
import { getConfig } from '../config/env';

let pool: Pool | null = null;

/** Memoized pg pool (lazy — unit tests never touch it). */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getConfig().databaseUrl,
      max: getConfig().databasePoolMax,
    });
  }
  return pool;
}

/** Test/ shutdown hook. */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

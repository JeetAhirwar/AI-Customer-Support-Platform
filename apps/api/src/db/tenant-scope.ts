import type { PoolClient } from 'pg';
import { getPool } from './pool';

export type ScopeKind = 'tenant' | 'user';
export type ScopeClient = PoolClient;

const SCOPE_GUC: Record<ScopeKind, string> = {
  tenant: 'app.tenant_id',
  user: 'app.user_id',
};

/**
 * Runs `fn` on one connection inside a transaction whose row-level-security
 * scope is set via `set_config(..., true)` (transaction-local — GUC never
 * leaks to the next query on the pooled connection).
 *
 * Every query against an RLS-enabled table (see migrations/004_rls.js) MUST go
 * through withTenant()/withUser(); outside a scope those tables read empty and
 * writes are rejected (fail-closed, never fail-open).
 *
 * Values are passed as bind parameters — no string interpolation. Callers pass
 * uuids that came from the DB or from a verified JWT claim; a malformed value
 * can only cause a uuid-cast error at query time, never a policy bypass.
 */
async function withScope<T>(
  kind: ScopeKind,
  value: string,
  fn: (client: ScopeClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config($1, $2, true)`, [SCOPE_GUC[kind], value]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Tenant-scoped transaction (business data + memberships). */
export function withTenant<T>(
  tenantId: string,
  fn: (client: ScopeClient) => Promise<T>,
): Promise<T> {
  return withScope('tenant', tenantId, fn);
}

/**
 * User-scoped transaction — for the login workspace picker, where the acting
 * tenant is not known yet (memberships visible via own user_id predicate).
 */
export function withUser<T>(
  userId: string,
  fn: (client: ScopeClient) => Promise<T>,
): Promise<T> {
  return withScope('user', userId, fn);
}

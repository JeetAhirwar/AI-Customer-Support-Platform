import { Injectable } from '@nestjs/common';
import { getPool } from '../db/pool';
import { withTenant, withUser } from '../db/tenant-scope';
import {
  DEFAULT_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  type DefaultRole,
} from '../rbac/permissions';

export interface MembershipSummary {
  membership_id: string;
  tenant_id: string;
  tenant_name: string;
  role: string;
  status: string;
}

export interface MembershipDetail extends MembershipSummary {
  permission_keys: string[];
  team_id: string | null;
}

/**
 * Tenancy service — SECURITY.md §1: tenant context is resolved server-side
 * from authenticated memberships, never from client-supplied authority.
 * RLS (ADR-003): tenant_memberships is policy-protected, so reads go through
 * withTenant/withUser scopes; roles/role_permissions are authz metadata
 * (no RLS) and are only ever queried with explicit tenant predicates.
 */
@Injectable()
export class TenancyService {
  /** Idempotent: seeds the four platform roles (+permission rows) for a tenant. */
  async ensureDefaultRoles(tenantId: string): Promise<void> {
    const pool = getPool();
    for (const role of DEFAULT_ROLES) {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO roles (tenant_id, name) VALUES ($1, $2)
         ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [tenantId, role],
      );
      const roleId = res.rows[0]!.id;
      for (const permission of DEFAULT_ROLE_PERMISSIONS[role as DefaultRole]) {
        await pool.query(
          `INSERT INTO role_permissions (role_id, permission_key)
           VALUES ($1, $2) ON CONFLICT (role_id, permission_key) DO NOTHING`,
          [roleId, permission],
        );
      }
    }
  }

  /** Active memberships of a user (for the workspace picker / login response). */
  async membershipsForUser(userId: string): Promise<MembershipSummary[]> {
    const res = await withUser(userId, (client) =>
      client.query<MembershipSummary>(
        `SELECT m.id AS membership_id, m.tenant_id, t.name AS tenant_name,
                r.name AS role, m.status
           FROM tenant_memberships m
           JOIN tenants t ON t.id = m.tenant_id
           JOIN roles r ON r.id = m.role_id
          WHERE m.user_id = $1 AND m.status = 'active'
          ORDER BY m.created_at ASC, m.id ASC`,
        [userId],
      ),
    );
    return res.rows;
  }

  /**
   * Membership of (user, tenant) with permission keys, or null.
   * Single source of truth for authorization decisions (RolesGuard).
   */
  async resolveMembership(
    userId: string,
    tenantId: string,
  ): Promise<MembershipDetail | null> {
    const res = await withTenant(tenantId, async (client) => {
      const membershipRes = await client.query<MembershipDetail>(
        `SELECT m.id AS membership_id, m.tenant_id, t.name AS tenant_name,
                r.name AS role, m.status, m.team_id
           FROM tenant_memberships m
           JOIN tenants t ON t.id = m.tenant_id
           JOIN roles r ON r.id = m.role_id
          WHERE m.user_id = $1 AND m.tenant_id = $2`,
        [userId, tenantId],
      );
      const membership = membershipRes.rows[0];
      if (!membership || membership.status !== 'active') return null;

      const permissions = await client.query<{ permission_key: string }>(
        `SELECT rp.permission_key
           FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
          WHERE r.tenant_id = $1 AND r.name = $2`,
        [tenantId, membership.role],
      );
      return {
        ...membership,
        permission_keys: permissions.rows.map((row) => row.permission_key),
      };
    });
    return res;
  }
}

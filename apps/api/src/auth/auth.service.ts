import { randomUUID } from 'crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AuditService, type AuditEventInput } from '../audit/audit.service';
import { getConfig } from '../config/env';
import { getPool } from '../db/pool';
import { AppException } from '../common/errors';
import { TenancyService, type MembershipSummary } from '../tenancy/tenancy.service';
import { hashPassword, verifyPassword } from './password';
import {
  hashRefreshToken,
  mintRefreshToken,
  signAccessToken,
} from './tokens';

/**
 * Auth service — SECURITY.md §auth:
 *  - short-lived JWT access + rotating refresh tokens (reuse detection revokes
 *    the family)
 *  - generic errors that never reveal account existence
 *  - tenant context: the JWT `tid` claim is minted only after server-side
 *    membership verification; roles are display-only snapshots (authorization
 *    re-checks the DB so revocation is immediate)
 *  - access-sensitive events are audited (FR-018, SECURITY.md §8): login
 *    (success + failure), tenant switch (success + denial), logout, refresh
 *    reuse detection. Audit-write failures propagate — "audit-write failure
 *    fails the business transaction" (no silent gaps). Refresh rotation is
 *    normal hygiene and stays in the sessions table, not the audit trail.
 */

interface UserRow {
  id: string;
  email: string;
  status: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  refresh_family_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  active_tenant_id: string | null;
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
  user: { id: string; email: string; status: string };
  memberships: MembershipSummary[];
}

/** Constant dummy hash — verified against on unknown accounts so a failed
 *  lookup costs roughly the same time as a wrong password (anti-enumeration). */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('timing-equalizer');
  return dummyHashPromise;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function invalidCredentials(): UnauthorizedException {
  // one indistinguishable error for: unknown user, missing credential,
  // wrong password, disabled account, dead session
  return new UnauthorizedException('Invalid credentials');
}

/** request facts only — never message bodies (DATABASE_DESIGN §5) */
function metaMetadata(meta: RequestMeta): Record<string, unknown> {
  return { ip: meta.ip ?? null, userAgent: meta.userAgent ?? null };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly tenancy: TenancyService,
    private readonly audit: AuditService,
  ) {}

  async login(
    rawEmail: string,
    password: string,
    meta: RequestMeta,
  ): Promise<LoginResult> {
    const email = normalizeEmail(rawEmail);
    const pool = getPool();

    const userRes = await pool.query<UserRow>(
      `SELECT id, email, status FROM users WHERE email = $1`,
      [email],
    );
    const user = userRes.rows[0];

    if (!user) {
      await verifyPassword(await getDummyHash(), password); // equalize timing
      await this.auditLoginFailure(null, meta, 'unknown_account');
      throw invalidCredentials();
    }

    const credRes = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM credentials WHERE user_id = $1`,
      [user.id],
    );
    const credential = credRes.rows[0];
    if (!credential) {
      await verifyPassword(await getDummyHash(), password);
      await this.auditLoginFailure(user, meta, 'invalid_credentials');
      throw invalidCredentials();
    }

    const passwordOk = await verifyPassword(credential.password_hash, password);
    if (!passwordOk) {
      await this.auditLoginFailure(user, meta, 'invalid_credentials');
      throw invalidCredentials();
    }
    if (user.status !== 'active') {
      await this.auditLoginFailure(user, meta, 'account_inactive');
      throw invalidCredentials();
    }

    const memberships = await this.tenancy.membershipsForUser(user.id);
    const active = memberships[0];

    const familyId = randomUUID();
    const session = await this.createSession(
      user.id,
      familyId,
      meta,
      active?.tenant_id ?? null,
    );

    const cfg = getConfig();
    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      tid: active?.tenant_id,
      role: active?.role,
    });

    if (active) {
      await this.audit.record({
        tenantId: active.tenant_id,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.login',
        targetType: 'session',
        targetId: session.id,
        outcome: 'success',
        metadata: metaMetadata(meta),
      });
    } else {
      // documented edge: no membership → no tenant to anchor the event to
      // (the audit store is tenant-scoped by spec) — structured log only
      this.logger.warn(
        `login ok but no memberships user=${user.id} — audit skipped`,
      );
    }

    this.logger.log(`login ok user=${user.id} tenant=${active?.tenant_id ?? '-'}`);

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: cfg.jwtAccessTtlSec,
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.refreshExpiresAt.toISOString(),
      user: { id: user.id, email: user.email, status: user.status },
      memberships,
    };
  }

  /**
   * Rotating refresh: presenting a valid token revokes it and issues a new one
   * in the same family. Presenting an ALREADY-REVOKED token means the token
   * leaked → the entire family is revoked (SECURITY.md reuse detection).
   * The active tenant is kept if the membership is still active, else the
   * default (first) active membership is re-derived.
   */
  async refresh(rawToken: string, meta: RequestMeta): Promise<LoginResult> {
    const { session, user } = await this.consumeSession(rawToken, meta);

    const kept = session.active_tenant_id
      ? await this.tenancy.resolveMembership(user.id, session.active_tenant_id)
      : null;

    let activeTid = kept ? session.active_tenant_id! : undefined;
    let role = kept ? kept.role : undefined;
    if (!kept) {
      const memberships = await this.tenancy.membershipsForUser(user.id);
      activeTid = memberships[0]?.tenant_id;
      role = memberships[0]?.role;
    }

    const next = await this.createSession(
      user.id,
      session.refresh_family_id,
      meta,
      activeTid ?? null,
    );

    const cfg = getConfig();
    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      tid: activeTid,
      role,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: cfg.jwtAccessTtlSec,
      refreshToken: next.refreshToken,
      refreshExpiresAt: next.refreshExpiresAt.toISOString(),
      user: { id: user.id, email: user.email, status: user.status },
      memberships: await this.tenancy.membershipsForUser(user.id),
    };
  }

  /**
   * Re-bind the session to another tenant AFTER server-side membership
   * verification (API_CONTRACTS §13 — authority never from headers/bodies).
   * Non-membership → generic permission_denied (no tenant-existence leak).
   */
  async switchTenant(
    rawToken: string,
    tenantId: string,
    meta: RequestMeta,
  ): Promise<LoginResult> {
    const { session, user } = await this.consumeSession(rawToken, meta);

    const membership = await this.tenancy.resolveMembership(user.id, tenantId);
    if (!membership) {
      // a denied cross-tenant probe is a security-relevant event (Gate-A
      // signal) — recorded under the CURRENT tenant anchor, then denied
      await this.auditSessionEvent(session.user_id, session.active_tenant_id, {
        action: 'tenant.switch',
        targetType: 'tenant',
        targetId: tenantId,
        outcome: 'denied',
        metadata: { ...metaMetadata(meta), attempted_tenant_id: tenantId },
      });
      throw new AppException('permission_denied', 'No access to this tenant');
    }

    const next = await this.createSession(
      user.id,
      session.refresh_family_id,
      meta,
      tenantId,
    );

    const cfg = getConfig();
    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      tid: tenantId,
      role: membership.role,
    });

    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId: user.id,
      action: 'tenant.switch',
      targetType: 'tenant',
      targetId: tenantId,
      outcome: 'success',
      metadata: {
        ...metaMetadata(meta),
        previous_tenant_id: session.active_tenant_id,
      },
    });

    this.logger.log(`switch-tenant ok user=${user.id} tenant=${tenantId}`);

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: cfg.jwtAccessTtlSec,
      refreshToken: next.refreshToken,
      refreshExpiresAt: next.refreshExpiresAt.toISOString(),
      user: { id: user.id, email: user.email, status: user.status },
      memberships: await this.tenancy.membershipsForUser(user.id),
    };
  }

  /**
   * Idempotent: revokes the session matching the token, always reports ok.
   * The logout itself is access-sensitive → audited under the session's
   * tenant anchor (unknown/dead tokens stay a silent no-op).
   */
  async logout(
    rawToken: string | undefined,
    meta: RequestMeta = {},
  ): Promise<{ ok: true }> {
    if (rawToken && rawToken.trim() !== '') {
      const tokenHash = hashRefreshToken(rawToken);
      const pool = getPool();
      const res = await pool.query<{
        id: string;
        user_id: string;
        active_tenant_id: string | null;
      }>(
        `SELECT id, user_id, active_tenant_id FROM sessions
          WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash],
      );
      const session = res.rows[0];
      if (session) {
        await pool.query(
          `UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout'
            WHERE id = $1 AND revoked_at IS NULL`,
          [session.id],
        );
        await this.auditSessionEvent(session.user_id, session.active_tenant_id, {
          action: 'auth.logout',
          targetType: 'session',
          targetId: session.id,
          outcome: 'success',
          metadata: metaMetadata(meta),
        });
      }
    }
    return { ok: true as const };
  }

  /** Shared refresh/switch prelude: validates the presented refresh session. */
  private async consumeSession(
    rawToken: string,
    meta: RequestMeta,
  ): Promise<{ session: SessionRow; user: UserRow }> {
    const pool = getPool();
    const tokenHash = hashRefreshToken(rawToken);

    const res = await pool.query<SessionRow>(
      `SELECT id, user_id, refresh_family_id, token_hash, expires_at,
              revoked_at, active_tenant_id
         FROM sessions WHERE token_hash = $1`,
      [tokenHash],
    );
    const session = res.rows[0];
    if (!session) throw invalidCredentials();

    if (session.revoked_at) {
      this.logger.warn(
        `refresh reuse detected — revoking family=${session.refresh_family_id}`,
      );
      await pool.query(
        `UPDATE sessions
            SET revoked_at = now(), revoke_reason = 'reuse_detected'
          WHERE refresh_family_id = $1 AND revoked_at IS NULL`,
        [session.refresh_family_id],
      );
      // a reuse detection is a leaked-token signal — audited before failing
      await this.auditSessionEvent(session.user_id, session.active_tenant_id, {
        action: 'auth.refresh_reuse',
        targetType: 'session',
        targetId: session.id,
        outcome: 'failure',
        metadata: {
          ...metaMetadata(meta),
          refresh_family_id: session.refresh_family_id,
        },
      });
      throw invalidCredentials();
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw invalidCredentials();
    }

    const userRes = await pool.query<UserRow>(
      `SELECT id, email, status FROM users WHERE id = $1`,
      [session.user_id],
    );
    const user = userRes.rows[0];
    if (!user || user.status !== 'active') throw invalidCredentials();

    // rotate: revoke the presented session (new one is minted by the caller)
    await pool.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = 'rotated'
        WHERE id = $1 AND revoked_at IS NULL`,
      [session.id],
    );

    return { session, user };
  }

  private async createSession(
    userId: string,
    familyId: string,
    meta: RequestMeta,
    activeTenantId: string | null,
  ): Promise<{ id: string; refreshToken: string; refreshExpiresAt: Date }> {
    const cfg = getConfig();
    const material = mintRefreshToken();
    const expiresAt = new Date(Date.now() + cfg.jwtRefreshTtlSec * 1000);
    const id = randomUUID();

    await getPool().query(
      `INSERT INTO sessions
         (id, user_id, refresh_family_id, token_hash, expires_at, meta,
          active_tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        userId,
        familyId,
        material.hash,
        expiresAt,
        JSON.stringify({ ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }),
        activeTenantId,
      ],
    );

    return { id, refreshToken: material.token, refreshExpiresAt: expiresAt };
  }

  /**
   * Failed-login audit (SECURITY.md §8 access-sensitive events). Unknown
   * accounts have no tenant anchor (the audit store is tenant-scoped by
   * spec) → structured log only; known accounts are recorded under their
   * default membership tenant. Write failures PROPAGATE (audit-write failure
   * fails the request — no silent gaps).
   */
  private async auditLoginFailure(
    user: UserRow | null,
    meta: RequestMeta,
    reason: 'unknown_account' | 'invalid_credentials' | 'account_inactive',
  ): Promise<void> {
    if (!user) {
      this.logger.warn(`login failed (unknown account) ip=${meta.ip ?? '-'}`);
      return;
    }
    const memberships = await this.tenancy.membershipsForUser(user.id);
    const tenantId = memberships[0]?.tenant_id;
    if (!tenantId) {
      this.logger.warn(
        `login failed user=${user.id} reason=${reason} — audit skipped (no membership)`,
      );
      return;
    }
    await this.audit.record({
      tenantId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      outcome: 'failure',
      metadata: { ...metaMetadata(meta), reason },
    });
  }

  /**
   * Records a session-scoped event under the session's active tenant,
   * falling back to the user's default membership; skips (log-only) when the
   * user has no tenant anchor at all — a structural edge, not a write gap.
   */
  private async auditSessionEvent(
    userId: string,
    activeTenantId: string | null,
    event: Omit<AuditEventInput, 'tenantId' | 'actorId' | 'actorType'>,
  ): Promise<void> {
    const tenantId =
      activeTenantId ??
      (await this.tenancy.membershipsForUser(userId))[0]?.tenant_id;
    if (!tenantId) {
      this.logger.warn(
        `audit skipped action=${event.action} user=${userId} (no tenant anchor)`,
      );
      return;
    }
    await this.audit.record({
      ...event,
      tenantId,
      actorId: userId,
      actorType: 'user',
    });
  }
}

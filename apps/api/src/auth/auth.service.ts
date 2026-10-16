import { randomUUID } from 'crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { getConfig } from '../config/env';
import { getPool } from '../db/pool';
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

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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
      throw invalidCredentials();
    }

    const credRes = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM credentials WHERE user_id = $1`,
      [user.id],
    );
    const credential = credRes.rows[0];
    if (!credential) {
      await verifyPassword(await getDummyHash(), password);
      throw invalidCredentials();
    }

    const passwordOk = await verifyPassword(credential.password_hash, password);
    if (!passwordOk || user.status !== 'active') {
      throw invalidCredentials();
    }

    const familyId = randomUUID();
    const session = await this.createSession(user.id, familyId, meta);

    const cfg = getConfig();
    const accessToken = signAccessToken({ sub: user.id, email: user.email });

    this.logger.log(`login ok user=${user.id}`);

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: cfg.jwtAccessTtlSec,
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.refreshExpiresAt.toISOString(),
      user: { id: user.id, email: user.email, status: user.status },
    };
  }

  /**
   * Rotating refresh: presenting a valid token revokes it and issues a new one
   * in the same family. Presenting an ALREADY-REVOKED token means the token
   * leaked → the entire family is revoked (SECURITY.md reuse detection).
   */
  async refresh(rawToken: string, meta: RequestMeta): Promise<LoginResult> {
    const pool = getPool();
    const tokenHash = hashRefreshToken(rawToken);

    const res = await pool.query<SessionRow>(
      `SELECT id, user_id, refresh_family_id, token_hash, expires_at, revoked_at
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

    // rotate: revoke the presented session, mint a new one in the same family
    await pool.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = 'rotated'
        WHERE id = $1 AND revoked_at IS NULL`,
      [session.id],
    );
    const next = await this.createSession(
      user.id,
      session.refresh_family_id,
      meta,
    );

    const cfg = getConfig();
    const accessToken = signAccessToken({ sub: user.id, email: user.email });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: cfg.jwtAccessTtlSec,
      refreshToken: next.refreshToken,
      refreshExpiresAt: next.refreshExpiresAt.toISOString(),
      user: { id: user.id, email: user.email, status: user.status },
    };
  }

  /** Idempotent: revokes the session matching the token, always reports ok. */
  async logout(rawToken: string | undefined): Promise<{ ok: true }> {
    if (rawToken && rawToken.trim() !== '') {
      const tokenHash = hashRefreshToken(rawToken);
      await getPool().query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout'
          WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash],
      );
    }
    return { ok: true as const };
  }

  private async createSession(
    userId: string,
    familyId: string,
    meta: RequestMeta,
  ): Promise<{ refreshToken: string; refreshExpiresAt: Date }> {
    const cfg = getConfig();
    const material = mintRefreshToken();
    const expiresAt = new Date(Date.now() + cfg.jwtRefreshTtlSec * 1000);

    await getPool().query(
      `INSERT INTO sessions
         (id, user_id, refresh_family_id, token_hash, expires_at, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        userId,
        familyId,
        material.hash,
        expiresAt,
        JSON.stringify({ ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }),
      ],
    );

    return { refreshToken: material.token, refreshExpiresAt: expiresAt };
  }
}

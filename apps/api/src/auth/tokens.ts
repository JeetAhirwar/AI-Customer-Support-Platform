import { createHash, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { getConfig } from '../config/env';

export interface AccessTokenClaims {
  sub: string;
  email: string;
}

function issuer(): string {
  return 'aicsp-api';
}

/** Signs a short-lived HS256 access token (TTL from JWT_ACCESS_TTL). */
export function signAccessToken(claims: AccessTokenClaims): string {
  const cfg = getConfig();
  return jwt.sign(claims, cfg.jwtAccessSecret, {
    algorithm: 'HS256',
    expiresIn: cfg.jwtAccessTtlSec,
    issuer: issuer(),
  });
}

/** Verifies signature, expiry and issuer. Throws on any failure. */
export function verifyAccessToken(token: string): AccessTokenClaims {
  const cfg = getConfig();
  const decoded = jwt.verify(token, cfg.jwtAccessSecret, {
    algorithms: ['HS256'],
    issuer: issuer(),
  });
  if (typeof decoded === 'string' || !decoded.sub || !decoded.email) {
    throw new Error('invalid access token payload');
  }
  return { sub: decoded.sub, email: String(decoded.email) };
}

/** Opaque 256-bit refresh token + its storage hash (raw token never persisted). */
export interface RefreshTokenMaterial {
  token: string;
  hash: string;
}

export function mintRefreshToken(): RefreshTokenMaterial {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

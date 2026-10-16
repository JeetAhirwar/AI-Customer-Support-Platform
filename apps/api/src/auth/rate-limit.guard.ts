import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  LOGIN_RATE_LIMITS,
  SlidingWindowLimiter,
  type LimitDecision,
} from './rate-limit';

interface BodyWithEmail {
  email?: unknown;
}

/**
 * Login rate limit: per IP + per account (SECURITY.md §auth).
 * 429 carries Retry-After (API_CONTRACTS conventions).
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private readonly ipLimiter = new SlidingWindowLimiter(
    LOGIN_RATE_LIMITS.perIp,
    LOGIN_RATE_LIMITS.windowMs,
  );
  private readonly accountLimiter = new SlidingWindowLimiter(
    LOGIN_RATE_LIMITS.perAccount,
    LOGIN_RATE_LIMITS.windowMs,
  );

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest & { body?: BodyWithEmail }>();
    const now = Date.now();

    const ip = request.ip ?? 'unknown';
    const ipResult = this.ipLimiter.check(ip, now);

    const rawEmail = request.body?.email;
    const emailKey =
      typeof rawEmail === 'string' && rawEmail.trim() !== ''
        ? `acct:${rawEmail.trim().toLowerCase()}`
        : null;
    const accountResult: LimitDecision = emailKey
      ? this.accountLimiter.check(emailKey, now)
      : { allowed: true, retryAfterSec: 0 };

    if (ipResult.allowed && accountResult.allowed) return true;

    const retryAfterSec = Math.max(
      ipResult.retryAfterSec,
      accountResult.retryAfterSec,
    );
    const reply = http.getResponse<FastifyReply>();
    if (typeof reply.header === 'function') {
      reply.header('Retry-After', String(retryAfterSec));
    } else {
      // defensive fallback for non-fastify reply shapes (tests/adapters)
      const loose = reply as unknown as {
        setHeader?: (k: string, v: string) => void;
      };
      if (typeof loose.setHeader === 'function') {
        loose.setHeader('Retry-After', String(retryAfterSec));
      }
    }
    throw new HttpException(
      { statusCode: 429, error: 'Too Many Requests', message: 'Too many requests' },
      429,
    );
  }

  /** test hook */
  reset(): void {
    this.ipLimiter.reset();
    this.accountLimiter.reset();
  }
}

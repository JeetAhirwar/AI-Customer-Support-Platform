import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppException } from '../common/errors';
import { PUBLIC_KEY } from '../common/public.decorator';
import { verifyAccessToken, type AccessTokenClaims } from '../auth/tokens';

/**
 * Global authentication guard: every route requires a valid Bearer JWT unless
 * explicitly marked @Public(). Attaches verified claims to `request.user`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AccessTokenClaims }>();

    const header = request.headers.authorization;
    if (typeof header !== 'string') {
      throw new AppException('unauthorized', 'Missing Authorization header');
    }
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token || token.trim() === '') {
      throw new AppException(
        'unauthorized',
        'Invalid Authorization header format',
      );
    }

    let claims: AccessTokenClaims;
    try {
      claims = verifyAccessToken(token);
    } catch {
      throw new AppException('unauthorized', 'Invalid or expired access token');
    }

    request.user = claims;
    return true;
  }
}

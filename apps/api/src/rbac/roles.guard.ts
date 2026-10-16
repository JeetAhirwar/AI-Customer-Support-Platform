import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppException } from '../common/errors';
import { ROLES_KEY } from './roles.decorator';
import { TenancyService } from '../tenancy/tenancy.service';

interface RequestWithClaims extends FastifyRequest {
  user?: { sub?: string; tid?: string };
  membership?: {
    membership_id: string;
    tenant_id: string;
    role: string;
    permission_keys: string[];
  };
}

/**
 * Tenant + role enforcement for tenant-scoped routes.
 * The tenant comes from the verified JWT `tid` claim (minted after server-side
 * membership verification — never from headers/bodies, API_CONTRACTS §13).
 * The membership/role is ALWAYS re-read from the DB so admin revocations and
 * role changes take effect immediately (SECURITY.md §auth).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenancy: TenancyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithClaims>();
    const sub = request.user?.sub;
    const tid = request.user?.tid;
    if (!sub || !tid) {
      throw new AppException(
        'permission_denied',
        'No active tenant membership for this operation',
      );
    }

    const membership = await this.tenancy.resolveMembership(sub, tid);
    if (!membership) {
      throw new AppException('permission_denied', 'No access to this tenant');
    }

    request.membership = {
      membership_id: membership.membership_id,
      tenant_id: membership.tenant_id,
      role: membership.role,
      permission_keys: membership.permission_keys,
    };

    if (!required.includes(membership.role)) {
      throw new AppException('permission_denied', 'Insufficient role');
    }
    return true;
  }
}

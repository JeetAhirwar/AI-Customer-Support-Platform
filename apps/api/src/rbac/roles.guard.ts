import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppException } from '../common/errors';
import { ROLES_KEY } from './roles.decorator';
import { PERMISSIONS_KEY } from './permissions.decorator';
import type { PermissionKey } from './permissions';
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
 * Tenant + role + permission enforcement for tenant-scoped routes.
 * The tenant comes from the verified JWT `tid` claim (minted after server-side
 * membership verification — never from headers/bodies, API_CONTRACTS §13).
 * The membership is ALWAYS re-read from the DB so admin revocations and role
 * changes take effect immediately (SECURITY.md §auth).
 *
 * Two independent gates, both AND-ed when both are declared:
 *  - @RequireRoles(...)      → the caller's role name must be in the list
 *  - @RequirePermissions(...) → EVERY declared key must appear in the
 *    membership's `role_permissions` rows (permission checks default-deny;
 *    a route with neither declaration is authenticated-only, so sensitive
 *    routes must always declare one of them explicitly)
 * Membership resolution runs when either decorator is present, so a
 * permissions-only route still gets `request.membership` populated.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenancy: TenancyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const requiredPermissions =
      this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
    const needsRoles = requiredRoles !== undefined && requiredRoles.length > 0;
    const needsPermissions =
      requiredPermissions !== undefined && requiredPermissions.length > 0;
    if (!needsRoles && !needsPermissions) return true;

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

    if (needsRoles && !requiredRoles!.includes(membership.role)) {
      throw new AppException('permission_denied', 'Insufficient role');
    }
    if (needsPermissions) {
      const missing = requiredPermissions!.filter(
        (key) => !membership.permission_keys.includes(key),
      );
      if (missing.length > 0) {
        throw new AppException(
          'permission_denied',
          `Missing permission: ${missing.join(', ')}`,
        );
      }
    }
    return true;
  }
}

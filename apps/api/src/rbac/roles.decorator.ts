import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'aicsp:required-roles';

/**
 * Declares allowed roles for a route (controller or method). Enforced by
 * RolesGuard, which always re-resolves the membership from the DB
 * (revocation is immediate — SECURITY.md).
 */
export const RequireRoles = (
  ...roles: string[]
): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

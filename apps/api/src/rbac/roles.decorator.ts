import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'aicsp:required-roles';

/**
 * Declares allowed roles for a route. Enforced by RolesGuard, which always
 * re-resolves the membership from the DB (revocation is immediate — SECURITY.md).
 */
export const RequireRoles = (...roles: string[]): MethodDecorator =>
  SetMetadata(ROLES_KEY, roles);

import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from './permissions';

export const PERMISSIONS_KEY = 'aicsp:required-permissions';

/**
 * Declares which permission keys a route requires (controller or method),
 * enforced by RolesGuard against the `role_permissions` rows loaded for the
 * caller's membership — SECURITY.md §auth: "RBAC (roles → permission keys,
 * per tenant) + resource-level checks in every service method" and
 * "permission checks default-deny; new endpoints require an explicit authz
 * decision in code review".
 *
 * Semantics: ALL declared keys are required (AND). The keys are data, not
 * code — a tenant's role can gain or lose one without a deploy, and the next
 * request reflects it because RolesGuard re-resolves the membership every
 * call (revocation is immediate).
 *
 * Roles and permissions are independent gates: a route may declare either or
 * both. With neither declared the route stays authenticated-only, which is
 * why sensitive routes should always carry an explicit declaration here.
 */
export const RequirePermissions = (
  ...permissions: PermissionKey[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

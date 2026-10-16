/**
 * Initial permission catalog + platform default roles (per tenant).
 * SECURITY.md §auth: "RBAC (roles → permission keys, per tenant)".
 * Roles/permissions are stored per tenant (roles.role_permissions rows) so a
 * tenant can later customize without code changes; these maps are the seeds.
 */

export const PERMISSION_KEYS = [
  'cases.view',
  'cases.reply',
  'cases.manage',
  'knowledge.manage',
  'members.manage',
  'settings.manage',
  'audit.view',
  'ai.config.manage',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const DEFAULT_ROLES = ['owner', 'admin', 'agent', 'viewer'] as const;
export type DefaultRole = (typeof DEFAULT_ROLES)[number];

/** owner = admin + future owner-only operations (billing, ownership transfer). */
const OWNER_ADMIN_PERMISSIONS: PermissionKey[] = [
  'cases.view',
  'cases.reply',
  'cases.manage',
  'knowledge.manage',
  'members.manage',
  'settings.manage',
  'audit.view',
  'ai.config.manage',
];

export const DEFAULT_ROLE_PERMISSIONS: Record<DefaultRole, PermissionKey[]> = {
  owner: OWNER_ADMIN_PERMISSIONS,
  admin: OWNER_ADMIN_PERMISSIONS,
  agent: ['cases.view', 'cases.reply'],
  viewer: ['cases.view'],
};

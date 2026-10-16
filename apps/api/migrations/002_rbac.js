/**
 * 002_rbac — tenancy & RBAC core (Phase 2).
 * Logical schema source: Documentation/DATABASE_DESIGN.md §2:
 *   tenant_memberships(id, tenant_id, user_id, role_id, team_id, status) — unique(tenant_id, user_id)
 *   roles(id, tenant_id, name) · role_permissions(role_id, permission_key) · teams(id, tenant_id, name)
 * Note: invitations table + invite flow arrive with the invitations/email slice
 * (needs the email outbox). RLS on tenant tables lands with ADR-003 execution.
 */

const { PgLiteral } = require('node-pg-migrate');
const raw = (sql) => PgLiteral.create(sql);

exports.up = (pgm) => {
  // Persist the active tenant per session (login default / switch-tenant).
  // Authz authority is the JWT tid claim minted AFTER server-side membership
  // verification — this column keeps refresh tokens bound to that context.
  pgm.sql(
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_tenant_id uuid
       REFERENCES tenants(id) ON DELETE SET NULL;`,
  );

  pgm.createTable(
    'roles',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: {
        type: 'uuid',
        notNull: true,
        references: 'tenants(id)',
        onDelete: 'cascade',
      },
      name: { type: 'text', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
    },
    { ifNotExists: true },
  );
  pgm.createIndex('roles', ['tenant_id', 'name'], {
    unique: true,
    name: 'roles_tenant_name_unique',
  });

  pgm.createTable(
    'role_permissions',
    {
      role_id: {
        type: 'uuid',
        notNull: true,
        references: 'roles(id)',
        onDelete: 'cascade',
      },
      permission_key: { type: 'text', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
    },
    { ifNotExists: true },
  );
  pgm.sql(
    `ALTER TABLE role_permissions
       ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_key);`,
  );

  pgm.createTable(
    'teams',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: {
        type: 'uuid',
        notNull: true,
        references: 'tenants(id)',
        onDelete: 'cascade',
      },
      name: { type: 'text', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
    },
    { ifNotExists: true },
  );
  pgm.createIndex('teams', ['tenant_id', 'name'], {
    unique: true,
    name: 'teams_tenant_name_unique',
  });

  pgm.createTable(
    'tenant_memberships',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: {
        type: 'uuid',
        notNull: true,
        references: 'tenants(id)',
        onDelete: 'cascade',
      },
      user_id: {
        type: 'uuid',
        notNull: true,
        references: 'users(id)',
        onDelete: 'cascade',
      },
      // restrict: deleting a role must not silently strip access
      role_id: { type: 'uuid', notNull: true, references: 'roles(id)' },
      team_id: {
        type: 'uuid',
        references: 'teams(id)',
        onDelete: 'set null',
      },
      status: { type: 'text', notNull: true, default: 'active' },
      created_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
    },
    { ifNotExists: true },
  );
  pgm.createIndex('tenant_memberships', ['tenant_id', 'user_id'], {
    unique: true,
    name: 'memberships_tenant_user_unique',
  });
  pgm.createIndex('tenant_memberships', ['user_id'], {
    name: 'memberships_user_idx',
  });
  pgm.sql(
    `ALTER TABLE tenant_memberships ADD CONSTRAINT memberships_status_check
     CHECK (status IN ('active','invited','disabled'));`,
  );
};

exports.down = (pgm) => {
  pgm.dropTable('tenant_memberships', { ifExists: true });
  pgm.dropTable('teams', { ifExists: true });
  pgm.dropTable('role_permissions', { ifExists: true });
  pgm.dropTable('roles', { ifExists: true });
  pgm.sql(`ALTER TABLE sessions DROP COLUMN IF EXISTS active_tenant_id;`);
};

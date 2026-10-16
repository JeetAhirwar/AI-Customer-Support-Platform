/**
 * 001_identity — tenancy & identity core for the auth module (Phase 2).
 * Logical schema source: Documentation/DATABASE_DESIGN.md §2 "Tenancy & identity".
 * Scope note: memberships/roles/invitations arrive with the tenancy + RBAC task.
 * Conventions: UUID v4 PKs, timestamptz UTC, status CHECKs, per §1.
 *
 * node-pg-migrate v9 note: plain string column defaults are dollar-quoted as
 * literals — SQL expressions (gen_random_uuid(), now(), casts) must be passed
 * as PgLiteral to be rendered raw.
 */

const { PgLiteral } = require('node-pg-migrate');

const raw = (sql) => PgLiteral.create(sql);

exports.up = (pgm) => {
  pgm.createTable(
    'tenants',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      name: { type: 'text', notNull: true },
      plan: { type: 'text', notNull: true, default: 'trial' },
      status: { type: 'text', notNull: true, default: 'active' },
      region: { type: 'text' },
      settings: { type: 'jsonb', notNull: true, default: raw(`'{}'::jsonb`) },
      created_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
    },
    { ifNotExists: true },
  );
  pgm.sql(
    `ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
     CHECK (status IN ('active','suspended','deleted'));`,
  );
  pgm.createIndex('tenants', ['status'], { name: 'tenants_status_idx' });

  pgm.createTable(
    'users',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      email: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true, default: 'active' },
      email_verified_at: { type: 'timestamptz' },
      mfa_enabled: { type: 'boolean', notNull: true, default: false },
      created_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
    },
    { ifNotExists: true },
  );
  // emails stored normalized (lowercase) by the application
  pgm.createIndex('users', ['email'], { unique: true, name: 'users_email_unique' });
  pgm.sql(
    `ALTER TABLE users ADD CONSTRAINT users_status_check
     CHECK (status IN ('active','invited','disabled'));`,
  );

  pgm.createTable(
    'credentials',
    {
      user_id: {
        type: 'uuid',
        primaryKey: true,
        notNull: true,
        references: 'users(id)',
        onDelete: 'cascade',
      },
      password_hash: { type: 'text', notNull: true },
      algorithm: { type: 'text', notNull: true, default: 'argon2id' },
      updated_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
    },
    { ifNotExists: true },
  );
  pgm.sql(
    `ALTER TABLE credentials ADD CONSTRAINT credentials_algorithm_check
     CHECK (algorithm IN ('argon2id'));`,
  );

  pgm.createTable(
    'sessions',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      user_id: {
        type: 'uuid',
        notNull: true,
        references: 'users(id)',
        onDelete: 'cascade',
      },
      refresh_family_id: { type: 'uuid', notNull: true },
      // sha256 of the opaque refresh token — raw tokens are never stored
      token_hash: { type: 'text', notNull: true },
      issued_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
      expires_at: { type: 'timestamptz', notNull: true },
      revoked_at: { type: 'timestamptz' },
      revoke_reason: { type: 'text' },
      meta: { type: 'jsonb', notNull: true, default: raw(`'{}'::jsonb`) },
      created_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
    },
    { ifNotExists: true },
  );
  pgm.createIndex('sessions', ['token_hash'], {
    unique: true,
    name: 'sessions_token_hash_unique',
  });
  pgm.createIndex('sessions', ['refresh_family_id'], { name: 'sessions_family_idx' });
  pgm.createIndex('sessions', ['user_id', 'revoked_at'], { name: 'sessions_user_active_idx' });
  pgm.sql(
    `ALTER TABLE sessions ADD CONSTRAINT sessions_revoke_reason_check
     CHECK (revoke_reason IS NULL OR revoke_reason IN
       ('rotated','logout','reuse_detected','admin_revoked','expired'));`,
  );
};

exports.down = (pgm) => {
  pgm.dropTable('sessions', { ifExists: true });
  pgm.dropTable('credentials', { ifExists: true });
  pgm.dropTable('users', { ifExists: true });
  pgm.dropTable('tenants', { ifExists: true });
};

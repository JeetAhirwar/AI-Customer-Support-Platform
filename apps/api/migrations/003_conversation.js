/**
 * 003_conversation — customers, queues, conversation & cases (Phase 2).
 * Logical schema source: Documentation/DATABASE_DESIGN.md §2–4:
 *   §2 customers(id, tenant_id, display_name, email, phone, locale,
 *      identity_level, metadata) — unique(tenant_id, normalized external keys)
 *      customer_identities(id, tenant_id, customer_id, channel, external_id,
 *      verification_state, verified_at) — unique(tenant_id, channel, external_id)
 *   §3 conversations / cases / messages / case_events / handoffs
 *   §4 queues (needed now: cases.queue_id, handoffs.destination_queue_id;
 *      routing_rules + agent_presence arrive with the routing slice)
 * Conventions (§1): uuid PKs, tenant_id FK -> tenants ON DELETE CASCADE,
 * composite indexes leading with tenant_id, CHECKs where practical.
 * RLS policies land in 004_rls (ADR-003 execution).
 */

const { PgLiteral } = require('node-pg-migrate');
const raw = (sql) => PgLiteral.create(sql);

// identical tenant scoping block on every tenant table
const tenantFk = {
  type: 'uuid',
  notNull: true,
  references: 'tenants(id)',
  onDelete: 'cascade',
};
const ts = () => ({
  created_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
  updated_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
});

// three-channel MVP (ADR-013); appended to as channels onboard
const channelCheck = (table) =>
  `ALTER TABLE ${table} ADD CONSTRAINT ${table}_channel_check
     CHECK (channel IN ('chat','email','voice'));`;

exports.up = (pgm) => {
  // --- Routing §4: queues first (cases.handoffs reference it) ---
  pgm.createTable(
    'queues',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: tenantFk,
      name: { type: 'text', notNull: true },
      channel: { type: 'text' }, // NULL = omnichannel queue
      team_id: {
        type: 'uuid',
        references: 'teams(id)',
        onDelete: 'set null',
      },
      priority: { type: 'integer', notNull: true, default: 0 },
      // overflow semantics decided in the routing slice (kept free-form here)
      overflow_policy: { type: 'text' },
      ...ts(),
    },
    { ifNotExists: true },
  );
  pgm.createIndex('queues', ['tenant_id', 'name'], {
    unique: true,
    name: 'queues_tenant_name_unique',
  });
  pgm.sql(channelCheck('queues'));

  // --- Customers §2 ---
  pgm.createTable(
    'customers',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: tenantFk,
      display_name: { type: 'text', notNull: true },
      email: { type: 'text' },
      phone: { type: 'text' },
      locale: { type: 'text', notNull: true, default: 'en' },
      identity_level: { type: 'text', notNull: true, default: 'none' },
      metadata: { type: 'jsonb', notNull: true, default: raw(`'{}'::jsonb`) },
      ...ts(),
    },
    { ifNotExists: true },
  );
  // unique(tenant_id, normalized external key): email normalized with lower()
  pgm.sql(
    `CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_email_unique
       ON customers (tenant_id, lower(email))
       WHERE email IS NOT NULL;`,
  );
  pgm.createIndex('customers', ['tenant_id'], {
    name: 'customers_tenant_idx',
  });
  pgm.sql(
    `ALTER TABLE customers ADD CONSTRAINT customers_identity_level_check
       CHECK (identity_level IN ('none','basic','verified'));`,
  );

  pgm.createTable(
    'customer_identities',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: tenantFk,
      customer_id: {
        type: 'uuid',
        notNull: true,
        references: 'customers(id)',
        onDelete: 'cascade',
      },
      channel: { type: 'text', notNull: true },
      external_id: { type: 'text', notNull: true },
      verification_state: { type: 'text', notNull: true, default: 'unverified' },
      verified_at: { type: 'timestamptz' },
      ...ts(),
    },
    { ifNotExists: true },
  );
  pgm.createIndex(
    'customer_identities',
    ['tenant_id', 'channel', 'external_id'],
    {
      unique: true,
      name: 'identities_tenant_channel_external_unique',
    },
  );
  pgm.createIndex('customer_identities', ['tenant_id', 'customer_id'], {
    name: 'identities_tenant_customer_idx',
  });
  pgm.sql(channelCheck('customer_identities'));
  pgm.sql(
    `ALTER TABLE customer_identities
       ADD CONSTRAINT identities_verification_state_check
       CHECK (verification_state IN ('unverified','pending','verified'));`,
  );

  // --- Conversation & cases §3 ---
  pgm.createTable(
    'conversations',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: tenantFk,
      channel: { type: 'text', notNull: true },
      external_thread_id: { type: 'text' }, // provider thread key (nullable pre-identify)
      customer_id: {
        type: 'uuid',
        references: 'customers(id)',
        onDelete: 'cascade',
      },
      status: { type: 'text', notNull: true, default: 'open' },
      first_message_at: { type: 'timestamptz' },
      last_activity_at: { type: 'timestamptz' },
      ...ts(),
    },
    { ifNotExists: true },
  );
  // unique(tenant_id, channel, external_thread_id) where present
  pgm.sql(
    `CREATE UNIQUE INDEX IF NOT EXISTS conversations_tenant_thread_unique
       ON conversations (tenant_id, channel, external_thread_id)
       WHERE external_thread_id IS NOT NULL;`,
  );
  pgm.createIndex('conversations', ['tenant_id', 'status'], {
    name: 'conversations_tenant_status_idx',
  });
  pgm.createIndex('conversations', ['tenant_id', 'customer_id'], {
    name: 'conversations_tenant_customer_idx',
  });
  pgm.sql(channelCheck('conversations'));
  pgm.sql(
    `ALTER TABLE conversations ADD CONSTRAINT conversations_status_check
       CHECK (status IN ('open','snoozed','closed'));`,
  );

  pgm.createTable(
    'cases',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: tenantFk,
      // every case belongs to a customer (anonymous chat creates one first)
      customer_id: {
        type: 'uuid',
        notNull: true,
        references: 'customers(id)',
        onDelete: 'cascade',
      },
      // the case is the durable record: losing the conversation must not lose it
      conversation_id: {
        type: 'uuid',
        references: 'conversations(id)',
        onDelete: 'set null',
      },
      status: { type: 'text', notNull: true, default: 'open' },
      priority: { type: 'text', notNull: true, default: 'normal' },
      queue_id: { type: 'uuid', references: 'queues(id)', onDelete: 'set null' },
      // removing an agent must not delete their cases
      assignee_id: { type: 'uuid', references: 'users(id)', onDelete: 'set null' },
      sla_due_at: { type: 'timestamptz' },
      resolution_code: { type: 'text' }, // taxonomy lands with the resolution slice
      resolved_at: { type: 'timestamptz' },
      reopened_at: { type: 'timestamptz' },
      ...ts(),
    },
    { ifNotExists: true },
  );
  pgm.createIndex('cases', ['tenant_id', 'status'], {
    name: 'cases_tenant_status_idx',
  });
  pgm.createIndex('cases', ['tenant_id', 'assignee_id'], {
    name: 'cases_tenant_assignee_idx',
  });
  pgm.createIndex('cases', ['tenant_id', 'queue_id'], {
    name: 'cases_tenant_queue_idx',
  });
  pgm.createIndex('cases', ['tenant_id', 'customer_id'], {
    name: 'cases_tenant_customer_idx',
  });
  pgm.createIndex('cases', ['tenant_id', 'conversation_id'], {
    name: 'cases_tenant_conversation_idx',
  });
  pgm.sql(
    `ALTER TABLE cases ADD CONSTRAINT cases_status_check
       CHECK (status IN ('new','open','pending','on_hold',
                         'resolved','closed','reopened'));`,
  );
  pgm.sql(
    `ALTER TABLE cases ADD CONSTRAINT cases_priority_check
       CHECK (priority IN ('low','normal','high','urgent'));`,
  );

  pgm.createTable(
    'messages',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: tenantFk,
      conversation_id: {
        type: 'uuid',
        notNull: true,
        references: 'conversations(id)',
        onDelete: 'cascade',
      },
      direction: { type: 'text', notNull: true },
      actor_type: { type: 'text', notNull: true },
      // full body lives in object storage (DATABASE_DESIGN §1.6); preview inline
      body_ref: { type: 'text' },
      body_preview: { type: 'text' },
      provider_message_id: { type: 'text' },
      idempotency_key: { type: 'text' },
      delivery_state: { type: 'text', notNull: true, default: 'pending' },
      sent_at: { type: 'timestamptz' },
      created_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
    },
    { ifNotExists: true },
  );
  // NULL idempotency keys do not collide (PG treats NULLs as distinct)
  pgm.createIndex('messages', ['tenant_id', 'idempotency_key'], {
    unique: true,
    name: 'messages_tenant_idempotency_unique',
  });
  pgm.createIndex('messages', ['tenant_id', 'conversation_id', 'created_at'], {
    name: 'messages_tenant_conversation_created_idx',
  });
  pgm.sql(
    `ALTER TABLE messages ADD CONSTRAINT messages_direction_check
       CHECK (direction IN ('inbound','outbound'));`,
  );
  pgm.sql(
    `ALTER TABLE messages ADD CONSTRAINT messages_actor_type_check
       CHECK (actor_type IN ('customer','agent','ai','system'));`,
  );
  pgm.sql(
    `ALTER TABLE messages ADD CONSTRAINT messages_delivery_state_check
       CHECK (delivery_state IN ('pending','sent','delivered','failed'));`,
  );

  pgm.createTable(
    'case_events',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: tenantFk,
      case_id: {
        type: 'uuid',
        notNull: true,
        references: 'cases(id)',
        onDelete: 'cascade',
      },
      event_type: { type: 'text', notNull: true }, // open-ended timeline vocabulary
      actor_type: { type: 'text', notNull: true },
      // no FK: actors include customers/automation, not only users
      actor_id: { type: 'uuid' },
      metadata: { type: 'jsonb', notNull: true, default: raw(`'{}'::jsonb`) },
      occurred_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
      created_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
      // append-only: no updated_at
    },
    { ifNotExists: true },
  );
  pgm.createIndex('case_events', ['tenant_id', 'case_id', 'occurred_at'], {
    name: 'case_events_tenant_case_occurred_idx',
  });
  pgm.sql(
    `ALTER TABLE case_events ADD CONSTRAINT case_events_actor_type_check
       CHECK (actor_type IN ('customer','agent','ai','system'));`,
  );

  pgm.createTable(
    'handoffs',
    {
      id: { type: 'uuid', primaryKey: true, default: raw('gen_random_uuid()') },
      tenant_id: tenantFk,
      case_id: {
        type: 'uuid',
        notNull: true,
        references: 'cases(id)',
        onDelete: 'cascade',
      },
      reason: { type: 'text', notNull: true },
      summary_ref: { type: 'text' },
      source_refs: { type: 'jsonb', notNull: true, default: raw(`'[]'::jsonb`) },
      destination_queue_id: {
        type: 'uuid',
        references: 'queues(id)',
        onDelete: 'set null',
      },
      state: { type: 'text', notNull: true, default: 'requested' },
      requested_at: { type: 'timestamptz', notNull: true, default: raw('now()') },
      accepted_at: { type: 'timestamptz' },
      accepted_by: {
        type: 'uuid',
        references: 'users(id)',
        onDelete: 'set null',
      },
      ...ts(),
    },
    { ifNotExists: true },
  );
  pgm.createIndex('handoffs', ['tenant_id', 'case_id'], {
    name: 'handoffs_tenant_case_idx',
  });
  pgm.sql(
    `ALTER TABLE handoffs ADD CONSTRAINT handoffs_state_check
       CHECK (state IN ('requested','accepted','declined','cancelled','timeout'));`,
  );
};

exports.down = (pgm) => {
  pgm.dropTable('handoffs', { ifExists: true });
  pgm.dropTable('case_events', { ifExists: true });
  pgm.dropTable('messages', { ifExists: true });
  pgm.dropTable('cases', { ifExists: true });
  pgm.dropTable('conversations', { ifExists: true });
  pgm.dropTable('customer_identities', { ifExists: true });
  pgm.dropTable('customers', { ifExists: true });
  pgm.dropTable('queues', { ifExists: true });
};

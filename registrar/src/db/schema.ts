import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  inet,
  integer,
  interval,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { IdentityBundle } from '@vector-sigma/shared';

/**
 * Vector Sigma registrar schema — mirrors docs/engineering-spec.md.
 *
 * One deliberate deviation from the spec SQL: delivery_log.device_id is
 * NULLABLE. The spec requires an audit row on EVERY outcome, including
 * denials against unknown UUIDs, where no devices row exists to
 * reference. The FK still enforces referential integrity for non-null
 * values. Decision posted on fleet-ops-f57.1 before implementation.
 */

export const devices = pgTable(
  'devices',
  {
    balenaUuid: uuid('balena_uuid').primaryKey(),
    agentName: text('agent_name').notNull().unique(),
    registrarKeyHash: text('registrar_key_hash').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    notes: text('notes'),
  },
  (t) => [check('devices_status_check', sql`${t.status} IN ('pending','active','revoked')`)],
);

export const identityBlobs = pgTable('identity_blobs', {
  deviceId: uuid('device_id')
    .primaryKey()
    .references(() => devices.balenaUuid),
  bundle: jsonb('bundle').$type<IdentityBundle>().notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const deliverySlots = pgTable(
  'delivery_slots',
  {
    deviceId: uuid('device_id')
      .primaryKey()
      .references(() => devices.balenaUuid),
    state: text('state').notNull().default('armed'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    autoRearmAfter: interval('auto_rearm_after').notNull().default(sql`'1 hour'::interval`),
    deliveryCount: integer('delivery_count').notNull().default(0),
  },
  (t) => [check('delivery_slots_state_check', sql`${t.state} IN ('armed','consumed')`)],
);

export const deliveryLog = pgTable(
  'delivery_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Nullable: denials for unknown UUIDs have no devices row to reference.
     *  FK still enforced for non-null values, per the spec SQL. */
    deviceId: uuid('device_id').references(() => devices.balenaUuid),
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    keyId: text('key_id'),
    sourceIp: inet('source_ip'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('delivery_log_outcome_check', sql`${t.outcome} IN ('delivered','denied','admin')`)],
);

export const adminKeys = pgTable('admin_keys', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  hash: text('hash').notNull(),
  label: text('label').notNull(),
});

/**
 * Primus-scoped machine keys for the mesh-enroll action
 * (fleet-ops-j7g.1 shape B). Hash-stored only — deleting the row is the
 * owner kill switch. One row per agent_name (primus); minting a second
 * key for the same name replaces the hash (revoke-by-replace).
 */
export const meshEnrollKeys = pgTable('mesh_enroll_keys', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  hash: text('hash').notNull(),
  agentName: text('agent_name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

/**
 * The registrar's persisted scoped key-creator key (fleet-ops-j7g.1
 * creator-key design call: registrar-side bootstrap). The plaintext is
 * minted once from the composition's master key, delivered to the
 * gateway, and stored here ONLY as its argon2id hash — the row exists
 * so the registrar can VERIFY its own configured creator key still
 * authenticates at the gateway, and so bootstrap never re-mints while
 * a live row exists. The actual key VALUE the service uses still lives
 * in the service env (GATEWAY_KEY_CREATOR_KEY) — this row is the
 * bootstrap's dedupe marker, not a credential store.
 */
export const gatewayCreatorKey = pgTable('gateway_creator_key', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  keyHash: text('key_hash').notNull(),
  alias: text('alias').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
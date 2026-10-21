import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
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
/**
 * Signed A2A identity (docs/a2a-signed-identity.md): one row per device holding the PUBLIC
 * Ed25519 key its agent generated on its own data volume (the private key never leaves it).
 * Reported by the registrant on its authenticated poll. `status`:
 *   active   — distributed to the device's mesh peers as peer_keys
 *   pending  — first key held for owner approval (VS_A2A_KEY_APPROVAL=always)
 * A DIFFERENT key reported while one is active never replaces it: it is recorded in the
 * conflict_* columns (an owner alarm; approve swaps it in, revoke clears it).
 * `guard_status` is the guard's own status.json as last reported (readiness for strict mode).
 */
export const a2aPublicKeys = pgTable(
  'a2a_public_keys',
  {
    deviceId: uuid('device_id')
      .primaryKey()
      .references(() => devices.balenaUuid),
    ed25519: text('ed25519').notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull(),
    conflictEd25519: text('conflict_ed25519'),
    conflictFingerprint: text('conflict_fingerprint'),
    conflictAt: timestamp('conflict_at', { withTimezone: true }),
    guardStatus: jsonb('guard_status'),
    reportedBundleVersion: integer('reported_bundle_version'),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('a2a_public_keys_status_check', sql`${t.status} IN ('active','pending')`)],
);

/** Fleet-wide mesh settings (one row, id = 1). `strict`: refuse unsigned A2A fleet-wide. */
export const meshSettings = pgTable('mesh_settings', {
  id: integer('id').primaryKey(),
  strict: boolean('strict').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

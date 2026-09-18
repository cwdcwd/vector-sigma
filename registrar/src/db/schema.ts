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
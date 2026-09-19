/**
 * E2E seed — deterministic, idempotent.
 *
 * Runs as the `seed` service in compose.e2e.yaml AFTER the registrar has
 * migrated the schema (healthcheck-gated). It uses the registrar's own
 * key-crypto module to hash the device key (one crypto code path) and
 * inserts exactly the state e2e.sh asserts against:
 *
 *   - device `sim-deploy-e2e` (uuid from env), status=active,
 *     argon2id hash of DEVICE_KEY
 *   - identity_blobs v1 bundle (the file set e2e.sh expects on the volume)
 *   - delivery_slots row: armed, auto_rearm_after = SEED_REARM_SECONDS (8s
 *     in the E2E — short window so the auto-rearm path is observable in
 *     seconds rather than the production 1h)
 *
 * Re-run safety: every insert is upsert-ish; on re-run the slot is reset
 * to armed with the short window and delivery_log rows for the device
 * are cleared so audit-count assertions stay deterministic.
 */
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { hashKey } from '../../registrar/dist/db/key-crypto.js';
import { devices, identityBlobs, deliverySlots, deliveryLog } from '../../registrar/dist/db/schema.js';
import type { IdentityBundle } from '../../shared/dist/index.js';

const env = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  uuid: process.env.E2E_DEVICE_UUID ?? '',
  key: process.env.E2E_DEVICE_KEY ?? '',
  agentName: process.env.E2E_AGENT_NAME ?? 'sim-deploy-e2e',
  rearmSeconds: Number(process.env.SEED_REARM_SECONDS ?? 8),
};

for (const k of ['databaseUrl', 'uuid', 'key', 'agentName'] as const) {
  if (env[k] === '') throw new Error(`seed: missing env ${k}`);
}
if (!Number.isFinite(env.rearmSeconds) || env.rearmSeconds <= 0) {
  throw new Error(`seed: SEED_REARM_SECONDS must be positive, got ${env.rearmSeconds}`);
}

const BUNDLE_VERSION = 1;

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * M3: Retry-with-backoff helper for DB connection.
 * Attempts up to `maxAttempts` times, waiting `delayMs` between failures.
 * Succeeds silently on connect; throws the last error on exhaustion.
 */
async function connectWithRetry(
  client: Client,
  maxAttempts: number,
  delayMs: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.connect();
      return;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        console.log(`[seed] db not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`);
        await wait(delayMs);
      }
    }
  }
  throw lastError;
}

/** The deterministic bundle the E2E device receives. */
function e2eBundle(): IdentityBundle {
  return {
    schema_version: 1,
    bundle_version: BUNDLE_VERSION,
    generated_at: new Date().toISOString(),
    files: [
      { path: 'config/agent.env', mode: '0600', content: 'AGENT_NAME=sim-deploy-e2e\nSOURCE=vector-sigma-e2e\n' },
      { path: 'config/secrets.env', mode: '0600', content: 'SIMULATED_SECRET=e2e-rotate-me\n' },
    ],
  };
}

async function main(): Promise<void> {
  // Schema gate: registrar (migrate-on-start) must be up first; the compose
  // healthcheck mostly ensures this, connectWithRetry makes it structural.
  const client = new Client({ connectionString: env.databaseUrl });
  await connectWithRetry(client, 30, 2000);
  const db = drizzle(client);

  const hash = await hashKey(env.key);
  console.log('[seed] device key hashed (argon2id, OWASP params)');

  const bundle = e2eBundle();

  await db
    .insert(devices)
    .values({
      balenaUuid: env.uuid,
      agentName: env.agentName,
      registrarKeyHash: hash,
      status: 'active',
      notes: 'compose-simulated device (deploy E2E)',
    })
    .onConflictDoUpdate({
      target: devices.balenaUuid,
      set: { registrarKeyHash: hash, status: 'active' },
    });

  await db
    .insert(identityBlobs)
    .values({ deviceId: env.uuid, bundle, version: BUNDLE_VERSION })
    .onConflictDoUpdate({
      target: identityBlobs.deviceId,
      set: { bundle, version: BUNDLE_VERSION, updatedAt: new Date() },
    });

  // Slot: armed, short re-arm window for the E2E. Re-run resets the window.
  await db
    .insert(deliverySlots)
    .values({
      deviceId: env.uuid,
      state: 'armed',
      autoRearmAfter: `${env.rearmSeconds} seconds`,
    })
    .onConflictDoUpdate({
      target: deliverySlots.deviceId,
      set: {
        state: 'armed',
        deliveredAt: null,
        autoRearmAfter: `${env.rearmSeconds} seconds`,
        deliveryCount: 0,
      },
    });

  // Deterministic audit baseline: clear prior rows for this device only.
  await db.delete(deliveryLog).where(eq(deliveryLog.deviceId, env.uuid));

  await client.end();
  console.log(
    `[seed] device ${env.uuid} (${env.agentName}) active, bundle v${BUNDLE_VERSION}, slot armed, rearm window ${env.rearmSeconds}s`,
  );
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
import { z } from 'zod';
import { BALENA_UUID_SHORT_RE, BALENA_UUID_CANONICAL_RE, normalizeBalenaUuid } from '@vector-sigma/shared';

const EnvSchema = z.object({
  /**
   * Device UUID injected by the platform (balena env). balenaOS injects
   * the balena-native SHORT form (32 hex, no hyphens); both forms are
   * accepted and normalized to canonical via the shared contract
   * (fleet-ops-f57.10) — the same normalizer the registrar applies.
   */
  BALENA_DEVICE_UUID: z
    .string()
    .refine(
      (v) => BALENA_UUID_SHORT_RE.test(v) || BALENA_UUID_CANONICAL_RE.test(v),
      'balena device UUID must be balena short-form (32 hex chars) or canonical hyphenated',
    )
    .transform(normalizeBalenaUuid),
  REGISTRAR_URL: z.string().url(),
  REGISTRAR_KEY: z.string().min(16),
  /**
   * TLS trust contract (fleet-ops-f57.13; RETIRED fleet-ops-lnf, j7g
   * phase 2 — the serve-only edge): the registrar's edge is tailscale
   * serve fronting Let's Encrypt certificates at the MagicDNS name —
   * publicly trusted CA, verified by every stock trust store (Node's
   * bundled Mozilla CA list included) with no provisioning. The
   * internal-CA machinery (VS_CA_CERT_B64 / VS_CA_CERT /
   * VS_ALLOW_PUBLIC_CA) retired with caddy: the f57.13 fail-loud gate
   * existed to prevent a silent fallback to "works because the clock
   * is right today" against the fleet's SELF-MINTED CA; with a public
   * CA at the edge there is nothing to provision and no silent-fallback
   * failure mode to guard — the stock store IS the correct trust
   * configuration. http REGISTRAR_URL (compose-internal topologies)
   * boots unchanged, as it always did.
   */
  /** Data volume root; bundle files land here relative to it. */
  DATA_DIR: z.string().min(1).default('/data/agent'),
  /** Max wait for NTP convergence before proceeding best-effort (ms). */
  CLOCK_GATE_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /** Watcher poll interval for remote bundle_version changes (ms). */
  WATCH_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  /**
   * Grace-poll interval for permanent bootstrap errors (f57.11): how
   * often a blocked device re-checks /v1/status while waiting for the
   * console fix. Production default 5 min; the compose E2E shortens it
   * so self-heal is observable inside the CI budget.
   */
  GRACE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  LOG_LEVEL: z.string().default('info'),
});

export interface RegistrantConfig {
  balenaDeviceUuid: string;
  registrarUrl: string;
  registrarKey: string;
  dataDir: string;
  clockGateTimeoutMs: number;
  watchIntervalMs: number;
  gracePollIntervalMs: number;
  logLevel: string;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): RegistrantConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid registrant configuration: ${issues}`);
  }
  const e = parsed.data;
  const registrarUrl = e.REGISTRAR_URL.replace(/\/+$/, '');
  // f57.13's https CA gate retired with the internal CA (lnf, phase 2):
  // the live edge presents Let's Encrypt certificates — public trust
  // needs no provisioning. See the EnvSchema note above.
  return {
    balenaDeviceUuid: e.BALENA_DEVICE_UUID,
    registrarUrl,
    registrarKey: e.REGISTRAR_KEY,
    dataDir: e.DATA_DIR,
    clockGateTimeoutMs: e.CLOCK_GATE_TIMEOUT_MS,
    watchIntervalMs: e.WATCH_INTERVAL_MS,
    gracePollIntervalMs: e.GRACE_POLL_INTERVAL_MS,
    logLevel: e.LOG_LEVEL,
  };
}
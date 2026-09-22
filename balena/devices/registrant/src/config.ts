import { z } from 'zod';
import { BALENA_UUID_SHORT_RE, BALENA_UUID_CANONICAL_RE, normalizeBalenaUuid } from '@vector-sigma/shared';

const boolFromEnv = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

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
   * TLS trust contract (fleet-ops-f57.13): an https REGISTRAR_URL requires
   * a VS internal CA provisioned, else startup aborts fail-loud naming
   * the fix path (the f57.8 posture — no silent fallback to "works
   * because the clock is right today"). The CA reaches Node through
   * ANY of:
   *   NODE_EXTRA_CA_CERTS  set (the vs-entrypoint shim exports it from
   *                        VS_CA_CERT_B64 or VS_CA_CERT — the normal path)
   *   VS_CA_CERT_B64       base64 CA cert (checked so a misconfigured shim
   *                        still fails loud INSIDE this process, at config
   *                        time, with the fleet's variable names)
   *   VS_CA_CERT           path to a baked CA cert PEM
   *   VS_ALLOW_PUBLIC_CA=true  explicit opt-out for the rare case the
   *                        registrar fronts a PUBLIC CA (e.g. a Let's
   *                        Encrypt cert on some future deployment) — never
   *                        the default.
   * http REGISTRAR_URL (compose-internal / pre-TLS topologies) needs none
   * of this and boots unchanged.
   */
  VS_CA_CERT_B64: z.string().optional(),
  VS_CA_CERT: z.string().optional(),
  VS_ALLOW_PUBLIC_CA: boolFromEnv.optional(),
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
  // TLS trust contract (f57.13): https requires a provisioned CA — fail
  // loud with the variable names, never a silent public-CA fallback.
  // Scheme is case-insensitive (Copilot f57.13 review): compare against the
  // parsed URL's lowercased protocol so `HTTPS://…` cannot bypass the gate.
  const isHttps = /^https:$/i.test(new URL(registrarUrl).protocol);
  if (isHttps && !e.VS_ALLOW_PUBLIC_CA) {
    const caProvisioned =
      typeof env.NODE_EXTRA_CA_CERTS === 'string' && env.NODE_EXTRA_CA_CERTS.length > 0 ||
      typeof e.VS_CA_CERT_B64 === 'string' && e.VS_CA_CERT_B64.length > 0 ||
      typeof e.VS_CA_CERT === 'string' && e.VS_CA_CERT.length > 0;
    if (!caProvisioned) {
      throw new Error(
        'invalid registrant configuration: REGISTRAR_URL is https but no VS CA is provisioned. ' +
          'Set VS_CA_CERT_B64 (balena fleet variable / compose env; the vs-entrypoint shim exports NODE_EXTRA_CA_CERTS from it), ' +
          'VS_CA_CERT (path to a baked CA PEM), or — only for a registrar fronting a PUBLIC CA — VS_ALLOW_PUBLIC_CA=true.',
      );
    }
  }
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
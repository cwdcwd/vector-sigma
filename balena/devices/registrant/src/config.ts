import { z } from 'zod';

const boolFromEnv = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  /** Device UUID injected by the platform (balena env). */
  BALENA_DEVICE_UUID: z
    .string()
    .regex(/^[0-9a-f]{32}$/i, 'balena device UUID (undashed 32-hex or dashed)')
    .or(z.string().uuid())
    .transform((v) =>
      /^[0-9a-f]{32}$/i.test(v)
        ? `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`
        : v,
    ),
  REGISTRAR_URL: z.string().url(),
  REGISTRAR_KEY: z.string().min(16),
  /** Data volume root; bundle files land here relative to it. */
  DATA_DIR: z.string().min(1).default('/data/agent'),
  /** Max wait for NTP convergence before proceeding best-effort (ms). */
  CLOCK_GATE_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /** Watcher poll interval for remote bundle_version changes (ms). */
  WATCH_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  LOG_LEVEL: z.string().default('info'),
});

export interface RegistrantConfig {
  balenaDeviceUuid: string;
  registrarUrl: string;
  registrarKey: string;
  dataDir: string;
  clockGateTimeoutMs: number;
  watchIntervalMs: number;
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
  return {
    balenaDeviceUuid: e.BALENA_DEVICE_UUID,
    registrarUrl: e.REGISTRAR_URL.replace(/\/+$/, ''),
    registrarKey: e.REGISTRAR_KEY,
    dataDir: e.DATA_DIR,
    clockGateTimeoutMs: e.CLOCK_GATE_TIMEOUT_MS,
    watchIntervalMs: e.WATCH_INTERVAL_MS,
    logLevel: e.LOG_LEVEL,
  };
}
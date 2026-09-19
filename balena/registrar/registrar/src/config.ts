import { z } from 'zod';

const boolFromEnv = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

// SESSION_SECRET has NO default on purpose (fleet-ops-f57.7): a baked-in
// fallback on the admin-console session HMAC would silently boot an
// insecure registrar on the fleet. Missing or short (<16) fails startup
// with the variable name and the fix path.
const sessionSecret = z
  .string({
    required_error: 'SESSION_SECRET is required — set it as a balena fleet/service variable on the registrar service (see balena/registrar/README.md)',
  })
  .min(
    16,
    'SESSION_SECRET must be at least 16 characters — set a strong random value as a balena fleet/service variable on the registrar service (see balena/registrar/README.md)',
  );

// DATABASE_URL is an optional whole-URL override (fleet-ops-f57.8):
// when unset, the URL is built from the parts below — DB_HOST defaults
// to 'postgres' (the docker compose service name, deterministic within
// the composition) — so the balena compose file carries every
// structural value and the owner sets only two secrets
// (POSTGRES_PASSWORD, SESSION_SECRET). The deploy/ self-host example
// sets DATABASE_URL directly and is unaffected.
const EnvSchema = z.object({
  DATABASE_URL: z.string().optional(),
  DB_HOST: z.string().default('postgres'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_USER: z.string().optional(),
  POSTGRES_PASSWORD: z.string().optional(),
  POSTGRES_DB: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: boolFromEnv.default('false'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  RATE_LIMIT_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  SESSION_SECRET: sessionSecret,
});

export interface RegistrarConfig {
  databaseUrl: string;
  port: number;
  host: string;
  logLevel: string;
  trustProxy: boolean;
  rateLimitWindowMs: number;
  rateLimitMaxFailures: number;
  sessionSecret: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RegistrarConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid registrar configuration: ${issues}`);
  }
  const e = parsed.data;

  // DATABASE_URL resolution (fleet-ops-f57.8): an explicit whole-URL
  // override wins; set-but-empty fails loud rather than silently falling
  // through to parts; absent builds from parts, naming every missing
  // variable plus the fix path (balena fleet/service variable).
  let databaseUrl: string;
  if (e.DATABASE_URL !== undefined) {
    if (e.DATABASE_URL.trim() === '') {
      throw new Error(
        'invalid registrar configuration: DATABASE_URL is set but empty — set it to a full postgres:// URL, or unset it so the URL is built from POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB (balena fleet/service variables, see balena/registrar/README.md)',
      );
    }
    databaseUrl = e.DATABASE_URL;
  } else {
    const missing: string[] = [];
    if (e.POSTGRES_USER === undefined || e.POSTGRES_USER.trim() === '') missing.push('POSTGRES_USER');
    if (e.POSTGRES_PASSWORD === undefined || e.POSTGRES_PASSWORD.trim() === '') missing.push('POSTGRES_PASSWORD');
    if (e.POSTGRES_DB === undefined || e.POSTGRES_DB.trim() === '') missing.push('POSTGRES_DB');
    if (missing.length > 0) {
      throw new Error(
        `invalid registrar configuration: DATABASE_URL is unset and required part(s) are missing: ${missing.join(', ')} — set each as a balena fleet/service variable (see balena/registrar/README.md)`,
      );
    }
    databaseUrl = `postgres://${encodeURIComponent(e.POSTGRES_USER as string)}:${encodeURIComponent(
      e.POSTGRES_PASSWORD as string,
    )}@${e.DB_HOST}:${e.DB_PORT}/${encodeURIComponent(e.POSTGRES_DB as string)}`;
  }

  return {
    databaseUrl,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS,
    rateLimitMaxFailures: e.RATE_LIMIT_MAX_FAILURES,
    sessionSecret: e.SESSION_SECRET,
  };
}
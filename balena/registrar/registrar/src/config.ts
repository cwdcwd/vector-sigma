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

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
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
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS,
    rateLimitMaxFailures: e.RATE_LIMIT_MAX_FAILURES,
    sessionSecret: e.SESSION_SECRET,
  };
}
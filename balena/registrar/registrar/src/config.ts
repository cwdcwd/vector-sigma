import { z } from 'zod';

const boolFromEnv = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  TRUST_PROXY: boolFromEnv.default('false'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  RATE_LIMIT_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  SESSION_SECRET: z.string().min(16).default('vsigma-change-me-session-secret'),
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
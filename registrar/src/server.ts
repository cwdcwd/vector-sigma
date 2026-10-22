import type { FastifyInstance } from 'fastify';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { buildApp } from './app.js';
import type { Clock } from './clock.js';
import type { RegistrarConfig } from './config.js';
import { AuthRateLimiter } from './rate-limit.js';

/** Everything the registrar process touches at startup, injected so the decisions are testable. */
export interface StartDeps {
  db: NodePgDatabase;
  config: RegistrarConfig;
  clock: Clock;
  env: Record<string, string | undefined>;
  /** drizzle's migrator, bound to the real migrations folder. */
  migrate: (db: NodePgDatabase, opts: { migrationsFolder: string }) => Promise<void>;
  migrationsFolder: string;
  warn: (message: string) => void;
  /** Register a signal handler (process.on in production). */
  onSignal: (signal: 'SIGTERM' | 'SIGINT', handler: () => void) => void;
  /** Release the database pool after the app closes. */
  closeDb: () => Promise<void>;
  exit: (code: number) => void;
}

/**
 * Registrar startup: migrate (or say loudly that migrations were skipped), build the app, wire
 * graceful shutdown (close the app, then the pool, then exit 0), and listen.
 */
export async function startRegistrar(deps: StartDeps): Promise<FastifyInstance> {
  const { db, config, clock } = deps;

  if (deps.env['MIGRATE_ON_START'] === 'true') {
    await deps.migrate(db, { migrationsFolder: deps.migrationsFolder });
  } else {
    // No default on purpose (fleet-ops-f57.7): absent means migrations are
    // SKIPPED — say so loudly instead of booting half-configured in silence.
    deps.warn(
      'MIGRATE_ON_START is not "true" — database migrations were skipped. ' +
        'Set MIGRATE_ON_START=true as a balena fleet/service variable on the registrar service (see platforms/balena/registrar/README.md).',
    );
  }

  const app = buildApp({
    db,
    config,
    clock,
    limiter: new AuthRateLimiter(clock, config.rateLimitWindowMs, config.rateLimitMaxFailures),
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await deps.closeDb();
    deps.exit(0);
  };
  deps.onSignal('SIGTERM', () => void shutdown('SIGTERM'));
  deps.onSignal('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`registrar listening on ${config.host}:${config.port}`);
  return app;
}

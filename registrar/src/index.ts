import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { AuthRateLimiter } from './rate-limit.js';
import { systemClock } from './clock.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  const db = drizzle(pool);

  if (process.env.MIGRATE_ON_START === 'true') {
    const migrationsFolder = new URL('../drizzle', import.meta.url).pathname;
    await migrate(db, { migrationsFolder });
  }

  const app = buildApp({
    db,
    config,
    clock: systemClock,
    limiter: new AuthRateLimiter(systemClock, config.rateLimitWindowMs, config.rateLimitMaxFailures),
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`registrar listening on ${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
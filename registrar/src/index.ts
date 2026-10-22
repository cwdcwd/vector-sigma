import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from './config.js';
import { systemClock } from './clock.js';
import { startRegistrar } from './server.js';

// Process glue only: real dependencies in, startRegistrar (server.ts, tested) does the deciding.
const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

startRegistrar({
  db: drizzle(pool),
  config,
  clock: systemClock,
  env: process.env,
  migrate,
  migrationsFolder: new URL('../drizzle', import.meta.url).pathname,
  warn: (message) => console.warn(message),
  onSignal: (signal, handler) => process.on(signal, handler),
  closeDb: () => pool.end(),
  exit: (code) => process.exit(code),
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

import { newDb, type DB } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { buildApp } from '../src/app.js';
import type { RegistrarConfig } from '../src/config.js';
import { AuthRateLimiter } from '../src/rate-limit.js';
import type { Clock } from '../src/clock.js';
import { hashKey } from '../src/db/key-crypto.js';
import { randomUUID } from 'node:crypto';
import { devices, identityBlobs, deliverySlots, adminKeys } from '../src/db/schema.js';
import type { IdentityBundle } from '@vector-sigma/shared';
import { SESSION_COOKIE, CSRF_COOKIE } from '../src/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = path.resolve(__dirname, '../drizzle');

/** Read every generated migration .sql, split into statements. */
export function readMigrationStatements(): string[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const sqlText = files.map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')).join('\n');
  return sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * pg-mem database with the REAL drizzle-generated DDL applied — the same
 * migration that runs against Postgres in production. No Postgres server
 * exists on this build host; pg-mem executes genuine SQL semantics
 * (CHECK constraints, FKs, interval arithmetic) in-process.
 */
/**
 * pg-mem 3.x's MemPg adapter throws "Not supported: getTypeParser" when a
 * query carries a `types` object (pg >= 8.10 always attaches one via
 * drizzle's prepared-statement path). Strip it before pg-mem's adaptQuery
 * sees it: pg-mem replaces $N placeholders itself and returns plain
 * JS values, so pg's type parsers are irrelevant on this path.
 */
function patchMemPgQuery(pgModule: { Pool: unknown; Client: unknown }): void {
  // MemPg is a class minted per createPg() call: methods live on .prototype.
  const proto = (pgModule.Client as { prototype: Record<string, unknown> }).prototype;
  const original = proto.query as (q: unknown, ...rest: unknown[]) => Promise<unknown>;
  if (original.name === 'vsigmaPatchedQuery') return; // already patched
  proto.query = function vsigmaPatchedQuery(query: Record<string, unknown>, ...rest: unknown[]) {
    if (query && typeof query === 'object' && (query.types !== undefined || query.rowMode !== undefined)) {
      const wantsArray = query.rowMode === 'array';
      const cleaned = { ...query };
      delete cleaned.types;
      delete cleaned.rowMode;
      const p = original.apply(this, [cleaned, ...rest]) as Promise<{
        rows: Array<Record<string, unknown>>;
        fields?: Array<{ name: string }>;
      }>;
      if (!wantsArray) return p;
      // Drizzle requested array-mode rows; pg-mem cannot produce them (its
      // adaptResults returns fields: []). pg-mem copies row keys in
      // projection order, so Object.values IS the positional row.
      return p.then((res) => ({
        ...res,
        rows: res.rows.map((row) => Object.values(row)),
      }));
    }
    return original.apply(this, [query, ...rest]);
  };
}

export function createMemDb(): DB {
  const db = newDb();
  for (const stmt of readMigrationStatements()) {
    db.public.none(stmt);
  }
  return db;
}

/** Mutable test clock — tests control time for auto-rearm windows. */
export class FakeClock implements Clock {
  t: Date;
  constructor(start = new Date('2026-01-01T00:00:00Z')) {
    this.t = start;
  }
  now(): Date {
    return new Date(this.t.getTime());
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export const TEST_CONFIG: RegistrarConfig = {
  databaseUrl: 'postgres://test:***@localhost:5432/test',
  port: 3000,
  host: '127.0.0.1',
  logLevel: 'silent',
  trustProxy: false,
  rateLimitWindowMs: 900_000,
  rateLimitMaxFailures: 5,
  sessionSecret: 'test-session-secret-0123456789abcdef',
};

export interface TestEnv {
  app: FastifyInstance;
  db: NodePgDatabase;
  memDb: DB;
  clock: FakeClock;
  limiter: AuthRateLimiter;
  device: {
    uuid: string;
    key: string;
    hash: string;
    bundle: IdentityBundle;
  };
  request: (opts: {
    method: string;
    url: string;
    body?: object;
    key?: string | null;
  }) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }>;
}

/**
 * Full integration environment: pg-mem DB + fastify app + inject harness.
 * hashParams: argon2 costs are dropped for the bulk of the suite (~100ms
 * per OWASP hash would dominate test time); crypto correctness is covered
 * separately in key-crypto.test.ts at full OWASP cost.
 */
export async function createTestEnv(opts?: {
  hashParams?: { memoryCostKiB: number; timeCost: number };
}): Promise<TestEnv> {
  const memDb = createMemDb();
  const pgModule = memDb.adapters.createPg();
  patchMemPgQuery(pgModule);
  const pool = new pgModule.Pool();
  const db = drizzle(pool) as unknown as NodePgDatabase;

  const clock = new FakeClock();
  const limiter = new AuthRateLimiter(clock, 900_000, 5);

  const app = buildApp({ db, config: TEST_CONFIG, clock, limiter });

  const uuid = randomUUID();
  const key = `bk_${randomUUID()}`;
  const hash = await hashKey(key, {
    memoryCostKiB: opts?.hashParams?.memoryCostKiB ?? 256,
    timeCost: opts?.hashParams?.timeCost ?? 1,
  });
  const bundle: IdentityBundle = {
    schema_version: 1,
    bundle_version: 1,
    generated_at: '2026-01-01T00:00:00Z',
    files: [{ path: 'config/agent.env', mode: '0600', content: 'AGENT_NAME=test\n' }],
  };

  const request = async (o: { method: string; url: string; body?: object; key?: string | null }) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (o.key !== null) {
      headers.authorization = `Bearer ${o.key}`;
    }
    const res = await app.inject({
      method: o.method as never,
      url: o.url,
      headers,
      ...(o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}),
    });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(res.body);
    } catch {
      /* non-JSON body */
    }
    return { status: res.statusCode, headers: res.headers as Record<string, string>, body };
  };

  return { app, db, memDb, clock, limiter, device: { uuid, key, hash, bundle }, request };
}

/** Insert a device row (+slot, optional bundle) with the given status. */
export async function seedDevice(
  db: NodePgDatabase,
  d: { uuid: string; hash: string; status?: string; bundle?: IdentityBundle | null; agentName?: string },
): Promise<void> {
  await db.insert(devices).values({
    balenaUuid: d.uuid,
    agentName: d.agentName ?? `agent-${d.uuid.slice(0, 8)}`,
    registrarKeyHash: d.hash,
    status: d.status ?? 'active',
  });
  await db.insert(deliverySlots).values({ deviceId: d.uuid });
  if (d.bundle !== null) {
    await db.insert(identityBlobs).values({
      deviceId: d.uuid,
      bundle: d.bundle,
      version: 1,
    });
  }
}

/** Insert an admin key row; returns its id. */
export async function seedAdminKey(
  db: NodePgDatabase,
  key: string,
  label = 'test-admin',
): Promise<number> {
  const hash = await hashKey(key, { memoryCostKiB: 256, timeCost: 1, parallelism: 1 });
  const rows = await db.insert(adminKeys).values({ hash, label }).returning({ id: adminKeys.id });
  return Number(rows[0].id);
}

/** Extract the _csrf hidden-input value from a rendered console page. */
export function extractCsrf(html: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('no _csrf input found in page HTML');
  return m[1];
}

/**
 * Cookie-carrying admin console client for tests: walks the real flow
 * (GET login → CSRF cookie → POST login → session cookie → mutations).
 */
export class AdminClient {
  private cookies = new Map<string, string>();

  constructor(private app: FastifyInstance) {}

  private absorb(res: { headers: Record<string, unknown> }): void {
    const sc = res.headers['set-cookie'];
    const list = sc === undefined ? [] : Array.isArray(sc) ? sc : [sc];
    for (const raw of list as string[]) {
      const first = String(raw).split(';')[0];
      const idx = first.indexOf('=');
      if (idx === -1) continue;
      const name = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async login(adminKey: string): Promise<{ status: number; html: string }> {
    const get = await this.app.inject({ method: 'GET', url: '/admin/login' });
    this.absorb(get);
    const csrf = this.cookies.get(CSRF_COOKIE) ?? '';
    const post = await this.app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: this.cookieHeader(),
      },
      payload: `admin_key=${encodeURIComponent(adminKey)}&_csrf=${encodeURIComponent(csrf)}`,
    });
    this.absorb(post);
    return { status: post.statusCode, html: post.body };
  }

  async get(url: string): Promise<{ status: number; html: string; headers: Record<string, unknown> }> {
    const res = await this.app.inject({
      method: 'GET',
      url,
      headers: { cookie: this.cookieHeader() },
    });
    return { status: res.statusCode, html: res.body, headers: res.headers };
  }

  async postForm(
    url: string,
    fields: Record<string, string>,
  ): Promise<{ status: number; html: string; headers: Record<string, unknown> }> {
    const payload = Object.entries(fields)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const res = await this.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: this.cookieHeader(),
      },
      payload,
    });
    this.absorb(res);
    return { status: res.statusCode, html: res.body, headers: res.headers };
  }

  /** CSRF token for a mutation, harvested from the page that hosts its form. */
  async csrfFrom(url: string): Promise<string> {
    const page = await this.get(url);
    return extractCsrf(page.html);
  }

  hasSession(): boolean {
    return this.cookies.has(SESSION_COOKIE);
  }
}

/** Typed views over the JSON request bodies (vitest runs untypechecked; this keeps tsc honest too). */
export function asStatusBody(b: Record<string, unknown>): {
  balena_uuid: string;
  device_status: string;
  slot: { state: string; delivery_count: number; delivered_at: string | null };
  bundle_version: number | null;
} {
  return b as unknown as {
    balena_uuid: string;
    device_status: string;
    slot: { state: string; delivery_count: number; delivered_at: string | null };
    bundle_version: number | null;
  };
}

export function asBundleBody(b: Record<string, unknown>): { bundle: IdentityBundle; bundle_version: number } {
  return b as unknown as { bundle: IdentityBundle; bundle_version: number };
}

/** All audit rows, oldest first, via raw SQL on the mem DB. */
export async function getAuditRows(env: TestEnv): Promise<Array<Record<string, unknown>>> {
  const { sql } = await import('drizzle-orm');
  const res = await env.db.execute(sql`SELECT * FROM delivery_log ORDER BY id ASC`);
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
}
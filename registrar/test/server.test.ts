/**
 * Registrar startup (src/server.ts): the MIGRATE_ON_START decision, listening, and graceful
 * shutdown order. index.ts only passes the real process dependencies in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startRegistrar, type StartDeps } from '../src/server.js';
import { createTestEnv, FakeClock, TEST_CONFIG } from './helpers.js';

let started: FastifyInstance | null = null;

afterEach(async () => {
  await started?.close();
  started = null;
});

async function deps(over: Partial<StartDeps> = {}): Promise<{ d: StartDeps; signals: Map<string, () => void>; order: string[] }> {
  const env = await createTestEnv();
  const signals = new Map<string, () => void>();
  const order: string[] = [];
  const d: StartDeps = {
    db: env.db,
    config: { ...TEST_CONFIG, port: 0 },
    clock: new FakeClock(),
    env: {},
    migrate: vi.fn(async () => {
      order.push('migrate');
    }),
    migrationsFolder: '/app/drizzle',
    warn: vi.fn(),
    onSignal: (signal, handler) => signals.set(signal, handler),
    closeDb: vi.fn(async () => {
      order.push('closeDb');
    }),
    exit: vi.fn((code: number) => {
      order.push(`exit:${code}`);
    }),
    ...over,
  };
  return { d, signals, order };
}

describe('startRegistrar', () => {
  it('MIGRATE_ON_START=true runs the migrations from the given folder before serving', async () => {
    const { d, order } = await deps({ env: { MIGRATE_ON_START: 'true' } });
    started = await startRegistrar(d);
    expect(d.migrate).toHaveBeenCalledWith(d.db, { migrationsFolder: '/app/drizzle' });
    expect(d.warn).not.toHaveBeenCalled();
    expect(order[0]).toBe('migrate');
    expect((await started.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it.each([undefined, 'false', 'TRUE', '1'])('MIGRATE_ON_START=%j skips migrations and says so loudly', async (value) => {
    const { d } = await deps({ env: { MIGRATE_ON_START: value } });
    started = await startRegistrar(d);
    expect(d.migrate).not.toHaveBeenCalled();
    expect(d.warn).toHaveBeenCalledWith(expect.stringMatching(/migrations were skipped/));
  });

  it('a failing migration aborts startup (the app never listens)', async () => {
    const { d } = await deps({ env: { MIGRATE_ON_START: 'true' }, migrate: vi.fn(async () => Promise.reject(new Error('lock timeout'))) });
    await expect(startRegistrar(d)).rejects.toThrow('lock timeout');
  });

  it.each(['SIGTERM', 'SIGINT'])('%s closes the app, then the pool, then exits 0', async (signal) => {
    let app: FastifyInstance | null = null;
    let listeningAtPoolClose: boolean | undefined;
    const { d, signals, order } = await deps({
      closeDb: vi.fn(async () => {
        listeningAtPoolClose = app?.server.listening;
      }),
    });
    app = await startRegistrar(d);
    expect(app.server.listening).toBe(true);
    expect([...signals.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    signals.get(signal)!();
    await vi.waitFor(() => expect(order).toContain('exit:0'));
    expect(d.closeDb).toHaveBeenCalledTimes(1);
    expect(listeningAtPoolClose).toBe(false); // the app stopped serving before the pool closed
    expect(order).toEqual(['exit:0']);
  });
});

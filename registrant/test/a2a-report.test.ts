/**
 * Signed A2A identity (docs/a2a-signed-identity.md): the registrant reports the agent's PUBLIC
 * key + guard status + applied bundle version on its watcher poll, and never crashes doing so.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RegistrarClient } from '../src/client.js';
import { reportA2aIdentity } from '../src/run.js';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const PUB = 'A'.repeat(43);
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function dataDir(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'vs-a2a-'));
  dirs.push(d);
  await mkdir(path.join(d, 'a2a-guard'), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(d, 'a2a-guard', name), content);
  return d;
}

function config(dir: string) {
  return {
    balenaDeviceUuid: UUID, registrarUrl: 'https://reg.example', registrarKey: 'k-1234567890abcdef',
    dataDir: dir, clockGateTimeoutMs: 60_000, watchIntervalMs: 20, gracePollIntervalMs: 20, logLevel: 'silent',
  };
}

function client(respond: () => Response) {
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), auth: headers.authorization ?? null, body: JSON.parse(String(init?.body ?? '{}')) });
    return respond();
  };
  return { calls, client: new RegistrarClient('https://reg.example', UUID, 'k-1234567890abcdef', fetchImpl) };
}

const ok = (status: string) => () => new Response(JSON.stringify({ status, fingerprint: 'f'.repeat(16) }), { status: 200 });

describe('registrant: a2a identity report', () => {
  it('reports the public key, guard status and applied bundle version with the device credential', async () => {
    const dir = await dataDir({
      'pubkey.json': JSON.stringify({ ed25519: PUB, fingerprint: 'x' }),
      'status.json': JSON.stringify({ running: true, outbound_peers: ['agent-b'] }),
      'ed25519.key': 'PRIVATE KEY MUST NEVER LEAVE',
    });
    const c = client(ok('active'));
    expect(await reportA2aIdentity(config(dir), c.client, 7)).toBe('reported');
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].url).toBe('https://reg.example/v1/a2a-key');
    expect(c.calls[0].auth).toBe('Bearer k-1234567890abcdef');
    expect(c.calls[0].body).toEqual({
      balena_uuid: UUID, ed25519: PUB,
      guard_status: { running: true, outbound_peers: ['agent-b'] }, bundle_version: 7,
    });
    expect(JSON.stringify(c.calls[0].body)).not.toContain('PRIVATE'); // only the public key leaves
  });

  it('reports the key alone when the guard has not written status yet', async () => {
    const c = client(ok('active'));
    await reportA2aIdentity(config(await dataDir({ 'pubkey.json': JSON.stringify({ ed25519: PUB }) })), c.client, 3);
    expect(c.calls[0].body.guard_status).toBeNull();
  });

  it('does nothing before the agent has generated a key', async () => {
    const c = client(ok('active'));
    expect(await reportA2aIdentity(config(await dataDir({})), c.client, 1)).toBe('absent');
    expect(await reportA2aIdentity(config(await dataDir({ 'pubkey.json': '{not json' })), c.client, 1)).toBe('absent');
    expect(c.calls).toHaveLength(0);
  });

  it('a registrar failure is retried later, never thrown', async () => {
    const c = client(() => new Response('{"error":"internal_error"}', { status: 500 }));
    const dir = await dataDir({ 'pubkey.json': JSON.stringify({ ed25519: PUB }) });
    expect(await reportA2aIdentity(config(dir), c.client, 1)).toBe('failed');
  });

  it('tracks the last status so a conflict is announced once', async () => {
    const c = client(ok('conflict'));
    const dir = await dataDir({ 'pubkey.json': JSON.stringify({ ed25519: PUB }) });
    const last: { status?: string } = {};
    await reportA2aIdentity(config(dir), c.client, 1, last);
    await reportA2aIdentity(config(dir), c.client, 1, last);
    expect(last.status).toBe('conflict');
    expect(c.calls).toHaveLength(2); // still reported each cycle (readiness heartbeat)
  });
});

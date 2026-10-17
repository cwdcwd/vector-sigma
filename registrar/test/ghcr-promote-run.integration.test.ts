/**
 * scripts/ghcr-promote-run.mjs — integration proof (fleet-ops-r3v).
 *
 * This is the EXACT command the publisher workflows invoke. Everything
 * else in this lane tests the modules; this suite runs the real script as
 * a child process against a real HTTP socket, so the CI contract itself is
 * covered end to end: argv parsing, layout-tar reading, the record file
 * the later verify job consumes, the exit code on success and on failure,
 * and the credential hygiene of the printed output.
 *
 * The `--scheme http` flag used here exists only for this test; CI omits it
 * and gets `https` (asserted below on the workflow text).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFakeOciLayoutTar } from './helpers/oci-fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const SCRIPT = path.join(repoRoot, 'scripts/ghcr-promote-run.mjs');
const REPOSITORY = 'cwdcwd/vector-sigma/registrar';
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** The same minimal wire-faithful registry shape the transport suite uses. */
class LocalRegistry {
  readonly blobs = new Map<string, Buffer>();
  readonly manifests = new Map<string, { bytes: Buffer; mediaType: string }>();
  readonly requests: string[] = [];
  failNext?: string;
  private server?: Server;
  origin = '';

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server!.address();
    if (!addr || typeof addr === 'string') throw new Error('no ephemeral port');
    this.origin = `127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${this.origin}`);
    const p = url.pathname;
    this.requests.push(`${req.method} ${p}`);

    if (this.failNext === `${req.method} ${p}`) {
      this.failNext = undefined;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('injected failure');
      return;
    }

    const body = await this.readBody(req);
    const blob = p.match(/^\/v2\/(.+)\/blobs\/(.+)$/);
    if (blob) {
      const rest = blob[2]!;
      if (rest === 'uploads/') {
        res.writeHead(202, { location: `/v2/${REPOSITORY}/blobs/uploads/sess-x`, 'content-length': '0' });
        res.end();
        return;
      }
      if (rest.startsWith('uploads/')) {
        const digest = url.searchParams.get('digest') ?? '';
        if (sha(body) !== digest) {
          res.writeHead(400);
          res.end('digest mismatch');
          return;
        }
        this.blobs.set(digest, body);
        res.writeHead(201, { 'docker-content-digest': digest, 'content-length': '0' });
        res.end();
        return;
      }
      const stored = this.blobs.get(rest);
      if (!stored) {
        res.writeHead(404, { 'content-length': '0' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': String(stored.length) });
      res.end(req.method === 'HEAD' ? undefined : stored);
      return;
    }

    const man = p.match(/^\/v2\/(.+)\/manifests\/(.+)$/);
    if (man) {
      const [, repo, ref] = man;
      const key = `${repo}@${ref}`;
      if (req.method === 'PUT') {
        const mediaType = String(req.headers['content-type'] ?? 'application/octet-stream');
        const digest = sha(body);
        this.manifests.set(key, { bytes: body, mediaType });
        this.manifests.set(`${repo}@${digest}`, { bytes: body, mediaType });
        res.writeHead(201, { 'docker-content-digest': digest, 'content-length': '0' });
        res.end();
        return;
      }
      const stored = this.manifests.get(key);
      if (!stored) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}');
        return;
      }
      res.writeHead(200, {
        'content-type': stored.mediaType,
        'docker-content-digest': sha(stored.bytes),
        'content-length': String(stored.bytes.length),
      });
      res.end(req.method === 'HEAD' ? undefined : stored.bytes);
      return;
    }

    res.writeHead(404, { 'content-length': '0' });
    res.end();
  }
}

let reg: LocalRegistry;
let dir: string;
let amdTar: string;
let armTar: string;
let recordPath: string;

function runScript(args: string[], env: Record<string, string> = {}): Promise<{ status: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [SCRIPT, ...args],
      { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000 },
      (err, stdout, stderr) => {
        const status = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ status, stdout: `${stdout}${stderr}` });
      },
    );
  });
}

beforeAll(async () => {
  reg = new LocalRegistry();
  await reg.start();
  dir = mkdtempSync(path.join(os.tmpdir(), 'ghcr-promote-run-'));
  amdTar = path.join(dir, 'registrar-amd64.tar');
  armTar = path.join(dir, 'registrar-arm64.tar');
  writeFileSync(
    amdTar,
    buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: [{ name: 'a.js', content: 'amd\n' }] }] }),
  );
  writeFileSync(
    armTar,
    buildFakeOciLayoutTar({ platform: 'linux/arm64', layers: [{ files: [{ name: 'a.js', content: 'arm\n' }] }] }),
  );
  recordPath = path.join(dir, 'promoted.json');
});

afterAll(async () => {
  await reg.stop();
});

describe('ghcr-promote-run.mjs: the real CI promote command', () => {
  it('promotes the exact scanned tars and writes a record verify can consume', async () => {
    const { status, stdout } = await runScript([
      'promote',
      '--registry',
      reg.origin,
      '--repository',
      REPOSITORY,
      '--tag',
      'deadbeef',
      '--layout',
      `linux/amd64=${amdTar}`,
      '--layout',
      `linux/arm64=${armTar}`,
      '--record',
      recordPath,
      '--scheme',
      'http',
    ]);
    expect(status, `promote must exit 0 — got output:\n${stdout}`).toBe(0);

    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    expect(record.repository).toBe(REPOSITORY);
    expect(record.index.tag).toBe('deadbeef');
    expect(record.index.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.perPlatform.map((p: { platform: string }) => p.platform).sort()).toEqual([
      'linux/amd64',
      'linux/arm64',
    ]);

    // Every byte the record names is really on the wire.
    const index = reg.manifests.get(`${REPOSITORY}@deadbeef`);
    expect(index, 'the index tag must exist on the wire').toBeDefined();
    expect(sha(index!.bytes)).toBe(record.index.digest);
    for (const p of record.perPlatform as Array<{ tag: string; digest: string }>) {
      const child = reg.manifests.get(`${REPOSITORY}@${p.tag}`);
      expect(child, `child tag ${p.tag} must exist`).toBeDefined();
      expect(sha(child!.bytes)).toBe(p.digest);
    }
  });

  it('verify re-reads by digest over the real socket and exits 0', async () => {
    const { status, stdout } = await runScript(['verify', '--registry', reg.origin, '--record', recordPath, '--scheme', 'http']);
    expect(status, `verify must exit 0 — got output:\n${stdout}`).toBe(0);
    expect(stdout).toContain('VERIFIED');
  });

  it('a registry failure makes promote exit nonzero (fail-closed) with a ::error:: line', async () => {
    // A FRESH registry: the shared one already holds these exact blobs from
    // the earlier promote, so blobExists would short-circuit the upload and
    // the injected failure would never fire.
    const fresh = new LocalRegistry();
    await fresh.start();
    try {
      fresh.failNext = `POST /v2/${REPOSITORY}/blobs/uploads/`;
      const { status, stdout } = await runScript([
        'promote',
        '--registry',
        fresh.origin,
        '--repository',
        REPOSITORY,
        '--tag',
        'willfail',
        '--layout',
        `linux/amd64=${amdTar}`,
        '--layout',
        `linux/arm64=${armTar}`,
        '--record',
        path.join(dir, 'fail.json'),
        '--scheme',
        'http',
      ]);
      expect(status).not.toBe(0);
      expect(stdout).toMatch(/::error::|RegistryClientError|500/);
      // The failed promotion must not have advertised a release tag.
      expect(fresh.manifests.has(`${REPOSITORY}@willfail`)).toBe(false);
    } finally {
      await fresh.stop();
    }
  });

  it('never prints the credential it was handed', async () => {
    const secret = 'ghs_supersecretvaluethatmustneversurface';
    const { stdout } = await runScript(
      [
        'promote',
        '--registry',
        reg.origin,
        '--repository',
        REPOSITORY,
        '--tag',
        'withtoken',
        '--layout',
        `linux/amd64=${amdTar}`,
        '--layout',
        `linux/arm64=${armTar}`,
        '--record',
        path.join(dir, 'token.json'),
        '--actor',
        'doombot',
        '--scheme',
        'http',
      ],
      { GHCR_TOKEN: secret },
    );
    expect(stdout).not.toContain(secret);
  });

  it('rejects an unknown subcommand', async () => {
    const { status, stdout } = await runScript(['frobnicate']);
    expect(status).not.toBe(0);
    expect(stdout).toContain('unknown subcommand');
  });

  it('rejects a malformed --layout spec before writing anything', async () => {
    const { status, stdout } = await runScript([
      'promote',
      '--registry',
      reg.origin,
      '--repository',
      REPOSITORY,
      '--tag',
      'bad',
      '--layout',
      'linux/amd64',
      '--record',
      path.join(dir, 'bad.json'),
    ]);
    expect(status).not.toBe(0);
    expect(stdout).toContain('malformed');
  });

  it('rejects an unsupported platform before writing anything', async () => {
    const { status, stdout } = await runScript([
      'promote',
      '--registry',
      reg.origin,
      '--repository',
      REPOSITORY,
      '--tag',
      'bad2',
      '--layout',
      `linux/riscv64=${amdTar}`,
      '--record',
      path.join(dir, 'bad2.json'),
    ]);
    expect(status).not.toBe(0);
    expect(stdout).toContain('unsupported');
  });
});

describe('ghcr-promote-run.mjs: CI invokes it with https (no scheme override)', () => {
  it('no publisher workflow passes --scheme', () => {
    for (const wf of [
      '.github/workflows/build-images.yml',
      '.github/workflows/release-registrar.yml',
      '.github/workflows/release-devices.yml',
    ]) {
      const text = readFileSync(path.join(repoRoot, wf), 'utf8');
      expect(text, `${wf} must not pass --scheme (production is https)`).not.toContain('--scheme');
    }
  });

  it('every publisher workflow that promotes or verifies invokes the in-repo script', () => {
    for (const wf of [
      '.github/workflows/build-images.yml',
      '.github/workflows/release-registrar.yml',
      '.github/workflows/release-devices.yml',
    ]) {
      const text = readFileSync(path.join(repoRoot, wf), 'utf8');
      expect(text).toContain('scripts/ghcr-promote-run.mjs');
    }
  });
});

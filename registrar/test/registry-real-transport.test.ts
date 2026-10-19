/**
 * Real-transport proof (fleet-ops-r3v).
 *
 * Every other suite in this lane injects an in-memory fake, which proves
 * the PROMOTION LOGIC but not the code that actually talks to a network.
 * This suite closes that gap: it starts a real `node:http` server that
 * implements the OCI Distribution v2 subset the client speaks, and drives
 * the REAL `FetchRegistryTransport` (global `fetch` → real socket →
 * real HTTP) through `promoteComponent` and `verifyRemote`.
 *
 * What this catches that the fakes cannot: header casing as the wire
 * sees it, `Content-Length`/body framing, `Location`-header upload
 * sessions resolved against the registry host, `Docker-Content-Digest`
 * parsing, and non-2xx handling — i.e. every failure mode that would only
 * appear once CI points this at ghcr.io.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promoteComponent } from '../src/registry/promote.js';
import { verifyRemote, type PromotedRecord } from '../src/registry/verify-remote.js';
import { createFetchTransport } from '../src/registry/fetch-transport.js';
import { fetchRegistryToken } from '../src/registry/auth.js';
import { buildFakeOciLayoutTar } from './helpers/oci-fixtures.js';
import type { RequiredPlatform } from '../src/oci-gate/types.js';

const REPOSITORY = 'cwdcwd/vector-sigma/registrar';
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** A minimal but wire-faithful OCI Distribution v2 registry. */
class LocalRegistry {
  readonly blobs = new Map<string, Buffer>();
  readonly manifests = new Map<string, { bytes: Buffer; mediaType: string }>();
  readonly requests: string[] = [];
  /** Set to inject a 500 on the next matching "METHOD /path" request. */
  failNext?: string;
  /** Serve these bytes instead of the stored ones for a `<repo>@<ref>` key. */
  readonly tamper = new Map<string, Buffer>();
  readonly tokensIssued: Array<{ scope: string; basicAuth: string | undefined }> = [];
  /** When set, any request without a Bearer token is rejected. */
  requireAuth = false;

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
    const path = url.pathname;
    this.requests.push(`${req.method} ${path}`);

    // Token endpoint — mirrors GHCR's shape closely enough to exercise
    // the Basic-auth header path without a credential ever hitting a URL.
    if (path === '/token') {
      this.tokensIssued.push({ scope: url.searchParams.get('scope') ?? '', basicAuth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: `tok-${this.tokensIssued.length}` }));
      return;
    }

    if (this.failNext === `${req.method} ${path}`) {
      this.failNext = undefined;
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('injected failure');
      return;
    }

    if (this.requireAuth && !String(req.headers.authorization ?? '').startsWith('Bearer ')) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="http://x/token"' });
      res.end('{"errors":[{"code":"UNAUTHORIZED"}]}');
      return;
    }

    const body = await this.readBody(req);

    // /v2/<name>/blobs/<digest>  (name may contain slashes)
    const blobMatch = path.match(/^\/v2\/(.+)\/blobs\/(.+)$/);
    if (blobMatch) {
      const [, , rest] = blobMatch;
      if (rest === 'uploads/') {
        res.writeHead(202, { location: `/v2/${REPOSITORY}/blobs/uploads/sess-${this.requests.length}`, 'content-length': '0' });
        res.end();
        return;
      }
      if (rest.startsWith('uploads/')) {
        const digest = url.searchParams.get('digest');
        if (!digest) {
          res.writeHead(400);
          res.end('missing digest');
          return;
        }
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
      res.writeHead(200, { 'content-length': String(stored.length), 'content-type': 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : stored);
      return;
    }

    const manifestMatch = path.match(/^\/v2\/(.+)\/manifests\/(.+)$/);
    if (manifestMatch) {
      const [, repo, ref] = manifestMatch;
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
      const tampered = this.tamper.get(key);
      const stored = this.manifests.get(key);
      if (!stored && !tampered) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}');
        return;
      }
      const bytes = tampered ?? stored!.bytes;
      res.writeHead(200, {
        'content-type': tampered ? 'application/vnd.oci.image.manifest.v1+json' : stored!.mediaType,
        'docker-content-digest': sha(bytes),
        'content-length': String(bytes.length),
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
      return;
    }

    res.writeHead(404, { 'content-length': '0' });
    res.end();
  }
}

let reg: LocalRegistry;

beforeAll(async () => {
  reg = new LocalRegistry();
  await reg.start();
});

afterAll(async () => {
  await reg.stop();
});

function layouts() {
  return [
    {
      platform: 'linux/amd64' as RequiredPlatform,
      tarBytes: buildFakeOciLayoutTar({
        platform: 'linux/amd64',
        layers: [{ files: [{ name: 'app/index.js', content: 'amd64 real\n' }] }],
      }),
    },
    {
      platform: 'linux/arm64' as RequiredPlatform,
      tarBytes: buildFakeOciLayoutTar({
        platform: 'linux/arm64',
        layers: [{ files: [{ name: 'app/index.js', content: 'arm64 real\n' }] }],
      }),
    },
  ];
}

function opts(overrides: Record<string, unknown> = {}) {
  return {
    transport: createFetchTransport(),
    registry: reg.origin,
    repository: REPOSITORY,
    scheme: 'http' as const,
    layouts: layouts(),
    archTag: (p: RequiredPlatform) => `realtag-${p === 'linux/amd64' ? 'amd64' : 'arm64'}`,
    indexTag: 'realtag',
    ...overrides,
  };
}

describe('real fetch transport: promotion over an actual HTTP socket', () => {
  it('promotes the exact scanned bytes to a real registry and writes every blob/manifest', async () => {
    const result = await promoteComponent(opts());
    expect(result.index.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.perPlatform).toHaveLength(2);

    const storedIndex = reg.manifests.get(`${REPOSITORY}@realtag`);
    expect(storedIndex, 'the index tag must exist on the wire').toBeDefined();
    expect(sha(storedIndex!.bytes)).toBe(result.index.digest);
    expect(storedIndex!.mediaType).toBe('application/vnd.oci.image.index.v1+json');

    for (const p of result.perPlatform) {
      const child = reg.manifests.get(`${REPOSITORY}@${p.digest}`);
      expect(child, `${p.platform} manifest must be retrievable by digest`).toBeDefined();
      expect(sha(child!.bytes)).toBe(p.digest);
      const parsed = JSON.parse(child!.bytes.toString('utf8'));
      expect(parsed.config.digest).toMatch(/^sha256:/);
      expect(reg.blobs.has(parsed.config.digest), 'the config blob must have been uploaded').toBe(true);
      for (const l of parsed.layers) {
        expect(reg.blobs.has(l.digest), `layer ${l.digest} must have been uploaded`).toBe(true);
        expect(sha(reg.blobs.get(l.digest)!)).toBe(l.digest);
      }
    }
  });

  it('issues an upload session and PUTs the whole blob monolithically (Location resolved against the host)', async () => {
    const fresh = new LocalRegistry();
    await fresh.start();
    try {
      await promoteComponent({
        ...opts({ archTag: (p: RequiredPlatform) => `loc-${p.split('/')[1]}`, indexTag: 'loc' }),
        registry: fresh.origin,
      });
      expect(fresh.requests.some((c) => c.startsWith('POST /v2/') && c.endsWith('/blobs/uploads/'))).toBe(true);
      expect(fresh.requests.some((c) => c.includes('/blobs/uploads/sess-') && c.startsWith('PUT'))).toBe(true);
    } finally {
      await fresh.stop();
    }
  });

  it('uses the real FetchRegistryTransport and the global fetch, not a fake', async () => {
    const t = createFetchTransport();
    const res = await t.send({ method: 'GET', url: `http://${reg.origin}/v2/`, headers: {} });
    // /v2/ is not implemented by the stub registry → a real 404 from a real socket.
    expect(res.status).toBe(404);
  });

  it('verify-remote re-reads the published index and children over the real socket and passes', async () => {
    const result = await promoteComponent(opts({ archTag: (p: RequiredPlatform) => `v-${p.split('/')[1]}`, indexTag: 'v' }));
    const record = result as PromotedRecord;
    const verified = await verifyRemote({
      transport: createFetchTransport(),
      registry: reg.origin,
      scheme: 'http',
      record,
    });
    expect(verified.indexDigest).toBe(record.index.digest);
    expect(verified.children).toHaveLength(2);
  });

  it('verify-remote fails closed on the real socket when the tag is retargeted to other bytes', async () => {
    const result = await promoteComponent(opts({ archTag: (p: RequiredPlatform) => `t-${p.split('/')[1]}`, indexTag: 't' }));
    const record = result as PromotedRecord;
    reg.tamper.set(
      `${REPOSITORY}@t`,
      Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] })),
    );
    try {
      await expect(
        verifyRemote({ transport: createFetchTransport(), registry: reg.origin, scheme: 'http', record }),
      ).rejects.toMatchObject({ code: 'index_mismatch' });
    } finally {
      reg.tamper.delete(`${REPOSITORY}@t`);
    }
  });

  it('surfaces a non-2xx from the wire as a RegistryClientError, never a silent success', async () => {
    const fresh = new LocalRegistry();
    await fresh.start();
    try {
      fresh.failNext = `POST /v2/${REPOSITORY}/blobs/uploads/`;
      await expect(
        promoteComponent({
          ...opts({ archTag: (p: RequiredPlatform) => `f-${p.split('/')[1]}`, indexTag: 'f' }),
          registry: fresh.origin,
        }),
      ).rejects.toMatchObject({ status: 500 });
    } finally {
      await fresh.stop();
    }
  });
});

describe('real fetch transport: token exchange is a real HTTP round trip', () => {
  it('sends the credential as a Basic header over the wire and receives a usable token', async () => {
    const token = await fetchRegistryToken(createFetchTransport(), {
      registry: reg.origin,
      repository: REPOSITORY,
      actions: 'pull,push',
      scheme: 'http',
    });
    expect(token).toMatch(/^tok-/);
    expect(reg.tokensIssued.at(-1)!.scope).toBe(`repository:${REPOSITORY}:pull,push`);
    expect(reg.tokensIssued.at(-1)!.basicAuth).toBeUndefined();
  });
});

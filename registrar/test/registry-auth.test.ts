/**
 * Token-exchange hygiene (fleet-ops-r3v).
 *
 * Pins the credential contract the promotion and verify-remote jobs rely
 * on: the password reaches exactly one place (a base64 Basic header),
 * never a URL and never an error message, and an anonymous caller gets a
 * request with no Authorization header at all.
 */
import { describe, expect, it } from 'vitest';
import { fetchRegistryToken } from '../src/registry/auth.js';
import { RegistryClientError, type RegistryRequest, type RegistryResponse, type RegistryTransport } from '../src/registry/types.js';

/** Records every request; answers the token endpoint with a canned body. */
class TokenStub implements RegistryTransport {
  readonly seen: RegistryRequest[] = [];
  constructor(
    private readonly body: string,
    private readonly status = 200,
  ) {}

  async send(req: RegistryRequest): Promise<RegistryResponse> {
    this.seen.push(req);
    return { status: this.status, headers: { 'content-type': 'application/json' }, body: Buffer.from(this.body) };
  }
}

const REPO = 'cwdcwd/vector-sigma/registrar';

describe('registry token exchange: request shape', () => {
  it('requests the ghcr token endpoint with an explicit repository scope', async () => {
    const stub = new TokenStub('{"token":"t"}');
    const token = await fetchRegistryToken(stub, { registry: 'ghcr.io', repository: REPO, actions: 'pull,push', username: 'u', password: 'p' });
    expect(token).toBe('t');
    const url = new URL(stub.seen[0].url);
    expect(url.hostname).toBe('ghcr.io');
    expect(url.pathname).toBe('/token');
    expect(url.searchParams.get('service')).toBe('ghcr.io');
    expect(url.searchParams.get('scope')).toBe(`repository:${REPO}:pull,push`);
  });

  it('carries the credential in exactly one place: a Basic Authorization header, never the URL', async () => {
    const stub = new TokenStub('{"token":"t"}');
    await fetchRegistryToken(stub, { registry: 'ghcr.io', repository: REPO, actions: 'pull,push', username: 'robot', password: 'hunter2' });
    const req = stub.seen[0];
    const expected = `Basic ${Buffer.from('robot:hunter2').toString('base64')}`;
    expect(req.headers.authorization).toBe(expected);
    expect(req.url).not.toContain('hunter2');
    expect(JSON.stringify(req.headers)).not.toContain('robot:hunter2');
  });

  it('sends NO Authorization header when no credentials are supplied (anonymous public pull)', async () => {
    const stub = new TokenStub('{"token":"anon"}');
    const token = await fetchRegistryToken(stub, { registry: 'ghcr.io', repository: REPO, actions: 'pull' });
    expect(token).toBe('anon');
    expect(stub.seen[0].headers.authorization).toBeUndefined();
    expect(stub.seen[0].headers.Authorization).toBeUndefined();
  });

  it('accepts the access_token spelling as well as token', async () => {
    const stub = new TokenStub('{"access_token":"alt"}');
    expect(await fetchRegistryToken(stub, { registry: 'ghcr.io', repository: REPO, actions: 'pull' })).toBe('alt');
  });
});

describe('registry token exchange: failure modes are loud', () => {
  it('throws on a non-2xx response, quoting the status and scope but not the credential', async () => {
    const stub = new TokenStub('{"errors":[{"code":"UNAUTHORIZED"}]}', 401);
    await expect(
      fetchRegistryToken(stub, { registry: 'ghcr.io', repository: REPO, actions: 'pull,push', username: 'robot', password: 'hunter2' }),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(RegistryClientError);
      const msg = (e as Error).message;
      expect(msg).toContain('401');
      expect(msg).toContain(REPO);
      expect(msg).not.toContain('hunter2');
      return true;
    });
  });

  it('throws when a 2xx body carries neither token field (never returns an empty token)', async () => {
    const stub = new TokenStub('{}');
    await expect(fetchRegistryToken(stub, { registry: 'ghcr.io', repository: REPO, actions: 'pull' })).rejects.toBeInstanceOf(
      RegistryClientError,
    );
  });

  it('throws when a 2xx body is not JSON', async () => {
    const stub = new TokenStub('<html>nope</html>');
    await expect(fetchRegistryToken(stub, { registry: 'ghcr.io', repository: REPO, actions: 'pull' })).rejects.toBeInstanceOf(
      RegistryClientError,
    );
  });
});

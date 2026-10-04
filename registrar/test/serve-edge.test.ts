import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Serve-only edge guard (fleet-ops-lnf, epic j7g phase 2 — the caddy
 * retirement, owner GO 2026-10-04).
 *
 * The composition's front door is the tailscale serve edge: the
 * master's tailscale service fronts the three management surfaces at
 * the MagicDNS names with Let's Encrypt certificates, and every
 * published service binds 127.0.0.1 loopback ONLY — the LAN front door
 * (80/443/8443/8444) this release retires. Caddy, the internal CA,
 * VS_CA_CERT_B64 and basic_auth are GONE.
 *
 * This test pins, so drift is a red CI run, not a canary discovery:
 *   1. serve-config.json: the v1.102.5 containerboot dialect (verified
 *      from the pinned tag's own source, cmd/containerboot/serve.go —
 *      readServeConfig + ipn/serve.go): TCP map keyed by PORT with
 *      HTTPS:true; Web map keyed "SNI:port" (there is NO implicit port
 *      443 in this dialect); handlers proxy the loopback publishes.
 *      The ${TS_CERT_DOMAIN} placeholder is Kubernetes-ONLY (outside
 *      kube containerboot substitutes an empty cert domain) — the
 *      MagicDNS FQDN is baked literally.
 *   2. Dockerfile.tailscale: FROM the same pinned tag the devices
 *      fleet's stock service uses (never :latest); the serve config
 *      is baked (the supervisor cannot bind-mount — the f57.12
 *      precedent), never a runtime fetch.
 *   3. balena/registrar compose: the tailscale service BUILDS the
 *      serve image and declares TS_SERVE_CONFIG; NO caddy service; no
 *      caddy-data volume; registrar/litellm/scotty publish loopback
 *      ONLY (no unprefixed host publishes anywhere).
 *   4. balena/devices compose: the tailscale service stays STOCK
 *      (devices join; they serve nothing) — the deliberate master/
 *      devices delta.
 *   5. No compose anywhere publishes to the LAN front door (80/443/
 *      8443/8444 without a 127.0.0.1 prefix).
 *
 * Full-line comments are stripped before scanning.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** Slice one `  <name>:` service block out of a compose (2-space indent). */
function serviceBlock(code: string, name: string): string {
  const lines = code.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^  ${name}:\\s*$`).test(l));
  if (start === -1) return '';
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (i > start && (/^  \S/.test(line) || /^\S/.test(line))) break;
    block.push(line);
  }
  return block.join('\n');
}

const registrarCompose = stripComments(
  read('balena/registrar/docker-compose.yml'),
);
const devicesCompose = stripComments(read('balena/devices/docker-compose.yml'));
const deployCompose = stripComments(read('deploy/compose.yaml'));

describe('serve-config.json: the containerboot v1.102.5 dialect (lnf)', () => {
  const sc = JSON.parse(read('balena/registrar/serve-config.json'));

  it('fronts exactly the three management surfaces on the tailnet ports', () => {
    expect(Object.keys(sc.TCP).sort()).toEqual(['443', '8443', '8444']);
    for (const port of ['443', '8443', '8444']) {
      expect(sc.TCP[port]).toEqual({ HTTPS: true });
    }
  });

  it('keys Web by SNI:port with the full MagicDNS FQDN (no implicit 443)', () => {
    const name = 'vector-sigma.tailb7207e.ts.net';
    expect(Object.keys(sc.Web).sort()).toEqual([
      `${name}:443`,
      `${name}:8443`,
      `${name}:8444`,
    ]);
  });

  it('proxies the loopback publishes: registrar 3000 / gateway 4000 / scotty 3306', () => {
    const name = 'vector-sigma.tailb7207e.ts.net';
    expect(sc.Web[`${name}:443`].Handlers['/'].Proxy).toBe('http://127.0.0.1:3000');
    expect(sc.Web[`${name}:8443`].Handlers['/'].Proxy).toBe('http://127.0.0.1:4000');
    expect(sc.Web[`${name}:8444`].Handlers['/'].Proxy).toBe('http://127.0.0.1:3306');
  });

  it('never uses the Kubernetes-only ${TS_CERT_DOMAIN} placeholder', () => {
    expect(read('balena/registrar/serve-config.json')).not.toContain('TS_CERT_DOMAIN');
  });
});

describe('Dockerfile.tailscale: the master serve image (lnf)', () => {
  const df = read('balena/registrar/Dockerfile.tailscale');
  const dfCode = stripComments(df);

  it('pins the same tailscale tag the devices fleet uses (never :latest)', () => {
    expect(dfCode).toMatch(/FROM tailscale\/tailscale:v1\.102\.5/);
    expect(dfCode).not.toMatch(/:latest/);
  });

  it('bakes the serve config (the supervisor cannot bind-mount)', () => {
    expect(dfCode).toMatch(/COPY serve-config\.json \/serve-config\.json/);
  });
});

describe('balena/registrar compose: the serve-only edge (lnf)', () => {
  it('the tailscale service BUILDS the serve image and declares TS_SERVE_CONFIG', () => {
    const ts = serviceBlock(registrarCompose, 'tailscale');
    expect(ts).toMatch(/dockerfile: Dockerfile\.tailscale/);
    expect(ts).toMatch(/TS_SERVE_CONFIG: \/serve-config\.json/);
  });

  it('has NO caddy service (retired with the owner GO)', () => {
    expect(serviceBlock(registrarCompose, 'caddy')).toBe('');
    expect(registrarCompose).not.toMatch(/Dockerfile\.caddy/);
    expect(registrarCompose).not.toMatch(/caddy-data/);
  });

  it.each([
    ['registrar', '127.0.0.1:3000:3000'],
    ['litellm', '127.0.0.1:4000:4000'],
    ['scotty', '127.0.0.1:3306:3306'],
  ])('%s publishes loopback-only: %s', (svc, publish) => {
    const block = serviceBlock(registrarCompose, svc);
    expect(block).toMatch(new RegExp(`- "${publish}"`));
  });

  it('publishes nothing to the LAN front door (IP-prefixed only)', () => {
    // every ports entry must carry the 127.0.0.1 prefix; dolt's :3326 is
    // the one documented exception (the queue contract, lane D5).
    const publishes = registrarCompose.match(/- "[^"]+:\d+"$/gm) ?? [];
    for (const p of publishes) {
      expect(p.startsWith('- "127.0.0.1:') || p === '- "3326:3306"').toBe(true);
    }
  });
});

describe('balena/devices compose: stock overlay, no serve (the deliberate delta)', () => {
  it('the tailscale service stays on the stock pinned image', () => {
    const ts = serviceBlock(devicesCompose, 'tailscale');
    expect(ts).toMatch(/^    image: tailscale\/tailscale:v1\.102\.5$/m);
    expect(ts).not.toMatch(/TS_SERVE_CONFIG/);
    expect(ts).not.toMatch(/dockerfile:/);
  });
});

describe('deploy twin parity: loopback publishes, no caddy (lnf)', () => {
  it('has NO caddy service', () => {
    expect(serviceBlock(deployCompose, 'caddy')).toBe('');
    expect(deployCompose).not.toMatch(/caddy-data/);
  });

  it.each([
    ['registrar', '127.0.0.1:3000:3000'],
    ['litellm', '127.0.0.1:4000:4000'],
    ['scotty', '127.0.0.1:3306:3306'],
  ])('%s publishes loopback-only: %s', (svc, publish) => {
    const block = serviceBlock(deployCompose, svc);
    expect(block).toMatch(new RegExp(`- "${publish}"`));
  });
});

describe('retired machinery is GONE repo-side (lnf, AC5)', () => {
  it('no compose carries basic_auth or SCOTTY_BASIC_AUTH_HASH', () => {
    for (const rel of [
      'balena/registrar/docker-compose.yml',
      'balena/devices/docker-compose.yml',
      'deploy/compose.yaml',
    ]) {
      const code = stripComments(read(rel));
      expect(code, rel).not.toMatch(/SCOTTY_BASIC_AUTH_HASH/);
      expect(code, rel).not.toMatch(/basic_auth/);
    }
  });

  it('the Caddyfile and Dockerfile.caddy are deleted', () => {
    let caddyfile: string | null = null;
    try {
      caddyfile = read('balena/registrar/Caddyfile');
    } catch {
      caddyfile = null;
    }
    expect(caddyfile).toBeNull();
    let dockerfile: string | null = null;
    try {
      dockerfile = read('balena/registrar/Dockerfile.caddy');
    } catch {
      dockerfile = null;
    }
    expect(dockerfile).toBeNull();
  });
});
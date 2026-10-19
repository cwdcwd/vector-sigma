import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { imageInputs, loadCatalog } from '../../scripts/image-catalog.mjs';

/**
 * Image content-exposure guards (fleet-ops-1py.14, plan PR #60).
 *
 * The merged plan's data classification rule 2: NO live
 * deployment-specific values in reusable image layers — tailnet DNS
 * names and addresses are the named examples. The master's
 * serve-config.json was the ONE remaining literal bake: the MagicDNS
 * FQDN keyed the Web map, and images/tailscale/Dockerfile's header comment
 * asserted (wrongly, per the plan's two-way verification) that the
 * ${TS_CERT_DOMAIN} placeholder is Kubernetes-only.
 *
 * The plan verified the placeholder mechanism two ways: the DEVICES
 * fleet's serve config already keys on ${TS_CERT_DOMAIN} at the same
 * pinned v1.102.5 tag and serves live; and containerboot's own source
 * at the tag substitutes ${TS_CERT_DOMAIN} with the node's cert domain
 * on ANY node type (cmd/containerboot/serve.go readServeConfig
 * bytes.ReplaceAll; main.go sets certDomain from the netmap's
 * CertDomains[0] — the master's MagicDNS FQDN).
 *
 * This suite pins:
 *   1. BOTH serve configs (master + devices) carry ZERO live tailnet
 *      names — the master keys Web on the ${TS_CERT_DOMAIN}
 *      placeholder exactly like the devices config.
 *   2. No Dockerfile comment (or any image-baked source) carries a
 *      literal MagicDNS FQDN or tailnet-qualified name.
 *   3. The stale "Kubernetes-only" comment is corrected — the master
 *      images/tailscale/Dockerfile header must document the placeholder as
 *      the cross-fleet mechanism.
 *   4. The TCP/ports contract is unchanged by the flip (443/8443/8444
 *      still HTTPS-fronted; proxies still loopback) — the exposure fix
 *      must not change WHAT is served, only remove the baked name.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Every file any published image reads from its build context: each
 * catalog component's Dockerfile + COPY inputs (images.json), with
 * directories expanded. Derived, never hand-listed, so a new baked file
 * is covered the moment a Dockerfile COPYs it. */
function expand(rel: string): string[] {
  const abs = path.join(repoRoot, rel);
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs)
    .filter((n) => n !== 'node_modules' && n !== 'dist')
    .flatMap((n) => expand(path.posix.join(rel, n)));
}
const catalog = loadCatalog(repoRoot);
const BAKED_INPUTS = [
  ...new Set(
    Object.keys(catalog.components).flatMap((c) => imageInputs(catalog, c, repoRoot).flatMap(expand)),
  ),
].sort();

/** A tailnet-qualified MagicDNS name: <host>.<tailnet>.ts.net. */
const TS_NET_NAME = /[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/i;

describe('master serve-config.json: placeholder, not a live name (1py.14 slice 1)', () => {
  const sc = JSON.parse(read('images/tailscale/serve-config.json'));

  it('keys every Web entry on the ${TS_CERT_DOMAIN} placeholder', () => {
    expect(Object.keys(sc.Web).sort()).toEqual(
      expect.arrayContaining(['${TS_CERT_DOMAIN}:443', '${TS_CERT_DOMAIN}:8443', '${TS_CERT_DOMAIN}:8444']),
    );
    expect(Object.keys(sc.Web)).toHaveLength(3);
  });

  it('carries no live tailnet name anywhere in the file', () => {
    expect(read('images/tailscale/serve-config.json')).not.toMatch(TS_NET_NAME);
  });

  it('keeps the fronted surfaces identical to the pre-flip contract (443/8443/8444 HTTPS, loopback proxies)', () => {
    expect(Object.keys(sc.TCP).sort()).toEqual(['3326', '443', '8443', '8444']);
    for (const port of ['443', '8443', '8444']) {
      expect(sc.TCP[port]).toEqual({ HTTPS: true });
    }
    // The queue's tailnet path (PR #87 review): a loopback TCP forward.
    expect(sc.TCP['3326']).toEqual({ TCPForward: '127.0.0.1:3326' });
    expect(sc.Web['${TS_CERT_DOMAIN}:443'].Handlers['/'].Proxy).toBe('http://127.0.0.1:3000');
    expect(sc.Web['${TS_CERT_DOMAIN}:8443'].Handlers['/'].Proxy).toBe('http://127.0.0.1:4000');
    expect(sc.Web['${TS_CERT_DOMAIN}:8444'].Handlers['/'].Proxy).toBe('http://127.0.0.1:3306');
  });
});

describe('no image-baked input carries a live tailnet name (1py.14)', () => {
  it('the derived input set covers every image (sanity: serve configs, hooks, docs, sources)', () => {
    for (const rel of [
      'images/tailscale/serve-config.json',
      'images/tailscale-devices/serve-config.json',
      'images/common/hooks/vs-a2a-wiring.sh',
      'images/common/bin/vs-mesh-enroll.py',
      'docs/device-environment.md',
      'docs/vs-environment.md',
      'registrar/src/mesh-enroll.ts',
    ]) {
      expect(BAKED_INPUTS).toContain(rel);
    }
  });

  it.each(BAKED_INPUTS)('%s carries no <host>.<tailnet>.ts.net literal', (rel) => {
    expect(read(rel), rel).not.toMatch(TS_NET_NAME);
  });

  it('images/tailscale/Dockerfile comments are corrected, not asserting the Kubernetes-only myth', () => {
    const master = read('images/tailscale/Dockerfile');
    // the stale claims that motivated the literal bake:
    expect(master).not.toMatch(/Kubernetes-only/i);
    expect(master).not.toMatch(/substitutes an empty cert domain/i);
    // the corrected contract names the mechanism:
    expect(master).toMatch(/TS_CERT_DOMAIN/);
  });
});
/**
 * Slice 2 (1py.14): the registrar's mesh-enroll module is an
 * IMAGE-BAKED source (compiled into the registrar image the build
 * workflow publishes). Its hardcoded tailnet constants
 * (MESH_TAILNET_SUFFIX, MESH_EDGE_HOST) put a live tailnet name into
 * every published registrar image. The plan's data classification:
 * deployment-specific values leave reusable layers; the loop-form
 * refusal semantics are KEPT but derive from runtime env, fail-closed.
 */
const MESH_SRC = 'registrar/src/mesh-enroll.ts';

describe('mesh-enroll: tailnet identity from runtime env, not image bytes (1py.14 slice 2)', () => {
  const src = read(MESH_SRC);

  it('carries no hardcoded tailnet suffix or edge-host literal', () => {
    expect(src).not.toMatch(/MESH_TAILNET_SUFFIX\s*=\s*['"]\./);
    expect(src).not.toMatch(/MESH_EDGE_HOST\s*=\s*['"][a-z0-9-]+\./);
    expect(src).not.toMatch(TS_NET_NAME);
  });

  it('declares the env keys and reads them fail-closed', () => {
    expect(src).toMatch(/MESH_TAILNET_SUFFIX_ENV\s*=\s*['"]VS_MESH_TAILNET_SUFFIX['"]/);
    expect(src).toMatch(/MESH_EDGE_HOST_ENV\s*=\s*['"]VS_MESH_EDGE_HOST['"]/);
    // fail-closed resolver: both must be set, non-empty, and the suffix
    // must look like a tailnet MagicDNS suffix (".ts.net"-terminated).
    expect(src).toMatch(/export function resolveMeshTopology/);
    expect(src).toMatch(/MeshTopologyError/);
  });

  it('assertNoLoopUrl keeps its semantics but takes the topology as a parameter', () => {
    const sigIdx = src.indexOf('export function assertNoLoopUrl');
    const sig = src.slice(sigIdx, src.indexOf('): void {', sigIdx));
    expect(sig).toMatch(/agentName: string/);
    expect(sig).toMatch(/url: string/);
    expect(sig).toMatch(/topology: MeshTopology/);
  });
});

describe('mesh-enroll CLI: tailnet suffix from the runtime environment (1py.14 slice 2)', () => {
  const cli = read('images/common/bin/vs-mesh-enroll.py');

  it('the baked CLI carries no hardcoded tailnet suffix', () => {
    expect(cli).not.toMatch(/MESH_TAILNET_SUFFIX\s*=\s*["']\.tailb7207e/);
    expect(cli).not.toMatch(TS_NET_NAME);
  });

  it('reads VS_MESH_TAILNET_SUFFIX from env, falling back to the bundle agent.env', () => {
    expect(cli).toMatch(/VS_MESH_TAILNET_SUFFIX/);
    expect(cli).toMatch(/agent\.env/);
  });
});

/**
 * Slice 3 (1py.14): docs/ files COPYd into both Hermes images
 * (/opt/vs/docs) are reusable layer content, same classification as the
 * serve config and mesh-enroll constants — they are part of BAKED_INPUTS
 * above. The plan's data rule 4 allows generic operator docs but not a
 * live network map, private URLs, or real deployment identifiers.
 */
describe('image-baked docs carry no live tailnet FQDN (1py.14 slice 3)', () => {
  it('the generic placeholder documents the mechanism without a live value', () => {
    const vsEnv = read('docs/vs-environment.md');
    expect(vsEnv).toMatch(/<master>\.<tailnet>\.ts\.net/);
  });
});

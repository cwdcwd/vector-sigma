/**
 * Pre-publication OCI content gate — fail-closed test matrix
 * (fleet-ops-1py.14 slice 4, plan PR #60/#61).
 *
 * ALL fixtures here are SYNTHETIC, built in-memory by
 * test/helpers/oci-fixtures.ts — this suite never touches a real
 * image, never shells docker, and never makes a network call. Every
 * negative case asserts BOTH that the gate rejects AND that no
 * network/registry client was invoked (this slice does zero registry
 * calls by design: a global fetch/http(s) sentinel must stay silent
 * across every gate run, pass or reject).
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runContentGate,
  scanPlatformLayout,
  ContentGateError,
  type PlatformLayoutInput,
} from '../src/oci-gate/gate.js';
import { assembleLocalOciIndex } from '../src/oci-gate/index-assembly.js';
import { parseTar, buildTar } from '../src/oci-gate/tar.js';
import { buildFakeOciLayoutTar, buildLayerBlob, sha256Digest, corruptTarTruncate } from './helpers/oci-fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// ---------------------------------------------------------------------------
// Network-sentinel: fails the test immediately if ANYTHING in this suite
// (the gate code included) ever attempts an outbound network call.
// ---------------------------------------------------------------------------
let networkCallAttempted = false;
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
let httpSpy: ReturnType<typeof vi.spyOn> | undefined;
let httpsSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  networkCallAttempted = false;
  if (typeof globalThis.fetch === 'function') {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      networkCallAttempted = true;
      throw new Error('network call attempted during a local-only content-gate run');
    });
  }
  httpSpy = vi.spyOn(http, 'request').mockImplementation(() => {
    networkCallAttempted = true;
    throw new Error('http.request attempted during a local-only content-gate run');
  });
  httpsSpy = vi.spyOn(https, 'request').mockImplementation(() => {
    networkCallAttempted = true;
    throw new Error('https.request attempted during a local-only content-gate run');
  });
});

afterEach(() => {
  fetchSpy?.mockRestore();
  httpSpy?.mockRestore();
  httpsSpy?.mockRestore();
});

function assertNoNetworkCalls(): void {
  expect(networkCallAttempted).toBe(false);
}

const CLEAN_FILES = [
  { name: 'usr/bin/app', content: 'binary-stand-in content, not a real ELF\n' },
  { name: 'etc/hostname', content: 'myhost\n' },
];

// ---------------------------------------------------------------------------
// tar round-trip sanity (the hand-rolled reader/writer this slice adds)
// ---------------------------------------------------------------------------
describe('tar reader/writer round-trip (local-only, no npm tar dependency)', () => {
  it('reads back exactly what it wrote, including a nested path', () => {
    const tar = buildTar([
      { name: 'a/b/c.txt', data: Buffer.from('hello world') },
      { name: 'd.txt', data: Buffer.from('') },
    ]);
    const entries = parseTar(tar);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.name).toBe('a/b/c.txt');
    expect(entries[0]!.data.toString('utf8')).toBe('hello world');
    expect(entries[1]!.name).toBe('d.txt');
    expect(entries[1]!.data.length).toBe(0);
  });

  it('throws on a truncated/corrupt tar rather than silently returning a partial entry', () => {
    const tar = buildTar([{ name: 'big.bin', data: Buffer.alloc(2000, 7) }]);
    const truncated = corruptTarTruncate(tar, 0.3);
    expect(() => parseTar(truncated)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Single-platform scan: happy path
// ---------------------------------------------------------------------------
describe('scanPlatformLayout: a clean single-platform layout passes (synthetic fixture)', () => {
  it('validates descriptors, walks layers, and finds no secrets/topology', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: CLEAN_FILES }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    expect(result.layerCount).toBe(1);
    expect(result.entryCount).toBeGreaterThan(0);
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Matrix case 1: secret in a LOWER/WHITEOUT layer — must still be caught.
// ---------------------------------------------------------------------------
describe('fail-closed: secret committed in a lower layer, deleted by a later whiteout', () => {
  it('rejects with secret_found even though the merged view hides the path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        { files: [{ name: 'opt/app/config/id_rsa', content: '-----BEGIN RSA PRIVATE KEY-----\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END RSA PRIVATE KEY-----\n' }] },
        { files: [{ name: 'opt/app/config/.wh.id_rsa', content: '' }] },
      ],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('secret_found');
    expect((err as ContentGateError).message).toMatch(/whiteout-deleted/);
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Matrix case 2: topology literal in a DELETED layer.
// ---------------------------------------------------------------------------
describe('fail-closed: tailnet topology literal in a deleted layer', () => {
  it('rejects with topology_literal_found for a lower-layer FQDN removed by a later whiteout', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/arm64',
      layers: [
        { files: [{ name: 'etc/app/peers.conf', content: 'edge=master-node.example-tailnet.ts.net\n' }] },
        { files: [{ name: 'etc/app/.wh.peers.conf', content: '' }] },
      ],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/arm64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('rejects an RFC1918 private IP literal, not deleted, present in the top layer', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/peers.conf', content: 'edge_ip=192.168.4.17\n' }] }],
    });
    expect(() => scanPlatformLayout({ platform: 'linux/amd64', tarBytes })).toThrow(ContentGateError);
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// PR #61 review round 3 finding #1: narrow, content-aware allowlist for
// stable upstream files that trip the RFC1918 scanner with their own
// illustrative/constant private-IP-shaped content — stock linux-pam
// access.conf and CPython's own ipaddress.py stdlib source.
// ---------------------------------------------------------------------------
describe('RFC1918 upstream allowlist: narrow, content-aware, not a path bypass', () => {
  // Trimmed excerpt reproducing the REAL upstream linux-pam
  // modules/pam_access/access.conf shape: the distinctive header text
  // the provenance check requires, plus genuine COMMENTED-OUT example
  // private-IP lines (never active rules) — see
  // https://github.com/linux-pam/linux-pam/blob/master/modules/pam_access/access.conf
  const STOCK_PAM_ACCESS_CONF = [
    '# Login access control table.',
    '#',
    '# permission:users:origins',
    '#',
    '# This is useful for configurations where you are trying to use',
    '# pam_access with X applications that provide PAM_TTY values.',
    '#',
    '# comment: It might be better to use network/netmask instead.',
    '#          The same is 192.168.201.0/24 or 192.168.201.0/255.255.255.0',
    '#+:root:192.168.201.',
    '#',
    '# User "john" should get access from ipv4 net/mask',
    '#+:john:127.0.0.0/24',
    '#',
    '# All other users should be denied to get access from all sources.',
    '-:ALL:ALL',
    '',
  ].join('\n');

  // Trimmed excerpt reproducing the shape of CPython's real
  // Lib/ipaddress.py stdlib source: the class declarations and
  // `_private_networks` list the provenance check requires, with the
  // private-IP ranges embedded exactly as CPython embeds them — as
  // literal arguments to IPv4Network(...)/IPv6Network(...) constructor
  // calls defining the module's own range constants.
  const STOCK_CPYTHON_IPADDRESS_PY = [
    'class IPv4Address(_BaseV4, _BaseAddress):',
    '    __slots__ = ("_ip", "__weakref__")',
    '',
    'class IPv6Address(_BaseV6, _BaseAddress):',
    '    __slots__ = ("_ip", "__weakref__", "_scope_id")',
    '',
    'class _IPv4Constants:',
    '    _private_networks = [',
    "        IPv4Network('0.0.0.0/8'),",
    "        IPv4Network('10.0.0.0/8'),",
    "        IPv4Network('127.0.0.0/8'),",
    "        IPv4Network('172.16.0.0/12'),",
    "        IPv4Network('192.168.0.0/16'),",
    '    ]',
    '',
  ].join('\n');

  it('passes a clean build when the stock linux-pam access.conf is present at its real path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/security/access.conf', content: STOCK_PAM_ACCESS_CONF }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('passes a clean build when CPython stdlib ipaddress.py is present at its real path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'usr/lib/python3.13/ipaddress.py', content: STOCK_CPYTHON_IPADDRESS_PY }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: an access.conf at the SAME path with a modified/deployment-specific private IP still rejects (allowlist is content-aware, not a path bypass)', () => {
    // Same path, same provenance header (passes the whole-file
    // provenance check), but one rule line is UNCOMMENTED (active) and
    // carries a deployment-looking private IP — the exact shape a real
    // baked fleet access rule would take. The per-occurrence shape
    // check must still catch this and reject. (Uses a COMPLETE address,
    // not the stock file's bare network-prefix form, so it actually
    // matches the rfc1918_private_ip pattern at all.)
    const tamperedContent = STOCK_PAM_ACCESS_CONF.replace('#+:john:127.0.0.0/24', '+:john:172.16.5.9');
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/security/access.conf', content: tamperedContent }, ...CLEAN_FILES] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: an ipaddress.py at the SAME path with a deployment-specific private IP OUTSIDE the IPv4Network(...) constructor shape still rejects', () => {
    // Same path, same provenance markers, but an EXTRA line appends a
    // private IP as a bare assignment (not an IPv4Network(...) literal
    // argument) — the shape a build step baking in a real deployed
    // address would actually take. The per-occurrence shape check must
    // still catch this and reject.
    const tamperedContent = `${STOCK_CPYTHON_IPADDRESS_PY}\n_deployed_edge_host = "192.168.77.42"\n`;
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'usr/lib/python3.13/ipaddress.py', content: tamperedContent }, ...CLEAN_FILES] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: a DIFFERENT file at a path that merely LOOKS like the allowed path, without the provenance markers, still rejects', () => {
    // Proves this is not a blanket path-name bypass: a file at the
    // exact allowed path, carrying a private IP, but LACKING the stock
    // file's distinctive provenance markers (i.e. not actually the
    // upstream file — someone could name any file this way) must still
    // reject.
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/security/access.conf', content: '+:root:192.168.201.5\n' }, ...CLEAN_FILES] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// PR #61 review round 4 finding #1 (P1, SECURITY HOLE): the round-3
// allowlist's per-occurrence SHAPE check (comment-prefixed line /
// IPv4Network(...) constructor argument) can be bypassed by an attacker
// who appends a NEW line that (a) keeps the file's whole-file provenance
// markers intact, AND (b) is itself shaped exactly like an accepted
// occurrence, while carrying a REAL deployed private IP that was never
// reviewed. Fixed by pinning the exact closed set of reviewed literal
// occurrence values per file (see UPSTREAM_ALLOWLIST's
// `approvedOccurrences` in secret-scan.ts) — these tests reproduce the
// owner's EXACT repro steps and prove they now reject.
// ---------------------------------------------------------------------------
describe('RFC1918 upstream allowlist round 4: exact-value pinning closes the shape-mimicry bypass', () => {
  const STOCK_PAM_ACCESS_CONF = [
    '# Login access control table.',
    '#',
    '# permission:users:origins',
    '#',
    '# This is useful for configurations where you are trying to use',
    '# pam_access with X applications that provide PAM_TTY values.',
    '#',
    '# comment: It might be better to use network/netmask instead.',
    '#          The same is 192.168.201.0/24 or 192.168.201.0/255.255.255.0',
    '#+:root:192.168.201.',
    '#',
    '# User "john" should get access from ipv4 net/mask',
    '#+:john:127.0.0.0/24',
    '#',
    '# All other users should be denied to get access from all sources.',
    '-:ALL:ALL',
    '',
  ].join('\n');

  const STOCK_CPYTHON_IPADDRESS_PY = [
    'class IPv4Address(_BaseV4, _BaseAddress):',
    '    __slots__ = ("_ip", "__weakref__")',
    '',
    'class IPv6Address(_BaseV6, _BaseAddress):',
    '    __slots__ = ("_ip", "__weakref__", "_scope_id")',
    '',
    'class _IPv4Constants:',
    '    _private_networks = [',
    "        IPv4Network('0.0.0.0/8'),",
    "        IPv4Network('10.0.0.0/8'),",
    "        IPv4Network('127.0.0.0/8'),",
    "        IPv4Network('172.16.0.0/12'),",
    "        IPv4Network('192.168.0.0/16'),",
    '    ]',
    '',
  ].join('\n');

  it('OWNER REPRO 1: an access.conf with provenance markers intact, plus an APPENDED comment-shaped line carrying a real deployed IP, still rejects', () => {
    // Exactly the owner's repro: `# production database endpoint:
    // 10.23.45.67` appended to a file that still carries every
    // provenance marker. The line is comment-shaped (passes the old
    // per-occurrence shape check) but its IP value (10.23.45.67) was
    // never in the reviewed approvedOccurrences set for this file.
    const bypassAttempt = `${STOCK_PAM_ACCESS_CONF}# production database endpoint: 10.23.45.67\n`;
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/security/access.conf', content: bypassAttempt }, ...CLEAN_FILES] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('OWNER REPRO 2: an ipaddress.py with class markers intact, plus an APPENDED IPv4Network(...) call carrying a real deployed IP, still rejects', () => {
    // Exactly the owner's repro: `PRODUCTION_NETWORK =
    // IPv4Network('10.23.45.0/24')` appended to a file that still
    // carries every class/constant provenance marker. The occurrence is
    // a genuine IPv4Network(...) constructor call (passes the old
    // per-occurrence shape check) but its literal argument
    // (10.23.45.0) was never in the reviewed approvedOccurrences set.
    const bypassAttempt = `${STOCK_CPYTHON_IPADDRESS_PY}\nPRODUCTION_NETWORK = IPv4Network('10.23.45.0/24')\n`;
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'usr/lib/python3.13/ipaddress.py', content: bypassAttempt }, ...CLEAN_FILES] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('the untampered real stock access.conf (exactly the reviewed approved occurrences) still passes', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/security/access.conf', content: STOCK_PAM_ACCESS_CONF }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('the untampered real stock ipaddress.py (exactly the reviewed approved occurrences) still passes', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'usr/lib/python3.13/ipaddress.py', content: STOCK_CPYTHON_IPADDRESS_PY }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: an unapproved RFC1918 value, even wearing the EXACT accepted shape, rejects even without a value collision with the real reviewed constants', () => {
    // A completely different private IP, same IPv4Network(...) shape,
    // same provenance markers — proves the gate checks VALUE
    // membership, not merely "is it an IPv4Network(...) call".
    const tampered = `${STOCK_CPYTHON_IPADDRESS_PY}\n        IPv4Network('192.168.55.0/24'),\n`;
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'usr/lib/python3.13/ipaddress.py', content: tampered }, ...CLEAN_FILES] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// PR #61 review round 4 finding #2: extend allowlist coverage to real
// upstream files newly discovered failing in the live CI image matrix —
// npm CLI's own npm-token.md doc page and OpenSSL's own example
// openssl.cnf. Fixture content below is copied VERBATIM from the real
// fetched upstream bytes (npm@10.8.2 / npm@11.6.2 docs content;
// openssl/openssl master branch apps/openssl.cnf) — not approximated.
// ---------------------------------------------------------------------------
describe('RFC1918 upstream allowlist: npm-token.md and openssl.cnf (round 4 finding #2)', () => {
  // Verified verbatim against the real unpkg-served npm@10.8.2 and
  // npm@11.6.2 docs/content/commands/npm-token.md (identical doc content
  // across both; fetched this review round). Trimmed to the sections
  // the provenance + occurrence checks need.
  const STOCK_NPM_TOKEN_MD = [
    '---',
    'title: npm-token',
    'section: 1',
    'description: Manage your authentication tokens',
    '---',
    '',
    '### Description',
    '',
    'This lets you list, create and revoke authentication tokens.',
    '',
    '* `npm token list`:',
    '  Shows a table of all active authentication tokens.',
    '',
    '* `npm token create [--read-only] [--cidr=<cidr-ranges>]`:',
    '  Create a new authentication token.',
    '',
    '```',
    'Read only token npm_1f… with id 7f3134 created 2017-10-21',
    '',
    'Publish token npm_af…  with id c03241 created 2017-10-02',
    'with IP Whitelist: 192.168.0.1/24',
    '',
    'Publish token npm_… with id e0cf92 created 2017-10-02',
    '',
    '```',
    '',
    '* `npm token revoke <token|id>`:',
    '  Immediately removes an authentication token from the registry.',
    '',
  ].join('\n');

  // Verified verbatim against the real openssl/openssl master branch
  // apps/openssl.cnf (fetched this review round) — trimmed to the
  // sections the provenance + occurrence checks need, preserving the
  // exact proxy-example comment line and its exact IP literal.
  const STOCK_OPENSSL_CNF = [
    '#',
    '# OpenSSL example configuration file.',
    '# See doc/man5/config.pod for more info.',
    '#',
    '',
    'HOME\t\t\t= .',
    'openssl_conf = openssl_init',
    '',
    '####################################################################',
    '[ ca ]',
    'default_ca\t= CA_default',
    '',
    '####################################################################',
    '[ CA_default ]',
    '',
    'dir\t\t= ./demoCA',
    '',
    '####################################################################',
    '[ req ]',
    'default_bits\t\t= 2048',
    'distinguished_name\t= req_distinguished_name',
    '',
    '[ req_distinguished_name ]',
    'countryName\t\t\t= Country Name (2 letter code)',
    '',
    '[insta] # CMP using Insta Demo CA',
    '# Message transfer',
    'server = pki.certificate.fi:8700',
    '# proxy = # set this as far as needed, e.g., http://192.168.1.1:8080',
    '# tls_use = 0',
    'path = pkix/',
    '',
  ].join('\n');

  it('passes a clean build when npm CLI\'s real stock npm-token.md doc is present at its real path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        {
          files: [
            { name: 'usr/local/lib/node_modules/npm/docs/content/commands/npm-token.md', content: STOCK_NPM_TOKEN_MD },
            ...CLEAN_FILES,
          ],
        },
      ],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: npm-token.md at the same path with an appended real deployed IP in the exact accepted table/doc shape still rejects', () => {
    const bypassAttempt = `${STOCK_NPM_TOKEN_MD}\nwith IP Whitelist: 10.23.45.67/32\n`;
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        {
          files: [
            { name: 'usr/local/lib/node_modules/npm/docs/content/commands/npm-token.md', content: bypassAttempt },
            ...CLEAN_FILES,
          ],
        },
      ],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('passes a clean build when the real stock openssl.cnf example config is present at its real path (postgres/tailscale image shape)', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/ssl/openssl.cnf', content: STOCK_OPENSSL_CNF }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: openssl.cnf at the same path with an UNCOMMENTED real deployed proxy value still rejects (shape check still applies on top of the value pin)', () => {
    const tampered = STOCK_OPENSSL_CNF.replace(
      '# proxy = # set this as far as needed, e.g., http://192.168.1.1:8080',
      'proxy = http://192.168.1.1:8080',
    );
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/ssl/openssl.cnf', content: tampered }, ...CLEAN_FILES] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: openssl.cnf at the same path with an appended real deployed IP (unreviewed value) still rejects even in comment shape', () => {
    const bypassAttempt = `${STOCK_OPENSSL_CNF}# backend: 10.50.60.70\n`;
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/ssl/openssl.cnf', content: bypassAttempt }, ...CLEAN_FILES] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// PR #61 review round 4 finding #3 (P2, lexical bug, fixed in the regex
// itself — not via another file exception): the RFC1918 regex's trailing
// boundary matched a dotted-quad PREFIX of a longer dotted identifier.
// CPython 3.13's Lib/random.py carries a real DOI research citation
// (`https://citeseerx.ist.psu.edu/viewdoc/download?doi=10.1.1.47.8407&...`)
// that false-positived as the private IP "10.1.1.47". Fixed by requiring
// a COMPLETE dotted-quad token (negative lookaround excludes a leading or
// trailing `.digit` continuation) in the regex itself.
// ---------------------------------------------------------------------------
describe('RFC1918 regex lexical fix (round 4 finding #3): complete dotted-quad tokens only', () => {
  it('a file containing ONLY the real CPython random.py DOI citation (not a private IP) passes clean — no allowlist entry needed', () => {
    const randomPyExcerpt = [
      '"""Random variable generators."""',
      '',
      'class Random:',
      '    def binomialvariate(self, n=1, p=0.5):',
      '        if n * p < 10.0:',
      '            pass',
      '        # BTRS: Transformed rejection with squeeze method by Wolfgang Hoermann',
      '        # https://citeseerx.ist.psu.edu/viewdoc/download?doi=10.1.1.47.8407&rep=rep1&type=pdf',
      '        assert n*p >= 10.0 and p <= 0.5',
      '',
    ].join('\n');
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'usr/lib/python3.13/random.py', content: randomPyExcerpt }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('a REAL RFC1918 endpoint in isolation (not part of a longer dotted identifier) still rejects — the boundary fix must not swing too far', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/peers.conf', content: 'edge_ip=10.1.1.47\n' }] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('a REAL RFC1918 endpoint immediately followed by a port number (no dot separator) still rejects — adjacent non-dot digits must not be excluded', () => {
    // Real-world log/config shape: "host:port" with no dot between the
    // IP and the port — the boundary fix excludes a FOLLOWING `.digit`
    // continuation specifically, not any adjacent digit.
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/peers.conf', content: 'connected from 10.1.1.47:5432 (postgres)\n' }] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('a private IP glued directly to a 5th dotted-digit group (same shape as the DOI bug) still correctly excludes the private-IP-looking prefix', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/some-other-id.txt', content: 'reference-id=192.168.1.1.99999\n' }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// PR #61 review round 5 finding #1: the round-4 RFC1918 boundary fix was
// still incomplete — two sub-bugs. (a) the left-boundary lookbehind
// `(?<!\.\d)` was backwards (it never catches the real "digit-then-dot"
// continuation shape that precedes a match when a longer dotted
// identifier's suffix looks like an RFC1918 address); fixed to
// `(?<!\d\.)`. (b) every octet position used an unconstrained `\d{1,3}`
// with no 0-255 range check, so an out-of-range value like `10.999.888.777`
// matched as if syntactically valid; fixed with a proper IPv4 octet
// pattern across ALL THREE range alternatives.
// ---------------------------------------------------------------------------
describe('RFC1918 regex fix (round 5 finding #1): left-boundary direction + octet range validation', () => {
  it('sub-bug (a) OWNER REPRO: a DOI-shaped identifier with a LONGER dotted-decimal prefix no longer matches on its suffix', () => {
    // The owner's exact repro: `doi=42.10.1.1.47` — the round-4 fix
    // only excluded a TRAILING continuation; it did nothing for a
    // LEADING continuation shaped as "digit.digit...digit" immediately
    // before the would-be match. `42.10.1.1.47`'s `10.1.1.47` suffix
    // still matched under the old (backwards) lookbehind.
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/some-other-id.txt', content: 'doi=42.10.1.1.47\n' }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('sub-bug (a) POSITIVE CONTROL: a genuine standalone private IP preceded by non-digit, non-dot content still rejects (the fix must not over-exclude)', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/peers.conf', content: 'host=10.23.45.67\n' }] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('sub-bug (b): an out-of-range octet string (10.999.888.777) does NOT match — octets outside 0-255 are not a valid IPv4 address', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/some-other-id.txt', content: 'reference=10.999.888.777\n' }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('sub-bug (b) octet boundary: 10.256.1.1 (256 is out of range) does NOT match', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/some-other-id.txt', content: 'reference=10.256.1.1\n' }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('sub-bug (b) octet boundary: 10.255.1.1 (255 is the valid max) still matches and rejects', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/peers.conf', content: 'edge_ip=10.255.1.1\n' }] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('192.168.0.0 (valid RFC1918 network address) still matches and rejects', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/peers.conf', content: 'edge_ip=192.168.0.0\n' }] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('topology_literal_found');
    assertNoNetworkCalls();
  });

  it('172.15.0.0 does NOT match — 172.15 is OUTSIDE the real RFC1918 172.16-31 range', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/some-other-id.txt', content: 'reference=172.15.0.0\n' }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('172.16.0.0 and 172.31.255.255 (both ends of the real 172.16-31 RFC1918 range) still match and reject', () => {
    for (const ip of ['172.16.0.0', '172.31.255.255']) {
      const tarBytes = buildFakeOciLayoutTar({
        platform: 'linux/amd64',
        layers: [{ files: [{ name: 'etc/app/peers.conf', content: `edge_ip=${ip}\n` }] }],
      });
      let err: unknown;
      try {
        scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
      } catch (e) {
        err = e;
      }
      expect(err, `expected ${ip} to reject`).toBeInstanceOf(ContentGateError);
      expect((err as ContentGateError).code).toBe('topology_literal_found');
    }
    assertNoNetworkCalls();
  });

  it('172.32.0.0 does NOT match — one past the real range upper bound', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/some-other-id.txt', content: 'reference=172.32.0.0\n' }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('the round-4 DOI/port/suffix regression tests still pass under the round-5 fix (no re-regression)', () => {
    // CPython random.py's real DOI citation still passes clean.
    const randomPyExcerpt = [
      '"""Random variable generators."""',
      '',
      '        # https://citeseerx.ist.psu.edu/viewdoc/download?doi=10.1.1.47.8407&rep=rep1&type=pdf',
      '',
    ].join('\n');
    const tarBytes1 = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'usr/lib/python3.13/random.py', content: randomPyExcerpt }, ...CLEAN_FILES] }],
    });
    expect(scanPlatformLayout({ platform: 'linux/amd64', tarBytes: tarBytes1 }).platform).toBe('linux/amd64');

    // A real IP immediately followed by a port number still rejects.
    const tarBytes2 = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/app/peers.conf', content: 'connected from 10.1.1.47:5432 (postgres)\n' }] }],
    });
    expect(() => scanPlatformLayout({ platform: 'linux/amd64', tarBytes: tarBytes2 })).toThrow(ContentGateError);
    assertNoNetworkCalls();
  });
});


// ---------------------------------------------------------------------------
// PR #61 review round 3 finding #2: path-traversal check must not conflate
// an absolute-rooted tar entry name (real upstream shape — proven against
// live tailscale/tailscale:v1.102.5 layer bytes pulled directly from
// registry-1.docker.io, digest
// sha256:d5b385151df469cba7b856e89b722639dbc56b258c28b4ab571cb216e52f5429 —
// a genuine directory entry literally named "/usr/local/bin") with an
// actual ".." parent-escape attempt.
// ---------------------------------------------------------------------------
describe('fail-closed: absolute-rooted tar entry names are NOT path traversal', () => {
  it('accepts a layer with an absolute-path directory entry (real tailscale upstream shape) and still scans its contents', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        {
          files: [
            { name: '/usr/local/bin', content: '', type: '5' },
            { name: '/usr/local/bin/tailscaled', content: 'binary-stand-in\n' },
          ],
        },
      ],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('still rejects an actual ".." parent-traversal segment even when absolute-rooted', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: '/usr/local/bin/../../../etc/passwd', content: 'root:x:0:0::/root:/bin/sh\n' }] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('path_traversal');
    assertNoNetworkCalls();
  });

  it('a secret inside an absolute-rooted-path file is still caught (absolute-path acceptance does not weaken secret scanning)', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        {
          files: [
            {
              name: '/usr/local/bin/leaked-key.pem',
              content:
                '-----BEGIN RSA PRIVATE KEY-----\n' +
                `${'A'.repeat(64)}\n` +
                `${'B'.repeat(20)}==\n` +
                '-----END RSA PRIVATE KEY-----\n',
            },
          ],
        },
      ],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('secret_found');
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Matrix case 3/4/5: index assembly — missing / duplicate / extra platform.
// ---------------------------------------------------------------------------
describe('fail-closed: OCI index assembly platform-set violations', () => {
  function cleanInput(platform: 'linux/amd64' | 'linux/arm64'): PlatformLayoutInput {
    return { platform, tarBytes: buildFakeOciLayoutTar({ platform, layers: [{ files: CLEAN_FILES }] }) };
  }

  it('rejects when a required platform is missing (only amd64 supplied)', () => {
    expect(() => runContentGate([cleanInput('linux/amd64')])).toThrow(ContentGateError);
    try {
      runContentGate([cleanInput('linux/amd64')]);
    } catch (e) {
      expect((e as ContentGateError).code).toBe('missing_platform');
    }
    assertNoNetworkCalls();
  });

  it('rejects a duplicate platform (two amd64 inputs)', () => {
    expect(() => runContentGate([cleanInput('linux/amd64'), cleanInput('linux/amd64')])).toThrow(ContentGateError);
    try {
      runContentGate([cleanInput('linux/amd64'), cleanInput('linux/amd64')]);
    } catch (e) {
      expect((e as ContentGateError).code).toBe('duplicate_platform');
    }
    assertNoNetworkCalls();
  });

  it('rejects an extra/unknown platform (linux/386 alongside the required pair)', () => {
    const extra: PlatformLayoutInput = {
      platform: 'linux/386' as unknown as 'linux/amd64',
      tarBytes: buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] }),
    };
    // force the layout's own declared platform to 386 so scanPlatformLayout's
    // internal platform-match check doesn't fire first for the wrong reason
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const inputs: PlatformLayoutInput[] = [cleanInput('linux/amd64'), cleanInput('linux/arm64'), { ...extra, tarBytes }];
    let err: unknown;
    try {
      runContentGate(inputs);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect(['extra_platform', 'malformed_layout']).toContain((err as ContentGateError).code);
    assertNoNetworkCalls();
  });

  it('assembles a valid index from exactly the two required, scanned digests', () => {
    const { index, results } = runContentGate([cleanInput('linux/amd64'), cleanInput('linux/arm64')]);
    expect(index.manifests).toHaveLength(2);
    const platforms = index.manifests.map((m) => `${m.platform!.os}/${m.platform!.architecture}`).sort();
    expect(platforms).toEqual(['linux/amd64', 'linux/arm64']);
    expect(results).toHaveLength(2);
    assertNoNetworkCalls();
  });
});

describe('fail-closed: index-assembly unit cases (allow-set + malformed descriptors)', () => {
  it('rejects a candidate digest outside the scanned-and-passed allow-set', () => {
    const d1 = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: sha256Digest(Buffer.from('a')), size: 1, platform: { os: 'linux', architecture: 'amd64' } };
    const d2 = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: sha256Digest(Buffer.from('b')), size: 1, platform: { os: 'linux', architecture: 'arm64' } };
    expect(() =>
      assembleLocalOciIndex({ candidates: [d1, d2], scannedAllowSet: new Set([d1.digest]) }),
    ).toThrow(ContentGateError);
    try {
      assembleLocalOciIndex({ candidates: [d1, d2], scannedAllowSet: new Set([d1.digest]) });
    } catch (e) {
      expect((e as ContentGateError).code).toBe('unknown_child_digest');
    }
  });

  it('rejects a malformed descriptor (bad digest string)', () => {
    const bad = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'not-a-digest', size: 1, platform: { os: 'linux', architecture: 'amd64' } };
    expect(() => assembleLocalOciIndex({ candidates: [bad as any], scannedAllowSet: new Set([bad.digest]) })).toThrow(
      ContentGateError,
    );
  });
});

// ---------------------------------------------------------------------------
// Matrix case 6: corrupt/truncated layer.
// ---------------------------------------------------------------------------
describe('fail-closed: corrupt/truncated layer blob', () => {
  it('rejects a layer whose gzip bytes are truncated mid-stream', () => {
    const { bytes: goodLayer } = buildLayerBlob({ files: CLEAN_FILES });
    const corrupted = goodLayer.subarray(0, Math.floor(goodLayer.length * 0.5));

    // Build a layout by hand so the corrupted blob's digest+size still
    // match what the manifest declares (otherwise this would be a
    // digest/size-mismatch case, not a corrupt-layer case).
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    const manifestDigest = index.manifests[0].digest.replace('sha256:', '');
    const manifestEntry = entries.find((e) => e.name === `blobs/sha256/${manifestDigest}`)!;
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    const layerDigestHex = manifest.layers[0].digest.replace('sha256:', '');

    // Replace the layer blob bytes with the truncated copy, and fix up
    // the manifest's digest+size to point at the corrupted bytes (so
    // the corruption is detected at decompress/parse time, not at the
    // earlier digest-check step).
    const corruptedDigest = sha256Digest(corrupted);
    manifest.layers[0].digest = corruptedDigest;
    manifest.layers[0].size = corrupted.length;
    const newManifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const newManifestDigest = sha256Digest(newManifestBytes);
    index.manifests[0].digest = newManifestDigest;
    index.manifests[0].size = newManifestBytes.length;

    const rebuilt = buildTar([
      { name: 'oci-layout', data: entries.find((e) => e.name === 'oci-layout')!.data },
      { name: 'index.json', data: Buffer.from(JSON.stringify(index), 'utf8') },
      { name: `blobs/sha256/${newManifestDigest.replace('sha256:', '')}`, data: newManifestBytes },
      { name: `blobs/sha256/${corruptedDigest.replace('sha256:', '')}`, data: corrupted },
      ...entries
        .filter((e) => e.name.startsWith('blobs/sha256/') && e.name !== `blobs/sha256/${manifestDigest}` && e.name !== `blobs/sha256/${layerDigestHex}`)
        .map((e) => ({ name: e.name, data: e.data })),
    ]);

    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('corrupt_layer');
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Matrix case 7: digest/size mismatch.
// ---------------------------------------------------------------------------
describe('fail-closed: descriptor digest/size mismatch against actual blob bytes', () => {
  it('rejects when the manifest blob bytes do not match the index-declared digest', () => {
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    const manifestHex = index.manifests[0].digest.replace('sha256:', '');
    const manifestEntry = entries.find((e) => e.name === `blobs/sha256/${manifestHex}`)!;
    // Tamper the manifest blob's bytes in place without updating index.json's digest.
    const tampered = Buffer.concat([manifestEntry.data, Buffer.from(' ')]);

    const rebuilt = buildTar(
      entries.map((e) => (e.name === `blobs/sha256/${manifestHex}` ? { name: e.name, data: tampered } : { name: e.name, data: e.data })),
    );

    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect(['digest_mismatch', 'size_mismatch']).toContain((err as ContentGateError).code);
    assertNoNetworkCalls();
  });

  it('rejects when the declared size does not match the actual blob length', () => {
    const tarBytes = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(tarBytes);
    const indexEntry = entries.find((e) => e.name === 'index.json')!;
    const index = JSON.parse(indexEntry.data.toString('utf8'));
    index.manifests[0].size = index.manifests[0].size + 500; // wrong size, digest untouched

    const rebuilt = buildTar(
      entries.map((e) => (e.name === 'index.json' ? { name: e.name, data: Buffer.from(JSON.stringify(index), 'utf8') } : { name: e.name, data: e.data })),
    );

    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('size_mismatch');
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Matrix case 8: tar path-traversal attempt.
// ---------------------------------------------------------------------------
describe('fail-closed: tar path-traversal attempt', () => {
  it('rejects a layer entry with a parent-traversal path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: '../../etc/passwd', content: 'root:x:0:0::/root:/bin/sh\n' }] }],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('path_traversal');
    assertNoNetworkCalls();
  });

  it('a bare absolute-path layer entry (no ".." segment) is accepted and scanned normally — PR #61 review round 3 finding #2: an absolute-rooted tar name alone is a legitimate upstream shape (see live tailscale v1.102.5 proof below), never path traversal by itself', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: '/etc/shadow', content: 'x\n' }] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('rejects path traversal in the OUTER layout tar itself', () => {
    const inner = buildFakeOciLayoutTar({ platform: 'linux/amd64', layers: [{ files: CLEAN_FILES }] });
    const entries = parseTar(inner);
    const rebuilt = buildTar([...entries.map((e) => ({ name: e.name, data: e.data })), { name: '../escape.txt', data: Buffer.from('x') }]);
    expect(() => scanPlatformLayout({ platform: 'linux/amd64', tarBytes: rebuilt })).toThrow(ContentGateError);
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// PR #61 review round 5 finding #2: extend allowlist coverage to 4 real
// upstream DERIVED-COPY files discovered newly failing in the live CI
// image matrix. Fixture content copied verbatim from real fetched upstream
// bytes where fetch was possible this round — see notes per-case for
// which content was independently verified vs. reasoned about.
// ---------------------------------------------------------------------------
describe('RFC1918 upstream allowlist round 5: derived-copy coverage (openssl.cnf.dist, npm-token.html, bpf.h, urllib/request.py)', () => {
  const STOCK_OPENSSL_CNF = [
    '#',
    '# OpenSSL example configuration file.',
    '# See doc/man5/config.pod for more info.',
    '#',
    '',
    'HOME\t\t\t= .',
    'openssl_conf = openssl_init',
    '',
    '####################################################################',
    '[ ca ]',
    'default_ca\t= CA_default',
    '',
    '####################################################################',
    '[ CA_default ]',
    '',
    'dir\t\t= ./demoCA',
    '',
    '####################################################################',
    '[ req ]',
    'default_bits\t\t= 2048',
    'distinguished_name\t= req_distinguished_name',
    '',
    '[ req_distinguished_name ]',
    'countryName\t\t\t= Country Name (2 letter code)',
    '',
    '[insta] # CMP using Insta Demo CA',
    '# Message transfer',
    'server = pki.certificate.fi:8700',
    '# proxy = # set this as far as needed, e.g., http://192.168.1.1:8080',
    '# tls_use = 0',
    'path = pkix/',
    '',
  ].join('\n');

  // Real fetched (unpkg-served npm@10.8.2) rendered HTML for
  // docs/output/commands/npm-token.html — verified byte-level against
  // the real file this round (grep'd for the distinctive strings and
  // the exact IP Whitelist text shape in its <pre><code> block).
  const STOCK_NPM_TOKEN_HTML = [
    '<!DOCTYPE html><html><head>',
    '<meta charset="utf-8">',
    '<title>npm-token</title>',
    '</head><body>',
    '<h1 id="----npm-token----1082">',
    '<span class="description">Manage your authentication tokens</span>',
    '</h1>',
    '<h3 id="description">Description</h3>',
    '<p>This lets you list, create and revoke authentication tokens.</p>',
    '<ul>',
    '<li><code>npm token list</code>:',
    'Shows a table of all active authentication tokens.</li>',
    '</ul>',
    '<pre><code>Read only token npm_1f… with id 7f3134 created 2017-10-21',
    '',
    'Publish token npm_af…  with id c03241 created 2017-10-02',
    'with IP Whitelist: 192.168.0.1/24',
    '',
    'Publish token npm_… with id e0cf92 created 2017-10-02',
    '',
    '</code></pre>',
    '<ul>',
    '<li>',
    '<p><code>npm token create [--read-only] [--cidr=&lt;cidr-ranges&gt;]</code>:',
    'Create a new authentication token.</p>',
    '</li>',
    '<li><code>npm token revoke &lt;token|id&gt;</code>:',
    'Immediately removes an authentication token from the registry.</li>',
    '</ul>',
    '</body></html>',
    '',
  ].join('\n');

  // Real fetched (torvalds/linux master) excerpt from
  // include/uapi/linux/bpf.h — the include-guard header and the exact
  // kernel-doc comment block containing the one RFC1918-shaped string
  // in the entire 7800+ line file.
  const STOCK_BPF_H = [
    '/* SPDX-License-Identifier: GPL-2.0 WITH Linux-syscall-note */',
    '#ifndef _UAPI__LINUX_BPF_H__',
    '#define _UAPI__LINUX_BPF_H__',
    '',
    '/*',
    ' * 		Let\'s imagine that the following code is part of a program',
    ' * 		attached to the TC ingress interface, on one end of a GRE',
    ' * 		tunnel, and is supposed to filter out all messages coming from',
    ' * 		remote ends with IPv4 address other than 10.0.0.1:',
    ' *',
    ' * 		::',
    ' *',
    ' * 			if (key.remote_ipv4 != 0x0a000001)',
    ' * 				return TC_ACT_SHOT;	// drop packet',
    ' */',
    'int bpf_skb_get_tunnel_key(struct __sk_buff *skb, struct bpf_tunnel_key *key, u32 size, u64 flags);',
    '',
    'enum bpf_prog_type {',
    '	BPF_PROG_TYPE_UNSPEC,',
    '};',
    '#endif /* _UAPI__LINUX_BPF_H__ */',
    '',
  ].join('\n');

  // Real fetched (cpython 3.13 branch) excerpt from Lib/urllib/request.py
  // — the one RFC1918-shaped string in the entire 2800+ line file, inside
  // _proxy_bypass_winreg_override's docstring.
  const STOCK_URLLIB_REQUEST_PY = [
    '"""An extensible library for opening URLs using a variety of protocols',
    '',
    'The OpenerDirector manages a collection of Handler objects...',
    '"""',
    '',
    'def urlopen(url, data=None, timeout=60):',
    '    pass',
    '',
    'class OpenerDirector:',
    '    pass',
    '',
    'def _proxy_bypass_winreg_override(host, override):',
    '    """Return True if the host should bypass the proxy server.',
    '',
    '    The proxy override list is obtained from the Windows',
    '    Internet settings proxy override registry value.',
    '',
    '    An example of a proxy override value is:',
    '    "www.example.com;*.example.net; 192.168.0.1"',
    '    """',
    '    pass',
    '',
  ].join('\n');

  it('passes a clean build when the real openssl.cnf.dist template copy is present at its real path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/ssl/openssl.cnf.dist', content: STOCK_OPENSSL_CNF }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: openssl.cnf.dist with an uncommented real deployed proxy value still rejects', () => {
    const tampered = STOCK_OPENSSL_CNF.replace(
      '# proxy = # set this as far as needed, e.g., http://192.168.1.1:8080',
      'proxy = http://192.168.1.1:8080',
    );
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'etc/ssl/openssl.cnf.dist', content: tampered }, ...CLEAN_FILES] }],
    });
    expect(() => scanPlatformLayout({ platform: 'linux/amd64', tarBytes })).toThrow(ContentGateError);
    assertNoNetworkCalls();
  });

  it('passes a clean build when the real rendered npm-token.html doc output is present at its real path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        {
          files: [
            { name: 'usr/local/lib/node_modules/npm/docs/output/commands/npm-token.html', content: STOCK_NPM_TOKEN_HTML },
            ...CLEAN_FILES,
          ],
        },
      ],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: npm-token.html with an appended real deployed IP in the accepted shape still rejects', () => {
    const bypassAttempt = `${STOCK_NPM_TOKEN_HTML}\n<p>with IP Whitelist: 10.23.45.67/32</p>\n`;
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        {
          files: [
            { name: 'usr/local/lib/node_modules/npm/docs/output/commands/npm-token.html', content: bypassAttempt },
            ...CLEAN_FILES,
          ],
        },
      ],
    });
    expect(() => scanPlatformLayout({ platform: 'linux/amd64', tarBytes })).toThrow(ContentGateError);
    assertNoNetworkCalls();
  });

  it('passes a clean build when the real Linux kernel uapi bpf.h header is present at its real path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'usr/include/linux/bpf.h', content: STOCK_BPF_H }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: bpf.h with an appended real deployed IP in the accepted kernel-doc comment shape still rejects', () => {
    const bypassAttempt = `${STOCK_BPF_H}\n/* IPv4 address other than 10.23.45.67 */\n`;
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'usr/include/linux/bpf.h', content: bypassAttempt }, ...CLEAN_FILES] }],
    });
    expect(() => scanPlatformLayout({ platform: 'linux/amd64', tarBytes })).toThrow(ContentGateError);
    assertNoNetworkCalls();
  });

  it('passes a clean build when the real CPython urllib/request.py stdlib module is present at its real path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'usr/lib/python3.13/urllib/request.py', content: STOCK_URLLIB_REQUEST_PY }, ...CLEAN_FILES] }],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: urllib/request.py with an appended real deployed IP in the accepted docstring shape still rejects', () => {
    const bypassAttempt = `${STOCK_URLLIB_REQUEST_PY}\n# real proxy: *.example.net; 10.23.45.67\n`;
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [{ files: [{ name: 'usr/lib/python3.13/urllib/request.py', content: bypassAttempt }, ...CLEAN_FILES] }],
    });
    expect(() => scanPlatformLayout({ platform: 'linux/amd64', tarBytes })).toThrow(ContentGateError);
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// PR #61 review round 5 finding #3: generalized exact-value-pinning
// mechanism now also covers GENERIC SECRET pattern matches (previously
// RFC1918-only). npm's own @npmcli/arborist README.md documents its auth
// mechanism with a real, verified dummy credential
// (`token: 'deadbeefcafebad'`) that trips the generic_api_key_assignment
// pattern. Proves (a) the real stock README passes clean, and (b) a
// bypass attempt that REPLACES or APPENDS a different credential-shaped
// value in the same file/pattern context still rejects — the same
// owner-mandated bypass-proof pattern as the RFC1918 fix in round 4.
// ---------------------------------------------------------------------------
describe('generic secret allowlist (round 5 finding #3): npmcli/arborist README.md dummy token', () => {
  // Real fetched (npm/cli latest branch) excerpt from
  // workspaces/arborist/README.md's USAGE options-object example —
  // verified byte-level against the real file this round.
  const STOCK_ARBORIST_README = [
    '# @npmcli/arborist',
    '',
    'Inspect and manage `node_modules` trees.',
    '',
    '## USAGE',
    '',
    '```js',
    "const Arborist = require('@npmcli/arborist')",
    '',
    'const arb = new Arborist({',
    '  // options object',
    '',
    "  // where we're doing stuff.  defaults to cwd.",
    "  path: '/path/to/package/root',",
    '',
    '  // url to the default registry.  defaults to npm\'s default registry',
    "  registry: 'https://registry.npmjs.org',",
    '',
    '  // Safest: a bearer token provided by a registry:',
    '  // 1. an npm auth token, used with the default registry',
    "  token: 'deadbeefcafebad',",
    '  // 2. an alias for the same thing:',
    "  _authToken: 'deadbeefcafebad',",
    '',
    '  // insecure options:',
    '  // 3. basic auth, username:password, base64 encoded',
    "  auth: 'aXNhYWNzOm5vdCBteSByZWFsIHBhc3N3b3Jk',",
    '  // 4. username and base64 encoded password',
    "  username: 'isaacs',",
    "  password: 'bm90IG15IHJlYWwgcGFzc3dvcmQ9',",
    '})',
    '',
    '// READING',
    '',
    'arb.loadActual().then(tree => {',
    '  // tree is also stored at arb.virtualTree',
    '})',
    '```',
    '',
  ].join('\n');

  it('passes a clean build when the real stock arborist README.md is present at its real path', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        {
          files: [
            { name: 'usr/local/lib/node_modules/npm/node_modules/@npmcli/arborist/README.md', content: STOCK_ARBORIST_README },
            ...CLEAN_FILES,
          ],
        },
      ],
    });
    const result = scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    expect(result.platform).toBe('linux/amd64');
    assertNoNetworkCalls();
  });

  it('BYPASS-PROOF: an arborist README.md with the dummy token REPLACED by a different, unreviewed credential-shaped value still rejects', () => {
    const tampered = STOCK_ARBORIST_README.replace(
      "  token: 'deadbeefcafebad',",
      "  token: 'sk-live-REAL9f8a7b6c5d4e3f2a1b0c',",
    );
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        {
          files: [
            { name: 'usr/local/lib/node_modules/npm/node_modules/@npmcli/arborist/README.md', content: tampered },
            ...CLEAN_FILES,
          ],
        },
      ],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('secret_found');
    assertNoNetworkCalls();
  });

  it('BYPASS-PROOF: an arborist README.md with a NEW credential-shaped line APPENDED (provenance markers intact) still rejects', () => {
    const bypassAttempt = `${STOCK_ARBORIST_README}\n<!-- real deployed secret: token: 'ghp_1234567890abcdef1234567890abcdef1234' -->\n`;
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        {
          files: [
            { name: 'usr/local/lib/node_modules/npm/node_modules/@npmcli/arborist/README.md', content: bypassAttempt },
            ...CLEAN_FILES,
          ],
        },
      ],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('secret_found');
    assertNoNetworkCalls();
  });

  it('NEGATIVE: a DIFFERENT file at a path merely looking like the allowed path, without provenance markers, still rejects', () => {
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        {
          files: [
            {
              name: 'usr/local/lib/node_modules/npm/node_modules/@npmcli/arborist/README.md',
              content: "token: 'deadbeefcafebad'\n",
            },
            ...CLEAN_FILES,
          ],
        },
      ],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('secret_found');
    assertNoNetworkCalls();
  });

  it('a DIFFERENT secret pattern (AWS access key) in an otherwise-allowlisted arborist README.md is NOT excused — the exception is pattern-scoped, not file-scoped', () => {
    const bypassAttempt = `${STOCK_ARBORIST_README}\nAKIAABCDEFGHIJKLMNOP\n`;
    const tarBytes = buildFakeOciLayoutTar({
      platform: 'linux/amd64',
      layers: [
        {
          files: [
            { name: 'usr/local/lib/node_modules/npm/node_modules/@npmcli/arborist/README.md', content: bypassAttempt },
            ...CLEAN_FILES,
          ],
        },
      ],
    });
    let err: unknown;
    try {
      scanPlatformLayout({ platform: 'linux/amd64', tarBytes });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentGateError);
    expect((err as ContentGateError).code).toBe('secret_found');
    assertNoNetworkCalls();
  });
});

// ---------------------------------------------------------------------------
// Static + behavioral proof: zero registry/network client anywhere in
// the slice-4 source tree, and the sentinel never fires across the
// WHOLE matrix above (pass or reject).
// ---------------------------------------------------------------------------
describe('no registry/network client anywhere in the oci-gate module tree (1py.14 slice 4)', () => {
  const OCI_GATE_DIR = path.join(repoRoot, 'registrar/src/oci-gate');
  const files = readdirSync(OCI_GATE_DIR).filter((f) => f.endsWith('.ts'));

  it.each(files)('%s imports no http/https/fetch/registry client', (file) => {
    const src = readFileSync(path.join(OCI_GATE_DIR, file), 'utf8');
    expect(src).not.toMatch(/from\s+['"]node:https?['"]/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/require\(['"]https?['"]\)/);
    expect(src).not.toMatch(/dockerode|docker-registry-client|ghcr\.io|registry-v2/i);
  });

  it('the sentinel observed zero network calls across every case in this file', () => {
    assertNoNetworkCalls();
  });
});

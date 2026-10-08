import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tailscale overlay service guard (fleet-ops-6c2, epic j7g phase 1a).
 *
 * Both balena composes gain a `tailscale` service: one private overlay
 * network across the registrar (master) and devices fleets. The service
 * shape was settled in the fleet consult (unanimous, 2026-10-01) and is
 * DECIDED in the epic body — this test pins it so drift is a red CI run,
 * not a deploy-day discovery:
 *
 *   - official image at a PINNED tag (never :latest; arm64 verified in the
 *     registry index 2026-10-01; current stable = v1.102.5),
 *   - network_mode: host (tailscaled needs the host netns; no published
 *     ports — the overlay is private, funnel is ACL-denied),
 *   - cap_add net_admin + net_raw (the containerboot contract),
 *   - TS_STATE_DIR structural env + ts-state named volume (identity
 *     survives restarts — without it every restart is a NEW tailnet node),
 *   - io.balena.features.kernel-modules label (settled shape; the tun
 *     module is builtin on the current balenaOS 8 kernels, the label is
 *     the forward-proofing),
 *   - TS_AUTHKEY (service-scoped secret) and TS_HOSTNAME (device-scoped
 *     MagicDNS name) arrive as balenaCloud dashboard variables — never in
 *     this file, not even as stubs (f57.8: no secrets in compose),
 *   - no container_name (the balena supervisor rejects it),
 *   - devices: passthrough for /dev/net/tun — the AC1 pre-flight checked
 *     the HOST node, but balenaOS containers do NOT inherit host /dev
 *     (falsified live on release 4373489: containerboot fell back to
 *     --tun=userspace-networking, tstun "no such device" — inbound
 *     tailnet traffic impossible). The passthrough is load-bearing:
 *     containerboot's own ensureTunFile mknod fallback needs CAP_MKNOD,
 *     which this service deliberately does not grant,
 *   - TS_USERSPACE: "false" — containerboot at v1.102.5 defaults
 *     UserspaceMode TRUE (cmd/containerboot/settings.go:111,
 *     def.Bool(os.Getenv("TS_USERSPACE"), true)); the passthrough alone
 *     would still boot userspace. "false" parses via strconv.ParseBool
 *     (util/def/def.go),
 *   - TS_BOOT_TIMEOUT: structural long boot deadline — v1.102.5's 60s
 *     default IPN-bus watch expires on a keyless NeedsLogin park and
 *     exits 1 → supervisor restart-loop ~61s (pinned live: 157 restarts
 *     on optimus-prime, 34 on the master). A long park keeps the
 *     container Running until the owner's TS_AUTHKEY lands (the
 *     supervisor recreates the container with the new env),
 *   - process-liveness healthcheck (kill -0 1) — join state is canary
 *     evidence (`tailscale status` shows the tailnet IP), not a
 *     healthcheck question, same marker-vs-liveness split as the rest
 *     of the composition,
 *   - the service block is BYTE-IDENTICAL in both composes (one shape,
 *     two files, no drift).
 *
 * Full-line comments are stripped before scanning, so the two files may
 * carry different documentation prose above the same service spec.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const composes = [
  'balena/registrar/docker-compose.yml',
  'balena/devices/docker-compose.yml',
];

/** File with full-line (`#`-prefixed) comment lines removed. */
function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Slice one `  <name>:` service block out of a compose. Services sit at
 * 2-space indent; the block ends at the next 2-space key, the next
 * top-level key (e.g. `volumes:`), or EOF. Returns '' when absent.
 */
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

describe.each(composes)('tailscale overlay service: %s', (rel) => {
  const code = stripComments(readFileSync(path.join(repoRoot, rel), 'utf8'));
  const ts = serviceBlock(code, 'tailscale');

  it('declares the tailscale service', () => {
    expect(ts).not.toBe('');
  });

  it('pins the official image at a fixed tag (never :latest)', () => {
    // lnf: the master BUILDS the serve image FROM this pin
    // (Dockerfile.tailscale) — either a direct `image:` pin (devices)
    // or a build whose FROM is the pin (master) satisfies the guard.
    expect(
      /^    image: tailscale\/tailscale:v1\.102\.5$/m.test(ts) ||
        /dockerfile: Dockerfile\.tailscale/.test(ts),
    ).toBe(true);
    expect(ts).not.toMatch(/:latest/);
  });

  it('runs on the host network namespace', () => {
    expect(ts).toMatch(/^    network_mode: host$/m);
  });

  it('carries net_admin + net_raw capabilities', () => {
    expect(ts).toMatch(/^      - net_admin$/m);
    expect(ts).toMatch(/^      - net_raw$/m);
  });

  it('ships only structural env (TS_STATE_DIR, TS_USERSPACE, TS_BOOT_TIMEOUT); secrets arrive as dashboard variables', () => {
    expect(ts).toMatch(/^      TS_STATE_DIR: \/var\/lib\/tailscale$/m);
    // f57.8: no secrets in compose — not even as empty stubs.
    expect(ts).not.toMatch(/TS_AUTHKEY/);
    expect(ts).not.toMatch(/TS_HOSTNAME/);
  });

  it('persists tailnet identity on the ts-state named volume', () => {
    expect(ts).toMatch(/^      - ts-state:\/var\/lib\/tailscale$/m);
    // The volume is declared in the compose's top-level volumes section.
    expect(code).toMatch(/^volumes:\n(?:  .*?\n)*?  ts-state:\s*$/m);
  });

  it('carries the kernel-modules feature label', () => {
    expect(ts).toMatch(/^      io\.balena\.features\.kernel-modules: "1"$/m);
  });

  it('uses no container_name (balena supervisor rejects it)', () => {
    expect(ts).not.toMatch(/container_name/);
  });

  it('publishes no ports — host network, private overlay, funnel denied', () => {
    expect(ts).not.toMatch(/^\s*ports:/m);
  });

  it('ships the /dev/net/tun passthrough (balenaOS containers do not inherit host /dev)', () => {
    // Host pre-flight is not container fact: on release 4373489 the
    // host had /dev/net/tun yet the container fell back to
    // --tun=userspace-networking ("tstun: no such device"). Inbound
    // tailnet traffic needs kernel tun — the passthrough is required.
    expect(ts).toMatch(/^    devices:$/m);
    expect(ts).toMatch(/^      - \/dev\/net\/tun$/m);
  });

  it('forces kernel tun with TS_USERSPACE=false (containerboot defaults userspace TRUE at v1.102.5)', () => {
    expect(ts).toMatch(/^      TS_USERSPACE: "false"$/m);
  });

  it('parks keyless boots instead of crashlooping (TS_BOOT_TIMEOUT beats the 60s default)', () => {
    // v1.102.5 default: the IPN-bus watch dies at 60s on a keyless
    // NeedsLogin park → exit 1 → supervisor restart-loop. A long
    // structural deadline keeps the container Running until the
    // owner's TS_AUTHKEY lands (recreate + join).
    expect(ts).toMatch(/^      TS_BOOT_TIMEOUT: "24h"$/m);
  });

  it('healthchecks process liveness only (join state is canary evidence)', () => {
    expect(ts).toMatch(/kill -0 1/);
    expect(ts).toMatch(/^    restart: always$/m);
  });
});

describe('tailscale overlay service: the deliberate master/devices delta (lnf + j7g.1)', () => {
  const blocks = composes.map((rel) => {
    const code = stripComments(readFileSync(path.join(repoRoot, rel), 'utf8'));
    return serviceBlock(code, 'tailscale');
  });

  it('both fleets BUILD the serve image and declare TS_SERVE_CONFIG (j7g.1: the devices serve their agent origin)', () => {
    // lnf (j7g phase 2): the master's tailscale service BUILDS the
    // serve image + declares TS_SERVE_CONFIG (fronting registrar :443,
    // gateway :8443, scotty :8444). j7g.1 (the owner's AC3 live-leg
    // origin decision) extends the SAME serve-only TLS edge pattern to
    // the devices fleet: the devices' tailscale service becomes a BUILD
    // too (Dockerfile.tailscale + serve-config.json in balena/devices),
    // fronting the agent's A2A origin at :9900 — keyed on the
    // ${TS_CERT_DOMAIN} placeholder so each of the N devices serves at
    // its own MagicDNS name. Everything else — image tag lineage,
    // network_mode, caps, tun passthrough, state volume, structural
    // env, healthcheck posture — is the ONE 6c2 service shape, and the
    // shared lines must stay identical so a future edit to the join
    // contract lands in BOTH blocks.
    const [master, devices] = blocks;
    expect(master).not.toBe('');
    expect(devices).not.toBe('');
    expect(master).toMatch(/dockerfile: Dockerfile\.tailscale/);
    expect(master).toMatch(/TS_SERVE_CONFIG: \/serve-config\.json/);
    expect(devices).toMatch(/dockerfile: Dockerfile\.tailscale/);
    expect(devices).toMatch(/TS_SERVE_CONFIG: \/serve-config\.json/);
    // the shared join contract: identical lines modulo the serve delta
    const stripServe = (b: string) =>
      b.split('\n').filter((l) =>
        !/dockerfile: Dockerfile\.tailscale/.test(l) &&
        !/build:/.test(l) &&
        !/context: \./.test(l) &&
        !/TS_SERVE_CONFIG/.test(l),
      );
    expect(stripServe(master)).toEqual(stripServe(devices));
  });
});
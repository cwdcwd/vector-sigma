import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * MagicDNS endpoint-flip guard (fleet-ops-lrb, j7g phase 1b;
 * REWORKED fleet-ops-lnf, phase 2 — the serve-only edge).
 *
 * The fleet's endpoint contract flipped (phase 1b) to the tailnet's
 * MagicDNS name; the canary (2026-10-02) DECIDED the mechanism:
 *
 *   - URLs keep the canonical MagicDNS name (REGISTRAR_URL,
 *     GATEWAY_URL, A2A_PUBLIC_URL — fleet variables).
 *   - In-container resolution is PINNED, not resolved: the container
 *     DNS chain has no ts.net route and accept-dns cannot reach the
 *     host dnsmasq chain from tailscaled's mount namespace, so the
 *     composes pin the name to the master's tailnet IP via
 *     extra_hosts (supervisor-supported, no ${VAR} path).
 *
 * lnf (phase 2) carries the same contract FORWARD unchanged — the
 * flipped URLs keep working because the serve edge fronts the SAME
 * names at the SAME ports; the pins stay load-bearing. What RETIRED
 * with caddy: the Caddyfile site aliases (the Caddyfile is deleted)
 * and the TS_MASTER_DNS variable (the serve config bakes the FQDN
 * literally).
 *
 * This test pins:
 *   1. The extra_hosts pin pair — byte-identical on every URL
 *      consumer: devices compose agent + registrant (REGISTRAR_URL),
 *      registrar compose hermes (GATEWAY_URL/A2A_PUBLIC_URL).
 *   2. The pin stays per-need: services that talk compose-internal
 *      names carry no pin.
 *   3. Provision-then-flip: no compose ships a flipped URL value.
 *   4. The serve config (the edge's fronting) keys on the SAME FQDN
 *      the pins carry — one name, every surface.
 *
 * Full-line comments are stripped before scanning.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

const PIN_NAME = 'vector-sigma.tailb7207e.ts.net';
const PIN_IP = '100.124.197.78';
const PIN_LINE = `${PIN_NAME}:${PIN_IP}`;

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

const balenaRegistrar = stripComments(
  read('balena/registrar/docker-compose.yml'),
);
const balenaDevices = stripComments(read('balena/devices/docker-compose.yml'));
const deployCompose = stripComments(read('deploy/compose.yaml'));

describe.each([
  ['balena/registrar/docker-compose.yml', balenaRegistrar],
  ['balena/devices/docker-compose.yml', balenaDevices],
] as const)('extra_hosts pin: %s', (_rel, code) => {
  it('carries the pin pair exactly where the flipped URLs are consumed', () => {
    // registrar compose: hermes (gateway/A2A URL consumer);
    // devices compose: agent + registrant (REGISTRAR_URL consumers).
    const sites =
      code === balenaRegistrar ? ['hermes'] : ['agent', 'registrant'];
    for (const site of sites) {
      const block = serviceBlock(code, site);
      expect(block, `service ${site}`).toMatch(
        new RegExp(`^\\s*- "${PIN_NAME.replace(/\./g, '\\.')}:${PIN_IP}"$`, 'm'),
      );
    }
  });

  it('pins the pin to the URL consumers only (no blanket fleet pin)', () => {
    // The pin is per-need: a service that talks compose-internal names
    // (postgres, litellm, scotty, dolt, registrar, tailscale,
    // registrant-own) must NOT gain it.
    const internal = [
      'postgres',
      'registrar',
      'litellm',
      'dolt',
      'scotty',
      'registrant-own',
      'tailscale',
    ];
    for (const svc of internal) {
      const block = serviceBlock(code, svc);
      expect(block, `service ${svc}`).not.toContain('extra_hosts');
    }
  });
});

describe('the serve edge keys on the SAME FQDN the pins carry (lnf)', () => {
  it('serve-config.json keys every fronted surface on the pinned name', () => {
    const sc = JSON.parse(read('balena/registrar/serve-config.json'));
    for (const key of Object.keys(sc.Web)) {
      expect(key.startsWith(`${PIN_NAME}:`)).toBe(true);
    }
  });
});

describe('provision-then-flip: no flipped URL ships in any compose (lrb)', () => {
  it('master compose REGISTRAR_URL stays compose-internal http', () => {
    const own = serviceBlock(balenaRegistrar, 'registrant-own');
    expect(own).toMatch(/REGISTRAR_URL: http:\/\/registrar:3000/);
    expect(own).not.toMatch(/ts\.net/);
  });

  it('no compose anywhere ships a ts.net URL (the flip is a fleet variable)', () => {
    for (const [rel, code] of [
      ['balena/registrar/docker-compose.yml', balenaRegistrar],
      ['balena/devices/docker-compose.yml', balenaDevices],
      ['deploy/compose.yaml', deployCompose],
    ] as const) {
      expect(code, rel).not.toMatch(/https?:\/\/[^\s"']*ts\.net/);
    }
  });

  it('deploy twin carries no extra_hosts pin (no tailnet in the self-host world)', () => {
    expect(deployCompose).not.toContain('extra_hosts');
  });
});
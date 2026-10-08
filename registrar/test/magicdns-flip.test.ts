import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * MagicDNS endpoint-flip guard (fleet-ops-lrb, j7g phase 1b;
 * REWORKED fleet-ops-lnf, phase 2 — the serve-only edge;
 * REWORKED fleet-ops-lfk — the proxy-dial pin).
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
 * lfk (2026-10-08) ADDS the proxy-dial pin: the litellm service —
 * the A2A proxy — gained a ts.net DIALING role (it follows a
 * registered agent's origin card and dials the advertised url, the
 * master's own name AND each enrolled device's serve name), so the
 * URL-consumer rule now covers it too. The pin set a service needs
 * is written for the ROLES it holds, not blanket; postgres/dolt/
 * scotty/registrar/registrant-own/tailscale still carry no pin (no
 * ts.net dialing role).
 *
 * This test pins:
 *   1. The extra_hosts pin pair — byte-identical on every URL
 *      consumer: devices compose agent + registrant (REGISTRAR_URL),
 *      registrar compose hermes (GATEWAY_URL/A2A_PUBLIC_URL).
 *   2. The litellm proxy-dial pins (lfk): the master's own name +
 *      every ENROLLED device serve name, one line each.
 *   3. The pin stays per-need: services with no ts.net dialing role
 *      carry no pin.
 *   4. Provision-then-flip: no compose ships a flipped URL value.
 *   5. The serve config (the edge's fronting) keys on the SAME FQDN
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

  it('lfk: the litellm proxy dials ts.net too — its pin set covers the roles (master edge host + enrolled device serve names)', () => {
    // The A2A proxy (litellm) follows a registered agent's origin card
    // and dials the ADVERTISED url: the master's own MagicDNS name and
    // each enrolled device's serve name. Without the pin every dial
    // died gaierror (live-proven 2026-10-08, Defect A).
    if (code !== balenaRegistrar) return; // the proxy lives on the master
    const block = serviceBlock(code, 'litellm');
    expect(block).toContain('extra_hosts');
    // the master's own name (the card-rewrite host):
    expect(block).toMatch(
      new RegExp(`^\\s*- "${PIN_NAME.replace(/\./g, '\\.')}:${PIN_IP}"$`, 'm'),
    );
    // every ENROLLED device serve name carries a pin line (one per
    // device — extra_hosts has no substitution path under the
    // supervisor; the enrolled set today: optimus-prime):
    expect(block).toMatch(
      /^\s*- "optimus-prime\.tailb7207e\.ts\.net:100\.99\.56\.18"$/m,
    );
  });

  it('pins the pin to the URL/dial consumers only (no blanket fleet pin)', () => {
    // The pin is per-need, written for the ROLES a service holds:
    // compose-internal-only services carry no pin. litellm gained a
    // ts.net DIALING role at lfk and is pinned (the test above);
    // these hold no ts.net role at all:
    const internal = [
      'postgres',
      'registrar',
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
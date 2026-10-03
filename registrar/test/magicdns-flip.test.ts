import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * MagicDNS endpoint flip guard (fleet-ops-lrb, epic j7g phase 1b).
 *
 * The fleet's endpoint contract flips from the LAN name to the tailnet's
 * MagicDNS name so devices in DIFFERENT LOCATIONS reach the master. The
 * lane's canary (2026-10-02, evidence on the bead) DECIDED the mechanism:
 *
 *   - URLs keep the canonical MagicDNS name (REGISTRAR_URL,
 *     GATEWAY_URL, A2A_PUBLIC_URL — fleet variables, flipped by the
 *     coordinator AFTER this release ships).
 *   - In-container resolution is pinned, NOT resolved: the container DNS
 *     chain (embedded 127.0.0.11 -> host dnsmasq -> upstream) has NO
 *     ts.net route, and the ts resolver (100.100.100.100) refuses all
 *     non-tailnet names ESERVFAIL; accept-dns cannot help (tailscaled
 *     rewrites only its OWN mount namespace's resolv.conf, never the
 *     host dnsmasq chain the containers inherit). So the compose pins
 *     the name to the master's tailnet IP via extra_hosts —
 *     supervisor-supported (docs.balena.io compose-fields table).
 *   - The pin pair is the DECIDED static pair: the master's MagicDNS
 *     FQDN and its tailnet IP. extra_hosts has no ${VAR} path under
 *     the balena supervisor, so the values are structural literals in
 *     the composes (never secrets; the tailnet is ACL-gated).
 *
 * Provision-then-flip (the f57.9 hazard class): caddy must SERVE the
 * MagicDNS name — site alias + internal-CA leaf — BEFORE any device's
 * variables flip to it. The AC2 pre-flip canary proved the hazard live:
 * TLS alert 80 on 443/8443 for the MagicDNS SNI. This release ships
 * the aliases; the variable flip rides a later coordinator step, so
 * this test pins the ordering contract structurally: the aliases exist
 * in the SAME release as the pins, and the flipped-URL variables stay
 * UNSET in these files (they arrive as balenaCloud variables only).
 *
 * This test pins, so drift is a red CI run, not a flip-day discovery:
 *   1. Caddyfile: ALL THREE fronted sites (443 registrar, 8443 gateway,
 *      8444 scotty) carry the MagicDNS alias as a second site address,
 *      via {$TS_MASTER_DNS:<default>} substitution — same mechanism +
 *      default shape as TLS_HOSTNAME (structural, not a secret).
 *   2. balena/registrar compose: hermes (the master-side consumer of
 *      the flipped gateway/A2A URLs) carries the pin; the caddy service
 *      carries the TS_MASTER_DNS structural env.
 *   3. balena/devices compose: agent + registrant (the consumers whose
 *      REGISTRAR_URL flips) BOTH carry the pin — byte-identical pair.
 *   4. deploy/ self-host twin: caddy carries the TS_MASTER_DNS env with
 *      its ${VAR:-default} interpolation dialect; NO pins anywhere in
 *      deploy/ (the self-host world has no tailnet by construction).
 *   5. No compose ships a flipped URL value: REGISTRAR_URL stays the
 *      compose-internal http://registrar:3000 (the flip is a fleet
 *      variable, a coordinator step AFTER this release).
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

const caddyfile = stripComments(read('balena/registrar/Caddyfile'));
const balenaRegistrar = stripComments(
  read('balena/registrar/docker-compose.yml'),
);
const balenaDevices = stripComments(read('balena/devices/docker-compose.yml'));
const deployCompose = stripComments(read('deploy/compose.yaml'));

describe('Caddyfile: MagicDNS aliases on every fronted site (lrb)', () => {
  it('registrar site (443) carries the MagicDNS alias', () => {
    expect(caddyfile).toMatch(
      /\{\$TLS_HOSTNAME:vsigma\.lan\}, \{\$TS_MASTER_DNS:[^}]+\} \{/,
    );
  });

  it('gateway site (8443) carries the MagicDNS alias', () => {
    expect(caddyfile).toMatch(
      /\{\$TLS_HOSTNAME:vsigma\.lan\}:8443, \{\$TS_MASTER_DNS:[^}]+\}:8443 \{/,
    );
  });

  it('scotty site (8444) carries the MagicDNS alias', () => {
    expect(caddyfile).toMatch(
      /\{\$TLS_HOSTNAME:vsigma\.lan\}:8444, \{\$TS_MASTER_DNS:[^}]+\}:8444 \{/,
    );
  });

  it('the alias substitution carries a structural default (never a secret)', () => {
    expect(caddyfile).toMatch(
      new RegExp(
        `\\{\\$TS_MASTER_DNS:${PIN_NAME.replace(/\./g, '\\.')}\\}`,
      ),
    );
  });

  it('port 80 redirect sites stay on the LAN hostname only (no overlay alias)', () => {
    // The :80 redirect pair is Host-generic already ({host} catch-all); the
    // aliases live on the TLS sites only. A ts.net name on port 80 would be
    // dead config — http://<MagicDNS>:80 is never the flip target.
    expect(caddyfile).not.toMatch(/http:\/\/\{\$TS_MASTER_DNS/);
  });
});

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
    // (postgres, litellm, scotty, dolt, registrar, caddy, tailscale,
    // registrant-own) must NOT gain it — the pin is for the flipped
    // public-name consumers only.
    const internal = [
      'postgres',
      'registrar',
      'litellm',
      'dolt',
      'scotty',
      'registrant-own',
      'tailscale',
      'caddy',
    ];
    for (const svc of internal) {
      const block = serviceBlock(code, svc);
      expect(block, `service ${svc}`).not.toContain('extra_hosts');
    }
  });
});

describe('caddy TS_MASTER_DNS env (the substitution source)', () => {
  it('balena registrar compose ships the structural env value', () => {
    const caddy = serviceBlock(balenaRegistrar, 'caddy');
    expect(caddy).toMatch(/TS_MASTER_DNS: vector-sigma\.tailb7207e\.ts\.net/);
  });

  it('deploy twin ships the interpolation-dialect env value', () => {
    const caddy = serviceBlock(deployCompose, 'caddy');
    expect(caddy).toMatch(
      /TS_MASTER_DNS: \$\{TS_MASTER_DNS:-vector-sigma\.tailb7207e\.ts\.net\}/,
    );
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
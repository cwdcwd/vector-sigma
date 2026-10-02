import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Scotty TLS fronting guard (fleet-ops-77i, epic j7g phase 1c).
 *
 * The scotty queue UI was the composition's widest exposure: raw
 * unauthenticated HTTP published on host :3306 to the LAN. This lane
 * fronts it behind caddy on 8444 with basic_auth (D2 green-lit: it
 * covers an ACL misconfiguration on an otherwise unauthenticated
 * read-only UI) and DROPS the raw :3306 host publish in the SAME
 * release — the same-release rule is the lane's consult major
 * (published-port changes are consumer breaks; add+verify 8444 and
 * remove :3306 together, never split).
 *
 * Port map after: 443 registrar, 8443 gateway, 8444 scotty —
 * port-per-service (LiteLLM derives card URLs from Host; path prefixes
 * break /ui).
 *
 * This test pins:
 *   1. Caddyfile: the scotty stanza is LIVE (not a comment), serves
 *      {$TLS_HOSTNAME}:8444 with `tls internal`, proxies to the
 *      in-container scotty:3306 (NOT the drifted scotty:8080), and
 *      carries basic_auth with the hash from a fleet variable
 *      (SCOTTY_BASIC_AUTH_HASH — owner-minted; the README table).
 *   2. BOTH compose twins: caddy publishes 8444:8444; scotty's
 *      3306:3306 host publish is GONE (its compose-internal 3306
 *      listener is untouched — scotty's healthcheck and bd bridge ride
 *      the compose network, never the host publish).
 *   3. The balena/deploy dialects are preserved (no $$ introduced in
 *      the balena twin's caddy healthcheck).
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

const caddyfile = stripComments(
  readFileSync(path.join(repoRoot, 'balena/registrar/Caddyfile'), 'utf8'),
);

describe('Caddyfile: scotty fronted on 8444 (77i)', () => {
  it('has a live scotty site stanza (the placeholder is gone)', () => {
    expect(caddyfile).toMatch(/\{\$TLS_HOSTNAME:vsigma\.lan\}:8444 \{/);
    expect(caddyfile).not.toMatch(/# \{\$TLS_HOSTNAME:vsigma\.lan\}:8444/);
  });

  it('serves scotty over the internal CA (tls internal)', () => {
    const stanza = caddyfile.match(
      /\{\$TLS_HOSTNAME:vsigma\.lan\}:8444 \{[\s\S]*?\n\}/,
    );
    expect(stanza).not.toBeNull();
    expect(stanza![0]).toMatch(/\ttls internal/);
  });

  it('proxies to the in-container scotty:3306, never the drifted :8080', () => {
    expect(caddyfile).toMatch(/reverse_proxy scotty:3306/);
    expect(caddyfile).not.toMatch(/scotty:8080/);
  });

  it('carries basic_auth with the hash from the SCOTTY_BASIC_AUTH_HASH fleet variable', () => {
    expect(caddyfile).toMatch(/basic_auth \{/);
    // Bare {$VAR} — NO default: an unset variable fails caddy's adapt
    // loudly (fail-loud gate, LITELLM_MASTER_KEY precedent).
    expect(caddyfile).toMatch(
      /owner \{\$SCOTTY_BASIC_AUTH_HASH\}/,
    );
    // No plaintext or literal hash may ship in the repo file.
    expect(caddyfile).not.toMatch(/\$2a\$/);
    expect(caddyfile).not.toMatch(/\$argon2/);
  });
});

describe.each([
  ['balena/registrar/docker-compose.yml', 'balena'],
  ['deploy/compose.yaml', 'deploy'],
])('scotty port flip: %s', (rel, dialect) => {
  const raw = readFileSync(path.join(repoRoot, rel), 'utf8');
  const code = stripComments(raw);

  function serviceBlock(name: string): string {
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

  it('caddy publishes 8444:8444 (scotty front door)', () => {
    expect(serviceBlock('caddy')).toMatch(/- "8444:8444"/);
  });

  it('scotty no longer publishes raw 3306:3306 to the host (same release)', () => {
    const scotty = serviceBlock('scotty');
    expect(scotty).not.toMatch(/^\s*- "3306:3306"$/m);
    expect(scotty).not.toMatch(/ports:/);
    // The compose-internal listener is untouched: scotty still runs its
    // healthcheck against in-container 127.0.0.1:3306.
    expect(scotty).toMatch(/127\.0\.0\.1:3306\/api\/projects/);
  });

  it(`${dialect} dialect preserved: caddy healthcheck carries no $$`, () => {
    if (dialect === 'balena') {
      expect(serviceBlock('caddy')).not.toMatch(/\$\$/);
    } else {
      expect(serviceBlock('caddy')).toMatch(/\$\$/);
    }
  });
});
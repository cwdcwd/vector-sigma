import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Balena Dockerfile builder-contract guard (fleet-ops-f57.21).
 *
 * Automatic population of TARGETARCH / TARGETPLATFORM is a BuildKit-only
 * feature. balena's remote builder uses the LEGACY builder, which sets
 * neither ARG — any Dockerfile that interpolates them builds fine under
 * local docker + CI (both BuildKit) and then breaks on the balena deploy
 * with an empty arch. registrar-v1.1.1 deploy run 36205380041 failed
 * exactly this way:
 *   ADD failed: failed to GET
 *   .../beads_1.2.2_linux_.tar.gz with status 404
 * (note linux_ with the EMPTY arch). The fix derives the arch at build
 * time from uname -m instead. This guard pins the contract: NO
 * TARGETARCH/TARGETPLATFORM token may appear (declared or interpolated)
 * in ANY Dockerfile under balena/** — present or future.
 *
 * Full-line comments are stripped before scanning: documentation comments
 * legitimately mention these tokens (this file's own history lives in the
 * Dockerfile.scotty header), only live instructions bind.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const balenaDir = path.join(repoRoot, 'balena');

/** BuildKit-only, auto-populated ARG tokens — banned in balena Dockerfiles. */
const FORBIDDEN_TOKENS = ['TARGETARCH', 'TARGETPLATFORM'] as const;

/** File with full-line (`#`-prefixed) comment lines removed. */
function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Recursively collect every Dockerfile* under balena/** (sorted for stable titles). */
function collectDockerfiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectDockerfiles(full));
    // Dockerfile* prefix: catches bare `Dockerfile` AND stage-suffixed
    // variants (`Dockerfile.scotty`) — the suffix form is where f57.21 lived.
    else if (entry.isFile() && entry.name.startsWith('Dockerfile')) out.push(full);
  }
  return out.sort();
}

const dockerfiles = collectDockerfiles(balenaDir);

describe('balena builder contract: Dockerfile inventory', () => {
  it('guards a non-empty set of balena Dockerfiles (guard is not vacuous)', () => {
    // 8 Dockerfiles exist at f57.21; if this drops to zero the recursion or
    // the repo layout changed and the per-file guard below would silently
    // stop covering anything.
    expect(dockerfiles.length).toBeGreaterThanOrEqual(8);
  });
});

describe.each(dockerfiles)('balena builder contract: %s', (abs) => {
  const rel = path.relative(repoRoot, abs);
  const code = stripComments(readFileSync(abs, 'utf8'));

  it.each(FORBIDDEN_TOKENS)(
    'uses no BuildKit-only auto-populated ARG token: %s',
    (token) => {
      // Contains the file + token in the failure message so a RED run names
      // the offending Dockerfile and token — the bug signature.
      expect(code, `${rel} uses BuildKit-only ARG token ${token}`).not.toContain(token);
    },
  );
});
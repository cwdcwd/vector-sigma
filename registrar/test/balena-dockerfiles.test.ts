import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../../scripts/image-catalog.mjs';

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
 * in ANY Dockerfile under balena/** or named by images.json — present or
 * future. (Releases now ship CI-built prebuilts, but the arch derivation
 * stays builder-agnostic so any image can still build under either.)
 *
 * Full-line comments are stripped before scanning: documentation comments
 * legitimately mention these tokens (this file's own history lives in the
 * images/scotty/Dockerfile header), only live instructions bind.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const imagesDir = path.join(repoRoot, 'images');

/** BuildKit-only, auto-populated ARG tokens — banned in balena Dockerfiles. */
const FORBIDDEN_TOKENS = ['TARGETARCH', 'TARGETPLATFORM'] as const;

/** File with full-line (`#`-prefixed) comment lines removed. */
function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Recursively collect every Dockerfile* under images/** (sorted for stable titles). */
function collectDockerfiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectDockerfiles(full));
    // Dockerfile* prefix: catches bare `Dockerfile` AND stage-suffixed
    // variants (`images/scotty/Dockerfile`) — the suffix form is where f57.21 lived.
    else if (entry.isFile() && entry.name.startsWith('Dockerfile')) out.push(full);
  }
  return out.sort();
}

const catalogDockerfiles = Object.values(
  loadCatalog(repoRoot).components as Record<string, { dockerfile: string }>,
).map((c) => path.join(repoRoot, c.dockerfile));
const dockerfiles = [...new Set([...collectDockerfiles(imagesDir), ...catalogDockerfiles])].sort();

describe('balena builder contract: Dockerfile inventory', () => {
  it('guards every image Dockerfile (guard is not vacuous)', () => {
    // 9 catalog images from 9 Dockerfiles; if the inventory shrinks below
    // the catalog, the per-file guard below would silently stop covering
    // a shipped image.
    expect(dockerfiles.length).toBeGreaterThanOrEqual(9);
    for (const df of catalogDockerfiles) expect(dockerfiles).toContain(df);
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
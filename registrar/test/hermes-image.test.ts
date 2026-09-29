import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Primus image contract guard (fleet-ops-b1r, owner ruling 2026-09-29:
 * "get these things into the codebase" — bake, don't runtime-install).
 *
 * The hermes service builds balena/registrar/Dockerfile.hermes — the
 * pinned official Hermes image plus bd 1.2.2 (full read-write — primus
 * is the queue CURATOR), the config-only queue join, the environment
 * docs, and the 03-vs-queue-join boot hook. This guard pins:
 *
 *   1. BOTH composes build the SAME Dockerfile (one artifact, no twin
 *      drift) — the balena app compose AND the deploy compose.
 *   2. the FROM pin is the official v2026.9.21 tag (parity with the
 *      pre-b1r image: line; do NOT bump independently).
 *   3. bd is baked at the fleet pin 1.2.2, tarball+checksums-verified,
 *      fail-loud, arch derived from uname -m (legacy-builder-safe).
 *   4. the read-only wrapper posture is NOT applied (bd-readonly is
 *      scotty's contract, never primus's).
 *   5. the queue join carries the CANONICAL project_id (the fleet
 *      contract, never regenerated) and the compose-service dolt host
 *      + port 3306 — the join the boot hook seeds at first boot.
 *   6. the docs are vendored byte-exact into the app dir (docs/ at the
 *      repo root is the source of truth — the vendored-drift pattern)
 *      and baked at /opt/vs/docs.
 *   7. the boot hook exists, is fail-soft, first-boot-only, and is
 *      wired as a cont-init script AFTER stage2 (the with-contenv
 *      shape, 03- prefix).
 *   8. the hermes service environment carries BEADS_DOLT_PASSWORD
 *      (the scotty posture: same secret as DOLT_PASSWORD, the env key
 *      bd reads; never baked into image layers).
 *   9. the devices app carries the forward shape (Dockerfile.agent-
 *      hermes documenting the pattern copy for the runtime-swap lane).
 *
 * Full-line comments are stripped where doc comments legitimately name
 * the forbidden tokens (the arch lesson is documented in the header).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/** File with full-line (`#`-prefixed) comment lines removed. */
function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const appDir = path.join(repoRoot, 'balena/registrar');
const dockerfile = readFileSync(path.join(appDir, 'Dockerfile.hermes'), 'utf8');
const dockerfileCode = stripComments(dockerfile);
const balenaCompose = stripComments(
  readFileSync(path.join(repoRoot, 'balena/registrar/docker-compose.yml'), 'utf8'),
);
const deployCompose = stripComments(
  readFileSync(path.join(repoRoot, 'deploy/compose.yaml'), 'utf8'),
);
const e2eOverlay = stripComments(
  readFileSync(path.join(repoRoot, 'deploy/compose.e2e.yaml'), 'utf8'),
);

/** Extract a top-level service block (2-space indent) from a compose. */
function serviceBlock(code: string, name: string): string {
  const m = new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|\\n\\w|\\Z|^$)`, 'm').exec(code);
  return m ? m[1] : '';
}

describe('primus image contract (fleet-ops-b1r)', () => {
  it('Dockerfile.hermes exists and carries the pinned official base', () => {
    expect(existsSync(path.join(appDir, 'Dockerfile.hermes'))).toBe(true);
    expect(dockerfile).toMatch(
      /FROM nousresearch\/hermes-agent:v2026\.9\.21/,
    );
    // The pin comment is load-bearing documentation, not decoration.
    expect(dockerfile).toMatch(/do NOT bump/);
  });

  it('bakes bd at the fleet pin 1.2.2, checksums-verified, fail-loud', () => {
    expect(dockerfileCode).toMatch(/ARG BD_VERSION=1\.2\.2/);
    expect(dockerfileCode).toMatch(/gastownhall\/beads\/releases\/download\/v\$\{BD_VERSION\}\/checksums\.txt/);
    expect(dockerfileCode).toMatch(/beads_\$\{BD_VERSION\}_linux_\$\{arch\}\.tar\.gz/);
    expect(dockerfileCode).toMatch(/sha256sum/);
    expect(dockerfileCode).toMatch(/exit 1/);
  });

  it('derives the release arch from uname -m (legacy-builder-safe, no TARGETARCH)', () => {
    expect(dockerfileCode).toMatch(/arch="\$\(uname -m\)"/);
    expect(dockerfileCode).not.toContain('TARGETARCH');
    expect(dockerfileCode).not.toContain('TARGETPLATFORM');
  });

  it('installs bd full read-write at /usr/local/bin/bd — NOT the bd-readonly wrapper posture', () => {
    // The wrapper posture is scotty's read-only contract. Primus is the
    // CURATOR: the Dockerfile must install the real binary directly.
    expect(dockerfileCode).toMatch(/mv \/tmp\/bd \/usr\/local\/bin\/bd/);
    expect(dockerfileCode).not.toMatch(/bd-readonly/);
    expect(dockerfileCode).not.toMatch(/bd\.real/);
  });

  it('bakes the queue join config with the canonical project contract', () => {
    const meta = JSON.parse(
      readFileSync(path.join(appDir, 'queue-join/.beads/metadata.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(meta.project_id).toBe('bcde5891-5482-4eb0-a223-8533504832d6');
    expect(meta.dolt_server_host).toBe('dolt');
    expect(meta.dolt_server_port).toBe(3306);
    expect(meta.dolt_server_user).toBe('vs');
    expect(meta.dolt_database).toBe('vs_ops');
    expect(dockerfileCode).toMatch(/COPY queue-join \/opt\/vs\/queue-join/);
  });

  it('bakes the vendored docs (queue-conventions + vs-environment) at /opt/vs/docs', () => {
    expect(dockerfileCode).toMatch(/COPY docs \/opt\/vs\/docs/);
    expect(existsSync(path.join(appDir, 'docs/queue-conventions.md'))).toBe(true);
    expect(existsSync(path.join(appDir, 'docs/vs-environment.md'))).toBe(true);
    // Vendored byte-exact vs the repo-root docs (the source of truth).
    for (const doc of ['queue-conventions.md', 'vs-environment.md']) {
      const a = readFileSync(path.join(repoRoot, 'docs', doc), 'utf8');
      const b = readFileSync(path.join(appDir, 'docs', doc), 'utf8');
      expect(a === b, `vendored docs/${doc} drifted from docs/${doc}`).toBe(true);
    }
  });

  it('wires the boot hook as a cont-init script after stage2, with-contenv shape', () => {
    expect(dockerfileCode).toMatch(/COPY vs-queue-join\.sh \/etc\/cont-init\.d\/03-vs-queue-join/);
    expect(dockerfileCode).toMatch(/chmod 0755 \/etc\/cont-init\.d\/03-vs-queue-join/);
    const hook = readFileSync(path.join(appDir, 'vs-queue-join.sh'), 'utf8');
    // The upstream image's own hook shape: /init scrubs env; with-contenv
    // rehydrates HERMES_HOME. A plain #!/bin/sh would default /opt/data.
    expect(hook).toMatch(/^#!\/command\/with-contenv sh/);
    // First-boot-only (operator/agent edits win).
    expect(hook).toMatch(/already seeded/);
    // FAIL-SOFT: never brick the agent — every error path exits 0.
    const hookCode = stripComments(hook);
    expect(hookCode).not.toMatch(/exit [1-9]/);
    // NEVER bd init in the hook — config-only join (the 9-09 lockout).
    // Comments are stripped first: the header DOCUMENTS the prohibition
    // ("NEVER bd init"), only a live invocation must fail this.
    expect(hookCode).not.toMatch(/\bbd init\b/);
    // Fails loud in logs when the baked bd answers off-pin.
    expect(hook).toMatch(/bd version 1\.2\.2/);
  });

  it('both composes build the same Dockerfile.hermes (one artifact, no twin drift)', () => {
    const balenaBlock = serviceBlock(balenaCompose, 'hermes');
    const deployBlock = serviceBlock(deployCompose, 'hermes');
    expect(balenaBlock, 'balena compose hermes block not found').not.toBe('');
    expect(deployBlock, 'deploy compose hermes block not found').not.toBe('');
    expect(balenaBlock).toMatch(/dockerfile:\s*Dockerfile\.hermes/);
    expect(deployBlock).toMatch(/dockerfile:\s*Dockerfile\.hermes/);
    // Neither side may regress to pulling the stock image.
    expect(balenaBlock).not.toMatch(/image:\s*nousresearch\/hermes-agent/);
    expect(deployBlock).not.toMatch(/image:\s*nousresearch\/hermes-agent/);
    // Same context root: the balena app dir (deploy resolves ../balena/registrar).
    expect(balenaBlock).toMatch(/context:\s*\./);
    expect(deployBlock).toMatch(/context:\s*\.\.\/balena\/registrar/);
  });

  it('hermes service env carries BEADS_DOLT_PASSWORD (the scotty password posture)', () => {
    const balenaBlock = serviceBlock(balenaCompose, 'hermes');
    const deployBlock = serviceBlock(deployCompose, 'hermes');
    // Deploy side: fail-closed interpolation (the scotty entry shape).
    expect(deployBlock).toMatch(/BEADS_DOLT_PASSWORD:\s*\$\{BEADS_DOLT_PASSWORD:\?[^}]*\}/);
    // Balena side: fleet variable cascades; the block documents the key
    // (no static value — f57.8). The comment is stripped, so assert the
    // README documents it instead (the variable table row).
    const readme = readFileSync(path.join(appDir, 'README.md'), 'utf8');
    expect(readme).toMatch(/BEADS_DOLT_PASSWORD[^\n]*hermes/);
  });

  it('e2e overlay satisfies the base compose’s fail-closed password entry', () => {
    const overlayBlock = serviceBlock(e2eOverlay, 'hermes');
    expect(overlayBlock, 'e2e overlay hermes block not found').not.toBe('');
    expect(overlayBlock).toMatch(/BEADS_DOLT_PASSWORD:/);
  });

  it('e2e asserts the b1r contract (AC13 exists and runs after AC12)', () => {
    const e2e = readFileSync(path.join(repoRoot, 'deploy/e2e.sh'), 'utf8');
    expect(e2e).toMatch(/ac13_primus_queue_tooling\(\)/);
    expect(e2e).toMatch(/ac12_primus_self_bootstrap\nac13_primus_queue_tooling/);
    // The canonical id must be asserted against the e2e dolt (the AC's
    // step 0 — the bead's "seeded with the canonical project_id").
    expect(e2e).toMatch(/bcde5891-5482-4eb0-a223-8533504832d6/);
  });

  it('devices app carries the runtime-swap forward shape', () => {
    expect(existsSync(path.join(repoRoot, 'balena/devices/Dockerfile.agent-hermes'))).toBe(true);
    const forward = readFileSync(
      path.join(repoRoot, 'balena/devices/Dockerfile.agent-hermes'),
      'utf8',
    );
    expect(forward).toMatch(/FROM nousresearch\/hermes-agent:v2026\.9\.21/);
    expect(forward).toMatch(/FORWARD-SHAPE ONLY/);
  });
});
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Primus image contract guard (fleet-ops-b1r, owner ruling 2026-09-29:
 * "get these things into the codebase" — bake, don't runtime-install).
 *
 * The hermes service builds images/hermes/Dockerfile — the
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
 *   6. the docs are COPYd straight from docs/ (repo-root build context —
 *      the only copy)
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

const appDir = path.join(repoRoot, 'platforms/balena/registrar');
const imageDir = path.join(repoRoot, 'images/hermes');
const dockerfile = readFileSync(path.join(imageDir, 'Dockerfile'), 'utf8');
const dockerfileCode = stripComments(dockerfile);
const balenaCompose = stripComments(
  readFileSync(path.join(repoRoot, 'platforms/balena/registrar/docker-compose.yml'), 'utf8'),
);
const deployCompose = stripComments(
  readFileSync(path.join(repoRoot, 'platforms/compose/compose.yaml'), 'utf8'),
);
const e2eOverlay = stripComments(
  readFileSync(path.join(repoRoot, 'test/e2e/compose.e2e.yaml'), 'utf8'),
);

/** Extract a top-level service block (2-space indent) from a compose. */
function serviceBlock(code: string, name: string): string {
  const m = new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|\\n\\w|\\Z|^$)`, 'm').exec(code);
  return m ? m[1] : '';
}

describe('primus image contract (fleet-ops-b1r)', () => {
  it('images/hermes/Dockerfile exists and carries the pinned official base', () => {
    expect(existsSync(path.join(imageDir, 'Dockerfile'))).toBe(true);
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
      readFileSync(path.join(repoRoot, 'images/common/queue-join/.beads/metadata.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(meta.project_id).toBe('bcde5891-5482-4eb0-a223-8533504832d6');
    expect(meta.dolt_server_host).toBe('dolt');
    expect(meta.dolt_server_port).toBe(3306);
    expect(meta.dolt_server_user).toBe('vs');
    expect(meta.dolt_database).toBe('vs_ops');
    expect(dockerfileCode).toMatch(/COPY images\/common\/queue-join \/opt\/vs\/queue-join/);
  });

  it('bakes its docs (queue-conventions + vs-environment) at /opt/vs/docs, straight from docs/', () => {
    // Repo-root build context: the COPY reads the canonical docs/ files.
    const docsCopy = /COPY ((?:docs\/[\w.-]+\s*\\?\s*)+)\/opt\/vs\/docs\//.exec(dockerfileCode);
    expect(docsCopy, 'docs COPY to /opt/vs/docs/ not found').not.toBeNull();
    for (const doc of ['queue-conventions.md', 'vs-environment.md']) {
      expect(docsCopy![1]).toContain(`docs/${doc}`);
      expect(existsSync(path.join(repoRoot, 'docs', doc))).toBe(true);
    }
  });

  it('wires the boot hook as a cont-init script after stage2, with-contenv shape', () => {
    expect(dockerfileCode).toMatch(/COPY images\/hermes\/vs-queue-join\.sh \/etc\/cont-init\.d\/03-vs-queue-join/);
    expect(dockerfileCode).toMatch(/chmod 0755 \/etc\/cont-init\.d\/03-vs-queue-join/);
    const hook = readFileSync(path.join(imageDir, 'vs-queue-join.sh'), 'utf8');
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

  it('j7g.1: the A2A mesh wiring hook is baked as cont-init 04- (primus is a mesh member)', () => {
    expect(dockerfileCode).toMatch(/COPY images\/common\/hooks\/vs-a2a-wiring\.sh \/etc\/cont-init\.d\/04-vs-a2a-wiring/);
    expect(dockerfileCode).toMatch(/chmod 0755 \/etc\/cont-init\.d\/04-vs-a2a-wiring/);
    const wiring = readFileSync(path.join(repoRoot, 'images/common/hooks/vs-a2a-wiring.sh'), 'utf8');
    expect(wiring).toMatch(/^#!\/command\/with-contenv sh/);
    // The CODE contract: bundle files -> runtime env + managed config.yaml.
    expect(wiring).toMatch(/A2A_PEER_TOKENS/);
    expect(wiring).toMatch(/A2A_OWN_IDENTITY_KEY/);
    expect(wiring).toMatch(/A2A_PUBLIC_URL/);
    expect(wiring).toMatch(/a2a_agents/);
    // Bind-safety: no identity in the bundle => inbound stays OFF.
    expect(wiring).toMatch(/A2A inbound stays OFF/);
    // FAIL-SOFT: never brick the agent (comment-stripped scan).
    const wiringCode = stripComments(wiring);
    expect(wiringCode).not.toMatch(/exit [1-9]/);
  });

  it('signed identity (docs/a2a-signed-identity.md): the wiring hook drives the a2a-guard from peer_keys', () => {
    const wiring = stripComments(readFileSync(path.join(repoRoot, 'images/common/hooks/vs-a2a-wiring.sh'), 'utf8'));
    // keygen every boot; the public key lands where the registrant reports it from
    expect(wiring).toMatch(/vs-a2a-guard keygen --state-dir "\$GUARD_DIR"/);
    expect(wiring).toMatch(/pubkey\.json/);
    // signed mode only when the bundle carries peer_keys; otherwise guard.json is REMOVED (service down)
    expect(wiring).toMatch(/peer_keys/);
    expect(wiring).toMatch(/os\.remove\(cfg\)/);
    // Hermes moves behind the guard and resolves callers by LOCAL tokens
    expect(wiring).toMatch(/set_env A2A_HOST "127\.0\.0\.1"/);
    expect(wiring).toMatch(/set_env A2A_PORT "9901"/);
    // keyed peers route through the outbound guard; the token is an env REFERENCE in config.yaml
    expect(wiring).toMatch(/http:\/\/127\.0\.0\.1:9902\/peer\//);
    expect(wiring).toMatch(/\$\{A2A_GUARD_OUTBOUND_TOKEN\}/);
    // the guard reads keys + strict from the LIVE bundle file (hot reload)
    expect(wiring).toMatch(/"bundle_a2a": os\.path\.join\(bundle_dir, "a2a\.json"\)/);
  });

  it('every compose runs the ONE hermes image (images.json component, no twin drift)', () => {
    const catalog = JSON.parse(readFileSync(path.join(repoRoot, 'images.json'), 'utf8'));
    expect(catalog.components.hermes).toMatchObject({
      dockerfile: 'images/hermes/Dockerfile',
      context: '.',
    });
    const balenaBlock = serviceBlock(balenaCompose, 'hermes');
    const deployBlock = serviceBlock(deployCompose, 'hermes');
    const e2eBlock = serviceBlock(e2eOverlay, 'hermes');
    expect(balenaBlock, 'balena compose hermes block not found').not.toBe('');
    expect(deployBlock, 'deploy compose hermes block not found').not.toBe('');
    // balena: the catalog build (repo-root context), rendered to the
    // promoted digest at release time.
    expect(balenaBlock).toMatch(/context:\s*\.\.\/\.\./);
    expect(balenaBlock).toMatch(/dockerfile:\s*images\/hermes\/Dockerfile/);
    // platforms/compose/: the published image itself, pinned by commit SHA.
    expect(deployBlock).toMatch(/image:\s*\$\{VS_IMAGE_REGISTRY:-ghcr\.io\/cwdcwd\/vector-sigma\}\/hermes:\$\{VS_IMAGE_TAG:\?/);
    expect(deployBlock).not.toMatch(/build:/);
    // E2E: the same image under its local tag (CI loads the scanned bytes),
    // with the catalog build as the local source fallback.
    expect(e2eBlock).toMatch(/image:\s*vs-e2e\/hermes:ci/);
    expect(e2eBlock).toMatch(/dockerfile:\s*images\/hermes\/Dockerfile/);
    // No side may regress to pulling the stock image.
    for (const block of [balenaBlock, deployBlock, e2eBlock]) {
      expect(block).not.toMatch(/image:\s*nousresearch\/hermes-agent/);
    }
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
    const e2e = readFileSync(path.join(repoRoot, 'test/e2e/e2e.sh'), 'utf8');
    expect(e2e).toMatch(/ac13_primus_queue_tooling\(\)/);
    expect(e2e).toMatch(/ac12_primus_self_bootstrap\nac13_primus_queue_tooling/);
    // The canonical id must be asserted against the e2e dolt (the AC's
    // step 0 — the bead's "seeded with the canonical project_id").
    expect(e2e).toMatch(/bcde5891-5482-4eb0-a223-8533504832d6/);
  });

  it('devices app carries the runtime-swap image, now the LIVE build (j7g.1)', () => {
    expect(existsSync(path.join(repoRoot, 'images/agent/Dockerfile'))).toBe(true);
    const agentHermes = readFileSync(
      path.join(repoRoot, 'images/agent/Dockerfile'),
      'utf8',
    );
    expect(agentHermes).toMatch(/FROM nousresearch\/hermes-agent:v2026\.9\.21/);
    // The swap is REAL: no forward-shape stub remains, bd is baked with the
    // checksums-verified supply chain, the gate is the ENTRYPOINT, and the
    // A2A wiring hook is baked as a cont-init script.
    expect(agentHermes).not.toMatch(/FORWARD-SHAPE ONLY/);
    expect(stripComments(agentHermes)).toMatch(/ARG BD_VERSION=1\.2\.2/);
    expect(stripComments(agentHermes)).toMatch(/checksums\.txt/);
    expect(stripComments(agentHermes)).toMatch(/ENTRYPOINT \["\/usr\/local\/bin\/gate\.sh"\]/);
    expect(stripComments(agentHermes)).toMatch(/COPY images\/common\/hooks\/vs-a2a-wiring\.sh \/etc\/cont-init\.d\/04-vs-a2a-wiring/);
    // The devices compose builds THIS file (rendered to the promoted digest
    // at release) with the canonical long-run
    // command and the HERMES_HOME/UID contract (the b1r parity).
    const devicesCompose = stripComments(
      readFileSync(path.join(repoRoot, 'platforms/balena/devices/docker-compose.yml'), 'utf8'),
    );
    const agentBlock = serviceBlock(devicesCompose, 'agent');
    expect(agentBlock).toMatch(/dockerfile: images\/agent\/Dockerfile/);
    expect(agentBlock).toMatch(/gateway", "run"|gateway run/);
    expect(agentBlock).toMatch(/HERMES_HOME: \/data\/agent/);
    expect(agentBlock).toMatch(/HERMES_UID: "1000"/);
  });

  it('1py.47.1: the VS hub router is baked as an s6 longrun routing the vs_ops board pipeline (stages, WIP caps, handoff validation), scoped to the queue join and dark by default', () => {
    // The router is the device's own board pipeline: it advances ready beads
    // through dev/test/review with WIP caps, validates stage agents' HANDOFF
    // comments over board metadata, and re-pings stale work through the
    // signed outbound route. It must never leave the baked vs_ops queue join
    // and must never re-initialize or raw-query the shared queue.
    for (const image of [dockerfileCode, stripComments(readFileSync(path.join(repoRoot, 'images/agent/Dockerfile'), 'utf8'))]) {
      expect(image).toMatch(/COPY images\/common\/bin\/vs-hub-router\.py \/usr\/local\/bin\/vs-hub-router/);
      expect(image).toMatch(/COPY images\/common\/s6\/vs-hub-router \/etc\/s6-overlay\/s6-rc\.d\/vs-hub-router/);
      expect(image).toMatch(/touch \/etc\/s6-overlay\/s6-rc\.d\/user\/contents\.d\/vs-hub-router/);
    }
    const router = readFileSync(path.join(repoRoot, 'images/common/bin/vs-hub-router.py'), 'utf8');
    const routerCode = stripComments(router);
    // Owner-controlled enablement: no roster, no routing (the router is dark).
    expect(routerCode).toMatch(/VS_HUB_AGENTS/);
    expect(routerCode).not.toMatch(/VS_HUB_TARGET_AGENT/);
    expect(routerCode).not.toMatch(/--queue-dir/);
    // The baked vs_ops queue join is the only workspace: the contract check
    // refuses anything else (the origin fleet's own hub workspace included).
    expect(routerCode).toMatch(/vs_ops/);
    expect(routerCode).toMatch(/"fleet_ops" in raw/);
    expect(routerCode).toMatch(/e3796a22/);
    // The bd argv allowlist: board reads + targeted edits only — no init, no
    // raw queries, no other verb can run through a router.
    expect(routerCode).toMatch(/BOARD_VERBS = \("status", "list", "ready", "comments", "update", "comment"\)/);
    expect(routerCode).not.toMatch(/"init"/);
    expect(routerCode).not.toMatch(/["']sql["']/);
    // Pipeline: explicit stages, role labels, WIP caps, handoff verbs.
    expect(routerCode).toMatch(/STAGE_VERBS/);
    expect(routerCode).toMatch(/"dev".*"blocked"/s);
    expect(routerCode).toMatch(/dev-done/);
    expect(routerCode).toMatch(/test-pass/);
    expect(routerCode).toMatch(/test-fail/);
    expect(routerCode).toMatch(/review-accepted/);
    expect(routerCode).toMatch(/changes-requested/);
    expect(routerCode).toMatch(/GUIDANCE:/);
    // Routing state rides board metadata stamps (never the bead tree) and
    // sweeps are single-flight under the router lock.
    expect(routerCode).toMatch(/hub_stage/);
    expect(routerCode).toMatch(/hub_dispatched_at/);
    expect(routerCode).toMatch(/hub_pending/);
    expect(routerCode).toMatch(/router\.lock/);
    expect(routerCode).toMatch(/VS_HUB_WIP/);
    // The single endpoint in code is the a2a-guard's outbound peer route on loopback.
    expect(routerCode.match(/127\.0\.0\.1:\d+[^'"`\s]*/g) ?? []).toEqual(['127.0.0.1:9902/peer/']);
    // No inbound port of its own (it dials the guard, never serves a socket).
    expect(routerCode).not.toMatch(/\b9900\b/);
    const s6run = readFileSync(path.join(repoRoot, 'images/common/s6/vs-hub-router/run'), 'utf8');
    expect(s6run).toMatch(/^#!\/command\/with-contenv sh/);
    const s6runCode = stripComments(s6run);
    expect(s6runCode).toMatch(/VS_HUB_AGENTS/);
    expect(s6runCode).toMatch(/VS_QUEUE_DIR/);
    expect(s6runCode).toMatch(/vs-queue/);
    expect(s6runCode).toMatch(/outbound-token/);
    expect(s6runCode).toMatch(/serve/);
    expect(s6runCode).not.toMatch(/--queue-dir/);
    expect(s6runCode).not.toMatch(/\bbd\b/);
    const s6finish = readFileSync(path.join(repoRoot, 'images/common/s6/vs-hub-router/finish'), 'utf8');
    expect(stripComments(s6finish)).toMatch(/exit 125/);
    expect(stripComments(s6finish)).toMatch(/VS_HUB_AGENTS/);
    expect(readFileSync(path.join(repoRoot, 'images/common/s6/vs-hub-router/type'), 'utf8')).toMatch(/longrun/);
    // The wiring hook stays out of hub routing: the roster is a compose/balena
    // env choice (owner-controlled), not a bundle-derived spool.
    const wiring = readFileSync(path.join(repoRoot, 'images/common/hooks/vs-a2a-wiring.sh'), 'utf8');
    expect(wiring).not.toMatch(/VS_HUB_TARGET_AGENT|vs-hub-queue|hub_router_agent/);
    // The queue conventions document the router contract; the design
    // constants doc pins the knobs.
    const conv = readFileSync(path.join(repoRoot, 'docs/queue-conventions.md'), 'utf8');
    expect(conv).toMatch(/vs-hub-router/);
    expect(conv).toMatch(/VS_HUB_AGENTS/);
    expect(conv).toMatch(/hub_pending/);
    const knobs = readFileSync(path.join(repoRoot, 'docs/vs-hub-router.md'), 'utf8');
    expect(knobs).toMatch(/VS_HUB_AGENTS/);
    expect(knobs).toMatch(/VS_HUB_WIP/);
    expect(knobs).toMatch(/message\/send/);
  });
});

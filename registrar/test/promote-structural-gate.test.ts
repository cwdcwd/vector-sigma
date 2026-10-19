/**
 * The exact-byte promotion contract (fleet-ops-r3v — completes PR #61
 * review round 1, finding #4, THE MOST SERIOUS finding).
 *
 * THE DEFECT: promote previously ran a SECOND `docker buildx build --push`
 * on a fresh runner and never consumed the already-scanned OCI tar / local
 * index, structurally bypassing the scan-then-promote gate. The interim
 * safe fallback removed the rebuild and left promote a no-op placeholder
 * with every downstream job `if: false` — safe, but it delivered nothing.
 *
 * THE REAL FIX (pinned here):
 *   1. `promote` contains NO docker/build-push-action, no `push: true`, and
 *      NEVER a docker/login-action step: it publishes the exact scanned
 *      bytes through the in-repo OCI Distribution client
 *      (scripts/ghcr-promote-run.mjs → registrar/src/registry/promote.ts),
 *      not through a builder.
 *   2. `promote` downloads the scanned OCI LAYOUT artifacts and invokes the
 *      promoter with them — the cryptographic link between what was scanned
 *      and what is published. It must never re-read source and rebuild.
 *   3. The multi-arch index is assembled by the promoter from ONLY the
 *      scanned-and-passed child descriptors. The old `promote-manifest` job
 *      (a second, independent `buildx imagetools create` assembly path) is
 *      GONE — one assembly path, one source of truth.
 *   4. `verify-remote` re-fetches by digest through the in-repo verifier
 *      (scripts/ghcr-promote-run.mjs verify → verifyRemote) with NO
 *      packages:write and no credential, and the verification is fail-closed
 *      (the verifier recomputes SHA-256 over served bytes rather than
 *      trusting a header or a promote-time return value).
 *   5. Every job that depends on real published GHCR bytes is switched back
 *      ON (no `if: false`), because the thing those jobs were waiting for
 *      now exists.
 *
 * Promotion lives once, in the reusable .github/workflows/_promote.yml
 * (PROMOTE below), fed by .github/workflows/_images.yml (PIPELINE); the
 * release workflows call both and keep only their tail.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const PIPELINE = '.github/workflows/_images.yml';
const PROMOTE = '.github/workflows/_promote.yml';
const RELEASE_WORKFLOWS = ['.github/workflows/release-registrar.yml', '.github/workflows/release-devices.yml'] as const;

interface WfJob {
  if?: boolean | string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Array<Record<string, unknown>>;
}
interface WfDoc {
  jobs: Record<string, WfJob>;
}

function loadWf(rel: string): WfDoc {
  return parseYaml(read(rel)) as WfDoc;
}

function stepsText(job: WfJob): string {
  return JSON.stringify(job.steps ?? '');
}

function needsList(job: WfJob): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

describe('exact-byte promotion: no builder anywhere in the publish path', () => {
  for (const wf of [PROMOTE]) {
    it(`${wf}: carries NO docker/build-push-action and no "push: true" anywhere`, () => {
      expect(read(wf)).not.toContain('docker/build-push-action');
      expect(read(wf)).not.toMatch(/push:\s*true/);
    });

    it(`${wf}: promote contains NO docker/build-push-action and no "push: true"`, () => {
      const text = stepsText(loadWf(wf).jobs.promote);
      expect(text, `${wf} promote must not rebuild the image`).not.toContain('docker/build-push-action');
      expect(text).not.toMatch(/push:\s*true/);
    });

    it(`${wf}: promote never logs into GHCR (no docker/login-action) — the token reaches the client only via env`, () => {
      const text = stepsText(loadWf(wf).jobs.promote);
      expect(text, `${wf} promote must not authenticate through docker/login-action`).not.toContain('docker/login-action');
      // The credential must arrive through a named env var the script reads,
      // never as a docker credential store entry or a URL parameter.
      expect(text).toContain('--token-env');
    });

    it(`${wf}: promote downloads the EXACT scanned OCI layout tars, not a rebuild source`, () => {
      const text = stepsText(loadWf(wf).jobs.promote);
      expect(text, `${wf} promote must consume the scanned layout artifacts`).toContain(
        'layout-${{ matrix.component }}-',
      );
      expect(text).toContain('actions/download-artifact');
    });

  }

  it(`${PIPELINE}: stage-and-scan publishes the layout tar it scanned (the bytes promote will push)`, () => {
    const text = stepsText(loadWf(PIPELINE).jobs['stage-and-scan']);
    expect(text).toContain('layout-${{ matrix.component }}-${{ matrix.arch_tag }}');
  });

  it('promotion is still gated behind the whole pipeline (scan, gate and E2E must pass first)', () => {
    for (const wf of ['.github/workflows/build-images.yml', ...RELEASE_WORKFLOWS]) {
      expect(needsList(loadWf(wf).jobs.publish), wf).toEqual(['images']);
    }
  });
});

describe('exact-byte promotion: one index-assembly path (promote-manifest retired)', () => {
  for (const wf of [PIPELINE, PROMOTE, ...RELEASE_WORKFLOWS]) {
    it(`${wf}: there is no promote-manifest job left`, () => {
      expect(loadWf(wf).jobs['promote-manifest'], `${wf} must not keep a second buildx index-assembly path`).toBeUndefined();
    });

  }

  it(`${PROMOTE}: the promoter script — not buildx — does the index assembly`, () => {
    const text = stepsText(loadWf(PROMOTE).jobs.promote);
    expect(text).toContain('scripts/ghcr-promote-run.mjs');
    expect(text).not.toContain('imagetools');
  });
});

describe('exact-byte promotion: verify-remote is credential-free and fail-closed', () => {
  for (const wf of [PROMOTE]) {
    it(`${wf}: verify-remote carries NO packages:write`, () => {
      const perms = loadWf(wf).jobs['verify-remote'].permissions;
      expect(perms?.packages, `${wf} verify-remote must not hold write scope`).not.toBe('write');
    });

    it(`${wf}: verify-remote runs the in-repo verifier (not a printed digest comparison)`, () => {
      const text = stepsText(loadWf(wf).jobs['verify-remote']);
      expect(text).toContain('scripts/ghcr-promote-run.mjs');
      expect(text).toContain('verify');
    });
  }
});

describe('exact-byte promotion: live publishing is behind an explicit owner switch', () => {
  // Merging a green PR pipeline must never, by itself, become a live GHCR
  // write. Every call to _promote.yml sits in a `publish` job gated on a
  // repo Actions variable that is unset in this repo: push-to-main with a
  // green gate publishes nothing until the owner deliberately flips the
  // switch. See docs/ghcr-promotion-runbook.md.
  for (const wf of ['.github/workflows/build-images.yml', ...RELEASE_WORKFLOWS]) {
    it(`${wf}: every _promote.yml call requires vars.VS_GHCR_PUBLISH_ENABLED`, () => {
      const calls = Object.values(loadWf(wf).jobs).filter(
        (job) => (job as { uses?: string }).uses === './.github/workflows/_promote.yml',
      );
      expect(calls.length).toBe(1);
      expect(String(calls[0].if)).toContain("vars.VS_GHCR_PUBLISH_ENABLED == 'true'");
    });
  }
});

describe('exact-byte promotion: downstream jobs are switched back ON', () => {
  const DOWNSTREAM_JOBS = ['scan', 'smoke', 'render', 'deploy'] as const;

  it(`${PROMOTE}: verify-remote is not switched off`, () => {
    expect(loadWf(PROMOTE).jobs['verify-remote'].if).toBeUndefined();
  });

  for (const wf of RELEASE_WORKFLOWS) {
    for (const jobId of DOWNSTREAM_JOBS) {
      it(`${wf}: job "${jobId}" no longer carries if: false`, () => {
        const job = loadWf(wf).jobs[jobId];
        expect(job, `${wf} must define job "${jobId}"`).toBeDefined();
        expect(job!.if, `${wf} job "${jobId}" must be enabled now that real bytes are published`).not.toBe(false);
      });
    }
  }
});

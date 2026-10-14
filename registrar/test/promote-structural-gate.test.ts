/**
 * PR #61 review round 1, finding #4 (THE MOST SERIOUS finding) — the
 * promote job previously ran a SECOND `docker buildx build --push` on a
 * fresh runner and never consumed the already-scanned OCI tar / local
 * index, structurally bypassing the scan-then-promote gate the whole PR
 * exists to build (release-registrar.yml and release-devices.yml, both
 * identical defect shape).
 *
 * SAFE-FALLBACK FIX (per the owner's own explicit instruction: "If an
 * exact-byte promoter client isn't ready yet ... the promote job must
 * NOT be wired to actually publish at all yet — leave it structurally
 * incapable of running"): this suite pins that
 *   1. `promote` no longer contains docker/build-push-action, `push:
 *      true`, or any docker/login-action step that authenticates for a
 *      WRITE (the job still downloads the stage-and-scan artifact and
 *      prints it — a placeholder, never a rebuild).
 *   2. Every downstream job that depends on real published GHCR bytes
 *      (promote-manifest, verify-remote, scan, smoke, render, deploy)
 *      carries `if: false` — structurally incapable of running, not
 *      merely conditionally skipped by a runtime check.
 *   3. `promote` downloads the index-${component} artifact — the EXACT
 *      bytes stage-and-scan already scanned — rather than re-reading
 *      source and rebuilding.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const RELEASE_WORKFLOWS = ['.github/workflows/release-registrar.yml', '.github/workflows/release-devices.yml'] as const;

interface WfJob {
  if?: boolean | string;
  needs?: string | string[];
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

describe('finding #4: promote no longer rebuilds-and-pushes (the structural defect)', () => {
  for (const wf of RELEASE_WORKFLOWS) {
    it(`${wf}: promote job contains NO docker/build-push-action step`, () => {
      const doc = loadWf(wf);
      const text = stepsText(doc.jobs.promote);
      expect(text, `${wf} promote job must not rebuild via docker/build-push-action`).not.toContain('docker/build-push-action');
    });

    it(`${wf}: promote job contains no "push: true"`, () => {
      const doc = loadWf(wf);
      const text = stepsText(doc.jobs.promote);
      expect(text).not.toMatch(/push:\s*true/);
    });

    it(`${wf}: promote job does not log into GHCR for a write (no docker/login-action step)`, () => {
      const doc = loadWf(wf);
      const text = stepsText(doc.jobs.promote);
      expect(text, `${wf} promote job must not authenticate to GHCR until the real exact-byte promoter lands`).not.toContain(
        'docker/login-action',
      );
    });

    it(`${wf}: promote job downloads the EXACT scanned index artifact (index-\${{ matrix.component }}), never rebuilds from source`, () => {
      const doc = loadWf(wf);
      const text = stepsText(doc.jobs.promote);
      expect(text).toContain('index-${{ matrix.component }}');
      expect(text).toContain('actions/download-artifact');
    });

    it(`${wf}: promote job is still gated behind all-components-gate (the scan must still pass first)`, () => {
      const doc = loadWf(wf);
      const needs = doc.jobs.promote.needs;
      const needsList = Array.isArray(needs) ? needs : needs ? [needs] : [];
      expect(needsList).toContain('all-components-gate');
    });
  }
});

describe('finding #4: every job that depends on real published GHCR bytes is structurally gated off (if: false)', () => {
  const DOWNSTREAM_JOBS = ['promote-manifest', 'verify-remote', 'scan', 'smoke', 'render', 'deploy'] as const;

  for (const wf of RELEASE_WORKFLOWS) {
    for (const jobId of DOWNSTREAM_JOBS) {
      it(`${wf}: job "${jobId}" carries if: false (structurally incapable of running, not conditionally skipped)`, () => {
        const doc = loadWf(wf);
        const job = doc.jobs[jobId];
        expect(job, `${wf} must still define job "${jobId}" (dormant, not deleted)`).toBeDefined();
        expect(job!.if, `${wf} job "${jobId}" must carry if: false until the exact-byte GHCR PoC lands`).toBe(false);
      });
    }
  }
});

describe('finding #4: build-images.yml (the PR-event path) already had the correct safe-fallback shape — unchanged, still correct', () => {
  it('build-images.yml promote job has no docker/build-push-action and no push: true (it was already a placeholder)', () => {
    const doc = loadWf('.github/workflows/build-images.yml');
    const text = stepsText(doc.jobs.promote);
    expect(text).not.toContain('docker/build-push-action');
    expect(text).not.toMatch(/push:\s*true/);
  });
});

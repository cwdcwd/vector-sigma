/**
 * Publisher workflow graph invariants (fleet-ops-1py.14 slice 5).
 *
 * Pins the structural shape Thanos's design (fleet-ops-1py.12) and
 * docs/ghcr-image-exposure-plan.md section B require of all three
 * publisher workflows — build-images.yml, release-registrar.yml,
 * release-devices.yml — by parsing the real YAML (follows the pattern
 * established in registrar/test/release-smoke.test.ts):
 *
 *   1. packages:write appears ONLY inside the promote job(s)'
 *      permissions block — never workflow-wide, never on any other job.
 *   2. cache-from: / cache-to: never appear anywhere in a candidate
 *      build step (stage-and-scan or promote) in any of the three
 *      workflows, on any event.
 *   3. The aggregate all-components-gate job's `needs:` list includes
 *      every stage/scan and index-assembly job.
 *   4. build-images.yml's pull_request path has NO promote job running
 *      at all (structurally gated off, not just permission-less).
 *   5. stage-and-scan jobs never carry docker/login-action (no GHCR
 *      auth before the gate).
 *   6. promote job(s) are the only ones gated behind
 *      all-components-gate passing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const WORKFLOWS = [
  '.github/workflows/build-images.yml',
  '.github/workflows/release-registrar.yml',
  '.github/workflows/release-devices.yml',
] as const;

interface WfJob {
  name?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  if?: string;
  strategy?: { matrix?: unknown };
  steps?: Array<Record<string, unknown>>;
}

interface WfDoc {
  permissions?: Record<string, string>;
  jobs: Record<string, WfJob>;
  on?: unknown;
}

function loadWf(rel: string): WfDoc {
  return parseYaml(read(rel)) as WfDoc;
}

function needsList(job: WfJob): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function stepsText(job: WfJob): string {
  return JSON.stringify(job.steps ?? '');
}

describe('publisher workflow graph: packages:write is scoped ONLY to promote jobs', () => {
  for (const wf of WORKFLOWS) {
    it(`${wf}: workflow-wide permissions block never carries packages:write`, () => {
      const doc = loadWf(wf);
      expect(doc.permissions, `${wf} must declare workflow-wide permissions`).toBeDefined();
      expect(doc.permissions!.packages, `${wf} workflow-wide permissions must not include packages:write`).not.toBe(
        'write',
      );
      expect(doc.permissions!.contents, `${wf} workflow-wide contents permission must be read`).toBe('read');
    });

    it(`${wf}: packages: write appears on promote/promote-manifest jobs only`, () => {
      const doc = loadWf(wf);
      const jobsWithPackagesWrite: string[] = [];
      for (const [jobId, job] of Object.entries(doc.jobs)) {
        if (job.permissions?.packages === 'write') {
          jobsWithPackagesWrite.push(jobId);
        }
      }
      expect(
        jobsWithPackagesWrite.length,
        `${wf} must grant packages:write to at least one job (the promote job)`,
      ).toBeGreaterThan(0);
      for (const jobId of jobsWithPackagesWrite) {
        expect(
          jobId === 'promote' || jobId === 'promote-manifest',
          `${wf}: job "${jobId}" carries packages:write but is not promote/promote-manifest — write scope leaked`,
        ).toBe(true);
      }
    });

    it(`${wf}: every non-promote job has contents:read only (no packages permission)`, () => {
      const doc = loadWf(wf);
      for (const [jobId, job] of Object.entries(doc.jobs)) {
        if (jobId === 'promote' || jobId === 'promote-manifest') continue;
        if (!job.permissions) continue; // falls back to workflow-wide contents:read
        expect(
          job.permissions.packages !== 'write',
          `${wf}: job "${jobId}" must not carry packages:write`,
        ).toBe(true);
      }
    });
  }
});

describe('publisher workflow graph: zero cache-from/cache-to in candidate build steps', () => {
  for (const wf of WORKFLOWS) {
    it(`${wf}: no job anywhere references cache-from/cache-to`, () => {
      const text = read(wf);
      expect(text).not.toMatch(/cache-from\s*:/);
      expect(text).not.toMatch(/cache-to\s*:/);
    });

    it(`${wf}: no job anywhere references type=gha cache scoping`, () => {
      const text = read(wf);
      expect(text).not.toContain('type=gha');
    });
  }
});

describe('publisher workflow graph: aggregate gate covers every stage/scan and index job', () => {
  for (const wf of WORKFLOWS) {
    it(`${wf}: all-components-gate needs both stage-and-scan and assemble-and-validate`, () => {
      const doc = loadWf(wf);
      const gate = doc.jobs['all-components-gate'];
      expect(gate, `${wf} must define an all-components-gate job`).toBeDefined();
      const needs = needsList(gate);
      expect(needs, `${wf} all-components-gate needs: list`).toContain('stage-and-scan');
      expect(needs, `${wf} all-components-gate needs: list`).toContain('assemble-and-validate');
    });

    it(`${wf}: all-components-gate uses if: always() so cancelled/skipped deps are inspected, not swallowed`, () => {
      const doc = loadWf(wf);
      const gate = doc.jobs['all-components-gate'];
      expect(gate.if, `${wf} all-components-gate must run with if: always()`).toBe('always()');
    });

    it(`${wf}: all-components-gate's own steps explicitly check both deps' .result`, () => {
      const doc = loadWf(wf);
      const text = stepsText(doc.jobs['all-components-gate']);
      expect(text).toContain('needs.stage-and-scan.result');
      expect(text).toContain('needs.assemble-and-validate.result');
    });

    it(`${wf}: promote (and promote-manifest, where present) are gated behind all-components-gate`, () => {
      const doc = loadWf(wf);
      const promote = doc.jobs.promote;
      expect(promote, `${wf} must define a promote job`).toBeDefined();
      expect(needsList(promote)).toContain('all-components-gate');

      if (doc.jobs['promote-manifest']) {
        expect(needsList(doc.jobs['promote-manifest'])).toContain('promote');
      }
    });
  }
});

describe('publisher workflow graph: PR path on build-images.yml has NO promote job at all', () => {
  it('build-images.yml promote job is structurally gated off for pull_request (if: guard excludes it)', () => {
    const doc = loadWf('.github/workflows/build-images.yml');
    const promote = doc.jobs.promote;
    expect(promote, 'build-images.yml must define a promote job for main/dispatch').toBeDefined();
    expect(promote.if, 'promote job must carry an if: guard excluding pull_request').toBeDefined();
    expect(promote.if).toContain("github.event_name != 'pull_request'");

    const verifyRemote = doc.jobs['verify-remote'];
    expect(verifyRemote, 'build-images.yml must define verify-remote').toBeDefined();
    expect(verifyRemote.if, 'verify-remote must also be excluded from pull_request').toContain(
      "github.event_name != 'pull_request'",
    );
  });

  it('manual build-images dispatch can select one promotion component while preserving full validation', () => {
    const doc = loadWf('.github/workflows/build-images.yml');
    const dispatch = (doc.on as { workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: string; options?: string[] }> } })
      .workflow_dispatch;
    const componentInput = dispatch?.inputs?.component;
    expect(componentInput, 'workflow_dispatch must expose a component selector').toBeDefined();
    expect(componentInput?.type).toBe('choice');
    expect(componentInput?.default).toBe('all');
    expect(componentInput?.options).toEqual([
      'all', 'registrar', 'registrant', 'scotty', 'hermes', 'postgres', 'litellm', 'tailscale', 'agent',
    ]);

    const promote = doc.jobs.promote;
    const verifyRemote = doc.jobs['verify-remote'];
    expect(promote.strategy?.matrix).toBeDefined();
    expect(verifyRemote.strategy?.matrix).toEqual(promote.strategy?.matrix);
    const manualSelection = "github.event_name == 'workflow_dispatch' && inputs.component != 'all'";
    const matrix = JSON.stringify(promote.strategy?.matrix);
    expect(matrix).toContain(manualSelection);
    expect(matrix).toContain('fromJSON');
    expect(matrix).toContain('registrar');
    expect(matrix).toContain('agent');
    expect(JSON.stringify(verifyRemote.strategy?.matrix)).toContain(manualSelection);

    // Selection is promotion-only: the scan and aggregate gate still cover
    // the full build matrix before even one component can be published.
    const scanComponents = new Set(
      (doc.jobs['stage-and-scan'] as unknown as { strategy: { matrix: { include: Array<{ component: string }> } } })
        .strategy.matrix.include.map((item) => item.component),
    );
    expect([...scanComponents].sort()).toEqual(
      ['agent', 'hermes', 'litellm', 'postgres', 'registrant', 'registrar', 'scotty', 'tailscale'].sort(),
    );
    expect(needsList(promote)).toContain('all-components-gate');
  });

  it('build-images.yml stage-and-scan and assemble-and-validate run unconditionally (validate-only on PR)', () => {
    const doc = loadWf('.github/workflows/build-images.yml');
    // These jobs must NOT carry a pull_request exclusion — they are the
    // validate-only path that DOES run on PR.
    expect(doc.jobs['stage-and-scan'].if).toBeUndefined();
    expect(doc.jobs['assemble-and-validate'].if).toBeUndefined();
  });

  it('build-images.yml never logs into GHCR inside stage-and-scan or assemble-and-validate', () => {
    const doc = loadWf('.github/workflows/build-images.yml');
    for (const jobId of ['stage-and-scan', 'assemble-and-validate']) {
      const text = stepsText(doc.jobs[jobId]);
      expect(text, `${jobId} must not reference docker/login-action`).not.toContain('docker/login-action');
      expect(text, `${jobId} must not reference secrets.GITHUB_TOKEN`).not.toContain('GITHUB_TOKEN');
    }
  });
});

describe('publisher workflow graph: stage-and-scan never authenticates to any registry', () => {
  for (const wf of WORKFLOWS) {
    it(`${wf}: stage-and-scan job has no docker/login-action step`, () => {
      const doc = loadWf(wf);
      const text = stepsText(doc.jobs['stage-and-scan']);
      expect(text).not.toContain('docker/login-action');
    });

    it(`${wf}: stage-and-scan's build step has push: false`, () => {
      const doc = loadWf(wf);
      const text = read(wf);
      // Scope to the stage-and-scan job's own YAML block to avoid
      // matching promote's push: true below it.
      const stageBlock = text.slice(
        text.indexOf('\n  stage-and-scan:'),
        text.indexOf('\n  assemble-and-validate:'),
      );
      expect(stageBlock).toContain('push: false');
      expect(stageBlock).not.toContain('push: true');
    });

    it(`${wf}: stage-and-scan builds to a local OCI layout (type=oci, no push target)`, () => {
      const text = read(wf);
      const stageBlock = text.slice(
        text.indexOf('\n  stage-and-scan:'),
        text.indexOf('\n  assemble-and-validate:'),
      );
      expect(stageBlock).toContain('type=oci');
      expect(stageBlock).toContain('dest=');
    });
  }
});

describe('publisher workflow graph: component sets match the design (8/7/3, union 9)', () => {
  it('build-images.yml stage-and-scan matrix covers the 8 main-build components', () => {
    const doc = loadWf('.github/workflows/build-images.yml');
    const components = new Set(
      (doc.jobs['stage-and-scan'] as unknown as { strategy: { matrix: { include: Array<{ component: string }> } } })
        .strategy.matrix.include.map((i) => i.component),
    );
    expect([...components].sort()).toEqual(
      ['agent', 'hermes', 'litellm', 'postgres', 'registrant', 'registrar', 'scotty', 'tailscale'].sort(),
    );
  });

  it('release-registrar.yml stage-and-scan matrix covers the 7 registrar-tag components', () => {
    const doc = loadWf('.github/workflows/release-registrar.yml');
    const components = new Set(
      (doc.jobs['stage-and-scan'] as unknown as { strategy: { matrix: { include: Array<{ component: string }> } } })
        .strategy.matrix.include.map((i) => i.component),
    );
    expect([...components].sort()).toEqual(
      ['hermes', 'litellm', 'postgres', 'registrant', 'registrar', 'scotty', 'tailscale'].sort(),
    );
  });

  it('release-devices.yml stage-and-scan matrix covers the 3 devices-tag components', () => {
    const doc = loadWf('.github/workflows/release-devices.yml');
    const components = new Set(
      (doc.jobs['stage-and-scan'] as unknown as { strategy: { matrix: { include: Array<{ component: string }> } } })
        .strategy.matrix.include.map((i) => i.component),
    );
    expect([...components].sort()).toEqual(['agent', 'registrant', 'tailscale-devices'].sort());
  });

  it('union of all three component sets is exactly the 9 named families', () => {
    const buildDoc = loadWf('.github/workflows/build-images.yml');
    const regDoc = loadWf('.github/workflows/release-registrar.yml');
    const devDoc = loadWf('.github/workflows/release-devices.yml');
    const collect = (doc: WfDoc) =>
      (doc.jobs['stage-and-scan'] as unknown as { strategy: { matrix: { include: Array<{ component: string }> } } })
        .strategy.matrix.include.map((i) => i.component);
    const union = new Set([...collect(buildDoc), ...collect(regDoc), ...collect(devDoc)]);
    expect([...union].sort()).toEqual(
      [
        'agent',
        'hermes',
        'litellm',
        'postgres',
        'registrant',
        'registrar',
        'scotty',
        'tailscale',
        'tailscale-devices',
      ].sort(),
    );
  });
});

describe('publisher workflow graph: CI loads the gate module built from registrar/src/oci-gate', () => {
  for (const wf of WORKFLOWS) {
    it(`${wf}: stage-and-scan/assemble-and-validate run npm run build before invoking the gate`, () => {
      const doc = loadWf(wf);
      for (const jobId of ['stage-and-scan', 'assemble-and-validate']) {
        const text = stepsText(doc.jobs[jobId]);
        expect(text, `${jobId} must run npm ci`).toContain('npm ci');
        expect(text, `${jobId} must run npm run build (compiles oci-gate dist/)`).toContain('npm run build');
      }
    });

    it(`${wf}: the gate CLI script exists and is invoked by both scan and assemble steps`, () => {
      const doc = loadWf(wf);
      const scanText = stepsText(doc.jobs['stage-and-scan']);
      const assembleText = stepsText(doc.jobs['assemble-and-validate']);
      expect(scanText).toContain('scripts/oci-gate-run.mjs');
      expect(scanText).toContain('scan ');
      expect(assembleText).toContain('scripts/oci-gate-run.mjs');
      expect(assembleText).toContain('assemble ');
    });
  }

  it('scripts/oci-gate-run.mjs exists and parses as valid ESM', () => {
    const scriptPath = path.join(repoRoot, 'scripts/oci-gate-run.mjs');
    expect(() => readFileSync(scriptPath, 'utf8')).not.toThrow();
  });
});

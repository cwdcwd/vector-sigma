/**
 * Publisher workflow graph invariants (fleet-ops-1py.14 slice 5).
 *
 * Pins the structural shape Thanos's design (fleet-ops-1py.12) and
 * docs/ghcr-image-exposure-plan.md section B require of the publish path,
 * by parsing the real YAML. The graph lives ONCE, in the reusable
 * .github/workflows/_images.yml; build-images.yml, release-registrar.yml
 * and release-devices.yml call it. Pinned here:
 *
 *   1. packages:write appears ONLY on the pipeline's promote job and on
 *      the caller jobs that invoke the pipeline to publish — never
 *      workflow-wide, never on the PR caller.
 *   2. cache-from: / cache-to: never appear in any publisher workflow.
 *   3. The aggregate all-components-gate `needs:` every stage/scan,
 *      index-assembly AND E2E job, and promote needs the gate.
 *   4. build-images.yml's pull_request caller cannot publish (publish:
 *      false, contents:read only).
 *   5. stage-and-scan never carries docker/login-action (no GHCR auth
 *      before the gate) and builds to a local OCI layout.
 *   6. The pipeline builds EVERY images.json component (so its E2E runs
 *      scanned bytes); each release promotes exactly its fleet's set.
 *   7. E2E runs the scanned amd64 layouts, never a rebuild.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { componentsFor, loadCatalog } from '../../scripts/image-catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');
const catalog = loadCatalog(repoRoot);

const PIPELINE = '.github/workflows/_images.yml';
const CALLERS = [
  '.github/workflows/build-images.yml',
  '.github/workflows/release-registrar.yml',
  '.github/workflows/release-devices.yml',
] as const;
const RELEASES = [
  ['.github/workflows/release-registrar.yml', 'registrar'],
  ['.github/workflows/release-devices.yml', 'devices'],
] as const;
const ALL_WORKFLOWS = [PIPELINE, ...CALLERS];

interface WfJob {
  name?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  if?: string | boolean;
  uses?: string;
  with?: Record<string, unknown>;
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

const pipeline = loadWf(PIPELINE);
const isPipelineCall = (job: WfJob) => job.uses === './.github/workflows/_images.yml';

describe('publisher workflows: every publisher runs the ONE shared pipeline', () => {
  for (const wf of CALLERS) {
    it(`${wf}: calls _images.yml and carries no build/scan/promote job of its own`, () => {
      const doc = loadWf(wf);
      const calls = Object.values(doc.jobs).filter(isPipelineCall);
      expect(calls.length, `${wf} must call the shared pipeline`).toBeGreaterThan(0);
      for (const forbidden of ['stage-and-scan', 'assemble-and-validate', 'all-components-gate', 'promote', 'verify-remote']) {
        expect(doc.jobs[forbidden], `${wf} must not define its own ${forbidden}`).toBeUndefined();
      }
      expect(read(wf)).not.toContain('docker/build-push-action');
    });
  }

  it('the pipeline is a workflow_call workflow with publish/promote inputs', () => {
    const on = pipeline.on as { workflow_call?: { inputs?: Record<string, { type?: string; default?: unknown }> } };
    const inputs = on.workflow_call?.inputs ?? {};
    expect(inputs.publish?.type).toBe('boolean');
    expect(inputs.publish?.default).toBe(false);
    expect(inputs.promote_fleet?.default).toBe('all');
    expect(inputs.promote_only?.default).toBe('all');
  });
});

describe('publisher workflow graph: packages:write is scoped ONLY to promote', () => {
  for (const wf of ALL_WORKFLOWS) {
    it(`${wf}: workflow-wide permissions are contents:read, never packages:write`, () => {
      const doc = loadWf(wf);
      expect(doc.permissions, `${wf} must declare workflow-wide permissions`).toBeDefined();
      expect(doc.permissions!.packages).not.toBe('write');
      expect(doc.permissions!.contents).toBe('read');
    });
  }

  it(`${PIPELINE}: packages:write appears on the promote job only`, () => {
    const writers = Object.entries(pipeline.jobs)
      .filter(([, job]) => job.permissions?.packages === 'write')
      .map(([id]) => id);
    expect(writers).toEqual(['promote']);
  });

  for (const wf of CALLERS) {
    it(`${wf}: packages:write only on the pipeline call that may publish`, () => {
      const doc = loadWf(wf);
      for (const [jobId, job] of Object.entries(doc.jobs)) {
        if (job.permissions?.packages !== 'write') continue;
        expect(isPipelineCall(job), `${wf}: job "${jobId}" carries packages:write but is not the pipeline call`).toBe(true);
        expect(job.with?.publish, `${wf}: "${jobId}" grants packages:write but never publishes`).not.toBe(false);
      }
    });
  }
});

describe('publisher workflow graph: zero cache-from/cache-to in candidate build steps', () => {
  for (const wf of ALL_WORKFLOWS) {
    it(`${wf}: no cache-from/cache-to, no type=gha cache scoping`, () => {
      const text = read(wf);
      expect(text).not.toMatch(/cache-from\s*:/);
      expect(text).not.toMatch(/cache-to\s*:/);
      expect(text).not.toContain('type=gha');
    });
  }
});

describe('publisher workflow graph: aggregate gate covers every stage/scan, index and E2E job', () => {
  const gate = pipeline.jobs['all-components-gate'];

  it('all-components-gate needs stage-and-scan, assemble-and-validate and e2e', () => {
    expect(needsList(gate).sort()).toEqual(['assemble-and-validate', 'e2e', 'stage-and-scan']);
  });

  it('all-components-gate uses if: always() so cancelled/skipped deps are inspected, not swallowed', () => {
    expect(gate.if).toBe('always()');
  });

  it("all-components-gate's own steps explicitly check every dep's .result", () => {
    const text = stepsText(gate);
    for (const dep of ['stage-and-scan', 'assemble-and-validate', 'e2e']) {
      expect(text).toContain(`needs.${dep}.result`);
    }
  });

  it('promote is gated behind all-components-gate; verify-remote behind promote', () => {
    expect(needsList(pipeline.jobs.promote)).toContain('all-components-gate');
    expect(needsList(pipeline.jobs['verify-remote'])).toContain('promote');
  });
});

describe('publisher workflow graph: publishing is explicit (PR path cannot publish)', () => {
  const build = loadWf('.github/workflows/build-images.yml');

  it('promote + verify-remote run only when the caller passes publish: true', () => {
    expect(pipeline.jobs.promote.if).toBe('inputs.publish');
    expect(pipeline.jobs['verify-remote'].if).toBe('inputs.publish');
  });

  it('build-images.yml: the pull_request caller passes publish: false with contents:read only', () => {
    const validate = build.jobs.validate;
    expect(isPipelineCall(validate)).toBe(true);
    expect(validate.if).toBe("github.event_name == 'pull_request'");
    expect(validate.with?.publish).toBe(false);
    expect(validate.permissions).toEqual({ contents: 'read' });
  });

  it('build-images.yml: the publishing caller is structurally excluded from pull_request and owner-gated', () => {
    const publish = build.jobs.publish;
    expect(isPipelineCall(publish)).toBe(true);
    expect(publish.if).toBe("github.event_name != 'pull_request'");
    expect(String(publish.with?.publish)).toContain("vars.VS_GHCR_PUBLISH_ENABLED == 'true'");
  });

  it('manual dispatch narrows PROMOTION to one component; the pipeline still builds + gates everything', () => {
    const dispatch = (build.on as { workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: string; options?: string[] }> } })
      .workflow_dispatch;
    const componentInput = dispatch?.inputs?.component;
    expect(componentInput?.type).toBe('choice');
    expect(componentInput?.default).toBe('all');
    expect(componentInput?.options?.[0]).toBe('all');
    expect(componentInput?.options?.slice(1).sort()).toEqual(Object.keys(catalog.components).sort());
    expect(String(build.jobs.publish.with?.promote_only)).toContain('inputs.component');

    const planText = stepsText(pipeline.jobs.plan);
    expect(planText).toMatch(/image-catalog\.mjs matrix\)/);
    expect(planText).not.toMatch(/image-catalog\.mjs matrix --/);
    expect(JSON.stringify(pipeline.jobs['stage-and-scan'].strategy?.matrix)).toContain('needs.plan.outputs.matrix');
    expect(JSON.stringify(pipeline.jobs.promote.strategy?.matrix)).toContain('needs.plan.outputs.promote');
    expect(pipeline.jobs['verify-remote'].strategy?.matrix).toEqual(pipeline.jobs.promote.strategy?.matrix);
  });

  it('stage-and-scan and assemble-and-validate run unconditionally (validate-only on PR)', () => {
    expect(pipeline.jobs['stage-and-scan'].if).toBeUndefined();
    expect(pipeline.jobs['assemble-and-validate'].if).toBeUndefined();
  });

  for (const [wf] of RELEASES) {
    it(`${wf}: the release tail runs only after the pipeline, and only when publishing is enabled`, () => {
      const doc = loadWf(wf);
      for (const jobId of ['release-evidence', 'scan', 'smoke']) {
        expect(needsList(doc.jobs[jobId])).toContain('images');
        expect(doc.jobs[jobId].if).toBe("vars.VS_GHCR_PUBLISH_ENABLED == 'true'");
      }
    });
  }
});

describe('publisher workflow graph: stage-and-scan never authenticates to any registry', () => {
  const stage = pipeline.jobs['stage-and-scan'];
  const stageBlock = read(PIPELINE).slice(
    read(PIPELINE).indexOf('\n  stage-and-scan:'),
    read(PIPELINE).indexOf('\n  assemble-and-validate:'),
  );

  it('stage-and-scan and assemble-and-validate never log into GHCR or touch the token', () => {
    for (const jobId of ['stage-and-scan', 'assemble-and-validate']) {
      const text = stepsText(pipeline.jobs[jobId]);
      expect(text).not.toContain('docker/login-action');
      expect(text).not.toContain('GITHUB_TOKEN');
    }
    expect(stepsText(stage)).not.toContain('docker/login-action');
  });

  it("stage-and-scan's build step has push: false and writes a local OCI layout", () => {
    expect(stageBlock).toContain('push: false');
    expect(stageBlock).not.toContain('push: true');
    expect(stageBlock).toContain('type=oci');
    expect(stageBlock).toContain('dest=');
  });

  it('the credential scan covers the image inputs from the catalog, not the whole build context', () => {
    const text = stepsText(stage);
    expect(text).toContain('scripts/image-catalog.mjs inputs');
    expect(text).toContain('scripts/credential-scan-run.mjs');
  });
});

describe('publisher workflow graph: component sets match the design (7/3, union 9)', () => {
  it('the catalog names the 9 families; the pipeline builds all of them', () => {
    expect(Object.keys(catalog.components).sort()).toEqual(
      ['agent', 'hermes', 'litellm', 'postgres', 'registrant', 'registrar', 'scotty', 'tailscale', 'tailscale-devices'],
    );
  });

  it('release-registrar promotes the 7 registrar-fleet components; release-devices the 3 devices ones', () => {
    for (const [wf, fleet] of RELEASES) {
      const doc = loadWf(wf);
      const call = Object.values(doc.jobs).find(isPipelineCall)!;
      expect(call.with?.promote_fleet, wf).toBe(fleet);
    }
    expect(componentsFor(catalog, 'registrar').sort()).toEqual(
      ['hermes', 'litellm', 'postgres', 'registrant', 'registrar', 'scotty', 'tailscale'],
    );
    expect(componentsFor(catalog, 'devices').sort()).toEqual(['agent', 'registrant', 'tailscale-devices']);
  });
});

describe('publisher workflow graph: CI loads the gate module built from registrar/src/oci-gate', () => {
  it('stage-and-scan/assemble-and-validate run npm ci + npm run build before invoking the gate', () => {
    for (const jobId of ['stage-and-scan', 'assemble-and-validate']) {
      const text = stepsText(pipeline.jobs[jobId]);
      expect(text, `${jobId} must run npm ci`).toContain('npm ci');
      expect(text, `${jobId} must run npm run build (compiles oci-gate dist/)`).toContain('npm run build');
    }
  });

  it('the gate CLI script is invoked by both scan and assemble steps', () => {
    const scanText = stepsText(pipeline.jobs['stage-and-scan']);
    const assembleText = stepsText(pipeline.jobs['assemble-and-validate']);
    expect(scanText).toContain('scripts/oci-gate-run.mjs');
    expect(scanText).toContain('scan ');
    expect(assembleText).toContain('scripts/oci-gate-run.mjs');
    expect(assembleText).toContain('assemble ');
  });

  it('scripts/oci-gate-run.mjs exists', () => {
    expect(() => readFileSync(path.join(repoRoot, 'scripts/oci-gate-run.mjs'), 'utf8')).not.toThrow();
  });
});

describe('publisher workflow graph: E2E runs the scanned bytes, never a rebuild', () => {
  const e2e = pipeline.jobs.e2e;

  it('e2e needs stage-and-scan and loads the scanned amd64 layouts', () => {
    expect(needsList(e2e)).toContain('stage-and-scan');
    const text = stepsText(e2e);
    expect(text).toContain('layout-*-amd64');
    expect(text).toContain('scripts/e2e-load-images.sh');
  });

  it('e2e runs in prebuilt mode (no --build) and always tears down', () => {
    const text = stepsText(e2e);
    expect(text).toContain('E2E_PREBUILT=1 deploy/e2e.sh --up');
    const teardown = (e2e.steps ?? []).find((s) => String(s.run ?? '').includes('--down'));
    expect(teardown?.if).toBe('always()');
  });

  it('ci.yml no longer runs a separate source-built E2E', () => {
    expect(read('.github/workflows/ci.yml')).not.toContain('deploy/e2e.sh');
  });
});

describe('publisher workflow steps: shape invariants that catch YAML parse-time breakage', () => {
  // GitHub Actions rejects a workflow file at parse time when a step carries
  // both run: and uses: — a failure mode naive YAML-parsing tests miss,
  // because the malformed nesting is legal YAML. This pins the shape so the
  // next tag cut cannot inherit it (1py.r3v review finding 1-2).
  for (const wf of ALL_WORKFLOWS) {
    it(`${wf}: every step in every job carries at most one of run/uses`, () => {
      const doc = loadWf(wf);
      for (const [jobId, job] of Object.entries(doc.jobs)) {
        const steps = Array.isArray(job.steps) ? job.steps : [];
        steps.forEach((step, i) => {
          const hasRun = typeof step.run === 'string';
          const hasUses = typeof step.uses === 'string';
          expect(
            hasRun && hasUses,
            `${wf}#${jobId} step ${i + 1} (${String(step.name ?? step.uses ?? '?')}): run and uses are mutually exclusive`,
          ).toBe(false);
        });
      }
    });

    // An unterminated double quote inside a run: block grafts the following
    // YAML into a single scalar — legal YAML, but the step's shell script is
    // truncated and the next steps are never emitted. Line-level counts would
    // false-positive on multi-line node -e ' payloads, so count per block.
    it(`${wf}: every run: block has an even double-quote count across the whole block`, () => {
      const doc = loadWf(wf);
      for (const [jobId, job] of Object.entries(doc.jobs)) {
        const steps = Array.isArray(job.steps) ? job.steps : [];
        steps.forEach((step) => {
          if (typeof step.run !== 'string') return;
          const quotes = (step.run.match(/"/g) ?? []).length;
          expect(
            quotes % 2,
            `${wf}#${jobId} step "${String(step.name)}": block carries ${quotes} unpaired double quotes`,
          ).toBe(0);
        });
      }
    });
  }

  for (const [wf, fleet] of RELEASES) {
    it(`${wf}: every --component ledger pin is a fully-quoted assignment on its own line`, () => {
      const raw = read(wf);
      const componentLines = raw.split('\n').map((line, i) => [i + 1, line] as const).filter(([, line]) =>
        /^\s*--component\s/.test(line),
      );
      expect(componentLines.length, `${wf}: expected ledger component pins`).toBeGreaterThan(0);
      for (const [n, rawLine] of componentLines) {
        expect(
          rawLine.trimEnd(),
          `${wf} line ${n}: --component pin must close its double-quoted value before the line end`,
        ).toMatch(/^\s*--component\s+.*"\s*(?:\\)?$/);
      }
    });

    // The evidence-ledger rollback artifact must name exactly the components
    // the release promotes (thanosbot's review note on #83) — the catalog's
    // fleet set, which is what the pipeline call promotes.
    it(`${wf}: release-evidence ledger --component list equals the ${fleet} fleet's promoted set`, () => {
      const doc = loadWf(wf);
      const ledgerSteps = Object.values(doc.jobs).flatMap((job) =>
        (Array.isArray(job.steps) ? job.steps : []).filter(
          (step) => typeof step.run === 'string' && /ghcr-promote-run\.mjs ledger/.test(step.run as string),
        ),
      );
      expect(ledgerSteps.length, `${wf}: exactly one release-evidence ledger step expected`).toBe(1);
      const found = [...(ledgerSteps[0].run as string).matchAll(/--component\s+([^=\s]+)=/g)].map((m) => m[1]);
      expect(found.sort()).toEqual(componentsFor(catalog, fleet).sort());
    });
  }
});

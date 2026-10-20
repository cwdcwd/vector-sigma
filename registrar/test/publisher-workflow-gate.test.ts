/**
 * Publisher workflow graph invariants (fleet-ops-1py.14 slice 5).
 *
 * Pins the structural shape Thanos's design (fleet-ops-1py.12) and
 * docs/ghcr-image-exposure-plan.md section B require of the publish path,
 * by parsing the real YAML. The graph lives ONCE, in two reusable
 * workflows: .github/workflows/_images.yml (build/scan/E2E, read-only) and
 * .github/workflows/_promote.yml (promote/verify). build-images.yml,
 * release-registrar.yml and release-devices.yml call _images.yml from an
 * `images` job and _promote.yml from a `publish` job that needs it. Pinned:
 *
 *   1. packages:write appears ONLY on _promote.yml's promote job and on
 *      the callers' `publish` job — never workflow-wide, never reachable
 *      from pull_request.
 *   2. cache-from: / cache-to: never appear in any publisher workflow.
 *   3. The aggregate all-components-gate `needs:` every stage/scan,
 *      index-assembly AND E2E job; every `publish` job needs `images`.
 *   4. build-images.yml's publish job is structurally excluded from
 *      pull_request and gated on the owner switch.
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
const PROMOTE = '.github/workflows/_promote.yml';
const CALLERS = [
  '.github/workflows/build-images.yml',
  '.github/workflows/release-registrar.yml',
  '.github/workflows/release-devices.yml',
] as const;
const RELEASES = [
  ['.github/workflows/release-registrar.yml', 'registrar'],
  ['.github/workflows/release-devices.yml', 'devices'],
] as const;
const ALL_WORKFLOWS = [PIPELINE, PROMOTE, ...CALLERS];

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
const promoteWf = loadWf(PROMOTE);
const isPipelineCall = (job: WfJob) => job.uses === './.github/workflows/_images.yml';
const isPromoteCall = (job: WfJob) => job.uses === './.github/workflows/_promote.yml';

describe('publisher workflows: every publisher runs the ONE shared pipeline', () => {
  for (const wf of CALLERS) {
    it(`${wf}: an images job calls _images.yml, a publish job (needing it) calls _promote.yml`, () => {
      const doc = loadWf(wf);
      expect(isPipelineCall(doc.jobs.images), `${wf} images job must call _images.yml`).toBe(true);
      expect(isPromoteCall(doc.jobs.publish), `${wf} publish job must call _promote.yml`).toBe(true);
      expect(needsList(doc.jobs.publish)).toEqual(['images']);
      for (const forbidden of ['stage-and-scan', 'assemble-and-validate', 'all-components-gate', 'promote', 'verify-remote']) {
        expect(doc.jobs[forbidden], `${wf} must not define its own ${forbidden}`).toBeUndefined();
      }
      expect(read(wf)).not.toContain('docker/build-push-action');
    });
  }

  it('both halves are workflow_call workflows; only _promote.yml takes promotion inputs', () => {
    type Call = { workflow_call?: { inputs?: Record<string, { type?: string; default?: unknown }> } | null };
    expect((pipeline.on as Call).workflow_call?.inputs ?? {}).toEqual({});
    const inputs = (promoteWf.on as Call).workflow_call?.inputs ?? {};
    expect(inputs.promote_fleet?.default).toBe('all');
    expect(inputs.promote_only?.default).toBe('all');
    expect(Object.keys(pipeline.jobs)).not.toContain('promote');
    expect(Object.keys(pipeline.jobs)).not.toContain('verify-remote');
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

  const writers = (doc: WfDoc) =>
    Object.entries(doc.jobs)
      .filter(([, job]) => job.permissions?.packages === 'write')
      .map(([id]) => id);

  it(`${PIPELINE}: no job holds packages:write (build/scan/E2E is read-only)`, () => {
    expect(writers(pipeline)).toEqual([]);
  });

  it(`${PROMOTE}: packages:write appears on the promote job only`, () => {
    expect(writers(promoteWf)).toEqual(['promote']);
  });

  for (const wf of CALLERS) {
    it(`${wf}: packages:write only on the publish job; the images job is contents:read`, () => {
      const doc = loadWf(wf);
      expect(writers(doc)).toEqual(['publish']);
      expect(doc.jobs.images.permissions).toEqual({ contents: 'read' });
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

describe('publisher workflow graph: aggregate gate covers every stage/scan and E2E job, then assembles every index', () => {
  const gate = pipeline.jobs['all-components-gate'];

  it('all-components-gate needs plan, stage-and-scan and e2e', () => {
    expect(needsList(gate).sort()).toEqual(['e2e', 'plan', 'stage-and-scan']);
  });

  it('all-components-gate assembles every index AFTER its result checks, from the plan component list', () => {
    const steps = (gate.steps ?? []) as Array<{ run?: string; env?: Record<string, string> }>;
    const check = steps.findIndex((s) => (s.run ?? '').includes('needs.stage-and-scan.result'));
    const assemble = steps.findIndex((s) => (s.run ?? '').includes('oci-gate-run.mjs assemble'));
    expect(check, 'result-check step').toBeGreaterThanOrEqual(0);
    expect(assemble, 'assemble runs only after the result checks pass').toBeGreaterThan(check);
    expect(steps[assemble]!.env?.COMPONENTS).toContain('needs.plan.outputs.components');
  });

  it('all-components-gate uses if: always() so cancelled/skipped deps are inspected, not swallowed', () => {
    expect(gate.if).toBe('always()');
  });

  it("all-components-gate's own steps explicitly check every dep's .result", () => {
    const text = stepsText(gate);
    for (const dep of ['plan', 'stage-and-scan', 'e2e']) {
      expect(text).toContain(`needs.${dep}.result`);
    }
  });

  it('promotion runs only after the whole pipeline: publish needs images; verify-remote needs promote', () => {
    for (const wf of CALLERS) expect(needsList(loadWf(wf).jobs.publish), wf).toEqual(['images']);
    expect(needsList(promoteWf.jobs.promote)).toContain('plan');
    expect(needsList(promoteWf.jobs['verify-remote'])).toContain('promote');
  });

  it('verify-remote is ONE job re-reading every promoted component from the plan list, failing if any fails', () => {
    const verify = promoteWf.jobs['verify-remote'];
    expect(verify.strategy, 'no per-component matrix').toBeUndefined();
    const text = stepsText(verify);
    expect(text).toContain('needs.plan.outputs.promote');
    expect(text).toContain('ghcr-promote-run.mjs verify');
    expect(text).toContain('exit \\"$failed\\"');
  });
});

describe('publisher workflow graph: publishing is explicit (PR path cannot publish)', () => {
  const build = loadWf('.github/workflows/build-images.yml');

  it('build-images.yml: images runs on every event with contents:read only', () => {
    expect(build.jobs.images.if).toBeUndefined();
    expect(build.jobs.images.permissions).toEqual({ contents: 'read' });
  });

  it('build-images.yml: publish is structurally excluded from pull_request and owner-gated', () => {
    expect(build.jobs.publish.if).toBe(
      "github.event_name != 'pull_request' && vars.VS_GHCR_PUBLISH_ENABLED == 'true'",
    );
  });

  for (const [wf] of RELEASES) {
    it(`${wf}: publish is owner-gated`, () => {
      expect(loadWf(wf).jobs.publish.if).toBe("vars.VS_GHCR_PUBLISH_ENABLED == 'true'");
    });
  }

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
    expect(stepsText(promoteWf.jobs.plan)).toContain('--only');
    expect(JSON.stringify(promoteWf.jobs.promote.strategy?.matrix)).toContain('needs.plan.outputs.promote');
  });

  it('stage-and-scan runs unconditionally and the gate (with index assembly) always runs (validate-only on PR)', () => {
    expect(pipeline.jobs['stage-and-scan'].if).toBeUndefined();
    expect(pipeline.jobs['all-components-gate'].if).toBe('always()');
  });

  for (const [wf] of RELEASES) {
    it(`${wf}: the release tail runs only after publish (skips with it)`, () => {
      const doc = loadWf(wf);
      for (const jobId of ['release-evidence', 'scan', 'smoke']) {
        expect(needsList(doc.jobs[jobId])).toEqual(['publish']);
      }
    });
  }
});

describe('publisher workflow graph: stage-and-scan never authenticates to any registry', () => {
  const stage = pipeline.jobs['stage-and-scan'];
  const stageBlock = read(PIPELINE).slice(
    read(PIPELINE).indexOf('\n  stage-and-scan:'),
    read(PIPELINE).indexOf('\n  e2e:'),
  );

  it('stage-and-scan and the index-assembling gate never log into GHCR or touch the token', () => {
    for (const jobId of ['stage-and-scan', 'all-components-gate']) {
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
      expect(loadWf(wf).jobs.publish.with?.promote_fleet, wf).toBe(fleet);
    }
    expect(componentsFor(catalog, 'registrar').sort()).toEqual(
      ['hermes', 'litellm', 'postgres', 'registrant', 'registrar', 'scotty', 'tailscale'],
    );
    expect(componentsFor(catalog, 'devices').sort()).toEqual(['agent', 'registrant', 'tailscale-devices']);
  });
});

describe('publisher workflow graph: CI loads the gate module built from registrar/src/oci-gate', () => {
  it('stage-and-scan and the index-assembling gate run npm ci + npm run build before invoking the gate', () => {
    for (const jobId of ['stage-and-scan', 'all-components-gate']) {
      const text = stepsText(pipeline.jobs[jobId]);
      expect(text, `${jobId} must run npm ci`).toContain('npm ci');
      expect(text, `${jobId} must run npm run build (compiles oci-gate dist/)`).toContain('npm run build');
    }
  });

  it('the gate CLI script is invoked by both scan and assemble steps', () => {
    const scanText = stepsText(pipeline.jobs['stage-and-scan']);
    const assembleText = stepsText(pipeline.jobs['all-components-gate']);
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
    expect(text).toContain('E2E_PREBUILT=1 test/e2e/e2e.sh --up');
    const teardown = (e2e.steps ?? []).find((s) => String(s.run ?? '').includes('--down'));
    expect(teardown?.if).toBe('always()');
  });

  // PR #87 review (kangbot): `docker load` reads type=oci layouts only on the
  // containerd image store; the hosted runners' classic store fails with
  // "open .../blobs/json: no such file or directory". The loader imports via
  // skopeo (store-agnostic) and proves the imported layers are the layout's.
  it('the loader imports with skopeo (never docker load) and verifies layer diff IDs', () => {
    const code = read('scripts/e2e-load-images.sh')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).toContain('skopeo copy');
    expect(code).toContain('oci-archive:');
    expect(code).toContain('docker-daemon:');
    expect(code).not.toMatch(/docker load/);
    expect(code).toContain('scripts/oci-layout-diffids.mjs');
    expect(code).toContain('.RootFS.Layers');
  });

  it('ci.yml no longer runs a separate source-built E2E', () => {
    expect(read('.github/workflows/ci.yml')).not.toContain('test/e2e/e2e.sh');
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

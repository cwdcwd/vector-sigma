import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Release smoke gate harness (fleet-ops-1py.7 rung 2, review 5480276420 on
 * PR #59 — Kang's five blockers were all tag-cut runtime failures that the
 * PR-event CI never executed: the release workflows are tags-only, and the
 * smoke script had never run against real image bytes).
 *
 * This suite pins the SMOKE GATE ITSELF, so its defect classes fail at PR
 * time instead of at the first tag cut:
 *
 *   1. Mode: scripts/release-smoke.sh must be git-mode 100755 — both
 *      release workflows invoke it directly (`run: scripts/...`), and a
 *      100644 script dies exit-126 at tag-cut (finding 3's class).
 *   2. trivy-action ref must be a real tag (@v0.36.0): the no-v form
 *      resolves to nothing and kills every release run at the scan job
 *      (finding 1's class).
 *   3. Artifact path coherence: each release workflow's deploy job must
 *      download the rendered compose to the SAME directory its `cd`
 *      enters (finding 2's class).
 *   4. Count-based grep assertions must match the REAL bake sources:
 *      every `grep -c '<needle>' <path>` in the smoke script is re-run
 *      against the mapped file in this tree, and the expected count must
 *      equal the real count. The original marker assertion (`grep -c
 *      'ready.marker'` expecting 1 against a file carrying 4) is the
 *      exact defect — a healthy image failed the gate (finding 5's
 *      class).
 *   5. The registrar fail-loud probe must INVOKE loadConfig(), not just
 *      import the module: registrar's config.ts exports loadConfig and
 *      index.ts calls it inside main() — a bare import on a healthy
 *      image prints nothing and the grep fails (finding 4's class). The
 *      registrant sibling works ONLY because its index.ts calls
 *      loadConfig() at module scope — pinned here so a future refactor
 *      that moves it inside a function fails this test, not the release.
 *   6. Fail-loud message needles exist in the sources the images bake.
 *   7. The dockerless shim (local smoke runner) parses.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const SMOKE = 'scripts/release-smoke.sh';
const WORKFLOWS = [
  '.github/workflows/release-registrar.yml',
  '.github/workflows/release-devices.yml',
] as const;

/** Image path -> repo source the bake COPYs from (the bytes the image carries). */
const IMAGE_TO_SOURCE: Record<string, string> = {
  '/usr/local/bin/postgres-wrapper.sh': 'balena/registrar/postgres-entrypoint.sh',
  '/usr/local/bin/gate.sh': 'balena/devices/agent/gate.sh',
};

const appFor: Record<string, string> = {
  '.github/workflows/release-registrar.yml': 'registrar',
  '.github/workflows/release-devices.yml': 'devices',
};

describe('release smoke gate: script is executable at CI-invoked paths (finding 3 class)', () => {
  it('scripts/release-smoke.sh is git-mode 100755 (direct `run:` invocation needs +x)', () => {
    let mode = '';
    try {
      mode = execFileSync('git', ['ls-files', '-s', SMOKE], { cwd: repoRoot }).toString().trim();
    } catch {
      mode = ''; // no git in the environment — fall through to the fs-mode check
    }
    if (mode) {
      expect(mode.startsWith('100755'), `git index mode for ${SMOKE}: ${mode}`).toBe(true);
    } else {
      const st = statSync(path.join(repoRoot, SMOKE));
      expect(st.mode & 0o111, `${SMOKE} must carry exec bits`).not.toBe(0);
    }
  });
});

describe('release workflows: tag-cut blocker classes (findings 1-2)', () => {
  it('every trivy-action ref is a v-tag (v-less ref = dead scan job)', () => {
    for (const wf of WORKFLOWS) {
      const text = read(wf);
      const refs = [...text.matchAll(/aquasecurity\/trivy-action@(\S+)/g)].map((m) => m[1]);
      expect(refs.length, `${wf} references trivy-action`).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref.startsWith('v'), `${wf}: trivy-action@${ref} — the v-less form does not resolve`).toBe(true);
      }
    }
  });

  it('deploy downloads the rendered compose to the directory it cds into', () => {
    for (const wf of WORKFLOWS) {
      const text = read(wf);
      // normalize: strip trailing slashes so `path: release/registrar/` (upload)
      // and `path: release/registrar` (download) both map to `registrar`.
      const downloads = [...text.matchAll(/path:\s*release\/(\S+)/g)]
        .map((m) => m[1].replace(/\/+$/, ''));
      const cds = [...text.matchAll(/cd\s+release\/(\S+)/g)]
        .map((m) => m[1].replace(/\/+$/, ''));
      expect(downloads.length, `${wf} names a download path`).toBeGreaterThan(0);
      expect(cds.length, `${wf} cds into a release dir`).toBeGreaterThan(0);
      for (const d of downloads) {
        expect(
          cds.includes(d),
          `${wf}: artifact downloads to release/${d} but deploy cds into release/${cds.join(', ')}`,
        ).toBe(true);
      }
      for (const c of cds) {
        expect(
          downloads.includes(c),
          `${wf}: deploy cds into release/${c} but no artifact lands there`,
        ).toBe(true);
      }
    }
  });

  it('each workflow smokes the app it releases (and names it in the step)', () => {
    for (const wf of WORKFLOWS) {
      const app = appFor[wf];
      const text = read(wf);
      expect(text, `${wf} smokes the ${app} app`).toContain(`scripts/release-smoke.sh cwdcwd/vector-sigma \${{ github.sha }} ${app}`);
      expect(text, `${wf} smoke step names the ${app} components`).toContain(
        `Boot-path smoke (${app} app components)`,
      );
    }
  });
});

describe('smoke assertions vs real bake sources (findings 4-5 classes)', () => {
  const smoke = read(SMOKE);

  it('every grep -c expectation equals the real line count in the mapped source', () => {
    // expect_grep  "<label>" "<image>" \
    //   "grep -c '<needle>' <path>" "<want>"
    const re =
      /expect_grep\s+"[^"]+"\s+"[^"]+"\s*\\\s*"grep -c '([^']+)' ([^"]+)"\s+"(\d+)"/g;
    const found = Array.from(smoke.matchAll(re)) as RegExpMatchArray[];
    expect(found.length, 'smoke script carries grep -c assertions').toBeGreaterThanOrEqual(3);
    for (const m of found) {
      const needle = m[1] as string;
      const imageTarget = m[2] as string;
      const want = m[3] as string;
      const source = IMAGE_TO_SOURCE[imageTarget];
      expect(
        source !== undefined,
        `no repo-source mapping for image path ${imageTarget} — add one to IMAGE_TO_SOURCE so this guard covers it`,
      ).toBeDefined();
      const lines = read(source as string).split('\n');
      const real = lines.filter((l) => l.includes(needle)).length;
      expect(
        real,
        `grep -c '${needle}' ${imageTarget} expects ${want} but ${source} carries ${real} matching lines — the gate fails a healthy image`,
      ).toBe(Number(want));
    }
  });

  it('the gate marker assertion is presence-shaped, not a wrong count (finding 5)', () => {
    // gate.sh legitimately carries ready.marker on 4 lines; a count-based
    // assertion with any single expected value is the defect class.
    expect(smoke).not.toContain("grep -c 'ready.marker'");
    expect(smoke).toContain("grep 'ready.marker' /usr/local/bin/gate.sh");
  });

  it('the registrar fail-loud probe invokes loadConfig(), not a bare import (finding 4)', () => {
    // The module-scope-import defect: config.ts only EXPORTS loadConfig;
    // index.ts calls it inside main(). A bare require() on a healthy image
    // prints nothing and the needle grep fails. (The file carries the
    // probe inside a double-quoted bash string, so the inner quotes are
    // backslash-escaped bytes — assert the byte-exact form.)
    expect(smoke).toContain('require(\\"/app/dist/config.js\\").loadConfig()');
    expect(smoke).not.toContain('require(\\"/app/dist/config.js\\")}catch');
  });

  it('the registrant probe runs the entrypoint — and that works because registrant/src/index.ts calls loadConfig() at module scope', () => {
    const smokeCmdRegistrar = 'node /app/dist/index.js 2>&1 | head -3';
    expect(smoke).toContain(smokeCmdRegistrar);
    const registrantIndex = read('registrant/src/index.ts');
    expect(
      /^\s*const config = loadConfig\(\);/m.test(registrantIndex) ||
        /^\s*loadConfig\(\)/m.test(registrantIndex),
      'registrant index must invoke loadConfig() at module scope — the entrypoint-run smoke assertion depends on it',
    ).toBe(true);
  });

  it('fail-loud needles exist in the sources the images bake', () => {
    expect(read('registrar/src/config.ts')).toContain('invalid registrar configuration');
    expect(read('registrant/src/config.ts')).toContain('invalid registrant configuration');
    expect(read('balena/registrar/postgres-entrypoint.sh')).toContain('LITELLM_PG_PASSWORD is required');
    expect(read('balena/registrar/litellm-entrypoint.sh')).toContain('LITELLM_PG_PASSWORD is required');
  });
});

describe('dockerless smoke shim (local gate runner)', () => {
  it('parses as valid ESM (node --check)', () => {
    expect(() =>
      execFileSync('node', ['--check', 'scripts/smoke-docker-shim.mjs'], { cwd: repoRoot }),
    ).not.toThrow();
  });

  it('release-smoke.sh routes DRUN through the shim when SMOKE_DOCKERLESS=1', () => {
    const smoke = read(SMOKE);
    expect(smoke).toContain('SMOKE_DOCKERLESS');
    expect(smoke).toContain('smoke-docker-shim.mjs');
  });
});
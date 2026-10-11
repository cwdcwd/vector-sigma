import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  MESH_TAILNET_SUFFIX_ENV,
  MESH_EDGE_HOST_ENV,
  resolveMeshTopology,
} from '../src/mesh-enroll.js';

/**
 * CI run 38166497113 (PR #61): AC17 (compose e2e's
 * ac17_mesh_enroll_capability) failed closed with
 * mesh_enroll_not_configured. Root cause — 1py.14 moved mesh-enroll's
 * tailnet suffix/edge host from baked constants to fail-closed runtime
 * env (VS_MESH_TAILNET_SUFFIX / VS_MESH_EDGE_HOST, resolveMeshTopology
 * in src/mesh-enroll.ts), but deploy/compose.e2e.yaml's registrar
 * service was never given them — the E2E registrar refused every
 * enroll by design, not a code defect. This pins the fix: the e2e
 * overlay supplies non-secret, synthetic topology values (same shape
 * the mesh-enroll-route unit tests use) so AC17 exercises the REAL
 * configured path, and a regression (the compose keys vanishing again,
 * or resolving to something resolveMeshTopology itself would reject)
 * fails CI locally before a compose e2e run is needed.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function readComposeE2e(): Record<string, unknown> {
  const raw = readFileSync(path.join(repoRoot, 'deploy/compose.e2e.yaml'), 'utf8');
  return parseYaml(raw) as Record<string, unknown>;
}

describe('deploy/compose.e2e.yaml: registrar carries mesh topology for AC17 (1py.14 follow-on)', () => {
  const doc = readComposeE2e();
  const services = doc.services as Record<string, { environment?: Record<string, string> }>;

  it('declares a registrar service override with an environment map', () => {
    expect(services.registrar).toBeDefined();
    expect(services.registrar.environment).toBeDefined();
  });

  it('carries VS_MESH_TAILNET_SUFFIX and VS_MESH_EDGE_HOST, non-empty', () => {
    const env = services.registrar.environment ?? {};
    expect(env[MESH_TAILNET_SUFFIX_ENV]).toBeTruthy();
    expect(env[MESH_EDGE_HOST_ENV]).toBeTruthy();
  });

  it('the configured values are accepted by resolveMeshTopology (fail-closed, not just non-empty)', () => {
    const env = services.registrar.environment ?? {};
    expect(() =>
      resolveMeshTopology({
        [MESH_TAILNET_SUFFIX_ENV]: env[MESH_TAILNET_SUFFIX_ENV],
        [MESH_EDGE_HOST_ENV]: env[MESH_EDGE_HOST_ENV],
      }),
    ).not.toThrow();
  });

  it('the suffix/edge host are synthetic (non-production) values — never a real fleet tailnet', () => {
    const env = services.registrar.environment ?? {};
    // The live fleet tailnet name is never allowed in a committed,
    // reusable test fixture (same rule image-content-exposure.test.ts
    // pins for baked image layers) — these are deterministic,
    // documented-synthetic e2e-only values.
    expect(env[MESH_TAILNET_SUFFIX_ENV]).toMatch(/^\.e2e-/);
    expect(env[MESH_EDGE_HOST_ENV]).toMatch(/^vsigma-master\.e2e-/);
  });
});

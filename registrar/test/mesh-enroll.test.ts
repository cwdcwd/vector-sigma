import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Mesh-enroll capability contract (fleet-ops-j7g.1 shape B).
 *
 * Guards the custody invariants the consult settled (the 2026-10-07
 * unanimous shape-B verdict, folded into the build dispatch):
 *
 *   1. SENTINEL SHAPE IS SERVER-SIDE: mesh-enroll.ts hardcodes the
 *      minted key shape (models empty, tpm unset, mesh-only
 *      allowed_routes); the shared request schema carries NO shape
 *      parameters — a caller cannot widen the mint.
 *   2. NO KEY MATERIAL TO THE CALLER: the /v1/mesh-enroll route sends
 *      alias/action/merged/bundle_version ONLY; the CLI never prints a
 *      key; the response contract asserts the field set exactly.
 *   3. MINT vs OPEN vs REFUSE: the decision table — fresh mint when
 *      the alias is absent; OPEN (verify + heal, never re-mint) when
 *      the alias is live AND the bundle carries it (the f57.14
 *      sentinel path); REFUSE when the alias is live but the bundle
 *      carries nothing (orphan guard).
 *   4. The CLI is vendored byte-exact (drift-pinned, the e5o.5
 *      pattern) and baked into the primus image at
 *      /usr/local/bin/vs-mesh-enroll.
 *   5. The CLI reads auth ONLY from env/bundle (MESH_ENROLL_KEY) —
 *      never from image layers; stdlib-only imports.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}
function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

const moduleSrc = read('registrar/src/mesh-enroll.ts');
const appSrc = read('registrar/src/app.ts');
const sharedSrc = read('shared/src/index.ts');
const cliSrc = read('scripts/vs-mesh-enroll.py');
const dockerfile = read('balena/registrar/Dockerfile.hermes');

describe('mesh-enroll sentinel shape is hardcoded server-side (j7g.1)', () => {
  it('the minted-shape constants exist and lock the mesh surface', () => {
    expect(moduleSrc).toMatch(/MESH_KEY_ALLOWED_ROUTES = \['\/a2a', '\/a2a\/\*', '\/v1\/agents'\]/);
    expect(moduleSrc).toMatch(/MESH_KEY_USER_ID = 'vs-mesh'/);
    // models empty + tpm unset: the payload literal must NOT set models/tpm
    // (LiteLLM defaults them closed) — pin the payload keys exactly.
    const payloadBlock = moduleSrc.slice(
      moduleSrc.indexOf('const payload: Record<string, unknown> = {'),
      moduleSrc.indexOf('const res = await gatewayCall(cfg, \'POST\', \'/key/generate\', payload)'),
    );
    expect(payloadBlock).toMatch(/key_alias: alias/);
    expect(payloadBlock).toMatch(/allowed_routes: MESH_KEY_ALLOWED_ROUTES/);
    expect(payloadBlock).not.toMatch(/^\s*models:/m);
    expect(payloadBlock).not.toMatch(/^\s*tpm/m);
  });

  it('the shared request schema carries NO key-shape parameters', () => {
    const block = sharedSrc.slice(
      sharedSrc.indexOf('MeshEnrollRequestSchema'),
      sharedSrc.indexOf('export type MeshEnrollRequest'),
    );
    expect(block).toMatch(/agent_name/);
    expect(block).toMatch(/origin_url/);
    expect(block).toMatch(/public_url/);
    expect(block).not.toMatch(/allowed_routes|models|tpm|duration|team_id|user_id|metadata/);
  });

  it('mint vs open vs refuse: the decision table in enrollAgent', () => {
    // REFUSE: alias live + bundle empty -> MeshEnrollError alias_live
    expect(moduleSrc).toMatch(/exists live on the gateway but agent/);
    // OPEN: alias live + bundle carries identity -> action = 'open'
    expect(moduleSrc).toMatch(/action = 'open'/);
    // MINT: alias absent -> mintMeshKey + recordMint (rate limit)
    expect(moduleSrc).toMatch(/opts.mintLimiter.recordMint\(agentName\)/);
    expect(moduleSrc).toMatch(/mintAllowed\(agentName\)/);
  });

  it('audit rows on failures, not just successes', () => {
    expect(moduleSrc).toMatch(/mesh_enroll_mint_failed/);
    expect(moduleSrc).toMatch(/mesh_enroll_register_failed/);
    expect(moduleSrc).toMatch(/mesh_enroll_merge_failed/);
    expect(moduleSrc).toMatch(/mesh_enroll_alias_live/);
    expect(moduleSrc).toMatch(/mesh_enroll_device_not_found/);
    expect(moduleSrc).toMatch(/mesh_enroll_no_bundle/);
    expect(moduleSrc).toMatch(/mesh_enroll_not_configured/);
    // the success audit row lands too
    expect(moduleSrc).toMatch(/mesh_enrolled_mint/);
    expect(moduleSrc).toMatch(/mesh_enrolled_open/);
  });

  it('creator-key bootstrap: env wins, master key only via bootstrap, marker dedupe', () => {
    const block = moduleSrc.slice(moduleSrc.indexOf('export async function bootstrapCreatorKey'));
    expect(block).toMatch(/MESH_MASTER_KEY_ENV/);
    expect(block).toMatch(/key-creator/);
    // The route lock: the e5o.3 mint surface + /v1/agents (the enroll's
    // card-row registration rides the creator key).
    expect(block).toMatch(/allowed_routes: \[\n\s+'\/user\/new',\n\s+'\/team\/new',\n\s+'\/team\/list',\n\s+'\/team\/member_add',\n\s+'\/key\/generate',\n\s+'\/v1\/agents',\n\s+\]/);
    expect(block).toMatch(/gatewayCreatorKey/);
    // the route only bootstraps when the env var is unset
    expect(appSrc).toMatch(/\(env\[MESH_CREATOR_KEY_ENV\] \?\? ''\)\.trim\(\) === ''/);
  });
});

describe('mesh-enroll API contract: no key material to the caller (j7g.1)', () => {
  it('the 200 response carries exactly alias/action/merged/bundle_version', () => {
    const block = appSrc.slice(appSrc.indexOf("app.post('/v1/mesh-enroll'"));
    const respIdx = block.indexOf('return reply.status(200).send({');
    expect(respIdx).toBeGreaterThan(-1);
    const resp = block.slice(respIdx, block.indexOf('});', respIdx));
    expect(resp).toMatch(/alias: outcome.alias/);
    expect(resp).toMatch(/action: outcome.action/);
    expect(resp).toMatch(/merged: outcome.merged/);
    expect(resp).toMatch(/bundle_version: outcome.bundleVersion/);
    expect(resp).not.toMatch(/key|token|secret/i);
  });

  it('machine-auth gate: mk_ prefix structural rejection + rate limiter + lastUsed', () => {
    expect(appSrc).toMatch(/isMeshEnrollKey\(presentedKey\) === false/);
    expect(appSrc).toMatch(/limiter.recordFailure\(ip\)/);
    expect(appSrc).toMatch(/lastUsedAt: clock.now()/);
  });

  it('the keys module carries the mk_ class', () => {
    const keys = read('registrar/src/keys.ts');
    expect(keys).toMatch(/MESH_ENROLL_KEY_PREFIX = 'mk_'/);
    expect(keys).toMatch(/export function mintMeshEnrollKey/);
  });
});

describe('vs-mesh-enroll CLI: thin, bundle-auth, drift-pinned (j7g.1)', () => {
  it('is vendored byte-exact (scripts/ -> balena/registrar/)', () => {
    expect(exists('scripts/vs-mesh-enroll.py')).toBe(true);
    expect(exists('balena/registrar/vs-mesh-enroll.py')).toBe(true);
    expect(
      cliSrc === read('balena/registrar/vs-mesh-enroll.py'),
      'balena/registrar/vs-mesh-enroll.py drifted from scripts/vs-mesh-enroll.py',
    ).toBe(true);
  });

  it('is baked into the primus image at /usr/local/bin/vs-mesh-enroll', () => {
    expect(dockerfile).toMatch(/COPY vs-mesh-enroll\.py \/usr\/local\/bin\/vs-mesh-enroll/);
    expect(dockerfile).toMatch(/chmod 0755 \/usr\/local\/bin\/vs-mesh-enroll/);
  });

  it('stdlib-only imports (no new runtime deps)', () => {
    const imports = [...cliSrc.matchAll(/^\s*(?:from\s+([\w.]+)\s+)?import\s+(.+)$/gm)].map(
      (m) => m[1] ?? m[2],
    );
    const allowed = new Set(['argparse', 'json', 'os', 'sys', 'urllib']);
    for (const imp of imports) {
      const root = imp.split('.')[0];
      expect(allowed.has(root), `unexpected import: ${imp}`).toBe(true);
    }
  });

  it('auth resolves from env or the bundle, never baked', () => {
    expect(cliSrc).toMatch(/MESH_ENROLL_KEY/);
    expect(cliSrc).toMatch(/config.*agent\.env|agent\.env/s);
    // the CLI never reads or prints key material from the API response
    expect(cliSrc).not.toMatch(/identity_key/);
  });

  it('returns {alias, merged} only — never echoes key fields', () => {
    expect(cliSrc).toMatch(/alias=/);
    expect(cliSrc).toMatch(/merged=/);
  });
});
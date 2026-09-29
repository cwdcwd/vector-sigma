import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Postgres-consolidation contract guard (fleet-ops-anc, owner ruling
 * 2026-09-29: "I want the consolidation. I hate the one shot containers").
 *
 * The one-shot litellm-init service is ELIMINATED from both composes; the
 * provisioning SQL lives in the postgres service's own wrapper image
 * (balena/registrar/Dockerfile.postgres + postgres-entrypoint.sh). This
 * guard pins the consolidation so the retired one-shot can never silently
 * return and the wrapper's hard gates stay in the tree:
 *
 *   1. no `litellm-init` service key in either compose;
 *   2. the postgres service BUILDS (Dockerfile.postgres) in both composes
 *      — not `image: postgres:16-alpine` (balena side) and not an unwrapped
 *      pull (deploy side);
 *   3. the balena litellm env block carries the STATIC
 *      OLLAMA_CLOUD_API_BASE line (the anc fixes train: the live
 *      api.openai.com misroute root cause — the comment promised the
 *      value, the line was absent);
 *   4. the wrapper script exists and forwards signals (trap TERM INT) —
 *      the graceful-shutdown contract is a HARD GATE: a wrapper that
 *      eats SIGTERM gets SIGKILLed at the 60s stop_grace_period deadline
 *      and corrupts the identity DB;
 *   5. the retired one-shot artifacts are gone (Dockerfile.litellm-init,
 *      litellm-init.sh);
 *   6. queue-join metadata carries the CANONICAL VS queue project_id (from
 *      fleet/status/vector-sigma-queue — the fleet contract, never
 *      regenerated), not the SET_BY_COORDINATOR placeholder;
 *   7. deploy parity: deploy/compose.yaml feeds the wrapper the same
 *      LITELLM_PG_PASSWORD + superuser credential the balena fleet vars
 *      deliver.
 *
 * Full-line comments are stripped before scanning where documentation
 * comments legitimately name the retired service.
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

const balenaCompose = stripComments(
  readFileSync(path.join(repoRoot, 'balena/registrar/docker-compose.yml'), 'utf8'),
);
const deployCompose = stripComments(
  readFileSync(path.join(repoRoot, 'deploy/compose.yaml'), 'utf8'),
);

describe('postgres consolidation contract (fleet-ops-anc)', () => {
  it.each([
    ['balena/registrar/docker-compose.yml', balenaCompose],
    ['deploy/compose.yaml', deployCompose],
  ])('%s: no litellm-init service key', (_rel, code) => {
    expect(code, 'the one-shot litellm-init service must not exist').not.toMatch(
      /^\s{2}litellm-init:\s*$/m,
    );
  });

  it.each([
    ['balena/registrar/docker-compose.yml', balenaCompose],
    ['deploy/compose.yaml', deployCompose],
  ])('%s: postgres service builds the wrapper image', (_rel, code) => {
    // The postgres block must be a build, and the dockerfile must be
    // Dockerfile.postgres. Extract the postgres service block (up to the
    // next service key) so a stray dockerfile line elsewhere cannot pass it.
    const m = /^ {2}postgres:\n([\s\S]*?)(?=^ {2}\S|\n\w|\Z|^$)/m.exec(code);
    expect(m, 'postgres service block not found').not.toBeNull();
    const block = m ? m[1] : '';
    expect(block, 'postgres must build, not pull the stock image').toMatch(
      /dockerfile:\s*Dockerfile\.postgres/,
    );
    expect(block, 'postgres must not use the unwrapped stock image').not.toMatch(
      /image:\s*postgres:16-alpine/,
    );
  });

  it('balena compose: litellm env carries the static OLLAMA_CLOUD_API_BASE line', () => {
    expect(balenaCompose).toMatch(
      /OLLAMA_CLOUD_API_BASE:\s*https:\/\/ollama\.com\/v1/,
    );
  });

  it('balena compose: postgres stop grace keeps the 60s SIGTERM budget', () => {
    const m = /^ {2}postgres:\n([\s\S]*?)(?=^ {2}\S)/m.exec(balenaCompose);
    const block = m ? m[1] : '';
    expect(block).toMatch(/stop_grace_period:\s*60s/);
  });

  it('wrapper script exists and forwards SIGTERM (the corruption hard gate)', () => {
    const wrapper = readFileSync(
      path.join(repoRoot, 'balena/registrar/postgres-entrypoint.sh'),
      'utf8',
    );
    // The wrapper MUST trap the stop signals and forward them to the child
    // postgres — eating the signal means SIGKILL at the deadline and a
    // corrupted identity DB (the exact failure this design closes).
    expect(wrapper).toMatch(/trap\s+\S+\s+TERM\s+INT/);
    expect(wrapper).toMatch(/kill -TERM "\$child"/);
    expect(wrapper).toMatch(/pg_isready/);
    // Provisioning SQL verbatim from the retired one-shot.
    expect(wrapper).toContain("CREATE ROLE litellm LOGIN");
    expect(wrapper).toContain('ALTER ROLE litellm LOGIN PASSWORD');
    expect(wrapper).toContain('REVOKE CONNECT ON DATABASE');
    expect(wrapper).toContain('CREATE DATABASE litellm OWNER litellm');
  });

  it('Dockerfile.postgres wraps the stock entrypoint, same base pin', () => {
    const dockerfile = readFileSync(
      path.join(repoRoot, 'balena/registrar/Dockerfile.postgres'),
      'utf8',
    );
    expect(dockerfile).toMatch(/FROM postgres:16-alpine/);
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/usr\/local\/bin\/postgres-wrapper\.sh"\]/);
    expect(dockerfile).toMatch(/CMD \["postgres"\]/);
  });

  it('retired one-shot artifacts are gone', () => {
    expect(
      existsSync(path.join(repoRoot, 'balena/registrar/Dockerfile.litellm-init')),
      'Dockerfile.litellm-init must be deleted',
    ).toBe(false);
    expect(
      existsSync(path.join(repoRoot, 'balena/registrar/litellm-init.sh')),
      'litellm-init.sh must be deleted',
    ).toBe(false);
  });

  it('queue-join metadata carries the canonical VS queue project_id', () => {
    const meta = JSON.parse(
      readFileSync(
        path.join(repoRoot, 'balena/registrar/queue-join/.beads/metadata.json'),
        'utf8',
      ),
    ) as { project_id?: string };
    // The canonical id minted by the coordinator's one-time init
    // (fleet/status/vector-sigma-queue) — a fleet contract, never
    // regenerated; the placeholder must not survive.
    expect(meta.project_id).toBe('bcde5891-5482-4eb0-a223-8533504832d6');
    expect(meta.project_id).not.toMatch(/SET_BY_COORDINATOR/);
  });

  it('deploy compose feeds the wrapper the provisioning credentials', () => {
    const m = /^ {2}postgres:\n([\s\S]*?)(?=^ {2}\S)/m.exec(deployCompose);
    const block = m ? m[1] : '';
    expect(block, 'LITELLM_PG_PASSWORD must reach the wrapper').toMatch(
      /LITELLM_PG_PASSWORD:/,
    );
    expect(block, 'superuser credential must reach the wrapper psql').toMatch(
      /PGPASSWORD:/,
    );
  });
});
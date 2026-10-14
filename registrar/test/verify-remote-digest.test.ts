/**
 * verify-remote-digest.mjs — the fail-closed comparison script wired
 * into release-registrar.yml / release-devices.yml's verify-remote job
 * (fleet-ops-1py.14, PR #61 review round 1, finding #5: "Fail remote
 * verification when the digests differ").
 *
 * THE DEFECT: the previous verify-remote step printed a "recorded" and
 * a "remote" digest side by side but never compared them or exited
 * nonzero on mismatch — every individual command could succeed even
 * when the values differed, so a retargeted tag sailed through. This
 * suite proves the standalone script (invoked as a real child process,
 * exactly as the workflow invokes it) exits 0 on a match and NONZERO
 * with a printed `::error::` on any mismatch — both the per-arch digest
 * and the published INDEX digest (owner's "also verify the published
 * index" requirement).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const SCRIPT = path.join(repoRoot, 'scripts/verify-remote-digest.mjs');

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;

function run(args) {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

describe('verify-remote-digest.mjs: per-arch digest comparison', () => {
  it('exits 0 when recorded and remote digests match', () => {
    const r = run(['--label', 'registrar/amd64', '--recorded', SHA_A, '--remote', SHA_A]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('exits NONZERO and prints ::error:: when recorded and remote digests differ (the owner-reproduced defect class)', () => {
    const r = run(['--label', 'registrar/amd64', '--recorded', SHA_A, '--remote', SHA_B]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('::error::');
    expect(r.stderr).toContain('digest mismatch');
    expect(r.stderr).toContain(SHA_A);
    expect(r.stderr).toContain(SHA_B);
  });
});

describe('verify-remote-digest.mjs: published INDEX digest comparison (owner requirement: also verify the index, not just one child manifest)', () => {
  it('exits 0 when BOTH the per-arch and index digests match', () => {
    const r = run([
      '--label', 'registrar',
      '--recorded', SHA_A, '--remote', SHA_A,
      '--recorded-index', SHA_B, '--remote-index', SHA_B,
    ]);
    expect(r.status).toBe(0);
  });

  it('exits NONZERO when the per-arch digest matches but the INDEX digest does not', () => {
    const r = run([
      '--label', 'registrar',
      '--recorded', SHA_A, '--remote', SHA_A,
      '--recorded-index', SHA_B, '--remote-index', SHA_A,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('index digest mismatch');
  });

  it('exits NONZERO when the INDEX digest matches but the per-arch digest does not', () => {
    const r = run([
      '--label', 'registrar',
      '--recorded', SHA_A, '--remote', SHA_B,
      '--recorded-index', SHA_B, '--remote-index', SHA_B,
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('digest mismatch');
  });

  it('refuses (usage error, exit nonzero) when only one of the index-pair flags is supplied', () => {
    const r = run(['--label', 'registrar', '--recorded', SHA_A, '--remote', SHA_A, '--recorded-index', SHA_B]);
    expect(r.status).not.toBe(0);
  });
});

describe('verify-remote-digest.mjs: usage errors', () => {
  it('exits nonzero when required flags are missing', () => {
    const r = run(['--label', 'x']);
    expect(r.status).not.toBe(0);
  });
});

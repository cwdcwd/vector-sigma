/**
 * credential-history-audit.mjs — redaction-behavior fixture test
 * (fleet-ops-1py.14 slice 6).
 *
 * Builds a tiny SYNTHETIC git repo in a scratch tmpdir (never the real
 * vector-sigma history), commits a fake credential-shaped string to
 * it, runs the actual audit script module against that repo, and
 * asserts:
 *   - the credential-shaped pattern IS detected (commit + path
 *     correctly attributed),
 *   - the fake secret's literal text NEVER appears anywhere in the
 *     script's return value or generated report file — only the
 *     pattern name, the commit SHA, and the path,
 *   - a clean synthetic repo (no credential-shaped content anywhere in
 *     history) reports zero findings and says so plainly.
 *
 * This is the script's OWN redaction self-test, distinct from
 * credential-scan.test.ts's unit-level redaction assertions on the
 * shared report.ts formatters.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCredentialHistoryAudit } from '../../scripts/credential-history-audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// A synthetic, obviously-fake AWS-shaped key — never a real credential.
const FAKE_SECRET_VALUE = 'AKIAFAKEHISTORYAUDIT';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-credhist-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  }).toString('utf8');
}

describe('credential-history-audit.mjs: detects + redacts a synthetic credential in a tiny repo', () => {
  it('finds the fake credential, attributes commit+path, and never leaks the value', () => {
    const repo = makeTmpDir();
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);

    writeFileSync(path.join(repo, 'leaked.env'), `AWS_KEY=${FAKE_SECRET_VALUE}\n`);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'oops']);

    const introducingSha = git(repo, ['log', '-1', '--pretty=%H']).trim();

    const outPath = path.join(repo, 'audit-report.txt');
    const result = runCredentialHistoryAudit(['--repo', repo, '--out', outPath]);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.pattern).toBe('aws_access_key_id');
    expect(result.findings[0]!.path).toBe('leaked.env');
    expect(result.findings[0]!.commit).toBe(introducingSha);

    // Redaction: the fake secret's literal text must appear NOWHERE in
    // the in-memory report string or the written report file.
    expect(result.report).not.toContain(FAKE_SECRET_VALUE);
    const writtenReport = readFileSync(outPath, 'utf8');
    expect(writtenReport).not.toContain(FAKE_SECRET_VALUE);
    expect(writtenReport).toContain('aws_access_key_id');
    expect(writtenReport).toContain(introducingSha);
    expect(writtenReport).toContain('leaked.env');
    expect(writtenReport).toContain('REDACTED');
  });

  it('a clean synthetic repo (no credential-shaped content ever) reports zero findings', () => {
    const repo = makeTmpDir();
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(repo, 'README.md'), 'nothing to see here\n');
    writeFileSync(path.join(repo, 'config.env'), 'EDGE_HOST=device.fleet-example.ts.net\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
    writeFileSync(path.join(repo, 'config.env'), 'EDGE_HOST=device.fleet-example.ts.net\nLAN_IP=192.168.1.5\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'update topology, still clean']);

    const outPath = path.join(repo, 'audit-report.txt');
    const result = runCredentialHistoryAudit(['--repo', repo, '--out', outPath]);

    expect(result.findings).toEqual([]);
    expect(result.report).toContain('ZERO credential-shaped patterns found');
    expect(result.commitsVisited).toBe(2);
  });

  it('real invocation against THIS repo (vector-sigma) never throws and writes a report', () => {
    // Exercises the real repo path end to end (not a synthetic fixture)
    // as a smoke check that the script works against actual history
    // shape — the full real-history audit result is asserted
    // separately in the task's manual run, not re-asserted here to
    // avoid a flaky test coupled to the live commit graph.
    const outPath = path.join(makeTmpDir(), 'real-smoke-report.txt');
    const result = runCredentialHistoryAudit(['--repo', repoRoot, '--out', outPath]);
    expect(result.commitsVisited).toBeGreaterThan(0);
    expect(readFileSync(outPath, 'utf8')).toContain('Credential-only git HISTORY audit');
    // Runtime scales with the checkout's history (several git calls per
    // commit, every ref): CI's depth-1 clone takes seconds, a full local
    // clone ~40s, so this one test gets more than the 30s default.
  }, 120_000);
});

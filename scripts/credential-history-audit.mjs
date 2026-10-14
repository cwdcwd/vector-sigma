#!/usr/bin/env node
// scripts/credential-history-audit.mjs — one-time, READ-ONLY git HISTORY
// audit for credential-shaped patterns (fleet-ops-1py.14 slice 6).
//
// Scope: credential classes ONLY (see registrar/src/credential-scan/
// patterns.ts) — this is a SEPARATE, narrower scan than the slice-4
// oci-gate's topology/secret scanner and does not touch tailnet FQDNs,
// RFC1918 IPs, or any other already-approved topology literal (owner
// ruling: existing topology in source/history is accepted; this audit
// exists solely to confirm there are no PASSWORDS OR KEYS in history).
//
// Read-only: this script makes ZERO writes to the repository. It never
// runs `git filter-branch`, `git rebase`, `git push --force`, or any
// other history-mutating command — it only reads (`git log`, `git
// cat-file`) already-committed objects. It is a REPORTING tool, not a
// remediation tool.
//
// Walks the FULL history (git log --all, every commit reachable from
// every ref — not just HEAD) and, for every commit, diffs against each
// parent (or scans the full tree for a root commit) to enumerate every
// blob INTRODUCED by that commit, then scans each such blob's bytes.
// A blob already reported for an earlier commit under the same path+
// pattern is not re-reported (one finding per distinct commit+path+
// pattern), but a credential surviving across many commits is still
// caught at its point of introduction and at any point it changes.
//
// REDACTION IS A HARD REQUIREMENT: this script writes pattern name +
// commit SHA + file path to its output — NEVER the matched substring,
// never a byte offset, never any content derived from the credential
// value. See registrar/src/credential-scan/scan-text.ts for the
// structural guarantee (the matched text never becomes a JS value
// this script could print).
//
// Usage:
//   node scripts/credential-history-audit.mjs --out <report-path>
//
// Exit code: 0 always (this is a reporting tool) UNLESS the git
// commands themselves fail (git not found, not a repo, etc.) — a
// found credential is reported in the output, not signaled via a
// nonzero exit, because slice 6 scope is "audit and report", and the
// STOP-and-escalate decision is a human/coordinator action taken on
// the report's contents, not an automated CI failure (this is a
// ONE-TIME manual audit script, not a per-PR CI gate — see
// credential-scan-run.mjs for the fail-closed CI gate on build
// inputs).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanBytesForCredentials } from '../registrar/dist/credential-scan/scan-text.js';
import { formatHistoryFinding } from '../registrar/dist/credential-scan/report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, '..');
let repoRoot = defaultRepoRoot;

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 512 }).toString('utf8');
}

function gitBuffer(args) {
  return execFileSync('git', args, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 512 });
}

function argVal(args, flag, fallback) {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
}

/** Every commit reachable from any ref, oldest first, full 40-char SHAs. */
function listAllCommits() {
  const out = git(['log', '--all', '--reverse', '--pretty=%H']).trim();
  return out === '' ? [] : out.split('\n');
}

/**
 * Blobs INTRODUCED by `commit`: for a commit with N>=1 parents, the
 * added/modified file paths + new blob OIDs across each parent diff
 * (dedup across parents for merges); for a root commit (no parents),
 * every path in its full tree.
 */
function blobsIntroducedBy(commit) {
  const parents = git(['rev-list', '--parents', '-n', '1', commit]).trim().split(/\s+/).slice(1);
  const out = new Map(); // path -> blobOid

  if (parents.length === 0) {
    const lsTree = git(['ls-tree', '-r', commit]).trim();
    if (lsTree === '') return out;
    for (const line of lsTree.split('\n')) {
      // "<mode> blob <oid>\t<path>"
      const tab = line.indexOf('\t');
      const meta = line.slice(0, tab).split(' ');
      const filePath = line.slice(tab + 1);
      if (meta[1] === 'blob') out.set(filePath, meta[2]);
    }
    return out;
  }

  for (const parent of parents) {
    const raw = git(['diff', '--no-renames', '--diff-filter=ACMR', '-r', '--raw', `${parent}`, commit]).trim();
    if (raw === '') continue;
    for (const line of raw.split('\n')) {
      // ":100644 100644 <oldblob> <newblob> M\t<path>"
      const tab = line.indexOf('\t');
      const meta = line.slice(0, tab).trim().split(/\s+/);
      const filePath = line.slice(tab + 1);
      const newBlob = meta[3];
      if (newBlob && newBlob !== '0'.repeat(newBlob.length)) {
        out.set(filePath, newBlob);
      }
    }
  }
  return out;
}

function main(argv) {
  const args = argv ?? process.argv.slice(2);
  const repoOverride = argVal(args, '--repo', undefined);
  if (repoOverride) repoRoot = path.resolve(repoOverride);
  const outPath = argVal(args, '--out', path.join(repoRoot, 'reports', 'credential-history-audit.txt'));

  const commits = listAllCommits();
  if (commits.length === 0) {
    throw new Error('credential-history-audit: `git log --all` returned no commits — not a git repo, or no history?');
  }

  const findings = [];
  const seen = new Set(); // dedupe key: commit|path|pattern
  let blobsScanned = 0;
  let commitsVisited = 0;

  for (const commit of commits) {
    commitsVisited++;
    const introduced = blobsIntroducedBy(commit);
    for (const [filePath, blobOid] of introduced) {
      let bytes;
      try {
        bytes = gitBuffer(['cat-file', 'blob', blobOid]);
      } catch {
        continue; // submodule gitlink entries etc. — not a real blob
      }
      blobsScanned++;
      const hits = scanBytesForCredentials(bytes);
      for (const pattern of hits) {
        const key = `${commit}|${filePath}|${pattern}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ pattern, commit, path: filePath });
      }
    }
  }

  const firstSha = commits[0];
  const lastSha = commits[commits.length - 1];
  const lines = [];
  lines.push('# Credential-only git HISTORY audit (fleet-ops-1py.14 slice 6)');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Scope: credential-shaped patterns ONLY (see registrar/src/credential-scan/patterns.ts).`);
  lines.push(`Topology/FQDN/IP literals are OUT OF SCOPE for this audit (owner-approved, handled separately by the slice-4 oci-gate).`);
  lines.push(`Commit range scanned: ${commits.length} commits reachable via \`git log --all\`, from ${firstSha} to ${lastSha} (oldest to newest).`);
  lines.push(`Blobs introduced/modified scanned: ${blobsScanned}.`);
  lines.push('');

  if (findings.length === 0) {
    lines.push('RESULT: ZERO credential-shaped patterns found in the full repository history.');
    lines.push(`All ${commits.length} commits and ${blobsScanned} introduced/modified blobs were scanned; no finding to report.`);
  } else {
    lines.push(`RESULT: ${findings.length} credential-shaped finding(s). Values are REDACTED below — never the matched text, only pattern/commit/path.`);
    lines.push('');
    for (const f of findings) {
      lines.push(formatHistoryFinding(f));
    }
  }
  lines.push('');

  const report = lines.join('\n');
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, report, 'utf8');
  console.log(report);
  console.log(`\ncredential-history-audit: wrote report to ${outPath}`);
  console.log(`commitsVisited=${commitsVisited} blobsScanned=${blobsScanned} findings=${findings.length}`);
  return { report, findings, commitsVisited, blobsScanned, outPath };
}

export { main as runCredentialHistoryAudit };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

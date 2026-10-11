#!/usr/bin/env node
// scripts/credential-scan-run.mjs — CI entry point for the fail-closed
// credential-only build-input scan (fleet-ops-1py.14 slice 6).
//
// Scans the Docker BUILD CONTEXT source trees (the same artifact class
// `docker buildx build` COPYs into image layers) for credential-shaped
// patterns ONLY — a separate, narrower scope than the slice-4 oci-gate
// (registrar/src/oci-gate), which scans already-built image layer
// bytes for both secrets AND topology literals. This script never
// flags a tailnet FQDN / RFC1918 IP / other approved topology literal
// (owner ruling: topology is accepted and out of scope here).
//
// Zero network calls, zero docker/buildx dependency — it reads the
// same files on disk that a `docker build` with this context would
// read, before any image is ever built. Fail-closed: any finding is a
// nonzero exit.
//
// Usage:
//   node scripts/credential-scan-run.mjs --context <dir> [--context <dir> ...]
import process from 'node:process';
import { scanSourceTree } from '../registrar/dist/credential-scan/source-tree-scan.js';
import { formatSourceTreeFinding } from '../registrar/dist/credential-scan/report.js';

function argVals(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) out.push(args[i + 1]);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const contexts = argVals(args, '--context');
  if (contexts.length === 0) {
    console.error('credential-scan-run: requires at least one --context <dir>');
    process.exit(1);
  }

  let totalFindings = 0;
  for (const context of contexts) {
    const findings = scanSourceTree(context);
    if (findings.length === 0) {
      console.log(`credential-scan-run: PASS ${context} — no credential-shaped patterns found`);
      continue;
    }
    totalFindings += findings.length;
    console.error(`credential-scan-run: REJECTED ${context} — ${findings.length} credential-shaped finding(s):`);
    for (const f of findings) {
      console.error(`  ${formatSourceTreeFinding(f)}`);
    }
  }

  if (totalFindings > 0) {
    console.error(`credential-scan-run: FAIL — ${totalFindings} total credential-shaped finding(s) across ${contexts.length} context(s)`);
    process.exit(1);
  }
  console.log(`credential-scan-run: PASS — 0 findings across ${contexts.length} context(s)`);
}

main();

#!/usr/bin/env node
// scripts/release-ledger.mjs — collate a release run's verified promotion
// records (promoted-<component>.json, written by scripts/publish-image.sh
// and proven by scripts/verify-published.sh) into ONE release-evidence.json
// rollback ledger: exact index + per-arch digests per component,
// re-renderable without resolving any mutable tag.
//
//   node scripts/release-ledger.mjs --out <path> --commit <sha> --ref <name> \
//     --run-id <id> [--actor <user>] [--generated-at <iso>] \
//     --component <name>=<record.json> [--component ...]
//
// No registry I/O, no credentials. Fails closed (exit 1) on any malformed
// record via the registrar's parsePromotionRecord/buildReleaseEvidence.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildReleaseEvidence, parsePromotionRecord, ReleaseEvidenceError } from '@vector-sigma/registrar/dist/registry/release-evidence.js';

function fail(msg) {
  console.error(`::error::release-ledger: ${msg}`);
  process.exit(1);
}

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function argAll(args, flag) {
  const out = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) out.push(args[i + 1]);
  }
  return out;
}

/**
* (fleet-ops-r3v) Collate the run's verified promotion
 * records into one release-evidence.json rollback ledger. Reads ONLY the
 * record files the promote jobs wrote — no registry I/O, no credentials —
 * and fails closed on any malformed record via the registrar's own
 * parsePromotionRecord/buildReleaseEvidence validators.
 */
function runLedger(argv) {
  const outPath = argVal(argv, '--out');
  const commit = argVal(argv, '--commit');
  const refName = argVal(argv, '--ref');
  const runId = argVal(argv, '--run-id');
  const actor = argVal(argv, '--actor');
  const generatedAt = argVal(argv, '--generated-at');
  const componentArgs = argAll(argv, '--component');
  if (!outPath || !commit || !refName || !runId || componentArgs.length === 0) {
    fail('requires --out <path> --commit <sha> --ref <name> --run-id <id> --component <name>=<record.json> [...]');
  }
  const records = new Map();
  for (const spec of componentArgs) {
    const eq = spec.indexOf('=');
    if (eq === -1) fail(`malformed --component "${spec}" (expected <name>=<record.json>)`);
    const name = spec.slice(0, eq);
    const recordPath = spec.slice(eq + 1);
    let raw;
    try {
      raw = JSON.parse(readFileSync(recordPath, 'utf8'));
    } catch (err) {
      fail(`cannot read promotion record "${recordPath}" for component ${name}: ${err.message}`);
    }
    try {
      records.set(name, parsePromotionRecord(name, raw));
    } catch (err) {
      if (err instanceof ReleaseEvidenceError) fail(`promotion record REJECTED for ${name} [${err.code}]: ${err.message}`);
      throw err;
    }
  }
  let evidence;
  try {
    evidence = buildReleaseEvidence(
      { commit, refName, runId, ...(actor ? { actor } : {}), ...(generatedAt ? { generatedAt } : {}) },
      records,
    );
  } catch (err) {
    if (err instanceof ReleaseEvidenceError) fail(`release evidence REJECTED [${err.code}]: ${err.message}`);
    throw err;
  }
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    `release-ledger: ledged ${records.size} component(s) into ${outPath} — content ${evidence.contentDigest}`,
  );
}

runLedger(process.argv.slice(2));

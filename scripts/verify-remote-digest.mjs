#!/usr/bin/env node
// scripts/verify-remote-digest.mjs — fail-closed digest comparison for the
// release workflows' verify-remote job (fleet-ops-1py.14, PR #61 review
// round 1 finding #5).
//
// THE DEFECT THIS FIXES: the previous verify-remote step computed/printed
// a "recorded" digest (from the promote job) and a "remote" digest
// (re-fetched from the registry) side by side, but never actually COMPARED
// them or failed the job on a mismatch — every individual shell command in
// that block could succeed even when the two values differed, so a
// retargeted tag or altered remote manifest sailed through and unblocked
// smoke/render/deploy. This script makes the comparison EXPLICIT and
// fail-closed: any mismatch (per-arch digest OR the published INDEX
// digest against the locally-validated index) prints a GitHub Actions
// ::error:: annotation and exits 1.
//
// Usage:
//   node scripts/verify-remote-digest.mjs \
//     --label <component/arch> --recorded <sha256:...> --remote <sha256:...> \
//     [--recorded-index <sha256:...> --remote-index <sha256:...>]
//
// Exit 0: every supplied pair matches. Exit 1: usage error OR any mismatch.
import process from 'node:process';

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const label = argVal(args, '--label');
  const recorded = argVal(args, '--recorded');
  const remote = argVal(args, '--remote');
  const recordedIndex = argVal(args, '--recorded-index');
  const remoteIndex = argVal(args, '--remote-index');

  if (!label || !recorded || !remote) {
    console.error('verify-remote-digest: requires --label <name> --recorded <digest> --remote <digest> [--recorded-index <digest> --remote-index <digest>]');
    process.exit(1);
  }

  // Either-but-not-the-other for the index pair is a caller usage error —
  // never silently skip the index-level check because one side was omitted.
  if ((recordedIndex && !remoteIndex) || (!recordedIndex && remoteIndex)) {
    console.error('verify-remote-digest: --recorded-index and --remote-index must both be supplied together or both omitted');
    process.exit(1);
  }

  let mismatched = false;
  if (recorded !== remote) {
    console.error(`::error::digest mismatch (${label}): recorded=${recorded} remote=${remote}`);
    mismatched = true;
  }
  if (recordedIndex && remoteIndex && recordedIndex !== remoteIndex) {
    console.error(`::error::index digest mismatch (${label}): recorded-index=${recordedIndex} remote-index=${remoteIndex}`);
    mismatched = true;
  }

  if (mismatched) process.exit(1);

  console.log(
    `verify-remote-digest: OK (${label}) — recorded=${recorded} matches remote=${remote}` +
      (recordedIndex ? ` · index recorded=${recordedIndex} matches remote=${remoteIndex}` : ''),
  );
}

main();

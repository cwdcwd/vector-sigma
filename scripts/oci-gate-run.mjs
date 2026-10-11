#!/usr/bin/env node
// scripts/oci-gate-run.mjs — CI entry point wiring the slice-4 local OCI
// content gate (registrar/src/oci-gate) into the slice-5 publisher
// workflows (fleet-ops-1py.14).
//
// This script performs ZERO network calls itself — same guarantee as the
// gate module it wraps. It only reads local files (an OCI-layout tar
// produced by `docker buildx build --output type=oci`, or previously
// written descriptor JSON) and writes local files. All registry I/O
// (import/push/verify) lives in the workflow's `promote`/`verify-remote`
// steps, after this script's gates have already passed — never before.
//
// Subcommands:
//   scan      --component <name> --platform <linux/amd64|linux/arm64>
//             --tar <path-to-oci-layout.tar> --out <path-to-descriptor.json>
//     Runs scanPlatformLayout() against the supplied OCI-layout tar.
//     Fails closed (nonzero exit) on any ContentGateError — secret found,
//     topology literal found, malformed layout, digest mismatch, etc.
//     On success writes the scanned manifest descriptor + metadata as
//     JSON, consumed by the `assemble` subcommand.
//
//   assemble  --component <name> --out <path-to-index.json>
//             --descriptors <d1.json> <d2.json> [...]
//     Reads N previously-scanned descriptor JSON files (one per required
//     platform) and calls assembleLocalOciIndex() to build the local OCI
//     index referencing ONLY those scanned-and-passed digests. Fails
//     closed on missing/duplicate/extra platform or any other gate
//     rejection.
//
// Exit code: 0 on pass, 1 on any rejection or usage error.
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import {
  scanPlatformLayout,
  assembleLocalOciIndex,
  ContentGateError,
} from '@vector-sigma/registrar/dist/oci-gate/index.js';

function fail(msg) {
  console.error(`oci-gate-run: ${msg}`);
  process.exit(1);
}

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function runScan(args) {
  const component = argVal(args, '--component');
  const platform = argVal(args, '--platform');
  const tarPath = argVal(args, '--tar');
  const outPath = argVal(args, '--out');
  if (!component || !platform || !tarPath || !outPath) {
    fail('scan requires --component <name> --platform <linux/amd64|linux/arm64> --tar <path> --out <path>');
  }
  if (platform !== 'linux/amd64' && platform !== 'linux/arm64') {
    fail(`unsupported --platform "${platform}" (expected linux/amd64 or linux/arm64)`);
  }

  let tarBytes;
  try {
    tarBytes = readFileSync(tarPath);
  } catch (err) {
    fail(`cannot read OCI layout tar at "${tarPath}": ${err.message}`);
    return;
  }

  try {
    const result = scanPlatformLayout({ platform, tarBytes });
    writeFileSync(outPath, JSON.stringify({ component, ...result }, null, 2));
    console.log(
      `oci-gate-run: PASS ${component} (${platform}) — ${result.layerCount} layers / ${result.entryCount} entries scanned, manifest ${result.manifestDescriptor.digest}`,
    );
  } catch (err) {
    if (err instanceof ContentGateError) {
      fail(`REJECTED ${component} (${platform}) [${err.code}]: ${err.message}`);
      return;
    }
    throw err;
  }
}

function runAssemble(args) {
  const component = argVal(args, '--component');
  const outPath = argVal(args, '--out');
  const descriptorsIdx = args.indexOf('--descriptors');
  if (!component || !outPath || descriptorsIdx === -1) {
    fail('assemble requires --component <name> --out <path> --descriptors <d1.json> [d2.json ...]');
  }
  const descriptorPaths = args.slice(descriptorsIdx + 1).filter((a) => !a.startsWith('--'));
  if (descriptorPaths.length === 0) {
    fail('assemble requires at least one --descriptors <path> argument');
  }

  let scanned;
  try {
    scanned = descriptorPaths.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  } catch (err) {
    fail(`cannot read/parse a --descriptors file: ${err.message}`);
    return;
  }

  const candidates = scanned.map((s) => s.manifestDescriptor);
  const scannedAllowSet = new Set(candidates.map((c) => c.digest));

  try {
    const index = assembleLocalOciIndex({ candidates, scannedAllowSet });
    writeFileSync(outPath, JSON.stringify(index, null, 2));
    console.log(`oci-gate-run: PASS ${component} index assembled — ${index.manifests.length} platform manifests`);
  } catch (err) {
    if (err instanceof ContentGateError) {
      fail(`REJECTED ${component} index assembly [${err.code}]: ${err.message}`);
      return;
    }
    throw err;
  }
}

const [, , cmd, ...rest] = process.argv;
if (cmd === 'scan') {
  runScan(rest);
} else if (cmd === 'assemble') {
  runAssemble(rest);
} else {
  fail(`unknown subcommand "${cmd ?? ''}" — expected "scan" or "assemble"`);
}

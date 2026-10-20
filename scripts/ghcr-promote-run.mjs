#!/usr/bin/env node
// scripts/ghcr-promote-run.mjs — CI entry point for the exact-byte GHCR
// promoter and its independent remote verifier (fleet-ops-r3v).
//
// This is the ONE script in the publisher pipeline that speaks to a real
// registry, and it does so through the same `OciDistributionClient` /
// `promoteComponent` / `verifyRemote` code paths that the unit tests
// exercise against an in-memory fake registry. There is no second
// implementation, no rebuild, and no `docker buildx --push` anywhere:
// the bytes pushed are read from the OCI-layout tars the stage-and-scan
// job already built and scanned.
//
// Subcommands:
//   promote  --registry ghcr.io --repository <ns>/<img> --tag <ref>
//            --layout linux/amd64=<tar> --layout linux/arm64=<tar>
//            --record <out.json> [--actor <u>] [--token-env <VAR>]
//            [--scheme https]
//     Exchanges credentials (if supplied) for a bearer token, promotes
//     the exact scanned bytes, verifies each staged byte on the way, and
//     writes the promotion record (index digest + per-arch digests) that
//     the later verify step consumes.
//
//   verify   --registry ghcr.io --record <in.json> [--token-env <VAR>]
//            [--scheme https]
//     Re-fetches the published index and every child BY DIGEST and fails
//     closed on any difference. Runs with no credentials for a public
//     package, so nothing about this check depends on the writer.
//
//   ledger   --out <path> --commit <sha> --ref <name> --run-id <id>
//            [--actor <u>] [--generated-at <iso>]
//            --component <name>=<record.json> [...]
//     Collates this run's verified promotion records into ONE
//     release-evidence.json (the rollback ledger). Fails closed on any
//     malformed record or a zero-component call. No registry I/O.
//
// --scheme exists ONLY so scripts/ghcr-promote-run.integration.test.ts can
// point the real script at a local `http` socket; production omits it and
// gets `https`.
//
// Exit code: 0 on success, 1 on any failure (fail-closed).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createFetchTransport } from '@vector-sigma/registrar/dist/registry/fetch-transport.js';
import { fetchRegistryToken } from '@vector-sigma/registrar/dist/registry/auth.js';
import { promoteComponent, PromotionError } from '@vector-sigma/registrar/dist/registry/promote.js';
import { verifyRemote, VerifyRemoteError } from '@vector-sigma/registrar/dist/registry/verify-remote.js';
import { buildReleaseEvidence, parsePromotionRecord, ReleaseEvidenceError } from '@vector-sigma/registrar/dist/registry/release-evidence.js';

function fail(msg) {
  console.error(`::error::ghcr-promote-run: ${msg}`);
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
 * Reads the token from a named environment variable. The value is never
 * printed, never echoed into the record, and never placed in a URL — it
 * is only ever handed to the transport as an `Authorization` header.
 */
function tokenFromEnv(actor) {
  const varName = argVal(process.argv.slice(2), '--token-env') ?? 'GHCR_TOKEN';
  const password = process.env[varName];
  if (!password) return undefined;
  return { username: actor ?? process.env.GITHUB_ACTOR ?? 'token', password };
}

async function runPromote(args) {
  const registry = argVal(args, '--registry');
  const repository = argVal(args, '--repository');
  const tag = argVal(args, '--tag');
  const recordPath = argVal(args, '--record');
  const layoutArgs = argAll(args, '--layout');
  if (!registry || !repository || !tag || !recordPath || layoutArgs.length === 0) {
    fail('promote requires --registry <host> --repository <ns>/<img> --tag <ref> --record <out.json> --layout <platform>=<tar> [...]');
  }

  const layouts = layoutArgs.map((spec) => {
    const eq = spec.indexOf('=');
    if (eq === -1) fail(`malformed --layout "${spec}" (expected <platform>=<path>)`);
    const platform = spec.slice(0, eq);
    const tarPath = spec.slice(eq + 1);
    if (platform !== 'linux/amd64' && platform !== 'linux/arm64') {
      fail(`unsupported --layout platform "${platform}" (expected linux/amd64 or linux/arm64)`);
    }
    let tarBytes;
    try {
      tarBytes = readFileSync(tarPath);
    } catch (err) {
      fail(`cannot read layout tar "${tarPath}": ${err.message}`);
    }
    return { platform, tarBytes };
  });

  const transport = createFetchTransport();
  const creds = tokenFromEnv(argVal(args, '--actor'));
  const scheme = argVal(args, '--scheme');
  let token;
  if (creds) {
    token = await fetchRegistryToken(transport, {
      registry,
      repository,
      actions: 'pull,push',
      ...(scheme ? { scheme } : {}),
      ...creds,
    });
    console.log(`ghcr-promote-run: acquired push token for ${repository} (credential never printed)`);
  } else {
    console.log(`ghcr-promote-run: WARNING no token supplied — attempting anonymous push to ${repository}`);
  }

  let result;
  try {
    result = await promoteComponent({
      transport,
      registry,
      repository,
      ...(token ? { token } : {}),
      ...(scheme ? { scheme } : {}),
      layouts,
      archTag: (platform) => `${tag}-${platform === 'linux/amd64' ? 'amd64' : 'arm64'}`,
      indexTag: tag,
    });
  } catch (err) {
    if (err instanceof PromotionError) fail(`promotion REJECTED [${err.code}]: ${err.message}`);
    throw err;
  }

  const record = {
    repository: result.repository,
    registry,
    index: { tag, digest: result.index.digest },
    perPlatform: result.perPlatform.map((p) => ({ platform: p.platform, tag: p.tag, digest: p.digest })),
  };
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(
    `ghcr-promote-run: promoted ${repository}:${tag} — index ${result.index.digest}, ` +
      `${result.perPlatform.length} platform manifests; record written to ${recordPath}`,
  );
}

async function runVerify(args) {
  const registry = argVal(args, '--registry');
  const recordPath = argVal(args, '--record');
  if (!registry || !recordPath) {
    fail('verify requires --registry <host> --record <in.json>');
  }

  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (err) {
    fail(`cannot read promotion record "${recordPath}": ${err.message}`);
  }

  const transport = createFetchTransport();
  const creds = tokenFromEnv(argVal(args, '--actor'));
  const scheme = argVal(args, '--scheme');
  // Always exchange for a token: GHCR rejects a header-less GET even on a
  // public package. Without credentials this is an anonymous, pull-only
  // token, so the re-read still proves the bytes without the writer's token.
  const token = await fetchRegistryToken(transport, {
    registry,
    repository: record.repository,
    actions: 'pull',
    ...(scheme ? { scheme } : {}),
    ...(creds ?? {}),
  });

  try {
    const result = await verifyRemote({
      transport,
      registry,
      record,
      ...(token ? { token } : {}),
      ...(scheme ? { scheme } : {}),
    });
    console.log(
      `ghcr-promote-run: VERIFIED ${result.repository} — index ${result.indexDigest} intact, ` +
        `${result.children.length} child manifests re-read by digest and byte-identical`,
    );
  } catch (err) {
    if (err instanceof VerifyRemoteError) fail(`remote verification FAILED [${err.code}]: ${err.message}`);
    throw err;
  }
}

/**
 * Ledger subcommand (fleet-ops-r3v): collate the run's verified promotion
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
    fail('ledger requires --out <path> --commit <sha> --ref <name> --run-id <id> --component <name>=<record.json> [...]');
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
    `ghcr-promote-run: ledged ${records.size} component(s) into ${outPath} — content ${evidence.contentDigest}`,
  );
}

const [, , cmd, ...rest] = process.argv;
const runner = cmd === 'promote' ? runPromote : cmd === 'verify' ? runVerify : cmd === 'ledger' ? runLedger : null;
if (!runner) {
  fail(`unknown subcommand "${cmd ?? ''}" — expected "promote", "verify", or "ledger"`);
}
await runner(rest);

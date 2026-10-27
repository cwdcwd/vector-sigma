#!/usr/bin/env node
import { readFileSync } from 'node:fs';

export const ECR_REPOSITORIES = Object.freeze({
  agent: 'vector-sigma/agent',
  hermes: 'vector-sigma/hermes',
  litellm: 'vector-sigma/litellm',
  postgres: 'vector-sigma/postgres',
  registrant: 'vector-sigma/registrant',
  registrar: 'vector-sigma/registrar',
  scotty: 'vector-sigma/scotty',
  tailscale: 'vector-sigma/tailscale',
  'tailscale-devices': 'vector-sigma/tailscale-devices',
});

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function createMirrorPlan(component, digest) {
  if (typeof component !== 'string' || !Object.hasOwn(ECR_REPOSITORIES, component)) {
    throw new Error(`unknown component: ${String(component)}`);
  }
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    throw new Error('source digest must be a lowercase sha256 digest');
  }
  return Object.freeze({
    architecture: 'linux/arm64',
    source: `ghcr.io/cwdcwd/vector-sigma/${component}@${digest}`,
    targetRepository: ECR_REPOSITORIES[component],
    targetDigest: digest,
    mode: 'dry-run',
  });
}

export function createMirrorPlanFromRecord(component, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('promotion record must be a JSON object');
  }
  if (record.registry !== 'ghcr.io' || record.repository !== `cwdcwd/vector-sigma/${component}`) {
    throw new Error('promotion record registry or repository does not match the selected component');
  }
  if (!Array.isArray(record.perPlatform)) throw new Error('promotion record has no perPlatform list');
  const arm64 = record.perPlatform.filter((entry) => entry?.platform === 'linux/arm64');
  if (arm64.length !== 1) throw new Error('promotion record must contain exactly one linux/arm64 digest');
  return createMirrorPlan(component, arm64[0].digest);
}

function main(argv) {
  const [recordPath, component] = argv;
  if (argv.length !== 2) throw new Error('usage: ecr-mirror-plan.mjs <promotion-record.json> <component>');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  console.log(JSON.stringify(createMirrorPlanFromRecord(component, record), null, 2));
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`ecr-mirror-plan: ${error.message}`);
    process.exitCode = 1;
  }
}

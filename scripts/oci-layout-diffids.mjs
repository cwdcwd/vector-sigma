#!/usr/bin/env node
// scripts/oci-layout-diffids.mjs — print the layer diff IDs (config
// rootfs.diff_ids, as a JSON array) of the single image in a buildx type=oci
// layout tar (index.json -> manifest -> config). A daemon reports the same
// list as `.RootFS.Layers` once the image is imported, on either image store,
// so scripts/e2e-load-images.sh uses it to prove E2E runs the scanned bytes.
//
// Usage: node scripts/oci-layout-diffids.mjs <layout.tar>
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const tar = process.argv[2];
if (!tar) {
  console.error('usage: oci-layout-diffids.mjs <layout.tar>');
  process.exit(2);
}
const member = (name) => execFileSync('tar', ['-xOf', tar, name], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
const blob = (digest) => JSON.parse(member(`blobs/${digest.replace(':', '/')}`));

let node = JSON.parse(member('index.json'));
// Unwrap nested indexes until exactly one image manifest remains (attestation
// manifests, if any, are not images).
for (let depth = 0; node.manifests; depth++) {
  const images = node.manifests.filter((m) => !m.annotations?.['vnd.docker.reference.type']);
  if (images.length !== 1 || depth > 3) {
    console.error(`oci-layout-diffids: ${tar} does not hold exactly one image manifest`);
    process.exit(1);
  }
  node = blob(images[0].digest);
}
const diffIds = node.config?.digest ? blob(node.config.digest).rootfs?.diff_ids : undefined;
if (!Array.isArray(diffIds) || diffIds.length === 0) {
  console.error(`oci-layout-diffids: ${tar} has no config rootfs.diff_ids`);
  process.exit(1);
}
console.log(JSON.stringify(diffIds));

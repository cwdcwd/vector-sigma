#!/usr/bin/env node
// scripts/check-index.mjs — the one rule for a published multi-arch index:
// it must be an OCI index of EXACTLY two image-manifest descriptors, one
// linux/amd64 and one linux/arm64, each equal to that platform's expected
// digest. Containment is not enough — an extra entry would make an
// unverified image reachable through the index (PR #97 review).
//
//   node scripts/check-index.mjs <index.json> <amd64-digest> <arm64-digest>
//
// Used by publish-image.sh (before any registry write) and
// resolve-published.sh (before a release reuses main's images). Exit 1 with
// the reason on stderr.
import { readFileSync } from 'node:fs';
import process from 'node:process';

const [file, amd, arm] = process.argv.slice(2);
const fail = (m) => {
  console.error(m);
  process.exit(1);
};
if (!file || !amd || !arm) fail('usage: check-index.mjs <index.json> <amd64-digest> <arm64-digest>');
let idx;
try {
  idx = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  fail(`not JSON: ${e.message}`);
}
if (idx.mediaType !== 'application/vnd.oci.image.index.v1+json') fail(`mediaType ${idx.mediaType} is not an OCI index`);
const m = Array.isArray(idx.manifests) ? idx.manifests : fail('no manifests array');
if (m.length !== 2) fail(`expected exactly 2 descriptors, found ${m.length}`);
const want = { 'linux/amd64': amd, 'linux/arm64': arm };
const seen = new Set();
for (const d of m) {
  const plat = `${d?.platform?.os}/${d?.platform?.architecture}`;
  if (!(plat in want)) fail(`unexpected platform ${plat} (digest ${d?.digest})`);
  if (seen.has(plat)) fail(`duplicate ${plat} descriptor`);
  seen.add(plat);
  if (d.digest !== want[plat]) fail(`${plat} descriptor is ${d.digest}, expected ${want[plat]}`);
  if (d.mediaType !== 'application/vnd.oci.image.manifest.v1+json') fail(`${plat} descriptor mediaType ${d.mediaType} is not an image manifest`);
}

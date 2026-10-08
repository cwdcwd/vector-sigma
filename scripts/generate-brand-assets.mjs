#!/usr/bin/env node
// Brand-asset embed generator (fleet-ops-1py.6).
//
// Reads the committed resized logo pair + favicon (docs/logo-128.png,
// docs/logo-256.png, docs/favicon-32.png) and regenerates
// registrar/src/brand-assets.ts — the build-time embed the admin console
// serves its branding from (/admin/static/logo-128.png,
// /admin/static/logo-256.png, /admin/static/favicon.png). The generated
// module is checked in, so the shipped image carries the assets compiled
// into registrar/dist with every other console source: no runtime
// filesystem read, no new deployment surface.
//
// The resize itself is a ONE-TIME ImageMagick step (verified on the
// builder host, IM 6.9.11: convert docs/logo.png -resize 128x128
// docs/logo-128.png, etc.) — the committed resized binaries are the
// source of truth. This script is Node-only on purpose (peer hosts run
// the regeneration path without ImageMagick installed): it embeds the
// committed art, it never resizes.
//
// Run from the repo root after replacing the source art:
//
//   node scripts/generate-brand-assets.mjs
//
// Byte-idempotent: running it twice produces the identical file. The
// registrar test suite (brand-assets.test.ts) re-runs this generator and
// pins the checked-in module byte-for-byte, so art edits that skip
// regeneration fail CI instead of silently drifting.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const docsDir = path.join(repoRoot, 'docs');
const outFile = path.join(repoRoot, 'registrar/src/brand-assets.ts');

/** The embedded set — order is the module's export order (pinned by tests). */
const ASSETS = [
  { file: 'logo-128.png', exportName: 'LOGO_128', blurb: 'Console wordmark logo (128x128 PNG)' },
  { file: 'logo-256.png', exportName: 'LOGO_256', blurb: 'Console logo, high-DPI (256x256 PNG)' },
  { file: 'favicon-32.png', exportName: 'FAVICON_32', blurb: 'Browser tab favicon (32x32 PNG)' },
];

function fail(msg) {
  console.error(`generate-brand-assets: ${msg}`);
  process.exit(1);
}

/** PNG signature — every source must be a real PNG (magic bytes, not extension). */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function loadAssets() {
  return ASSETS.map((a) => {
    const bytes = readFileSync(path.join(docsDir, a.file));
    if (!bytes.subarray(0, 8).equals(PNG_SIG)) fail(`${a.file} is not a PNG (bad magic bytes)`);
    return { ...a, base64: bytes.toString('base64') };
  });
}

export function generateModule(assets) {
  const lines = [];
  lines.push('// GENERATED FILE — do not edit by hand (fleet-ops-1py.6).');
  lines.push('//');
  lines.push('// Embedded brand assets: the admin console serves its logo pair and');
  lines.push('// favicon from these base64 blobs (routes /admin/static/logo-128.png,');
  lines.push('// /admin/static/logo-256.png, /admin/static/favicon.png) — build-time');
  lines.push('// embed, no runtime filesystem read, no new deployment surface.');
  lines.push('// Regenerate after changing the committed source art with:');
  lines.push('//');
  lines.push('//   node scripts/generate-brand-assets.mjs');
  lines.push('//');
  lines.push('// Sources: docs/logo-128.png, docs/logo-256.png, docs/favicon-32.png');
  lines.push('// (one-time ImageMagick resize of docs/logo.png — convert docs/logo.png -resize 128x128 docs/logo-128.png).');
  lines.push('');
  for (const a of assets) {
    lines.push(`/** ${a.blurb} — PNG bytes, base64. */`);
    lines.push(`export const ${a.exportName} =`);
    lines.push(`  '${a.base64}';`);
    lines.push('');
  }
  return lines.join('\n');
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const moduleText = generateModule(loadAssets());
  writeFileSync(outFile, moduleText);
  console.log(`generate-brand-assets: wrote ${outFile} (${moduleText.length} bytes)`);
}
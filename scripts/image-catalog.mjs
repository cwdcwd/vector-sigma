#!/usr/bin/env node
// scripts/image-catalog.mjs — the image catalog (images.json) as workflow
// inputs. One list drives every image workflow, so a component added or
// moved changes one file, not three hand-copied matrices.
//
// Usage:
//   node scripts/image-catalog.mjs matrix [--fleet all|registrar|devices] [--only <component>]
//       -> {"include":[{component,context,dockerfile,platform,arch_tag,runner},...]}
//   node scripts/image-catalog.mjs components [--fleet ...] [--only <component>]
//       -> ["registrar",...]
//   node scripts/image-catalog.mjs inputs <component>
//       -> the repo-relative paths the image reads from its build context
//          (its Dockerfile + every COPY source), one per line — the exact
//          input set the credential scan covers.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadCatalog(root = repoRoot) {
  return JSON.parse(readFileSync(path.join(root, 'images.json'), 'utf8'));
}

/** Component names for a fleet ('all' = every component), optionally narrowed to one. */
export function componentsFor(catalog, fleet = 'all', only = 'all') {
  let names = Object.keys(catalog.components);
  if (fleet !== 'all') {
    names = names.filter((n) => catalog.components[n].fleets.includes(fleet));
    if (names.length === 0) throw new Error(`image-catalog: no components for fleet '${fleet}'`);
  }
  if (only && only !== 'all') {
    if (!names.includes(only)) throw new Error(`image-catalog: '${only}' is not a component of fleet '${fleet}'`);
    names = [only];
  }
  return names;
}

export function matrixFor(catalog, fleet = 'all', only = 'all') {
  const include = [];
  for (const component of componentsFor(catalog, fleet, only)) {
    const { context, dockerfile } = catalog.components[component];
    for (const p of catalog.platforms) include.push({ component, context, dockerfile, ...p });
  }
  return { include };
}

/** Dockerfile instructions: comment lines dropped, `\` continuations joined. */
export function dockerInstructions(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Context-relative sources of every COPY/ADD that reads the build context. */
export function copySources(text) {
  const out = [];
  for (const ins of dockerInstructions(text)) {
    if (!/^(COPY|ADD)\s/i.test(ins)) continue;
    const args = ins.split(/\s+/).slice(1);
    if (args.some((a) => a.startsWith('--from='))) continue; // stage copy
    const paths = args.filter((a) => !a.startsWith('--')).slice(0, -1);
    out.push(...paths.filter((p) => !/^https?:\/\//.test(p)));
  }
  return out;
}

/** Repo-relative paths an image reads from its build context (Dockerfile first). */
export function imageInputs(catalog, component, root = repoRoot) {
  const entry = catalog.components[component];
  if (!entry) throw new Error(`image-catalog: unknown component '${component}'`);
  const text = readFileSync(path.join(root, entry.dockerfile), 'utf8');
  const rel = (p) => path.normalize(path.join(entry.context, p)).split(path.sep).join('/');
  return [...new Set([entry.dockerfile, ...copySources(text).map(rel)])];
}

function arg(args, flag, fallback) {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1];
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const catalog = loadCatalog();
  const fleet = arg(args, '--fleet', 'all');
  const only = arg(args, '--only', 'all');
  switch (cmd) {
    case 'matrix':
      console.log(JSON.stringify(matrixFor(catalog, fleet, only)));
      break;
    case 'components':
      console.log(JSON.stringify(componentsFor(catalog, fleet, only)));
      break;
    case 'inputs':
      console.log(imageInputs(catalog, args[0]).join('\n'));
      break;
    default:
      console.error('usage: image-catalog.mjs matrix|components [--fleet all|registrar|devices] [--only <component>] | inputs <component>');
      process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

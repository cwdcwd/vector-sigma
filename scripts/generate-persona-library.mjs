#!/usr/bin/env node
// Persona-library embed generator (fleet-ops-zbq.2).
//
// Reads personas/<slug>/{persona.json,SOUL.md} from the repo root and
// regenerates registrar/src/persona-library.ts — the build-time embed the
// admin console's persona pre-fill picker serves from. The generated
// module is checked in, so the shipped image carries the library compiled
// into registrar/dist with every other console source: no runtime fetch
// path, no filesystem read at serve time, no new deployment surface.
//
// Run from the repo root after editing personas/**:
//
//   node scripts/generate-persona-library.mjs
//
// Byte-idempotent: running it twice produces the identical file. The
// registrar test suite re-runs this generator and pins the checked-in
// module byte-for-byte, so library edits that skip regeneration fail CI
// instead of silently drifting from the personas/ source of truth.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const personasDir = path.join(repoRoot, 'personas');
const outFile = path.join(repoRoot, 'registrar/src/persona-library.ts');

/** Env keys with secret-looking names are refused — the library is non-secret content by contract. */
const SECRETISH_KEY_RE = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASS|CRED|CREDENTIAL)(_|$)/i;

function fail(msg) {
  console.error(`generate-persona-library: ${msg}`);
  process.exit(1);
}

function loadPersonas() {
  const entries = readdirSync(personasDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (entries.length === 0) fail(`no persona directories under personas/`);
  const personas = [];
  for (const slug of entries) {
    const dir = path.join(personasDir, slug);
    const metaPath = path.join(dir, 'persona.json');
    const soulPath = path.join(dir, 'SOUL.md');
    if (!statSync(metaPath).isFile()) fail(`personas/${slug}/persona.json missing`);
    if (!statSync(soulPath).isFile()) fail(`personas/${slug}/SOUL.md missing`);
    let meta;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch (err) {
      fail(`personas/${slug}/persona.json is not valid JSON: ${err.message}`);
    }
    if (meta.slug !== slug) fail(`personas/${slug}/persona.json slug is ${JSON.stringify(meta.slug)}, directory says ${JSON.stringify(slug)}`);
    if (meta.soul_file !== 'SOUL.md') fail(`personas/${slug}/persona.json soul_file must be "SOUL.md"`);
    for (const field of ['name', 'role', 'description', 'model_route']) {
      if (typeof meta[field] !== 'string' || meta[field].trim() === '') {
        fail(`personas/${slug}/persona.json field ${field} must be a non-empty string`);
      }
    }
    const extraEnv = meta.extra_env ?? {};
    if (extraEnv === null || typeof extraEnv !== 'object' || Array.isArray(extraEnv)) {
      fail(`personas/${slug}/persona.json extra_env must be an object of KEY=VALUE defaults`);
    }
    for (const [key, value] of Object.entries(extraEnv)) {
      if (typeof value !== 'string') fail(`personas/${slug}/persona.json extra_env[${key}] must be a string`);
      if (SECRETISH_KEY_RE.test(key)) {
        fail(`personas/${slug}/persona.json extra_env[${key}] looks secret-shaped — secrets never live in the library`);
      }
    }
    const soulContents = readFileSync(soulPath, 'utf8');
    if (soulContents.trim() === '') fail(`personas/${slug}/SOUL.md is empty`);
    personas.push({
      slug,
      name: meta.name,
      role: meta.role,
      description: meta.description,
      model_route: meta.model_route,
      extra_env: extraEnv,
      soul_contents: soulContents,
    });
  }
  return personas;
}

/** Serialize one persona as TS source lines (stable key order = literal order). */
function tsPersona(p, indent) {
  const pad = ' '.repeat(indent);
  const padIn = ' '.repeat(indent + 2);
  const lines = [
    `${pad}{`,
    `${padIn}slug: ${JSON.stringify(p.slug)},`,
    `${padIn}name: ${JSON.stringify(p.name)},`,
    `${padIn}role: ${JSON.stringify(p.role)},`,
    `${padIn}description: ${JSON.stringify(p.description)},`,
    `${padIn}model_route: ${JSON.stringify(p.model_route)},`,
    `${padIn}extra_env: ${JSON.stringify(p.extra_env)},`,
    `${padIn}soul_contents: ${JSON.stringify(p.soul_contents)},`,
    `${pad}},`,
  ];
  return lines.join('\n');
}

function generateModule(personas) {
  const header = `// GENERATED FILE — do not edit by hand (fleet-ops-zbq.2).
//
// Embedded persona library: the admin console's structured-editor persona
// pre-fill picker serves these presets. Regenerate after any edit under
// personas/ with:
//
//   node scripts/generate-persona-library.mjs
//
// Build-time embed by contract: this module compiles into registrar/dist
// alongside every other console source — there is no runtime fetch path
// and no filesystem read at serve time. The library ships as reviewed,
// non-secret persona content only; secrets stay per-device, typed into
// the console's write-only fields exactly as before.

/** One library persona preset, as offered by the console picker. */
export interface PersonaPreset {
  slug: string;
  name: string;
  role: string;
  description: string;
  model_route: string;
  /** Default KEY=VALUE env entries (non-secret only; validated at generation). */
  extra_env: Record<string, string>;
  /** Verbatim SOUL.md contents; prefills the soul_contents editor field. */
  soul_contents: string;
}

/** All personas, sorted by slug. Empty array = picker renders disabled. */
export const PERSONA_LIBRARY: readonly PersonaPreset[] = [
`;
  const body = personas.map((p) => tsPersona(p, 2)).join('\n');
  return `${header}${body}\n];\n`;
}

function main() {
  const personas = loadPersonas();
  const moduleText = generateModule(personas);
  writeFileSync(outFile, moduleText);
  console.log(
    `generate-persona-library: wrote ${path.relative(repoRoot, outFile)} (${personas.length} personas: ${personas
      .map((p) => p.slug)
      .join(', ')})`,
  );
}

// Importable surface for the self-pin test (registrar/test/persona-library.test.ts):
// the test regenerates the module text in-memory and byte-compares against
// the checked-in file — no tree writes, no drift possible without CI going red.
export { loadPersonas, generateModule };

const isCli = import.meta.url === `file://${process.argv[1]}` || path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (isCli) main();
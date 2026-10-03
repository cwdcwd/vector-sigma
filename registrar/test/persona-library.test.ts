import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Embedded persona library (fleet-ops-zbq.2).
 *
 * The admin console's persona pre-fill picker serves PERSONA_LIBRARY —
 * a GENERATED module (scripts/generate-persona-library.mjs) checked in
 * under registrar/src so it compiles into dist with every other console
 * source: build-time embed, no runtime fetch path, no filesystem read
 * at serve time. These tests pin the two contracts that keep the embed
 * honest:
 *
 * 1. REGENERATION PIN: the checked-in module is byte-identical to what
 *    the generator produces from personas/ today — a library edit that
 *    skips regeneration fails here instead of silently drifting.
 * 2. CONTENT CONTRACT: non-secret, slug-unique, structurally valid
 *    presets (the picker renders them raw into the console page).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

async function importGenerator(): Promise<{
  loadPersonas: () => Array<Record<string, unknown>>;
  generateModule: (personas: Array<Record<string, unknown>>) => string;
}> {
  return import(path.join(repoRoot, 'scripts/generate-persona-library.mjs'));
}

describe('persona library embed (zbq.2)', () => {
  it('checked-in module is byte-identical to the generator output (no drift)', async () => {
    const gen = await importGenerator();
    const regenerated = gen.generateModule(gen.loadPersonas());
    const checkedIn = readFileSync(
      path.join(repoRoot, 'registrar/src/persona-library.ts'),
      'utf8',
    );
    expect(checkedIn).toBe(regenerated);
  });

  it('library presets are structurally valid and unique by slug', async () => {
    const { PERSONA_LIBRARY } = await import('../src/persona-library.js');
    expect(PERSONA_LIBRARY.length).toBeGreaterThanOrEqual(1);
    const slugs = new Set<string>();
    for (const p of PERSONA_LIBRARY) {
      expect(p.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(slugs.has(p.slug)).toBe(false);
      slugs.add(p.slug);
      for (const field of ['name', 'role', 'description', 'model_route', 'soul_contents'] as const) {
        expect(p[field].trim()).not.toBe('');
      }
      // extra_env: string values only, no secret-shaped keys (defense in
      // depth — the generator already refuses them at generation time).
      for (const [key, value] of Object.entries(p.extra_env)) {
        expect(typeof value).toBe('string');
        expect(/(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASS|CRED|CREDENTIAL)(_|$)/i.test(key)).toBe(false);
      }
    }
    // Sorted by slug — deterministic island and picker order.
    const sorted = [...PERSONA_LIBRARY].map((p) => p.slug);
    expect(sorted).toEqual([...sorted].sort());
  });

  it('library carries no secret-shaped strings (non-secret content contract)', async () => {
    const { PERSONA_LIBRARY } = await import('../src/persona-library.js');
    const blob = JSON.stringify(PERSONA_LIBRARY);
    // The library is reviewable persona content; a secret that lands here
    // ships inside every console page render. Byte-scan the whole embed.
    for (const marker of ['sk-', 'xoxb-', 'BEGIN RSA PRIVATE KEY', 'BEGIN PRIVATE KEY', 'GATEWAY_API_KEY=']) {
      expect(blob.includes(marker)).toBe(false);
    }
  });

  it('library content stays fleet-agnostic (no agent or owner names)', async () => {
    const { PERSONA_LIBRARY } = await import('../src/persona-library.js');
    const blob = JSON.stringify(PERSONA_LIBRARY);
    // Owner ruling (zbq epic): the repo ships no fleet, owner, or
    // coordinator names in library content — any fleet running
    // vector-sigma adopts these personas unchanged.
    expect(/doombot|ultronbot|kangbot|thanosbot|lazybaer|primus/i.test(blob)).toBe(false);
  });
});
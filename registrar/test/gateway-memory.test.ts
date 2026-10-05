import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * gateway-memory plugin contract (fleet-ops-e5o.3).
 *
 * The VS agent images bake a product-agnostic copy of the gateway-memory
 * plugin (deploy/gateway-memory/ — canonical; byte-pinned into both balena
 * app dirs by the vendored-drift test). This guard pins the lane's
 * non-vendoring contract points:
 *
 *   1. The plugin is stdlib-only (the bake ruling: no new runtime deps
 *      for the agent image). Import scan over the python sources.
 *   2. plugin.yaml declares BOTH memory keys in requires_env — the origin
 *      plugin declares only the shared one (the verified consult gap);
 *      tools.py reads both, so the manifest must too.
 *   3. Tool names are the product-agnostic trio (memory_get/set/list) —
 *      no origin-fleet naming (fleet_memory_*, litellm/LITELLM brand
 *      tokens) leaks into repo content (the fleet-agnostic rule).
 *   4. provenance-sha256.txt matches the actual files (drift guard: a
 *      silently-diverged vendored copy is the failure the stamp exists
 *      to catch).
 *   5. The Dockerfiles bake the plugin + hook with the 06- cont-init
 *      ordering (after queue-join 03-, A2A 04-, GitHub identity 05-).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const pluginDir = path.join(repoRoot, 'deploy/gateway-memory');

const PY_SOURCES = ['__init__.py', 'schemas.py', 'tools.py'] as const;
const ALLOWED_IMPORTS = new Set([
  'json', 'os', 'urllib', 'urllib.error', 'urllib.parse', 'urllib.request', 'pathlib', 'sys',
]);

function pythonImports(src: string): string[] {
  const out: string[] = [];
  for (const line of src.split('\n')) {
    const m = /^\s*(?:from\s+([\w.]+)\s+)?import\s+(.+)$/.exec(line);
    if (!m) continue;
    if (m[1]) {
      if (m[1] === '.') continue; // intra-package relative import — not a dep
      out.push(m[1]);
      continue;
    }
    for (const piece of m[2].split(',')) {
      const mod = piece.trim().split(/\s+as\s+/)[0].split('.')[0].trim();
      if (mod) out.push(mod);
    }
  }
  return out;
}

function stripComments(raw: string): string {
  return raw.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
}

describe('gateway-memory plugin (e5o.3)', () => {
  it('exists as a complete plugin: manifest, registration, tools, skill', () => {
    for (const f of [
      'plugin.yaml',
      '__init__.py',
      'schemas.py',
      'tools.py',
      'skills/gateway-memory/SKILL.md',
      'provenance-sha256.txt',
    ]) {
      expect(existsSync(path.join(pluginDir, f)), `deploy/gateway-memory/${f} missing`).toBe(true);
    }
  });

  it('is stdlib-only (no third-party imports — the bake ruling)', () => {
    for (const f of PY_SOURCES) {
      const src = readFileSync(path.join(pluginDir, f), 'utf8');
      const code = stripComments(src);
      for (const mod of pythonImports(code)) {
        const root = mod.split('.')[0];
        expect(
          ALLOWED_IMPORTS.has(mod) || ALLOWED_IMPORTS.has(root),
          `${f} imports '${mod}' — the plugin must stay stdlib-only (bake ruling)`,
        ).toBe(true);
      }
    }
  });

  it('plugin.yaml declares BOTH memory keys in requires_env (the origin-gap fix)', () => {
    const y = readFileSync(path.join(pluginDir, 'plugin.yaml'), 'utf8');
    expect(y).toMatch(/GATEWAY_MEMORY_SHARED_KEY/);
    expect(y).toMatch(/GATEWAY_MEMORY_PRIVATE_KEY/);
    // both marked secret
    const sharedBlock = /name:\s*GATEWAY_MEMORY_SHARED_KEY[\s\S]*?secret:\s*true/.test(y);
    const privateBlock = /name:\s*GATEWAY_MEMORY_PRIVATE_KEY[\s\S]*?secret:\s*true/.test(y);
    expect(sharedBlock, 'shared key entry must be secret: true').toBe(true);
    expect(privateBlock, 'private key entry must be secret: true').toBe(true);
  });

  it('tools.py reads exactly the two declared env keys', () => {
    const src = readFileSync(path.join(pluginDir, 'tools.py'), 'utf8');
    expect(src).toMatch(/GATEWAY_MEMORY_SHARED_KEY/);
    expect(src).toMatch(/GATEWAY_MEMORY_PRIVATE_KEY/);
    // The route lock is documented + used in the mint payload contract.
    expect(src).toMatch(/\/v1\/memory/);
  });

  it('carries no origin-fleet or vendor naming (fleet-agnostic content rule)', () => {
    const banned = [
      /fleet[-_]memory/i,
      /litellm_memory/i,
      /\bai\.lan\b/i,
      /Hermes agent fleet/i,
    ];
    const files = [
      'plugin.yaml', '__init__.py', 'schemas.py', 'tools.py',
      'skills/gateway-memory/SKILL.md', 'README.md',
    ];
    for (const f of files) {
      // FLEET_MEMORY_BASE_URL is the ONE sanctioned origin token (the
      // env retarget seam — renaming it would fork the env contract;
      // PROVENANCE.md records the ruling). Mask it before the scan.
      const src = readFileSync(path.join(pluginDir, f), 'utf8')
        .replace(/FLEET_MEMORY_BASE_URL/g, 'RETARGET_BASE_URL');
      for (const re of banned) {
        expect(src.match(re), `${f} matches origin-naming ${re}`).toBeNull();
      }
    }
    // FLEET_MEMORY_BASE_URL is the ONE allowed origin token: the env
    // retarget seam is already supported by that name (keeping it is
    // cheaper than forking the env contract). The plugin docs say so.
    expect(
      readFileSync(path.join(pluginDir, 'README.md'), 'utf8'),
    ).toMatch(/FLEET_MEMORY_BASE_URL/);
  });

  it('provenance-sha256.txt matches the actual plugin files (drift guard)', () => {
    // node:crypto sha256 over every pinned file; the stamp is authoritative.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const stamp = readFileSync(path.join(pluginDir, 'provenance-sha256.txt'), 'utf8');
    const pinned = new Map<string, string>();
    for (const line of stamp.split('\n')) {
      const m = /^([0-9a-f]{64})\s\s(.+)$/.exec(line.trim());
      if (m) pinned.set(m[2], m[1]);
    }
    expect(pinned.size, 'stamp parses to at least one pinned file').toBeGreaterThan(0);
    for (const [rel, want] of pinned) {
      const got = createHash('sha256')
        .update(readFileSync(path.join(pluginDir, rel)))
        .digest('hex');
      expect(got, `provenance drift: ${rel} (stamp ${want.slice(0, 12)}, file ${got.slice(0, 12)})`).toBe(want);
    }
    // every non-provenance file in the dir is pinned (no unpinned drift)
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(full));
        else if (e.name !== 'provenance-sha256.txt') out.push(path.relative(pluginDir, full));
      }
      return out.sort();
    };
    const onDisk = walk(pluginDir);
    const pinnedPaths = [...pinned.keys()].sort();
    expect(onDisk, 'every plugin file is provenance-pinned').toEqual(pinnedPaths);
  });
});

describe('gateway-memory bake wiring (e5o.3, Dockerfiles + hook)', () => {
  const strip = (p: string) => stripComments(readFileSync(path.join(repoRoot, p), 'utf8'));

  it('primus image (Dockerfile.hermes) bakes plugin + 06- hook', () => {
    const code = strip('balena/registrar/Dockerfile.hermes');
    expect(code).toMatch(/COPY gateway-memory \/opt\/vs\/gateway-memory/);
    expect(code).toMatch(/COPY vs-memory-tools\.sh \/etc\/cont-init\.d\/06-vs-memory-tools/);
    expect(code).toMatch(/chmod 0755 \/etc\/cont-init\.d\/06-vs-memory-tools/);
  });

  it('devices image (Dockerfile.agent-hermes) bakes plugin + 06- hook', () => {
    const code = strip('balena/devices/Dockerfile.agent-hermes');
    expect(code).toMatch(/COPY agent\/gateway-memory \/opt\/vs\/gateway-memory/);
    expect(code).toMatch(/COPY agent\/vs-memory-tools\.sh \/etc\/cont-init\.d\/06-vs-memory-tools/);
    expect(code).toMatch(/chmod 0755 \/etc\/cont-init\.d\/06-vs-memory-tools/);
  });

  it('the hook: with-contenv shape, installs to plugins/, seeds plugins.enabled, fail-soft', () => {
    const hook = readFileSync(path.join(repoRoot, 'deploy/vs-memory-tools.sh'), 'utf8');
    expect(hook).toMatch(/^#!\/command\/with-contenv sh/);
    const code = stripComments(hook);
    // installs into $HERMES_HOME/plugins/<plugin-name> (the loader's
    // discovery root) — asserted via the hook's own variables so a
    // rename of the plugin name stays one-edit coherent.
    expect(code).toMatch(/PLUGINS_DIR="\$HOME_DIR\/plugins"/);
    expect(code).toMatch(/PLUGIN_NAME="gateway-memory"/);
    expect(code).toMatch(/rm -rf "\$PLUGINS_DIR\/\$PLUGIN_NAME"/);
    // seeds the PluginManager allow-list (the load-bearing gate)
    expect(code).toMatch(/plugins\.enabled/);
    // excludes build-host bytecode
    expect(code).toMatch(/__pycache__/);
    // FAIL-SOFT: never a live non-zero exit (comment-stripped)
    expect(code).not.toMatch(/exit [1-9]/);
  });

  it('no BuildKit-only ARG tokens in the hook-driven Dockerfiles (f57.21 guard holds)', () => {
    // the balena-dockerfiles test already sweeps all Dockerfiles; this is
    // the lane-local restatement for the two images this lane touches.
    for (const f of ['balena/registrar/Dockerfile.hermes', 'balena/devices/Dockerfile.agent-hermes']) {
      expect(strip(f)).not.toContain('TARGETARCH');
      expect(strip(f)).not.toContain('TARGETPLATFORM');
    }
  });
});
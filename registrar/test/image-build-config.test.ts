import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  componentsFor,
  copySources as copySourcesOf,
  dockerInstructions,
  imageInputs,
  loadCatalog,
} from '../../scripts/image-catalog.mjs';

/**
 * Single-source image builds. Every first-party image builds from the REPO
 * ROOT context and COPYs the canonical sources (registrar/, registrant/,
 * shared/, deploy/, scripts/, docs/) — the balena app dirs no longer carry
 * vendored copies, so there is nothing to byte-pin. What this file guards
 * instead is the build configuration that replaced the copies:
 *
 *   - images.json (the catalog every image workflow reads) names real
 *     Dockerfiles, and every input an image COPYs exists (a rename can't
 *     silently drop a file from an image);
 *   - dependencies install from the root lockfile (`npm ci`), never a
 *     lockfile-free `npm install`;
 *   - registrar/tsconfig.image.json excludes only modules the shipped
 *     server never imports;
 *   - e5o.1: each Hermes image ships its OWN environment map;
 *   - no vendored copy creeps back under balena/.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

const catalog = loadCatalog(repoRoot);
const instructions = (rel: string): string[] => dockerInstructions(read(rel));
const copySources = (rel: string): string[] => copySourcesOf(read(rel));

describe('single-source image builds', () => {
  it('the catalog covers both fleets and every first-party Dockerfile', () => {
    expect(componentsFor(catalog, 'registrar').sort()).toEqual(
      ['hermes', 'litellm', 'postgres', 'registrant', 'registrar', 'scotty', 'tailscale'],
    );
    expect(componentsFor(catalog, 'devices').sort()).toEqual(['agent', 'registrant', 'tailscale-devices']);
    const dockerfiles = Object.values(catalog.components).map((c: { dockerfile: string }) => c.dockerfile);
    for (const rel of ['registrar/Dockerfile', 'registrant/Dockerfile']) expect(dockerfiles).toContain(rel);
  });

  it.each(Object.keys(catalog.components))('%s: Dockerfile + every COPY input exists', (component) => {
    const inputs = imageInputs(catalog, component, repoRoot);
    expect(inputs.length).toBeGreaterThan(1);
    const missing = inputs.filter((s: string) => !existsSync(path.join(repoRoot, s)));
    expect(missing, `${component} reads paths that do not exist`).toEqual([]);
  });

  it.each(['registrar/Dockerfile', 'registrant/Dockerfile'])(
    '%s: installs from the root lockfile with npm ci',
    (rel) => {
      const ins = instructions(rel);
      expect(copySources(rel)).toContain('package-lock.json');
      const installs = ins.filter((i) => /\bnpm (ci|install|i)\b/.test(i));
      expect(installs.length).toBeGreaterThan(0);
      for (const i of installs) expect(i, `${rel}: ${i}`).toMatch(/\bnpm ci\b/);
    },
  );

  it('registrar/tsconfig.image.json excludes only modules the shipped server never imports', () => {
    const cfg = read('registrar/tsconfig.image.json');
    const excluded = [...cfg.matchAll(/"src\/([\w-]+)"/g)].map((m) => m[1]);
    expect(excluded.sort()).toEqual(['credential-scan', 'oci-gate', 'registry']);

    const srcRoot = path.join(repoRoot, 'registrar/src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        const rel = path.relative(srcRoot, p);
        if (excluded.some((e) => rel === e || rel.startsWith(`${e}/`))) continue;
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        for (const m of readFileSync(p, 'utf8').matchAll(/from\s+'(\.[^']+)'/g)) {
          const target = path.relative(srcRoot, path.resolve(path.dirname(p), m[1]));
          if (excluded.some((e) => target === e || target.startsWith(`${e}/`))) {
            offenders.push(`${rel} imports ${m[1]}`);
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders, 'shipped code imports a module the image build excludes').toEqual([]);
  });

  // e5o.1 — the wrong-map regression guard. The devices image once shipped
  // primus's MASTER map, so a device agent read "You are primus … the queue
  // CURATOR" plus a queue host (dolt:3306) unreachable from a device.
  it('e5o.1: each Hermes image ships its own environment map (wrong-map regression)', () => {
    const docsOf = (rel: string) =>
      copySources(rel)
        .filter((s) => s.startsWith('docs/'))
        .map((s) => s.slice('docs/'.length));
    const devices = docsOf('balena/devices/Dockerfile.agent-hermes');
    const primus = docsOf('balena/registrar/Dockerfile.hermes');

    expect(devices).toContain('device-environment.md');
    expect(devices).toContain('queue-conventions.md');
    expect(devices, 'devices image must NOT ship the master map').not.toContain('vs-environment.md');
    expect(primus).toContain('vs-environment.md');
    expect(primus, 'primus image must NOT ship the device map').not.toContain('device-environment.md');

    // "You are primus" in ANY doc the devices image ships is the defect.
    for (const doc of devices) {
      expect(read(`docs/${doc}`).includes('You are primus'), `docs/${doc} (devices image)`).toBe(false);
    }
    const deviceMap = read('docs/device-environment.md');
    expect(deviceMap).toMatch(/:3326/);
    expect(deviceMap).toMatch(/WORKER/);
    expect(deviceMap).toMatch(/NEVER run `bd init`/);
  });

  it('balena/ carries no vendored copies of canonical sources', () => {
    const banned = [
      'balena/registrar/registrar',
      'balena/registrar/registrant-own',
      'balena/devices/registrant',
      'balena/registrar/docs',
      'balena/devices/docs',
      'balena/registrar/gateway-memory',
      'balena/devices/agent/gateway-memory',
    ];
    expect(banned.filter((p) => existsSync(path.join(repoRoot, p)))).toEqual([]);

    // No file under balena/ may share a name with a canonical hook script.
    const canonical = new Set([
      ...readdirSync(path.join(repoRoot, 'deploy')).filter((n) => /\.(sh|py)$/.test(n)),
      ...readdirSync(path.join(repoRoot, 'scripts')).filter((n) => /^vs-.*\.(sh|py)$/.test(n)),
    ]);
    const dupes: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (canonical.has(name)) dupes.push(path.relative(repoRoot, p));
      }
    };
    walk(path.join(repoRoot, 'balena'));
    expect(dupes, 'COPY these from deploy/ or scripts/ instead').toEqual([]);
  });
});

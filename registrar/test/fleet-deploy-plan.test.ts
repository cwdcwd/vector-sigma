import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planBalenaDeploy } from '../../scripts/fleet-deploy-plan.mjs';

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../platforms/fleets/examples/${name}`, import.meta.url), 'utf8'));
const balena = (): any => load('balena-fleet.example.json');
const RELEASE = '0123456789abcdef0123456789abcdef';
// A deployable copy: real-looking (non-placeholder) digests, as a promoted config would pin.
const deployable = (): any => {
  const c = balena();
  c.status = 'deployable';
  Object.keys(c.images).forEach((k, i) => {
    c.images[k] = `sha256:${(i + 10).toString(16).repeat(2).padEnd(64, 'ab').slice(0, 64)}`;
  });
  return c;
};

describe('balena deploy plan for a per-fleet config (fleet-ops-210.1)', () => {
  it('plans deploys and pins to the config apps only, never the repo-variable fleets', () => {
    const { errors, plan } = planBalenaDeploy(deployable(), { release: RELEASE, sourceDir: 'rel' });
    expect(errors).toEqual([]);
    expect(plan.map((s) => s.argv.join(' '))).toEqual([
      'balena deploy g_c_d/vs-balena-b-registrar --source rel/registrar --release-tag git-tag <release-tag> --note vs-balena-b <release-tag>',
      'balena deploy g_c_d/vs-balena-b-devices --source rel/devices --release-tag git-tag <release-tag> --note vs-balena-b <release-tag>',
      `balena fleet pin g_c_d/vs-balena-b-registrar ${RELEASE}`,
      `balena fleet pin g_c_d/vs-balena-b-devices ${RELEASE}`,
    ]);
    for (const s of plan) expect(s.argv.join(' ')).not.toMatch(/vars\.|vector-sigma-master|g_c_d\/vector-sigma\b/);
  });

  it('refuses an example (placeholder) config', () => {
    const { errors, plan } = planBalenaDeploy(balena(), { release: RELEASE });
    expect(plan).toEqual([]);
    expect(errors.some((e) => e.includes('only a "deployable" config'))).toBe(true);
  });

  it('refuses an aws target', () => {
    const c = deployable();
    c.target = 'aws';
    delete c.balena;
    c.database = { kind: 'rds-postgres', endpoint: 'db.abc.us-east-1.rds.amazonaws.com' };
    c.aws = { account: '123456789012', region: 'us-east-1', agentcore_runtime: 'vs_b', ecs_cluster: 'vs-b' };
    const { errors, plan } = planBalenaDeploy(c, { release: RELEASE });
    expect(plan).toEqual([]);
    expect(errors).toContain('$.target: deploy plan applies to a balena target only');
  });

  it('refuses an existing production fleet via the shared validator', () => {
    const c = deployable();
    c.balena.fleets.devices = 'g_c_d/vector-sigma';
    const { errors, plan } = planBalenaDeploy(c, { release: RELEASE });
    expect(plan).toEqual([]);
    expect(errors.some((e) => e.includes('existing production fleet'))).toBe(true);
  });

  it('requires a 32-hex release id', () => {
    for (const bad of [undefined, '', 'abc', 'G'.repeat(32), `${RELEASE}0`]) {
      const { errors, plan } = planBalenaDeploy(deployable(), { release: bad as any });
      expect(plan).toEqual([]);
      expect(errors.some((e) => e.startsWith('--release'))).toBe(true);
    }
  });
});

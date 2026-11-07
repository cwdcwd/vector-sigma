import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateFleetConfig } from '../../scripts/fleet-config.mjs';

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../platforms/fleets/examples/${name}`, import.meta.url), 'utf8'));
const aws = (): any => load('aws-fleet.example.json');
const balena = (): any => load('balena-fleet.example.json');
const DIGEST = `sha256:${'a'.repeat(63)}b`;

describe('fleet deployment config (fleet-ops-210.1)', () => {
  it('accepts the shipped AWS and Balena examples', () => {
    expect(validateFleetConfig(aws())).toEqual([]);
    expect(validateFleetConfig(balena())).toEqual([]);
  });

  it('rejects an unknown target and a missing required image component', () => {
    const c = aws();
    c.target = 'gcp';
    delete c.images.litellm;
    const errs = validateFleetConfig(c);
    expect(errs).toContain('$.target: must be "aws" or "balena"');
    expect(errs.some((e) => e.includes('missing required component "litellm"'))).toBe(true);
  });

  it('requires pinned digests, rejects tags and placeholders in deployable configs', () => {
    const c = aws();
    c.status = 'deployable';
    c.images.agent = 'ghcr.io/cwdcwd/vector-sigma/agent:latest';
    c.images.hermes = `sha256:${'0'.repeat(64)}`;
    const errs = validateFleetConfig(c);
    expect(errs.some((e) => e.startsWith('$.images.agent: must be a pinned sha256 digest'))).toBe(true);
    expect(errs.some((e) => e.startsWith('$.images.hermes: placeholder digest'))).toBe(true);
  });

  it('accepts a real-looking digest on a deployable config', () => {
    const c = balena();
    c.status = 'deployable';
    for (const k of Object.keys(c.images)) c.images[k] = DIGEST;
    expect(validateFleetConfig(c)).toEqual([]);
  });

  it('rejects an image component that is not in images.json', () => {
    const c = balena();
    c.images.unknown = `sha256:${'b'.repeat(64)}`;
    expect(validateFleetConfig(c)).toContain('$.images.unknown: not an images.json component');
  });

  it('rejects credential-shaped keys anywhere in the config', () => {
    const c = aws();
    c.aws.secret_access_key = 'x';
    c.endpoints.registrar_bootstrap = 'x';
    const errs = validateFleetConfig(c);
    expect(errs.some((e) => e.includes('$.aws.secret_access_key'))).toBe(true);
    expect(errs.some((e) => e.includes('$.endpoints.registrar_bootstrap'))).toBe(true);
  });

  it('requires https, instance-unique endpoints; registrar and gateway must differ', () => {
    const c = balena();
    c.endpoints.queue_url = 'http://queue.example';
    c.endpoints.gateway_url = c.endpoints.registrar_url;
    const errs = validateFleetConfig(c);
    expect(errs).toContain('$.endpoints.queue_url: must be an https URL unique to this instance');
    expect(errs).toContain('$.endpoints: registrar_url and gateway_url must differ');
  });

  it('enforces target-specific blocks and database kind', () => {
    const a = aws();
    a.balena = { fleets: { registrar: 'g_c_d/x', devices: 'g_c_d/y' } };
    a.database = { kind: 'container' };
    const ea = validateFleetConfig(a);
    expect(ea).toContain('$.balena: not allowed for an aws target');
    expect(ea.some((e) => e.startsWith('$.database: aws target needs'))).toBe(true);

    const b = balena();
    b.aws = { account: '123456789012', region: 'us-east-1', agentcore_runtime: 'x', ecs_cluster: 'y' };
    b.database = { kind: 'rds-postgres', endpoint: 'h.rds.amazonaws.com' };
    const eb = validateFleetConfig(b);
    expect(eb).toContain('$.aws: not allowed for a balena target');
    expect(eb).toContain('$.database: balena target needs {"kind":"container"}');
  });

  it('validates AWS account, region and RDS endpoint shapes', () => {
    const c = aws();
    c.aws.account = '12345';
    c.aws.region = 'useast1';
    c.database.endpoint = 'db.example.com';
    const errs = validateFleetConfig(c);
    expect(errs).toContain('$.aws.account: must be a 12-digit account id');
    expect(errs).toContain('$.aws.region: must look like us-east-1');
    expect(errs.some((e) => e.startsWith('$.database: aws target needs'))).toBe(true);
  });

  it('refuses to reuse existing production balena fleets', () => {
    const c = balena();
    c.balena.fleets.devices = 'g_c_d/vector-sigma';
    c.balena.fleets.registrar = c.balena.fleets.devices;
    const errs = validateFleetConfig(c);
    expect(errs.some((e) => e.includes('"g_c_d/vector-sigma" is an existing production fleet'))).toBe(true);
    expect(errs).toContain('$.balena.fleets: registrar and devices must differ');
  });

  it('rejects unknown top-level keys and non-object input', () => {
    const c = aws();
    c.surprise = true;
    expect(validateFleetConfig(c)).toContain('$.surprise: unknown key');
    expect(validateFleetConfig(null)).toEqual(['config must be a JSON object']);
  });

  it('accepts last_known_good as a full pinned digest set (the documented rollback field)', () => {
    const c = balena();
    c.status = 'deployable';
    for (const k of Object.keys(c.images)) c.images[k] = DIGEST;
    c.last_known_good = { ...c.images, registrar: `sha256:${'c1'.repeat(32)}` };
    expect(validateFleetConfig(c)).toEqual([]);
  });

  it('validates last_known_good with the same digest and component rules as images', () => {
    const c = balena();
    c.status = 'deployable';
    for (const k of Object.keys(c.images)) c.images[k] = DIGEST;
    c.last_known_good = { ...c.images, registrar: 'ghcr.io/cwdcwd/vector-sigma/registrar:latest', bogus: DIGEST };
    const errs = validateFleetConfig(c);
    expect(errs.some((e) => e.startsWith('$.last_known_good.registrar: must be a pinned sha256 digest'))).toBe(true);
    expect(errs).toContain('$.last_known_good.bogus: not an images.json component');
    delete c.last_known_good.litellm;
    expect(validateFleetConfig(c)).toContain('$.last_known_good: missing required component "litellm"');
  });
});

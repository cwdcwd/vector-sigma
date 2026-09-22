import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * TLS trust contract (fleet-ops-f57.13): an https REGISTRAR_URL requires a
 * provisioned VS CA; http boots unchanged. Five branches:
 *   1. https + NO CA provision          -> startup aborts, naming the vars
 *   2. https + NODE_EXTRA_CA_CERTS      -> boots (the vs-entrypoint path)
 *   3. https + VS_CA_CERT_B64 / VS_CA_CERT -> boots (misconfigured-shim path)
 *   4. https + VS_ALLOW_PUBLIC_CA=true   -> boots (explicit public-CA opt-out)
 *   5. http + no CA                     -> boots unchanged (pre-TLS topology)
 * Scheme is case-insensitive (Copilot review): HTTPS:// also gates.
 */

const baseEnv = {
  BALENA_DEVICE_UUID: '11111111-2222-3333-4444-555555555555',
  REGISTRAR_URL: 'https://vsigma.lan',
  REGISTRAR_KEY: 'bk_test-000000000001',
};

describe('config TLS trust contract (f57.13)', () => {
  it('aborts on https with no CA provisioned (fail-loud, names the fix)', () => {
    expect(() => loadConfig({ ...baseEnv })).toThrowError(
      /REGISTRAR_URL is https but no VS CA is provisioned/,
    );
    expect(() => loadConfig({ ...baseEnv })).toThrowError(
      /VS_CA_CERT_B64/,
    );
  });

  it('boots https with NODE_EXTRA_CA_CERTS (the vs-entrypoint shim path)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      NODE_EXTRA_CA_CERTS: '/tmp/vs-ca.pem',
    });
    expect(cfg.registrarUrl).toBe('https://vsigma.lan');
  });

  it('boots https with VS_CA_CERT_B64 (shim misconfigured — still fails loud inside, but config passes)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      VS_CA_CERT_B64: 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==',
    });
    expect(cfg.registrarUrl).toBe('https://vsigma.lan');
  });

  it('boots https with VS_CA_CERT (baked CA path)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      VS_CA_CERT: '/usr/local/share/vs-ca.crt',
    });
    expect(cfg.registrarUrl).toBe('https://vsigma.lan');
  });

  it('boots https with VS_ALLOW_PUBLIC_CA=true (explicit opt-out, never default)', () => {
    const cfg = loadConfig({ ...baseEnv, VS_ALLOW_PUBLIC_CA: 'true' });
    expect(cfg.registrarUrl).toBe('https://vsigma.lan');
  });

  it('VS_ALLOW_PUBLIC_CA=false does NOT bypass the contract', () => {
    expect(() =>
      loadConfig({ ...baseEnv, VS_ALLOW_PUBLIC_CA: 'false' }),
    ).toThrowError(/no VS CA is provisioned/);
  });

  it('http boots unchanged with no CA variables at all (pre-TLS topology)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      REGISTRAR_URL: 'http://registrar:3000',
    });
    expect(cfg.registrarUrl).toBe('http://registrar:3000');
  });

  it('gates uppercase HTTPS:// too (scheme is case-insensitive — Copilot review)', () => {
    expect(() =>
      loadConfig({ ...baseEnv, REGISTRAR_URL: 'HTTPS://vsigma.lan' }),
    ).toThrowError(/no VS CA is provisioned/);
  });
});
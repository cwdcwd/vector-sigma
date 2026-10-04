import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * TLS trust contract (fleet-ops-f57.13; RETIRED fleet-ops-lnf, j7g
 * phase 2 — the serve-only edge).
 *
 * The f57.13 fail-loud gate (https REGISTRAR_URL requires a VS internal
 * CA provisioned) existed to prevent a silent public-CA fallback
 * against the fleet's SELF-MINTED CA. lnf retired the internal CA
 * with caddy: the registrar's edge is tailscale serve fronting Let's
 * Encrypt certificates at the MagicDNS name — a publicly trusted CA
 * that every stock trust store (Node's bundled Mozilla list included)
 * verifies with zero provisioning. With a public CA at the edge the
 * stock store IS the correct configuration; there is no
 * silent-fallback failure mode left to guard, so the gate and its
 * VS_CA_* variables are gone.
 *
 * The contract now:
 *   1. https REGISTRAR_URL boots with NO CA variables — public trust,
 *      no provisioning (the live tailnet shape).
 *   2. http REGISTRAR_URL boots unchanged (compose-internal
 *      topologies; the e2e device path).
 *   3. The retired variables are no longer part of the schema: an
 *      https URL with stray VS_CA_* values in the environment still
 *      boots (unknown env keys were never rejected — the f57.8
 *      posture: nothing crashes on retired variables), and the
 *      config never reads them.
 *   4. Scheme handling is unchanged: https:// and HTTPS:// both parse
 *      as https (the URL contract), http:// as http.
 */

const baseEnv = {
  BALENA_DEVICE_UUID: '11111111-2222-3333-4444-555555555555',
  REGISTRAR_URL: 'https://vector-sigma.tailb7207e.ts.net',
  REGISTRAR_KEY: 'bk_test-000000000001',
};

describe('config TLS contract (lnf, phase 2 — public trust, no provisioning)', () => {
  it('boots https with NO CA variables at all (Let’s Encrypt is publicly trusted)', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.registrarUrl).toBe('https://vector-sigma.tailb7207e.ts.net');
  });

  it('boots https with stray retired variables still in the environment (never a crash)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      VS_CA_CERT_B64: 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==',
      VS_CA_CERT: '/tmp/retired-ca.pem',
      VS_ALLOW_PUBLIC_CA: 'false',
    });
    expect(cfg.registrarUrl).toBe('https://vector-sigma.tailb7207e.ts.net');
  });

  it('http boots unchanged (compose-internal topology)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      REGISTRAR_URL: 'http://registrar:3000',
    });
    expect(cfg.registrarUrl).toBe('http://registrar:3000');
  });

  it('uppercase HTTPS:// parses the same as https:// (URL contract)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      REGISTRAR_URL: 'HTTPS://vector-sigma.tailb7207e.ts.net',
    });
    expect(cfg.registrarUrl).toBe('HTTPS://vector-sigma.tailb7207e.ts.net');
  });

  it('trailing slashes are still stripped from REGISTRAR_URL', () => {
    const cfg = loadConfig({
      ...baseEnv,
      REGISTRAR_URL: 'https://vector-sigma.tailb7207e.ts.net///',
    });
    expect(cfg.registrarUrl).toBe('https://vector-sigma.tailb7207e.ts.net');
  });
});
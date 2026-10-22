/**
 * The bundle + API contract shared by the registrar (producer) and the registrant (consumer).
 * These schemas are the only thing standing between a hand-rolled /v1/rotate caller and a
 * device's data directory, so their refusals are pinned here directly, not only through the
 * registrar's route tests.
 */
import { describe, expect, it } from 'vitest';
import {
  A2aKeyReportSchema,
  BINARY_MAX_DECODED_BYTES,
  BootstrapRequestSchema,
  BundleFileSchema,
  IdentityBundleSchema,
  MeshEnrollRequestSchema,
  REGISTRAR_ROUTES,
  RotateRequestSchema,
  StatusSuccessSchema,
  normalizeBalenaUuid,
} from '../src/index.js';

const SHORT = 'b1e516d9cf23c6bd0b474edae9ec41e6';
const CANONICAL = 'b1e516d9-cf23-c6bd-0b47-4edae9ec41e6';
const file = (over: Record<string, unknown> = {}) => ({ path: 'config/agent.env', mode: '0600', content: 'A=1\n', ...over });

describe('balena UUIDs', () => {
  it('normalizes the balena short form to canonical lowercase', () => {
    expect(normalizeBalenaUuid(SHORT.toUpperCase())).toBe(CANONICAL);
    expect(normalizeBalenaUuid(CANONICAL.toUpperCase())).toBe(CANONICAL);
  });

  it('request schemas accept both forms and emit canonical', () => {
    expect(BootstrapRequestSchema.parse({ balena_uuid: SHORT }).balena_uuid).toBe(CANONICAL);
    expect(BootstrapRequestSchema.parse({ balena_uuid: CANONICAL }).balena_uuid).toBe(CANONICAL);
  });

  it.each(['', 'not-a-uuid', SHORT.slice(1), `${SHORT}0`, CANONICAL.replace(/-/g, '_')])('refuses %j', (v) => {
    expect(BootstrapRequestSchema.safeParse({ balena_uuid: v }).success).toBe(false);
  });
});

describe('bundle files', () => {
  it('accepts a relative 0600 text file', () => {
    expect(BundleFileSchema.safeParse(file()).success).toBe(true);
  });

  it.each(['/etc/passwd', '../escape', 'config/../../escape', 'a/../b', ''])('refuses unsafe path %j', (path) => {
    expect(BundleFileSchema.safeParse(file({ path })).success).toBe(false);
  });

  it('refuses any mode other than 0600', () => {
    expect(BundleFileSchema.safeParse(file({ mode: '0644' })).success).toBe(false);
  });

  it('a dotted name that is not a .. segment is fine', () => {
    expect(BundleFileSchema.safeParse(file({ path: 'config/..hidden' })).success).toBe(true);
  });

  it('caps base64 payloads by DECODED size, at exactly the limit', () => {
    const at = Buffer.alloc(BINARY_MAX_DECODED_BYTES).toString('base64');
    const over = Buffer.alloc(BINARY_MAX_DECODED_BYTES + 1).toString('base64');
    expect(BundleFileSchema.safeParse(file({ path: 'assets/logo.png', content: at, encoding: 'base64' })).success).toBe(true);
    const r = BundleFileSchema.safeParse(file({ path: 'assets/logo.png', content: over, encoding: 'base64' }));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['content']);
  });

  it('text files are not size-capped by the binary limit', () => {
    expect(BundleFileSchema.safeParse(file({ content: 'x'.repeat(BINARY_MAX_DECODED_BYTES * 2) })).success).toBe(true);
  });
});

describe('identity bundle', () => {
  const bundle = { schema_version: 1, bundle_version: 1, generated_at: '2026-10-22T00:00:00Z', files: [file()] };

  it('accepts a minimal bundle', () => {
    expect(IdentityBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it.each([
    ['unknown schema version', { schema_version: 2 }],
    ['zero bundle version', { bundle_version: 0 }],
    ['fractional bundle version', { bundle_version: 1.5 }],
    ['empty generated_at', { generated_at: '' }],
    ['no files', { files: [] }],
  ])('refuses %s', (_label, over) => {
    expect(IdentityBundleSchema.safeParse({ ...bundle, ...over }).success).toBe(false);
  });

  it('rotate requests carry a non-empty, individually validated file set', () => {
    expect(RotateRequestSchema.safeParse({ balena_uuid: SHORT, files: [] }).success).toBe(false);
    expect(RotateRequestSchema.safeParse({ balena_uuid: SHORT, files: [file({ path: '/abs' })] }).success).toBe(false);
  });
});

describe('a2a key report', () => {
  const pub = 'A'.repeat(43); // raw 32-byte Ed25519 key, base64url, no padding

  it('accepts the public key alone, or with guard status and bundle version', () => {
    expect(A2aKeyReportSchema.safeParse({ balena_uuid: SHORT, ed25519: pub }).success).toBe(true);
    expect(
      A2aKeyReportSchema.safeParse({ balena_uuid: SHORT, ed25519: pub, guard_status: { running: true }, bundle_version: 12 }).success,
    ).toBe(true);
    expect(A2aKeyReportSchema.safeParse({ balena_uuid: SHORT, ed25519: pub, guard_status: null, bundle_version: null }).success).toBe(true);
  });

  it.each([
    ['padded base64', `${'A'.repeat(42)}=`],
    ['standard-alphabet chars', `${'A'.repeat(42)}+`],
    ['too short', 'A'.repeat(42)],
    ['too long (a private key would be)', 'A'.repeat(86)],
  ])('refuses a key that is %s', (_label, ed25519) => {
    expect(A2aKeyReportSchema.safeParse({ balena_uuid: SHORT, ed25519 }).success).toBe(false);
  });

  it('refuses a negative bundle version', () => {
    expect(A2aKeyReportSchema.safeParse({ balena_uuid: SHORT, ed25519: pub, bundle_version: -1 }).success).toBe(false);
  });
});

describe('mesh enroll request', () => {
  const ok = { agent_name: 'optimus-prime', origin_url: 'http://hermes:9900', public_url: 'https://edge:8443/a2a/optimus-prime' };

  it('accepts a well-formed request', () => {
    expect(MeshEnrollRequestSchema.safeParse(ok).success).toBe(true);
  });

  it.each(['', '-leading-dash', 'has space', 'semi;colon', 'x'.repeat(65)])('refuses agent_name %j', (agent_name) => {
    expect(MeshEnrollRequestSchema.safeParse({ ...ok, agent_name }).success).toBe(false);
  });

  it('carries no key-shape parameters: unknown fields are stripped, never passed through', () => {
    const parsed = MeshEnrollRequestSchema.parse({ ...ok, allowed_routes: ['/key/generate'], models: ['*'] });
    expect(parsed).toEqual(ok);
  });

  it.each(['hermes:9900', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://edge/x', 'not a url'])(
    'refuses a non-http(s) origin_url / public_url %j',
    (url) => {
      expect(MeshEnrollRequestSchema.safeParse({ ...ok, origin_url: url }).success).toBe(false);
      expect(MeshEnrollRequestSchema.safeParse({ ...ok, public_url: url }).success).toBe(false);
    },
  );
});

describe('status reply and routes', () => {
  it('status reply needs a canonical uuid and allows a null bundle version (pre-delivery)', () => {
    const reply = {
      balena_uuid: CANONICAL,
      device_status: 'active',
      slot: { state: 'armed', delivery_count: 0, delivered_at: null },
      bundle_version: null,
    };
    expect(StatusSuccessSchema.safeParse(reply).success).toBe(true);
    expect(StatusSuccessSchema.safeParse({ ...reply, balena_uuid: SHORT }).success).toBe(false);
    expect(StatusSuccessSchema.safeParse({ ...reply, device_status: 'unknown' }).success).toBe(false);
  });

  it('every API route is versioned under /v1 except the health probe', () => {
    for (const [name, route] of Object.entries(REGISTRAR_ROUTES)) {
      if (name === 'healthz') expect(route).toBe('/healthz');
      else expect(route).toMatch(/^\/v1\//);
    }
  });
});

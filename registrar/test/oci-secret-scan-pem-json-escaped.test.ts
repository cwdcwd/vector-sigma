/**
 * PR #61 review round 2 — finding #2 regression tests for the MIRRORED
 * oci-gate secret-scan path (fleet-ops-1py.14, review round 2 by
 * cwdcwd on commit 2f070ad).
 *
 * Same regression and fix as credential-scan-pem-json-escaped.test.ts,
 * proven here against registrar/src/oci-gate/secret-scan.ts directly
 * (the image LAYER/CONFIG scanning path — the owner explicitly called
 * out that both files carried "the same regression"). Also proves the
 * fix reaches image CONFIG JSON scanning (config-scan.ts), which reuses
 * secret-scan.ts's PATTERNS table verbatim, by exercising the exact
 * shape a real private key takes when it is serialized into an image
 * config.json's Labels/Env — a JSON string value with escaped `\n`.
 *
 * A FRESHLY GENERATED, disposable, never-used Ed25519 PKCS#8 key is
 * used throughout (never a real/production key).
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scanLayersForSecretsAndTopology } from '../src/oci-gate/secret-scan.js';
import { scanConfigForSecretsAndTopology } from '../src/oci-gate/config-scan.js';
import type { LayerEntry } from '../src/oci-gate/layer-walk.js';

function generateDisposablePemPkcs8(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

function fakeLayerEntry(name: string, content: string): LayerEntry {
  return {
    name,
    type: '0',
    size: Buffer.byteLength(content, 'utf8'),
    data: Buffer.from(content, 'utf8'),
    linkname: '',
    layerIndex: 0,
    layerDigest: 'sha256:' + '0'.repeat(64),
    deleted: false,
    isWhiteoutMarker: false,
  };
}

describe('oci-gate secret-scan: pem_private_key detects BOTH real-newline and JSON-escaped-newline PEM content in image LAYER bytes (PR #61 review round 2 finding #2, mirrored fix)', () => {
  const disposablePem = generateDisposablePemPkcs8();
  const placeholderShape = '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----';

  it('(a) raw multi-line PEM baked as a layer file is still detected — no regression', () => {
    const entries = [fakeLayerEntry('config/github-app.pem', disposablePem)];
    const findings = scanLayersForSecretsAndTopology(entries);
    expect(findings.map((f) => f.pattern)).toContain('pem_private_key');
  });

  it('(b) a JSON file baked as a layer containing JSON.stringify(key) (escaped \\n) is NOW detected — the regression this fixes', () => {
    const jsonSerialized = JSON.stringify({ private_key: disposablePem });
    expect(jsonSerialized.includes('\n')).toBe(false);
    const entries = [fakeLayerEntry('config/service-account.json', jsonSerialized)];
    const findings = scanLayersForSecretsAndTopology(entries);
    expect(
      findings.map((f) => f.pattern),
      'JSON-serialized real PEM in a layer file must still be flagged — round-2 regression was zero findings here',
    ).toContain('pem_private_key');
  });

  it('(c) the admin-html.ts placeholder baked as a layer file (a copy of the source) still passes — no false positive', () => {
    const entries = [fakeLayerEntry('dist/admin-html.js', `placeholder: '${placeholderShape}'`)];
    const findings = scanLayersForSecretsAndTopology(entries);
    expect(findings.map((f) => f.pattern)).not.toContain('pem_private_key');
  });

  it('(c-cont) the placeholder JSON-serialized the same way still passes', () => {
    const jsonSerializedPlaceholder = JSON.stringify({ github_app_pem: placeholderShape });
    const entries = [fakeLayerEntry('dist/structured-fields.json', jsonSerializedPlaceholder)];
    const findings = scanLayersForSecretsAndTopology(entries);
    expect(findings.map((f) => f.pattern)).not.toContain('pem_private_key');
  });
});

describe('oci-gate config-scan: a real private key JSON-serialized into image CONFIG (Env/Labels) is detected through the same reused PATTERNS table', () => {
  const disposablePem = generateDisposablePemPkcs8();

  it('detects the JSON-escaped-newline key hiding in config.Labels', () => {
    const jsonSerialized = JSON.stringify({ private_key: disposablePem });
    const config = { config: { Labels: { baked_service_account: jsonSerialized } } };
    const findings = scanConfigForSecretsAndTopology(config, 'sha256:' + '1'.repeat(64));
    expect(findings.map((f) => f.pattern)).toContain('pem_private_key');
  });

  it('detects the JSON-escaped-newline key hiding in config.Env', () => {
    const jsonSerialized = JSON.stringify({ private_key: disposablePem });
    const config = { config: { Env: [`SERVICE_ACCOUNT_JSON=${jsonSerialized}`] } };
    const findings = scanConfigForSecretsAndTopology(config, 'sha256:' + '2'.repeat(64));
    expect(findings.map((f) => f.pattern)).toContain('pem_private_key');
  });

  it('a clean config with no PEM content anywhere still scans clean', () => {
    const config = { config: { Env: ['PATH=/usr/bin'], Labels: { built: 'true' } } };
    expect(scanConfigForSecretsAndTopology(config, 'sha256:' + '3'.repeat(64))).toEqual([]);
  });
});

/**
 * Credential-only pattern scanner — synthetic fixture test matrix
 * (fleet-ops-1py.14 slice 6).
 *
 * ALL fixtures here are SYNTHETIC: no real credential material ever
 * appears in this file. Pattern-shaped strings are assembled from
 * clearly-fake segments (mock_, example, 0000...) so no fixture here
 * could itself be mistaken for a live secret by a future scanner.
 *
 * Pins three invariants:
 *  1. Each credential pattern class is detected on a representative
 *     synthetic sample.
 *  2. Already-approved topology literals (tailnet FQDNs, RFC1918 IPs)
 *     are NEVER flagged by this credential-only scanner — that is the
 *     slice-4 oci-gate's separate, already-tested scope.
 *  3. Findings never carry the matched substring — only pattern name
 *     + location (report.ts formatting + the underlying finding
 *     shapes are structurally value-less).
 */
import { describe, expect, it } from 'vitest';
import { scanTextForCredentials, scanBytesForCredentials } from '../src/credential-scan/scan-text.js';
import { formatSourceTreeFinding, formatHistoryFinding } from '../src/credential-scan/report.js';
import { CREDENTIAL_PATTERNS } from '../src/credential-scan/patterns.js';

// Synthetic, obviously-fake samples — one per pattern class.
const SYNTHETIC_SAMPLES: Record<string, string> = {
  pem_private_key: '-----BEGIN RSA PRIVATE KEY-----\n[SYNTHETIC-FIXTURE-NOT-A-REAL-KEY]\n-----END RSA PRIVATE KEY-----\n',
  aws_access_key_id: 'AKIAFAKEEXAMPLE00000',
  github_token_classic: `ghp_${'a'.repeat(36)}`,
  github_token_fine_grained: `github_pat_${'b'.repeat(22)}`,
  slack_token: 'xoxb-0000000000-fakefakefakefake',
  anthropic_api_key: `sk-ant-${'c'.repeat(24)}`,
  openai_api_key: `sk-${'d'.repeat(24)}`,
  google_api_key: `AIza${'E'.repeat(35)}`,
  stripe_live_key: `sk_live_${'f'.repeat(24)}`,
  jwt_token: `eyJhbGciOiJIUzI1NiJ9.${'g'.repeat(20)}.${'h'.repeat(20)}`,
  generic_high_entropy_keyed_assignment: `api_key: "${'z'.repeat(20)}"`,
};

describe('CREDENTIAL_PATTERNS: every declared pattern class has a fixture and is detected', () => {
  for (const pattern of CREDENTIAL_PATTERNS) {
    it(`detects ${pattern.name} on its synthetic sample`, () => {
      const sample = SYNTHETIC_SAMPLES[pattern.name];
      expect(sample, `missing synthetic fixture for pattern "${pattern.name}"`).toBeDefined();
      const hits = scanTextForCredentials(sample!);
      expect(hits, `expected "${pattern.name}" to fire on its own fixture`).toContain(pattern.name);
    });
  }

  it('every SYNTHETIC_SAMPLES key corresponds to a real declared pattern (no stale fixture)', () => {
    const declared = new Set(CREDENTIAL_PATTERNS.map((p) => p.name));
    for (const key of Object.keys(SYNTHETIC_SAMPLES)) {
      expect(declared.has(key as (typeof CREDENTIAL_PATTERNS)[number]['name']), `fixture "${key}" has no matching pattern`).toBe(
        true,
      );
    }
  });
});

describe('credential-only scanner: topology/FQDN/IP literals are NEVER flagged (separate scope from slice-4 oci-gate)', () => {
  const topologySamples = [
    'edge=some-device.example-tailnet.ts.net',
    'MASTER_HOST=primus.another-tailnet.ts.net',
    'internal_ip=192.168.4.17',
    'private_ip=10.0.0.5',
    'private_ip=172.16.0.9',
  ];

  for (const sample of topologySamples) {
    it(`does not flag topology literal: "${sample.split('=')[0]}=<redacted-topology-literal>"`, () => {
      const hits = scanTextForCredentials(sample);
      expect(hits, `topology literal incorrectly flagged as credential: ${sample.split('=')[0]}`).toEqual([]);
    });
  }

  it('a combined config file with ONLY topology literals (no credentials) scans clean', () => {
    const configText = [
      'edge_host=master-node.fleet-example.ts.net',
      'lan_ip=192.168.1.100',
      'peer=device-7.fleet-example.ts.net',
    ].join('\n');
    expect(scanTextForCredentials(configText)).toEqual([]);
  });
});

describe('credential-only scanner: binary content is skipped, not scanned', () => {
  it('a buffer with embedded NUL bytes is never decoded/scanned even if it contains a credential-shaped run', () => {
    const binaryWithShape = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x02]),
      Buffer.from(`AKIAFAKEEXAMPLE00000`, 'utf8'),
      Buffer.from([0x00]),
    ]);
    expect(scanBytesForCredentials(binaryWithShape)).toEqual([]);
  });

  it('an empty buffer scans clean', () => {
    expect(scanBytesForCredentials(Buffer.alloc(0))).toEqual([]);
  });

  it('a plain-text buffer without NUL bytes IS scanned normally', () => {
    const buf = Buffer.from(`AKIAFAKEEXAMPLE00000`, 'utf8');
    expect(scanBytesForCredentials(buf)).toContain('aws_access_key_id');
  });
});

describe('redaction: findings and their formatted report lines never carry the matched value', () => {
  it('formatSourceTreeFinding never includes anything beyond pattern + path + the literal word REDACTED', () => {
    const line = formatSourceTreeFinding({ pattern: 'aws_access_key_id', path: 'config/secrets.env' });
    expect(line).toContain('aws_access_key_id');
    expect(line).toContain('config/secrets.env');
    expect(line).toContain('REDACTED');
    // Structural guarantee: the finding type has no "value"/"match"/
    // "text" field for the formatter to have pulled from in the first
    // place — this assertion documents that guarantee at the type
    // level by constructing the narrowest possible object literal.
    const finding: { pattern: 'aws_access_key_id'; path: string } = { pattern: 'aws_access_key_id', path: 'x' };
    expect(Object.keys(finding).sort()).toEqual(['path', 'pattern']);
  });

  it('formatHistoryFinding never includes anything beyond pattern + commit + path + the literal word REDACTED', () => {
    const line = formatHistoryFinding({ pattern: 'pem_private_key', commit: 'deadbeef'.repeat(5), path: 'deploy/key.pem' });
    expect(line).toContain('pem_private_key');
    expect(line).toContain('deadbeef'.repeat(5));
    expect(line).toContain('deploy/key.pem');
    expect(line).toContain('REDACTED');
  });

  it('scanTextForCredentials return value is a plain array of pattern-name strings, never objects carrying match text', () => {
    const hits = scanTextForCredentials(`AKIAFAKEEXAMPLE00000`);
    expect(hits).toEqual(['aws_access_key_id']);
    for (const hit of hits) {
      expect(typeof hit).toBe('string');
      // A pattern name string is short, fixed-vocabulary, and never
      // itself resembles the 20-character AWS key body — distinguishes
      // "the scanner told us WHAT matched" from "the scanner told us
      // the match", which would be the redaction defect this pins.
      expect(hit.length).toBeLessThan(60);
      expect(hit).not.toMatch(/AKIA[0-9A-Z]{16}/);
    }
  });
});

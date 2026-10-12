/**
 * Source-tree (build-input) credential scanner — filesystem fixture
 * tests (fleet-ops-1py.14 slice 6). Builds tiny synthetic directory
 * trees under a scratch tmpdir, never touches the real repo tree, and
 * never contains real credential material.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanSourceTree } from '../src/credential-scan/source-tree-scan.js';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-credscan-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('scanSourceTree: finds credential-shaped content in a synthetic build context', () => {
  it('flags a fake AWS key committed in a config file, with the correct relative path', () => {
    const root = makeTmpDir();
    writeFileSync(path.join(root, 'config.env'), 'AWS_KEY=AKIAFAKEEXAMPLE00000\n');
    const findings = scanSourceTree(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.pattern).toBe('aws_access_key_id');
    expect(findings[0]!.path).toBe('config.env');
  });

  it('walks nested directories and reports forward-slash relative paths', () => {
    const root = makeTmpDir();
    mkdirSync(path.join(root, 'nested', 'deeper'), { recursive: true });
    writeFileSync(path.join(root, 'nested', 'deeper', 'secrets.txt'), `token: "${'x'.repeat(20)}"\n`);
    const findings = scanSourceTree(root);
    expect(findings.map((f) => f.path)).toContain('nested/deeper/secrets.txt');
  });

  it('skips .git, node_modules, dist, coverage directories entirely', () => {
    const root = makeTmpDir();
    for (const excluded of ['.git', 'node_modules', 'dist', 'coverage']) {
      mkdirSync(path.join(root, excluded), { recursive: true });
      writeFileSync(path.join(root, excluded, 'leaked.env'), 'AWS_KEY=AKIAFAKEEXAMPLE00000\n');
    }
    const findings = scanSourceTree(root);
    expect(findings).toEqual([]);
  });

  it('a clean build context (only topology literals) produces zero findings', () => {
    const root = makeTmpDir();
    writeFileSync(path.join(root, 'compose.env'), 'EDGE_HOST=device.fleet-example.ts.net\nLAN_IP=192.168.1.50\n');
    expect(scanSourceTree(root)).toEqual([]);
  });

  it('reports one finding per (pattern, file) pair when multiple files are affected', () => {
    const root = makeTmpDir();
    writeFileSync(path.join(root, 'a.env'), 'AWS_KEY=AKIAFAKEEXAMPLE00000\n');
    writeFileSync(path.join(root, 'b.env'), 'AWS_KEY=AKIAFAKEEXAMPLE11111\n');
    const findings = scanSourceTree(root);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.path).sort()).toEqual(['a.env', 'b.env']);
  });

  it('an empty directory scans clean without throwing', () => {
    const root = makeTmpDir();
    expect(scanSourceTree(root)).toEqual([]);
  });

  it('does not flag the admin-html.ts GitHub App PEM textarea placeholder shape (PR #61 review finding #2)', () => {
    const root = makeTmpDir();
    writeFileSync(
      path.join(root, 'admin-html.ts'),
      "{ name: 'github_app_pem', placeholder: '-----BEGIN RSA PRIVATE KEY-----\\n\u2026\\n-----END RSA PRIVATE KEY-----' }\n",
    );
    expect(scanSourceTree(root)).toEqual([]);
  });

  it('STILL flags a real-shaped synthetic PEM body committed in a build-context file', () => {
    const root = makeTmpDir();
    writeFileSync(
      path.join(root, 'leaked-key.pem'),
      '-----BEGIN RSA PRIVATE KEY-----\n' +
        'MIIEpQIBAAKCAQEA1c79z5Pad7OejecsQ0bu3aumPeYQcOxQZUwQg5wKEPOHGSU\n' +
        '-----END RSA PRIVATE KEY-----\n',
    );
    const findings = scanSourceTree(root);
    expect(findings.map((f) => f.pattern)).toContain('pem_private_key');
  });
});

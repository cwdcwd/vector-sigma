import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * scripts/publish-image.sh must publish an index that is EXACTLY the two
 * scanned image manifests (PR #97 review): one linux/amd64 + one linux/arm64
 * descriptor, each the scanned digest for its platform. Containment is not
 * enough — an extra descriptor would make an unscanned image reachable
 * through the published index. Every rejection must happen before any
 * registry call: a stub `regctl` records whether it was ever invoked.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '../../scripts/publish-image.sh');
const C = 'demo';
const AMD = `sha256:${'a'.repeat(64)}`;
const ARM = `sha256:${'b'.repeat(64)}`;
const EXTRA = `sha256:${'c'.repeat(64)}`;
const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

const desc = (digest: string, architecture: string, mediaType = MANIFEST) => ({
  mediaType,
  digest,
  size: 1,
  platform: { architecture, os: 'linux' },
});

let dir: string;
let calls: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'publish-image-'));
  for (const sub of ['bin', 'layouts', 'descriptors', 'empty']) mkdirSync(path.join(dir, sub));
  calls = path.join(dir, 'regctl-calls.log');
  // Stub regctl: log the call, then fail so a passing guard stops at the
  // first registry operation (the test only needs to see it was reached).
  writeFileSync(path.join(dir, 'bin', 'regctl'), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 1\n`);
  chmodSync(path.join(dir, 'bin', 'regctl'), 0o755);
  for (const [arch, digest] of [['amd64', AMD], ['arm64', ARM]] as const) {
    writeFileSync(
      path.join(dir, 'descriptors', `${C}-${arch}.descriptor.json`),
      JSON.stringify({ component: C, manifestDescriptor: desc(digest, arch) }),
    );
    execFileSync('tar', ['-cf', path.join(dir, 'layouts', `${C}-${arch}.tar`), '-C', path.join(dir, 'empty'), '.']);
  }
});

function run(index: unknown) {
  const indexFile = path.join(dir, 'index.json');
  writeFileSync(indexFile, typeof index === 'string' ? index : JSON.stringify(index));
  const res = spawnSync(
    'bash',
    [
      SCRIPT,
      '--component', C,
      '--registry', 'registry.invalid',
      '--repository', `owner/repo/${C}`,
      '--tag', 'deadbeef',
      '--layouts', path.join(dir, 'layouts'),
      '--descriptors', path.join(dir, 'descriptors'),
      '--index', indexFile,
      '--record', path.join(dir, 'record.json'),
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` } },
  );
  const regctlCalls = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  return { status: res.status, output: `${res.stdout}${res.stderr}`, regctlCalls };
}

const index = (manifests: unknown[]) => ({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests });

describe('publish-image.sh: the index must be exactly the two scanned manifests', () => {
  it('rejects an index with an EXTRA, unscanned descriptor — before any registry call', () => {
    const r = run(index([desc(AMD, 'amd64'), desc(ARM, 'arm64'), desc(EXTRA, 'amd64')]));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('expected exactly 2 descriptors, found 3');
    expect(r.regctlCalls).toBe('');
    expect(existsSync(path.join(dir, 'record.json'))).toBe(false);
  });

  it('rejects swapped platform digests', () => {
    const r = run(index([desc(ARM, 'amd64'), desc(AMD, 'arm64')]));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('linux/amd64 descriptor is');
    expect(r.regctlCalls).toBe('');
  });

  it('rejects a duplicate platform in place of the other', () => {
    const r = run(index([desc(AMD, 'amd64'), desc(AMD, 'amd64')]));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('duplicate linux/amd64');
    expect(r.regctlCalls).toBe('');
  });

  it('rejects an unexpected platform', () => {
    const r = run(index([desc(AMD, 'amd64'), desc(ARM, 's390x')]));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('unexpected platform linux/s390x');
    expect(r.regctlCalls).toBe('');
  });

  it('rejects a descriptor that is not an image manifest (e.g. a nested index)', () => {
    const r = run(index([desc(AMD, 'amd64'), desc(ARM, 'arm64', 'application/vnd.oci.image.index.v1+json')]));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('is not an image manifest');
    expect(r.regctlCalls).toBe('');
  });

  it('rejects a document that is not an OCI index', () => {
    const r = run({ schemaVersion: 2, mediaType: MANIFEST, manifests: [desc(AMD, 'amd64'), desc(ARM, 'arm64')] });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('is not an OCI index');
    expect(r.regctlCalls).toBe('');
  });

  it('accepts exactly the two scanned manifests and proceeds to the digest copy', () => {
    const r = run(index([desc(ARM, 'arm64'), desc(AMD, 'amd64')]));
    // The stub fails the first registry call; reaching it is the point.
    expect(r.regctlCalls).toMatch(/^image copy ocidir:\/\/.+@sha256:a{64} registry\.invalid\/owner\/repo\/demo@sha256:a{64}/);
  });
});

/**
 * filterExcusedFindings (src/oci-gate/allowlist.ts): which files are even eligible for an
 * allowlist excuse. Anything it cannot re-read as text must keep its finding (fail closed);
 * the real-image excuse cases live in oci-allowlist-real-images.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { filterExcusedFindings } from '../src/oci-gate/allowlist.js';
import type { LayerEntry } from '../src/oci-gate/layer-walk.js';
import type { ScanFinding } from '../src/oci-gate/secret-scan.js';

const SECRET = 'AKIA' + 'ABCDEFGHIJKLMNOP'; // aws_access_key_id shape, split so this file never matches itself
const entry = (name: string, data: Buffer | string, over: Partial<LayerEntry> = {}): LayerEntry => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { name, type: '0', size: buf.length, data: buf, linkname: '', layerIndex: 0, layerDigest: 'sha256:00', deleted: false, isWhiteoutMarker: false, ...over };
};
const finding = (path: string, pattern = 'aws_access_key_id'): ScanFinding => ({
  kind: 'secret', pattern, path, layerIndex: 0, layerDigest: 'sha256:00', deleted: false,
});

describe('filterExcusedFindings: fail-closed eligibility', () => {
  it('no findings in, none out (and no work)', () => {
    expect(filterExcusedFindings([entry('a', SECRET)], [])).toEqual([]);
  });

  it('a text file no allowlist entry covers keeps its finding', () => {
    const f = [finding('opt/app/creds.txt')];
    expect(filterExcusedFindings([entry('opt/app/creds.txt', `key=${SECRET}\n`)], f)).toEqual(f);
  });

  it.each([
    ['a binary file (NUL in the first 8000 bytes)', entry('bin/tool', Buffer.concat([Buffer.from(SECRET), Buffer.from([0])]))],
    ['a whiteout marker', entry('etc/.wh.creds', SECRET, { isWhiteoutMarker: true })],
    ['a symlink', entry('etc/creds', SECRET, { type: '2' })],
    ['an empty file', entry('etc/creds', '')],
  ])('%s is never re-read for an excuse, so its finding stays', (_label, e) => {
    const f = [finding(e.name)];
    expect(filterExcusedFindings([e], f)).toEqual(f);
  });

  it('a finding for a path with no entry at all stays', () => {
    const f = [finding('missing/path')];
    expect(filterExcusedFindings([entry('other', 'x')], f)).toEqual(f);
  });

  it('an unknown pattern name is never excused', () => {
    const f = [finding('opt/app/creds.txt', 'no_such_pattern')];
    expect(filterExcusedFindings([entry('opt/app/creds.txt', SECRET)], f)).toEqual(f);
  });
});

describe('npm ip-address@10.5.0 dist/common.js (byte-identity provenance)', () => {
  // The real file is excused only by its exact upstream bytes (sha256 pin); the base-image
  // integration (scotty on node 26.12.1) proves the positive case. Any edit to the file, even one
  // that keeps the same allowed literal, falls outside the pin and keeps its finding.
  it('a same-path file with different bytes is not excused', () => {
    const text = '/**\n * `10.0.0.0/8` is not in `10.0.0.0/16`.\n */\nfunction isInSubnet(address) {}\n';
    const path = 'usr/local/lib/node_modules/npm/node_modules/ip-address/dist/common.js';
    const f = [finding(path, 'rfc1918_private_ip')];
    expect(filterExcusedFindings([entry(path, text)], f)).toEqual(f);
  });
});

/**
 * The image gate's ustar/PAX reader (src/oci-gate/tar.ts), tested directly. Every layer's
 * secret scan reads entry.data from this parser, so any disagreement between it and Docker's
 * reader (Go archive/tar) about where an entry's bytes are is a way to hide content from the
 * gate. Fixtures are built with the module's own buildTar plus byte-level header edits.
 */
import { describe, expect, it } from 'vitest';
import { buildTar, parseTar } from '../src/oci-gate/tar.js';

const BLOCK = 512;
const padded = (n: number) => Math.ceil(n / BLOCK) * BLOCK;

/** One PAX record: "<len> <key>=<value>\n", where <len> counts the whole record including itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return Buffer.from(`${len}${body}`);
}

/** Overwrite a header's 12-byte size field (offset 124) with an octal value. */
function setHeaderSize(tar: Buffer, headerOffset: number, size: number): void {
  Buffer.from(size.toString(8).padStart(11, '0') + '\0', 'ascii').copy(tar, headerOffset + 124);
}

describe('parseTar: plain ustar', () => {
  it('round-trips files and directories in archive order', () => {
    const tar = buildTar([
      { name: 'etc/', type: '5' },
      { name: 'etc/app.conf', data: Buffer.from('k=v\n') },
      { name: 'empty' },
    ]);
    const entries = parseTar(tar);
    expect(entries.map((e) => [e.name, e.type, e.size])).toEqual([
      ['etc/', '5', 0],
      ['etc/app.conf', '0', 4],
      ['empty', '0', 0],
    ]);
    expect(entries[1]!.data.toString()).toBe('k=v\n');
  });

  it('a body that fills exactly one block leaves no padding to skip', () => {
    const body = Buffer.alloc(BLOCK, 0x61);
    const entries = parseTar(buildTar([{ name: 'a', data: body }, { name: 'b', data: Buffer.from('x') }]));
    expect(entries.map((e) => e.name)).toEqual(['a', 'b']);
    expect(entries[0]!.data.equals(body)).toBe(true);
  });

  it('stops at the two-zero-block end marker; a single zero block is skipped', () => {
    const a = buildTar([{ name: 'a', data: Buffer.from('1') }]).subarray(0, BLOCK * 2); // header + body, no end marker
    const b = buildTar([{ name: 'b', data: Buffer.from('2') }]);
    const tar = Buffer.concat([a, Buffer.alloc(BLOCK), b]);
    expect(parseTar(tar).map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('joins the ustar prefix field onto the name', () => {
    const tar = buildTar([{ name: 'leaf.txt', data: Buffer.from('x') }]);
    tar.write('deep/dir', 345, 'utf8');
    expect(parseTar(tar)[0]!.name).toBe('deep/dir/leaf.txt');
  });

  it('surfaces non-regular typeflags with their link target', () => {
    const tar = buildTar([{ name: 'link', type: '2' }]);
    tar.write('/etc/shadow', 157, 'utf8');
    expect(parseTar(tar)[0]).toMatchObject({ name: 'link', type: '2', linkname: '/etc/shadow' });
  });
});

describe('parseTar: size field encodings', () => {
  it('reads GNU base-256 sizes (top bit set)', () => {
    const tar = buildTar([{ name: 'big', data: Buffer.from('hello') }]);
    const field = Buffer.alloc(12);
    field[0] = 0x80;
    field[11] = 5;
    field.copy(tar, 124);
    expect(parseTar(tar)[0]).toMatchObject({ name: 'big', size: 5 });
    expect(parseTar(tar)[0]!.data.toString()).toBe('hello');
  });

  it('an all-NUL size field reads as zero', () => {
    const tar = buildTar([{ name: 'z' }]);
    Buffer.alloc(12).copy(tar, 124);
    expect(parseTar(tar)[0]!.size).toBe(0);
  });

  it('a non-octal size field throws instead of guessing', () => {
    const tar = buildTar([{ name: 'bad', data: Buffer.from('x') }]);
    tar.write('9999zzzz', 124, 'ascii');
    expect(() => parseTar(tar)).toThrow(/malformed octal/);
  });

  it('a declared size past the end of the archive throws (no silent partial entry)', () => {
    const tar = buildTar([{ name: 'trunc', data: Buffer.from('abc') }]);
    setHeaderSize(tar, 0, 10 * BLOCK);
    expect(() => parseTar(tar)).toThrow(/truncated entry body for "trunc"/);
  });
});

describe('parseTar: GNU long names and PAX headers', () => {
  it('a GNU L entry renames the next entry only', () => {
    const long = `${'d/'.repeat(80)}file.txt`;
    const entries = parseTar(
      buildTar([
        { name: '././@LongLink', type: 'L', data: Buffer.from(`${long}\0`) },
        { name: 'truncated-name', data: Buffer.from('x') },
        { name: 'next', data: Buffer.from('y') },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual([long, 'next']);
  });

  it('a PAX path overrides the next entry only', () => {
    const entries = parseTar(
      buildTar([
        { name: 'PaxHeader', type: 'x', data: paxRecord('path', 'real/path.txt') },
        { name: 'short', data: Buffer.from('x') },
        { name: 'after', data: Buffer.from('y') },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual(['real/path.txt', 'after']);
  });

  it('malformed PAX records are ignored without throwing', () => {
    const entries = parseTar(
      buildTar([
        { name: 'PaxHeader', type: 'x', data: Buffer.from('0 path=x\nnot-a-record') },
        { name: 'kept', data: Buffer.from('x') },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual(['kept']);
  });

  it('a PAX size governs where the entry body ends, exactly as Docker reads it', () => {
    // Crafted layer: the ustar size field says 0 but the PAX record says N. Docker's reader uses N
    // and extracts the real body. If the gate used the ustar 0, it would scan an empty file and
    // treat the body (here, a decoy tar with its own end marker) as more headers. The payload
    // would then never be scanned.
    const payload = Buffer.from('-----BEGIN PRIVATE KEY-----\nhidden\n');
    const decoy = buildTar([{ name: 'innocent.txt', data: Buffer.from('nothing to see') }]);
    const body = Buffer.concat([decoy, payload]);
    const tar = buildTar([
      { name: 'PaxHeader', type: 'x', data: paxRecord('size', String(body.length)) },
      { name: 'evil', data: body },
    ]);
    const evilHeader = BLOCK + padded(paxRecord('size', String(body.length)).length);
    setHeaderSize(tar, evilHeader, 0);

    const entries = parseTar(tar);
    expect(entries.map((e) => e.name)).toEqual(['evil']);
    expect(entries[0]!.size).toBe(body.length);
    expect(entries[0]!.data.equals(body)).toBe(true);
  });

  it('a PAX size past the end of the archive throws', () => {
    const tar = buildTar([
      { name: 'PaxHeader', type: 'x', data: paxRecord('size', String(50 * BLOCK)) },
      { name: 'evil', data: Buffer.from('x') },
    ]);
    expect(() => parseTar(tar)).toThrow(/truncated entry body for "evil"/);
  });

  it('a non-numeric PAX size throws instead of falling back to the header size', () => {
    const tar = buildTar([
      { name: 'PaxHeader', type: 'x', data: paxRecord('size', '12abc') },
      { name: 'evil', data: Buffer.from('x') },
    ]);
    expect(() => parseTar(tar)).toThrow(/malformed PAX size/);
  });
});

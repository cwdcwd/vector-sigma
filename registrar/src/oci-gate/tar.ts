/**
 * Minimal POSIX ustar/PAX tar reader + writer (fleet-ops-1py.14 slice 4).
 *
 * No `tar` npm dependency exists in this workspace (registrar runs
 * stdlib-only); Docker's OCI-layout exports and gzip layer tars are
 * ustar/PAX archives, so a small, well-scoped reader covers both the
 * outer layout tar and every layer tar. The writer exists ONLY to
 * build synthetic fixtures in tests — never used against real image
 * bytes.
 *
 * Supported typeflags: '0'/'\0' (regular file), '5' (directory),
 * 'L' (GNU long name — the next header's name is overridden by this
 * entry's data), 'x'/'g' (PAX extended header — 'path' and 'size'
 * keys override the next header). Anything else (symlink, hardlink,
 * device, fifo) is surfaced with its raw typeflag so callers can
 * decide (whiteout detection only cares about the NAME).
 */

export interface TarEntry {
  name: string;
  type: string;
  size: number;
  data: Buffer;
  linkname: string;
}

const BLOCK_SIZE = 512;

function readOctal(buf: Buffer, start: number, len: number): number {
  const raw = buf.subarray(start, start + len);
  // GNU base-256 encoding: top bit of the first byte set.
  if (raw.length > 0 && (raw[0]! & 0x80) !== 0) {
    let value = BigInt(raw[0]! & 0x7f);
    for (let i = 1; i < raw.length; i++) {
      value = (value << 8n) | BigInt(raw[i]!);
    }
    return Number(value);
  }
  const str = raw.toString('ascii').replace(/\0.*$/, '').trim();
  if (str === '') return 0;
  const n = parseInt(str, 8);
  if (Number.isNaN(n)) {
    throw new Error(`tar: malformed octal field at offset ${start}`);
  }
  return n;
}

function readString(buf: Buffer, start: number, len: number): string {
  const raw = buf.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return (nul === -1 ? raw : raw.subarray(0, nul)).toString('utf8');
}

function isZeroBlock(buf: Buffer, offset: number): boolean {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (buf[offset + i] !== 0) return false;
  }
  return true;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    let sp = data.indexOf(0x20, pos);
    if (sp === -1) break;
    const lenStr = data.subarray(pos, sp).toString('ascii');
    const recLen = parseInt(lenStr, 10);
    if (!Number.isFinite(recLen) || recLen <= 0) break;
    const record = data.subarray(pos, pos + recLen).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1) {
      const key = record.slice(sp - pos + 1, eq);
      const value = record.slice(eq + 1).replace(/\n$/, '');
      out[key] = value;
    }
    pos += recLen;
  }
  return out;
}

/**
 * Parses a ustar/PAX tar byte stream into entries, in archive order.
 * Throws ContentGate-shaped malformed-archive errors on truncated or
 * unreadable headers — never silently drops a trailing partial entry
 * (that is how a corrupt/truncated-layer attack would hide content).
 */
export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingLongName: string | undefined;
  let pendingPax: Record<string, string> | undefined;
  let consecutiveZeroBlocks = 0;

  while (offset + BLOCK_SIZE <= buf.length) {
    if (isZeroBlock(buf, offset)) {
      consecutiveZeroBlocks++;
      offset += BLOCK_SIZE;
      if (consecutiveZeroBlocks >= 2) break;
      continue;
    }
    consecutiveZeroBlocks = 0;

    const header = buf.subarray(offset, offset + BLOCK_SIZE);
    let name = readString(header, 0, 100);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    let size = readOctal(header, 124, 12);
    const linkname = readString(header, 157, 100);
    const prefix = readString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;

    // A PAX 'size' record governs where THIS entry's body ends, exactly as Docker's reader
    // (Go archive/tar) applies it. It must be applied before the body is sliced: reading the
    // body with the ustar size field instead would let a crafted layer (ustar size 0, PAX size N)
    // hide N bytes from the scan. Those bytes would be parsed as further headers (a decoy
    // archive), while Docker extracts them as the file. A non-numeric PAX size fails closed.
    if (typeflag !== 'L' && typeflag !== 'x' && typeflag !== 'g' && pendingPax?.size !== undefined) {
      if (!/^\d+$/.test(pendingPax.size)) {
        throw new Error(`tar: malformed PAX size ${JSON.stringify(pendingPax.size)} for "${name}"`);
      }
      size = Number(pendingPax.size);
    }

    offset += BLOCK_SIZE;
    const dataStart = offset;
    const dataLen = size;
    const paddedLen = Math.ceil(dataLen / BLOCK_SIZE) * BLOCK_SIZE;
    if (dataStart + dataLen > buf.length) {
      throw new Error(`tar: truncated entry body for "${name}" (declared size ${dataLen} exceeds remaining archive bytes)`);
    }
    const data = buf.subarray(dataStart, dataStart + dataLen);
    offset = dataStart + paddedLen;

    if (typeflag === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      pendingPax = { ...(pendingPax ?? {}), ...parsePax(Buffer.from(data)) };
      continue;
    }

    if (pendingLongName !== undefined) {
      name = pendingLongName;
      pendingLongName = undefined;
    }
    if (pendingPax?.path) {
      name = pendingPax.path;
    }
    pendingPax = undefined;

    entries.push({ name, type: typeflag, size, data: Buffer.from(data), linkname });
  }

  return entries;
}

function writeOctal(value: number, len: number): Buffer {
  const str = value.toString(8).padStart(len - 1, '0');
  const buf = Buffer.alloc(len);
  buf.write(str, 'ascii');
  buf[len - 1] = 0;
  return buf;
}

function writeHeaderField(header: Buffer, start: number, len: number, value: string): void {
  header.write(value, start, len, 'utf8');
}

/**
 * Builds a ustar tar archive from entries. TEST-FIXTURE USE ONLY — the
 * gate never writes image bytes back out; this exists so the
 * synthetic-fixture test matrix can construct tiny fake layer/layout
 * tars without shelling out to a real `tar` binary.
 */
export function buildTar(entries: Array<{ name: string; type?: string; data?: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const type = entry.type ?? '0';
    const header = Buffer.alloc(BLOCK_SIZE);
    writeHeaderField(header, 0, 100, entry.name);
    header.write('0000644', 100, 7, 'ascii');
    header[107] = 0;
    header.write('0000000', 108, 7, 'ascii');
    header[115] = 0;
    header.write('0000000', 116, 7, 'ascii');
    header[123] = 0;
    writeOctal(data.length, 12).copy(header, 124);
    writeOctal(0, 12).copy(header, 136);
    header[156] = type.charCodeAt(0);
    header.write('ustar', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');

    // checksum: header with the checksum field as spaces
    const checksumField = Buffer.alloc(8, 0x20);
    checksumField.copy(header, 148);
    let sum = 0;
    for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i]!;
    writeOctal(sum, 7).copy(header, 148);
    header[155] = 0;

    chunks.push(header);
    if (data.length > 0) {
      chunks.push(data);
      const pad = Math.ceil(data.length / BLOCK_SIZE) * BLOCK_SIZE - data.length;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

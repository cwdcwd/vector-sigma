/**
 * Source-tree (build-input) credential scanner (fleet-ops-1py.14
 * slice 6). Walks a directory recursively and scans every regular
 * file's bytes for credential-shaped patterns — this is the CI gate's
 * scan surface: the Docker build-context source trees the publisher
 * workflows pass to `docker buildx build`, i.e. the actual build-input
 * artifact class on this repo (no docker/buildx dependency is needed
 * to read the same files docker would COPY into a layer).
 *
 * Deliberately credential-only: this module imports nothing from
 * registrar/src/oci-gate (the slice-4 topology/secret scanner for
 * already-built image layers) and never flags a tailnet FQDN, an
 * RFC1918 IP, or any other topology literal — those stay the slice-4
 * gate's exclusive concern.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { scanBytesForCredentials } from './scan-text.js';
import type { SourceTreeFinding } from './report.js';

const DEFAULT_EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.beads']);

export interface ScanSourceTreeOptions {
  /** Directory basenames to skip entirely (in addition to the defaults). */
  excludeDirs?: string[];
}

function walk(root: string, dir: string, excludeDirs: Set<string>, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (excludeDirs.has(name)) continue;
      walk(root, full, excludeDirs, out);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
}

/**
 * Scans every regular file under `rootDir`. Returns one finding per
 * (pattern, file) pair — never the matched value, never a byte offset
 * into the file.
 *
 * `rootDir` may also be a single regular file (an image's COPY input
 * list mixes files and directories): that file alone is scanned and
 * findings carry its basename. A path that is neither throws — an
 * unreadable input must never read as a clean scan.
 */
export function scanSourceTree(rootDir: string, opts: ScanSourceTreeOptions = {}): SourceTreeFinding[] {
  const excludeDirs = new Set([...DEFAULT_EXCLUDE_DIRS, ...(opts.excludeDirs ?? [])]);
  const files: string[] = [];
  const rootStat = statSync(rootDir);
  if (rootStat.isFile()) {
    files.push(rootDir);
    rootDir = path.dirname(rootDir);
  } else if (rootStat.isDirectory()) {
    walk(rootDir, rootDir, excludeDirs, files);
  } else {
    throw new Error(`scanSourceTree: ${rootDir} is neither a file nor a directory`);
  }

  const findings: SourceTreeFinding[] = [];
  for (const filePath of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch {
      continue;
    }
    const hits = scanBytesForCredentials(bytes);
    if (hits.length === 0) continue;
    const relPath = path.relative(rootDir, filePath).split(path.sep).join('/');
    for (const pattern of hits) {
      findings.push({ pattern, path: relPath });
    }
  }
  return findings;
}

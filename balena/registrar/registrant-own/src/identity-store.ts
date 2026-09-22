import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IdentityBundleSchema, type IdentityBundle } from '@vector-sigma/shared';

/** Name of the delivered bundle snapshot on the data volume. */
export const BUNDLE_FILE = 'identity-bundle.json';
/** Ready marker the agent entrypoint blocks on. */
export const READY_MARKER = 'ready.marker';

/**
 * Identity store on the shared data volume. Delivered bundles are
 * applied atomically: whole-bundle validation first, then every file
 * written tmp+rename with mode 0600 — a refused/partial bundle is
 * never partially applied.
 */
export class IdentityStore {
  constructor(private readonly dataDir: string) {}

  bundlePath(): string {
    return path.join(this.dataDir, BUNDLE_FILE);
  }

  markerPath(): string {
    return path.join(this.dataDir, READY_MARKER);
  }

  /** Parse + validate the on-disk bundle snapshot. Null when absent. */
  async readBundle(): Promise<IdentityBundle | null> {
    let raw: string;
    try {
      raw = await readFile(this.bundlePath(), 'utf8');
    } catch {
      return null;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = IdentityBundleSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  }

  /** The ready marker contents, when present. Null when absent. */
  async readMarker(): Promise<string | null> {
    try {
      return await readFile(this.markerPath(), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Apply a delivered bundle: validate everything first, then write
   * all files (each tmp+rename, mode 0600), then the bundle snapshot,
   * then the ready marker. Throws on any validation failure without
   * touching the data dir — refused bundles are never partially
   * applied.
   */
  async applyBundle(bundle: IdentityBundle): Promise<void> {
    // Whole-bundle validation BEFORE any write.
    const parsed = IdentityBundleSchema.safeParse(bundle);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new Error(`bundle rejected: ${issues}`);
    }
    // Defense in depth: resolve containment under dataDir.
    const root = path.resolve(this.dataDir);
    for (const f of parsed.data.files) {
      const resolved = path.resolve(root, f.path);
      if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        throw new Error(`bundle rejected: unsafe path ${f.path}`);
      }
    }

    // Stage UNDER the data dir: staging and final targets must share one
    // filesystem or the tmp+rename apply dies EXDEV (rename(2) cannot cross
    // devices — dataDir is a volume in real deployments, os.tmpdir() is not).
    const staging = await mkdtemp(path.join(root, '.staging-'));
    try {
      for (const [i, f] of parsed.data.files.entries()) {
        const target = path.join(root, f.path);
        const tmp = path.join(staging, `file-${i}`);
        await writeFile(tmp, f.content, { mode: 0o600 });
        await mkdir(path.dirname(target), { recursive: true });
        await rename(tmp, target);
      }
      // Bundle snapshot (same authoritative payload) next.
      const tmpBundle = path.join(staging, 'bundle');
      await writeFile(tmpBundle, JSON.stringify(parsed.data, null, 2), { mode: 0o600 });
      await rename(tmpBundle, this.bundlePath());
      // Ready marker last: its presence means identity is complete.
      const tmpMarker = path.join(staging, 'marker');
      await writeFile(tmpMarker, `bundle_version=${parsed.data.bundle_version}\n`, { mode: 0o600 });
      await rename(tmpMarker, this.markerPath());
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Verify the ready marker exists (agent gate helper). */
  async isReady(): Promise<boolean> {
    try {
      await stat(this.markerPath());
      return true;
    } catch {
      return false;
    }
  }
}
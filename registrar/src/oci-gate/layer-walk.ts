/**
 * Layer walking with OCI whiteout handling (fleet-ops-1py.14 slice 4).
 *
 * Decompresses each layer blob (gzip or plain tar — both mediaTypes
 * the OCI spec allows for layers) and parses its tar entries. OCI
 * whiteout convention: a file named `.wh.<basename>` in a directory
 * marks `<basename>` as deleted by this layer; `.wh..wh..opq` marks
 * the directory itself as "opaque" (everything beneath it in lower
 * layers is hidden from the merged view).
 *
 * CRITICAL CONTRACT: this module exists to WALK every layer's raw
 * entries for scanning purposes, not to build a merged filesystem
 * view. A whiteout marker tells a real runtime "do not show this
 * path", but the bytes that were ever shipped in a lower layer are
 * still part of the published image — a secret committed in a layer
 * and "deleted" by a later layer's whiteout is still exfiltrable by
 * anyone who pulls the index and inspects layer blobs directly. So
 * `walkAllLayers` returns EVERY entry from EVERY layer, annotated
 * with whether it is whiteout-deleted in the final merged view, but
 * never DROPS an entry from the returned set. Callers that want the
 * merged (runtime) view can filter on `deleted`; the content-gate
 * scanner (secret-scan.ts) deliberately does NOT filter, by design.
 */
import { gunzipSync } from 'node:zlib';
import { parseTar, type TarEntry } from './tar.js';
import { ContentGateError } from './errors.js';
import { validateDescriptorAgainstBlob, type LoadedOciLayout } from './oci-layout.js';
import type { OciDescriptor } from './types.js';

export interface LayerEntry extends TarEntry {
  /** Index of the layer (0 = lowest/first) this entry came from. */
  layerIndex: number;
  /** The layer's blob digest, for provenance in findings. */
  layerDigest: string;
  /** True if a whiteout in THIS OR A LATER layer removes this path from the merged view. */
  deleted: boolean;
  /** True if this entry IS a whiteout marker itself (not real content). */
  isWhiteoutMarker: boolean;
}

const OPAQUE_MARKER = '.wh..wh..opq';

function decompressLayer(bytes: Buffer, mediaType: string): Buffer {
  const isGzip = mediaType.includes('gzip') || (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b);
  if (!isGzip) return bytes;
  try {
    return gunzipSync(bytes);
  } catch (err) {
    throw new ContentGateError('corrupt_layer', `layer failed to decompress (gzip): ${(err as Error).message}`, err);
  }
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Walks every layer in manifest order (lowest first), parses each
 * layer's tar fail-closed (digest+size validated against the real
 * blob, decompression/parse errors surfaced as corrupt_layer), and
 * returns every entry from every layer annotated with merged-view
 * deletion status. No entry is ever dropped from the returned array —
 * whiteout rules only set `deleted`, they do not filter.
 */
export function walkAllLayers(layout: LoadedOciLayout, layerDescs: OciDescriptor[]): LayerEntry[] {
  const perLayerEntries: TarEntry[][] = [];

  for (let i = 0; i < layerDescs.length; i++) {
    const desc = layerDescs[i]!;
    const bytes = validateDescriptorAgainstBlob(desc, layout.blobs, `layer[${i}] ${desc.digest}`);
    const tarBytes = decompressLayer(bytes, desc.mediaType);
    let entries: TarEntry[];
    try {
      entries = parseTar(tarBytes);
    } catch (err) {
      throw new ContentGateError('corrupt_layer', `layer[${i}] ${desc.digest} tar is corrupt/truncated: ${(err as Error).message}`, err);
    }
    for (const entry of entries) {
      // PR #61 review round 3 finding #2 (live CI proof: tailscale
      // v1.102.5 layer[4], digest
      // sha256:d5b385151df469cba7b856e89b722639dbc56b258c28b4ab571cb216e52f5429,
      // pulled and inspected directly from the real upstream registry —
      // contains a genuine tar entry literally named "/usr/local/bin",
      // an absolute-path DIRECTORY entry with no ".." segment and no
      // symlink typeflag). An absolute-rooted tar entry name is a
      // STYLE choice some image builders emit (tar -P / "preserve
      // absolute paths") — it is NOT, by itself, a parent-directory
      // escape attempt, and the gate never extracts to a filesystem
      // (it only scans entry bytes in memory via LayerEntry), so there
      // is no extraction-root escape to protect against here in the
      // first place. The actual traversal attack this check must
      // still catch is a ".." path SEGMENT (archive entry whose
      // resolved path walks above the archive root) — that is
      // orthogonal to whether the name happens to start with "/".
      // Strip any number of leading slashes (and a leading "./") for
      // the purpose of this check and the stored/returned `name` so
      // whiteout/opaque-marker matching and scan `path` reporting are
      // consistent for both absolute- and relative-style tar entries,
      // then reject ONLY a literal ".." path segment — the actual
      // escape vector.
      const normalized = entry.name.replace(/^(?:\.\/|\/)+/, '');
      if (normalized.split('/').includes('..')) {
        throw new ContentGateError('path_traversal', `layer[${i}] ${desc.digest} tar entry attempts path traversal: "${entry.name}"`);
      }
    }
    perLayerEntries.push(entries);
  }

  // Determine deletion status: for each real path, find the HIGHEST
  // layer index at which either (a) a whiteout for that exact path
  // exists, or (b) an opaque marker exists for an ancestor directory
  // at or above that layer. A path is "deleted in the merged view" if
  // such a layer index exists that is >= the layer the path's own
  // content came from (deletions only apply to lower/equal layers,
  // i.e. a later layer can delete what an earlier layer wrote; it
  // cannot delete content introduced in a layer written AFTER it).
  const whiteoutsByLayer: Array<Set<string>> = [];
  const opaqueDirsByLayer: Array<Set<string>> = [];
  for (let i = 0; i < perLayerEntries.length; i++) {
    const wh = new Set<string>();
    const opq = new Set<string>();
    for (const entry of perLayerEntries[i]!) {
      // Same leading-slash/`./` normalization as the path-traversal
      // check above (PR #61 review round 3 finding #2) — an
      // absolute-rooted entry name (e.g. real upstream tailscale
      // layer bytes: "/usr/local/bin") must normalize to the SAME
      // key an equivalent relative-style entry/whiteout from another
      // layer would use, or whiteout/opaque-dir matching silently
      // fails to connect an absolute-named file to a relative-named
      // whiteout for the same logical path.
      const normalized = entry.name.replace(/^(?:\.\/|\/)+/, '').replace(/\/$/, '');
      const base = basename(normalized);
      if (base === OPAQUE_MARKER) {
        opq.add(dirname(normalized));
      } else if (base.startsWith('.wh.')) {
        const deletedName = base.slice('.wh.'.length);
        wh.add(dirname(normalized) === '' ? deletedName : `${dirname(normalized)}/${deletedName}`);
      }
    }
    whiteoutsByLayer.push(wh);
    opaqueDirsByLayer.push(opq);
  }

  function isAncestorDir(ancestor: string, pathStr: string): boolean {
    if (ancestor === '') return true;
    return pathStr === ancestor || pathStr.startsWith(`${ancestor}/`);
  }

  function isDeletedAtOrAbove(normalized: string, fromLayer: number): boolean {
    for (let j = fromLayer; j < perLayerEntries.length; j++) {
      if (whiteoutsByLayer[j]!.has(normalized)) return true;
      // OCI image-spec: an opaque whiteout hides the directory's contents from LOWER layers
      // only; files in the same layer as the marker are retained.
      if (j === fromLayer) continue;
      for (const dir of opaqueDirsByLayer[j]!) {
        if (isAncestorDir(dir, normalized) && normalized !== dir) return true;
      }
    }
    return false;
  }

  const result: LayerEntry[] = [];
  for (let i = 0; i < perLayerEntries.length; i++) {
    const desc = layerDescs[i]!;
    for (const entry of perLayerEntries[i]!) {
      const normalized = entry.name.replace(/^(?:\.\/|\/)+/, '').replace(/\/$/, '');
      const base = basename(normalized);
      const isWhiteoutMarker = base === OPAQUE_MARKER || base.startsWith('.wh.');
      const deleted = isWhiteoutMarker ? false : isDeletedAtOrAbove(normalized, i);
      result.push({
        ...entry,
        name: normalized,
        layerIndex: i,
        layerDigest: desc.digest,
        deleted,
        isWhiteoutMarker,
      });
    }
  }
  return result;
}

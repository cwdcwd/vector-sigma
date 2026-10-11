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
      const normalized = entry.name.replace(/^\.\//, '');
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
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
      const normalized = entry.name.replace(/^\.\//, '').replace(/\/$/, '');
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
      const normalized = entry.name.replace(/^\.\//, '').replace(/\/$/, '');
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

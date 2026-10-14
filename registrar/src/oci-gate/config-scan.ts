/**
 * Image CONFIG JSON content scanning (fleet-ops-1py.14 fix for PR #61
 * review finding #3).
 *
 * `loadConfig` (oci-layout.ts) validates and parses the OCI image
 * config JSON; THIS module runs the same credential/topology patterns
 * already applied to layer content (secret-scan.ts) against every
 * plausible leak vector inside that JSON:
 *   - config.Env            (array of "KEY=VALUE" strings)
 *   - config.Labels          (map of string -> string)
 *   - config.Cmd / Entrypoint (array of strings)
 *   - history[].created_by   (array of build-step strings, at the
 *                             config's top level per the OCI image
 *                             config spec — NOT nested under `config`)
 *
 * Reuses the exact same PATTERNS table as secret-scan.ts (imported,
 * never re-implemented) so a pattern added for layer content is
 * automatically enforced here too, and vice versa — one source of
 * truth for "what counts as a secret/topology literal in shipped image
 * bytes", whether it lives in a layer file or in the config JSON.
 */
import type { ScanFinding } from './secret-scan.js';
import { scanLayersForSecretsAndTopology } from './secret-scan.js';
import { ContentGateError } from './errors.js';
import type { LayerEntry } from './layer-walk.js';

/** Pulls every plausible leak-vector string out of a parsed OCI image config JSON. */
function extractConfigStrings(config: Record<string, unknown>): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  const inner = (config.config && typeof config.config === 'object' ? (config.config as Record<string, unknown>) : config) as Record<
    string,
    unknown
  >;

  const pushArray = (key: string, arr: unknown) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((v, i) => {
      if (typeof v === 'string') out.push({ path: `config.${key}[${i}]`, value: v });
    });
  };
  pushArray('Env', inner.Env);
  pushArray('Cmd', inner.Cmd);
  pushArray('Entrypoint', inner.Entrypoint);

  if (inner.Labels && typeof inner.Labels === 'object') {
    for (const [k, v] of Object.entries(inner.Labels as Record<string, unknown>)) {
      if (typeof v === 'string') out.push({ path: `config.Labels[${k}]`, value: v });
    }
  }

  // history is a TOP-LEVEL array on the OCI image config (sibling of
  // `config`/`rootfs`), per the image-spec — never nested under `config`.
  if (Array.isArray(config.history)) {
    config.history.forEach((h, i) => {
      if (h && typeof h === 'object' && typeof (h as Record<string, unknown>).created_by === 'string') {
        out.push({ path: `history[${i}].created_by`, value: (h as Record<string, unknown>).created_by as string });
      }
    });
  }

  return out;
}

/**
 * Scans the parsed config JSON's extracted strings through the SAME
 * secret/topology patterns the layer scanner uses, by wrapping each
 * string as a synthetic single-entry "layer" so the existing scanner
 * (and its binary-sniff/whiteout-aware plumbing) is reused verbatim
 * rather than re-implemented.
 */
export function scanConfigForSecretsAndTopology(config: Record<string, unknown>, configDigest: string): ScanFinding[] {
  const strings = extractConfigStrings(config);
  const syntheticEntries: LayerEntry[] = strings.map((s) => ({
    name: s.path,
    type: '0',
    size: Buffer.byteLength(s.value, 'utf8'),
    data: Buffer.from(s.value, 'utf8'),
    linkname: '',
    layerIndex: -1,
    layerDigest: configDigest,
    deleted: false,
    isWhiteoutMarker: false,
  }));
  return scanLayersForSecretsAndTopology(syntheticEntries);
}

/** Scans and throws fail-closed on the first finding, same contract as assertNoSecretsOrTopologyLiterals. */
export function assertConfigHasNoSecretsOrTopologyLiterals(config: Record<string, unknown>, configDigest: string): void {
  const findings = scanConfigForSecretsAndTopology(config, configDigest);
  if (findings.length === 0) return;
  const first = findings[0]!;
  const code = first.kind === 'secret' ? 'secret_found' : 'topology_literal_found';
  throw new ContentGateError(
    code,
    `content gate rejected: ${first.kind} pattern "${first.pattern}" found in image config (${configDigest}) at "${first.path}"`,
    findings,
  );
}

/** Shared OCI shape types for the local content gate (slice 4). */

export interface OciPlatform {
  architecture: string;
  os: string;
  variant?: string;
}

export interface OciDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: OciPlatform;
  annotations?: Record<string, string>;
}

export interface OciIndex {
  schemaVersion: number;
  mediaType?: string;
  manifests: OciDescriptor[];
}

export interface OciManifest {
  schemaVersion: number;
  mediaType?: string;
  config: OciDescriptor;
  layers: OciDescriptor[];
}

export const REQUIRED_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
export type RequiredPlatform = (typeof REQUIRED_PLATFORMS)[number];

export function platformKey(p: OciPlatform | undefined): string | undefined {
  if (!p) return undefined;
  return `${p.os}/${p.architecture}`;
}

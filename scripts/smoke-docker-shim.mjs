#!/usr/bin/env node
// scripts/smoke-docker-shim.mjs — dockerless backend for release-smoke.sh
// (fleet-ops-1py.7 rung 2, born from review 5480276420 on PR #59).
//
// WHY: the smoke gate asserts against real image bytes, but not every host
// that needs to run it has docker (the Pi build hosts do not). With
// SMOKE_DOCKERLESS=1, release-smoke.sh routes every DRUN call here, and
// this shim answers the exact docker CLI surface the smoke script uses —
//   docker run --rm --entrypoint sh <image> -c <cmd>
//   docker buildx imagetools inspect <image>
// — against raw GHCR bytes: the image index is fetched, the linux/arm64
// child manifest resolved (devices are aarch64; that is the platform the
// docker run path would execute), and its layer tars are materialized to
// a local cache. The -c command then runs on THIS host with absolute
// paths rewritten into the materialized tree.
//
// WHAT IT PROVES: the smoke gate's assertions are the boot-path BYTES
// classes — file presence (test), content needles (grep/cat), the
// images' own compiled JS fail-loud paths (node probes), and manifest
// platform coverage (imagetools). All of those run faithfully here.
// On an aarch64 host the baked ARM64 binaries even execute natively
// (bd --version). What it does NOT prove: entrypoint exec bits at
// container start, volumes, networking, pid namespaces. The CI smoke
// job (real docker) stays the authoritative run; this is the local
// development gate — and the unit-test harness pins its contract.
//
// LIMIT: command execution is host-side with a barren environment
// (PATH + HOME only), approximating the CI container env for the
// config fail-loud probes. Host binaries (node, sh, grep) answer the
// call; only the image's own files are read from the materialized tree.
//
// Cache: layers materialize under $SMOKE_CACHE_DIR (default
// ~/.cache/vs-smoke), keyed by the arm64 child manifest's config digest
// — immutable bytes, so caching is safe.
// EXIT: 0 success / nonzero failure (mirrors docker CLI conventions).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const REGISTRY = 'ghcr.io';
const cacheRoot = process.env.SMOKE_CACHE_DIR
  ? path.resolve(process.env.SMOKE_CACHE_DIR)
  : path.join(process.env.HOME ?? tmpdir(), '.cache', 'vs-smoke');

const ACCEPT_INDEX =
  'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json';
const ACCEPT_MANIFEST =
  'application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json';

// ─── registry client (anonymous; VS images are public until the owner flip) ─
async function regToken(repo) {
  const scope = `repository:${repo}:pull`;
  const res = await fetch(`https://${REGISTRY}/token?scope=${encodeURIComponent(scope)}`);
  if (!res.ok) throw new Error(`ghcr token ${res.status} for ${repo}`);
  return (await res.json()).token;
}

async function regFetch(repo, ref, accept, token) {
  const res = await fetch(`https://${REGISTRY}/v2/${repo}/manifests/${ref}`, {
    headers: { Accept: accept, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`registry ${res.status} for ${repo}@${ref}`);
  return res.json();
}

async function regBlob(repo, digest, token) {
  const res = await fetch(`https://${REGISTRY}/v2/${repo}/blobs/${digest}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`blob ${res.status} for ${repo}@${digest}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── image resolution + materialization ─────────────────────────────────────
function splitImage(imageRef) {
  const withoutHost = imageRef.startsWith(`${REGISTRY}/`) ? imageRef.slice(REGISTRY.length + 1) : imageRef;
  const slash = withoutHost.indexOf('/');
  const colon = withoutHost.lastIndexOf(':');
  const repo = colon > slash ? withoutHost.slice(0, colon) : withoutHost;
  const ref = colon > slash ? withoutHost.slice(colon + 1) : 'latest';
  return { repo, ref };
}

// Resolve to the linux/arm64 child manifest when the ref is an index.
async function resolveImage(imageRef) {
  const { repo, ref } = splitImage(imageRef);
  const token = await regToken(repo);
  const indexDoc = await regFetch(repo, ref, ACCEPT_INDEX, token);
  let manifest = indexDoc;
  if (Array.isArray(indexDoc.manifests)) {
    const arm = indexDoc.manifests.find(
      (m) => m.platform && m.platform.os === 'linux' && m.platform.architecture === 'arm64',
    );
    if (!arm) throw new Error(`no linux/arm64 child in index ${imageRef}`);
    manifest = await regFetch(repo, arm.digest, ACCEPT_MANIFEST, token);
  }
  return { repo, ref, token, manifest };
}

// Extract layer tars into the cache dir, applying OCI whiteouts AFTER EACH
// LAYER (overlay order: layer N's .wh.X removes prior state; a later layer
// re-adding X wins — an end-state-only pass would delete re-added files).
// Device nodes (dev/*) are excluded: mknod fails unprivileged, and nothing
// in the smoke assertions reads /dev.
function applyWhiteouts(dir) {
  const walk = (d) => {
    for (const entry of readdirSafe(d)) {
      const full = path.join(d, entry);
      if (entry.startsWith('.wh.')) {
        const target = path.join(d, entry.slice(4));
        if (pathExists(target)) rmSync(target, { recursive: true, force: true });
        rmSync(full, { force: true });
      } else if (isDir(full)) walk(full);
    }
  };
  walk(dir);
}

async function materialize(repo, ref, token, manifest) {
  const key = (manifest.config?.digest ?? `${repo}:${ref}`).replace(/[:@]/g, '_');
  const dir = path.join(cacheRoot, key);
  if (existsSync(path.join(dir, '.complete'))) return dir;
  mkdirSync(dir, { recursive: true });

  for (const layer of manifest.layers ?? []) {
    const blob = await regBlob(repo, layer.digest, token);
    const tarPath = path.join(cacheRoot, `${layer.digest.replace(/[:]/g, '_')}.tar`);
    writeFileSync(tarPath, blob);
    execFileSync('tar', [
      '-xf', tarPath, '-C', dir,
      '--no-same-owner', '--no-same-permissions',
      '--exclude=./dev/*', '--exclude=dev/*',
    ]);
    applyWhiteouts(dir);
  }
  writeFileSync(path.join(dir, '.complete'), String(Date.now()));
  return dir;
}

function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
function pathExists(p) {
  try { statSync(p); return true; } catch { return false; }
}
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// ─── host-side command execution against the materialized tree ──────────────
// The command runs CHROOTED into the materialized tree inside a user
// namespace (unshare -Ur) — no privileges needed. Container-absolute paths,
// wrapper scripts, and the images' own arm64 binaries resolve exactly as in
// a container (this host is aarch64, so baked binaries run natively).
// /dev is not populated (materialize excludes device nodes) — nothing in
// the smoke assertions touches it; if a future assertion does, it needs
// a real container, not this shim.
function runInImage(root, cmd) {
  try {
    execFileSync('unshare', ['-Ur', 'chroot', root, '/bin/sh', '-c', cmd], {
      stdio: 'inherit',
      env: { PATH: '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin' },
    });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}

// ─── CLI surface ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

async function cmdRun() {
  // expected shape: run --rm --entrypoint sh <image> -c <cmd>
  let entrypoint = null;
  let imageArg = null;
  let cmd = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--rm') continue;
    if (argv[i] === '--entrypoint') { entrypoint = argv[++i]; continue; }
    if (argv[i] === '-c') { cmd = argv[i + 1]; break; }
    if (imageArg === null) imageArg = argv[i];
    else throw new Error(`unexpected run arg ${argv[i]}`);
  }
  if (!imageArg || !cmd) throw new Error('run: no image or -c command');
  if (entrypoint !== null && entrypoint !== 'sh') throw new Error(`run: unsupported entrypoint ${entrypoint}`);

  const { repo, ref, token, manifest } = await resolveImage(imageArg);
  const root = await materialize(repo, ref, token, manifest);
  process.exit(runInImage(root, cmd));
}

async function cmdImagetoolsInspect() {
  const image = argv[3];
  if (!image) throw new Error('imagetools inspect: no image');
  const { repo, ref } = splitImage(image);
  const token = await regToken(repo);
  const indexDoc = await regFetch(repo, ref, ACCEPT_INDEX, token);
  if (!Array.isArray(indexDoc.manifests)) throw new Error(`${image} is not a multi-arch index`);
  const lines = [`Name:      ${REGISTRY}/${repo}:${ref}`];
  for (const m of indexDoc.manifests) {
    const p = m.platform ?? {};
    lines.push('Manifests:');
    lines.push(`  Name:      ${REGISTRY}/${repo}@${m.digest}`);
    lines.push(`  Platform:  ${p.os ?? 'unknown'}/${p.architecture ?? 'unknown'}${p.variant ? `/${p.variant}` : ''}`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

async function main() {
  if (argv[0] === 'run') return cmdRun();
  if (argv[0] === 'buildx' && argv[1] === 'imagetools' && argv[2] === 'inspect') return cmdImagetoolsInspect();
  console.error(`smoke-docker-shim: unsupported docker surface: ${argv.join(' ')}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`smoke-docker-shim: ${e.message}`);
  process.exit(1);
});
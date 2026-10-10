#!/usr/bin/env node
// scripts/render-release-compose.mjs — render a digest-pinned balena app compose
// from CI-built GHCR images (fleet-ops-1py.7 rung 2).
//
// WHY: the balena supervisor performs NO ${VAR} substitution in its compose
// (compose-file v2.4 semantics — `image: ${TAG}` is a literal string on the
// device), so the prebuilt deploy flow needs image digests PINNED into the
// compose the supervisor runs. The repo composes stay build:-shaped (E2E stays
// source-build per the owner's Q5 ruling); THIS script renders the deploy form
// at tag-cut time: every build: service becomes
//   image: ghcr.io/<owner>/<repo>/<component>@sha256:<arm64 child digest>
//
// ARCH NOTE — the arm64 CHILD digest, not the index digest: balena devices are
// Raspberry Pi 5 (aarch64), `balena deploy` runs on an x86 GitHub runner, and
// the runner's docker resolves an index reference to the amd64 child. Pinning
// the index digest would re-upload the WRONG arch to the balena registry. The
// rendered compose pins the linux/arm64 child-manifest digest for every
// VS-built service; the pin is deterministic (a platform manifest has exactly
// one blob) and self-describing in audits.
//
// PROVENANCE: alongside the compose, <app>.release.json records the GHCR tags,
// per-service digests and the render time — the audit trail the runbook cites.
//
// USAGE (repo root):
//   node scripts/render-release-compose.mjs --app registrar --registry-owner cwdcwd \
//       --repo vector-sigma --sha <full 40-char commit> --out <dir>
//   node scripts/render-release-compose.mjs --app registrar --registry-owner cwdcwd \
//       --repo vector-sigma --sha <sha> --check     (offline validation)
//
// Digests resolve from the local docker daemon when available (CI logs into
// GHCR first), else via anonymous registry tokens (public images only).
// EXIT: 0 success / 1 any failure.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse: parseYaml, stringify: stringifyYaml } = require('yaml');

// ─── args ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--app') out.app = argv[++i];
    else if (a.startsWith('--app=')) out.app = a.slice(6);
    else if (a === '--registry-owner') out.registryOwner = argv[++i];
    else if (a.startsWith('--registry-owner=')) out.registryOwner = a.slice(17);
    else if (a === '--repo') out.repo = argv[++i];
    else if (a.startsWith('--repo=')) out.repo = a.slice(7);
    else if (a === '--sha') out.sha = argv[++i];
    else if (a.startsWith('--sha=')) out.sha = a.slice(6);
    else if (a === '--out') out.out = argv[++i];
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`render-release-compose: unknown argument ${a}`); out.help = true; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.app || !args.registryOwner || !args.repo || (!args.check && !args.sha)) {
  console.error(`Usage: node scripts/render-release-compose.mjs --app <registrar|devices> --registry-owner <owner> --repo <repo> [--sha <40-char commit>] [--out <dir>] [--check]`);
  process.exit(args.help && args.app && args.registryOwner && args.repo ? 0 : 1);
}

// ─── service -> GHCR component map ──────────────────────────────────────────
// The build-images.yml matrix names these components. devices tailscale is a
// SEPARATE component ('tailscale-devices'): its Dockerfile bakes the
// ${TS_CERT_DOMAIN} placeholder serve config (N devices, one compose), while
// the master's bakes the literal MagicDNS names — different bytes, different
// images. 'dolt' is a stock pinned image: not built by CI, left untouched.
const APP_SERVICE_COMPONENTS = {
  registrar: {
    postgres: 'postgres',
    registrar: 'registrar',
    litellm: 'litellm',
    dolt: null,
    scotty: 'scotty',
    hermes: 'hermes',
    'registrant-own': 'registrant',
    tailscale: 'tailscale',
  },
  devices: {
    agent: 'agent',
    registrant: 'registrant',
    tailscale: 'tailscale-devices',
  },
};

function fail(msg) {
  console.error(`render-release-compose: ERROR: ${msg}`);
  process.exit(1);
}

// ─── digest resolution ──────────────────────────────────────────────────────
function haveDocker() {
  try {
    execFileSync('docker', ['version', '--format', '{{.Client.Version}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function arm64DigestViaDocker(image) {
  // `docker buildx imagetools inspect` — no local pull needed; uses stored
  // registry creds when the runner logged in.
  const out = execFileSync('docker',
    ['buildx', 'imagetools', 'inspect', image],
    { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
  const lines = out.split('\n');
  const digestLine = lines.find((l) => /^Digest:\s+sha256:/.test(l.trim()));
  const manifestsIdx = lines.findIndex((l) => l.includes('Manifests:'));
  const manifests = [];
  if (manifestsIdx >= 0) {
    // imagetools prints each child as: a Name line with @sha256, then a
    // MediaType line, then a SEPARATE 'Platform:' line (and an Annotations
    // block). Walk the block: start a child on @sha256, fill its platform
    // when the Platform line arrives.
    let cur = null;
    for (const l of lines.slice(manifestsIdx + 1)) {
      const nm = l.match(/@(sha256:[0-9a-f]{64})/);
      const pm = l.match(/Platform:\s*(\S+)\s*$/);
      if (nm) {
        if (cur) manifests.push(cur);
        cur = { digest: nm[1], platform: null };
      } else if (pm && cur) {
        cur.platform = pm[1];
      }
    }
    if (cur) manifests.push(cur);
  }
  const arm = manifests.find((m) => m.platform === 'linux/arm64');
  if (arm) return arm.digest;
  fail(`no linux/arm64 manifest found for ${image} (children: ${manifests.map((m) => m.platform).join(', ') || 'none'})`);
}

async function arm64DigestViaRegistry(owner, repo, component, tag) {
  // Anonymous registry API: token, then index GET, then arm64 child manifest.
  const tokenUrl = `https://ghcr.io/token?scope=repository:${owner}/${repo}/${component}:pull`;
  const tokenRes = await fetch(tokenUrl);
  if (!tokenRes.ok) fail(`registry token request failed for ${component}: HTTP ${tokenRes.status}`);
  const token = (await tokenRes.json()).token;
  const ref = tag;
  const idxRes = await fetch(`https://ghcr.io/v2/${owner}/${repo}/${component}/manifests/${ref}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
    },
  });
  if (!idxRes.ok) fail(`manifest request failed for ${component}:${ref}: HTTP ${idxRes.status} — image missing or private without docker login`);
  const idx = await idxRes.json();
  const manifests = idx.manifests || [];
  const arm = manifests.find((m) => m.platform && m.platform.os === 'linux' && m.platform.architecture === 'arm64');
  if (!arm) fail(`no linux/arm64 manifest in ${component}:${ref} (children: ${manifests.map((m) => `${m.platform?.os}/${m.platform?.architecture}`).join(', ')})`);
  return arm.digest;
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const app = args.app;
  const map = APP_SERVICE_COMPONENTS[app];
  if (!map) fail(`unknown --app ${app} (known: registrar, devices)`);

  const composePath = path.join('balena', app, 'docker-compose.yml');
  if (!existsSync(composePath)) fail(`${composePath} not found (run from the repo root)`);
  const raw = readFileSync(composePath, 'utf8');

  let parsed;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    fail(`cannot parse ${composePath}: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.services) fail(`${composePath} has no services:`);
  const version = String(parsed.version ?? '').trim().replace(/^"|"$/g, '');
  if (version !== '2.4') fail(`${composePath} version is ${JSON.stringify(parsed.version)} — expected "2.4" (the schema pin is load-bearing for the balena CLI validator)`);

  const services = Object.keys(parsed.services);
  for (const [svc, component] of Object.entries(map)) {
    if (component === null) {
      if (!services.includes(svc)) fail(`service ${svc} is expected (stock-image) but missing from ${composePath}`);
      continue;
    }
    if (!services.includes(svc)) fail(`service ${svc} mapped to component ${component} but not present in ${composePath}`);
  }

  // Every service present must appear in the map: an unmapped service would
  // silently ship its build: (or worse, an unpinned tag) to the supervisor.
  for (const svc of services) {
    if (!(svc in map)) fail(`service ${svc} is not in the ${app} component map — add it or remove the service (refusing to render an unmapped service)`);
    const svcDef = parsed.services[svc];
    if (map[svc] !== null && !svcDef.build) {
      fail(`service ${svc} is mapped to component ${map[svc]} but has no build: section in the repo compose — the render requires every VS-built service to be build:-shaped in the repo`);
    }
  }

  if (args.check) {
    const mapped = Object.entries(map).filter(([, c]) => c !== null).length;
    console.log(`render-check: OK — ${app}: ${services.length} services, ${mapped} VS-built services mapped, compose parses, version "2.4" pin intact`);
    process.exit(0);
  }

  const useDocker = haveDocker();
  const rendered = structuredClone(parsed);
  const provenance = { app, commit: args.sha, renderedAt: new Date().toISOString(), images: {} };

  for (const [svc, component] of Object.entries(map)) {
    if (component === null) continue;
    const imageBase = `ghcr.io/${args.registryOwner}/${args.repo}/${component}`;
    const tagged = `${imageBase}:${args.sha}`;
    let digest;
    if (useDocker) {
      digest = arm64DigestViaDocker(tagged);
    } else {
      digest = await arm64DigestViaRegistry(args.registryOwner, args.repo, component, args.sha);
    }
    const svcDef = rendered.services[svc];
    svcDef.image = `${imageBase}@${digest}`;
    delete svcDef.build;
    provenance.images[svc] = { component, ghcrTag: tagged, arm64Digest: digest, image: svcDef.image };
    console.log(`render: ${app}/${svc} -> ${svcDef.image}`);
  }

  const text = stringifyYaml(rendered);
  // Interpolation gate: the balena supervisor does NO ${VAR} substitution, so
  // any ${...} left in the rendered file would ship as a literal string. The
  // ONE exemption: healthcheck `test: ["CMD-SHELL", "..."]` — that string is
  // passed to /bin/sh INSIDE the container, which does the substitution at
  // runtime (pg_isready -U ${POSTGRES_USER}, proven on the live fleet).
  const gateCopy = JSON.parse(JSON.stringify(rendered));
  for (const svc of Object.values(gateCopy.services || {})) {
    if (svc.healthcheck) delete svc.healthcheck;
  }
  const gateText = stringifyYaml(gateCopy);
  if (/\$\{/.test(gateText)) fail(`rendered compose still contains \${...} interpolation outside healthchecks (the supervisor does no substitution — strip variables from balena/${app}/docker-compose.yml)`);

  const outDir = args.out || path.join('.release', app);
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'docker-compose.yml');
  writeFileSync(outPath, text);
  const provPath = path.join(outDir, `${app}.release.json`);
  writeFileSync(provPath, JSON.stringify(provenance, null, 2) + '\n');
  console.log(`render: wrote ${outPath}`);
  console.log(`render: wrote ${provPath}`);
  console.log(`render: summary — app=${app} commit=${args.sha} services=${Object.keys(provenance.images).length} resolution=${useDocker ? 'docker-daemon' : 'registry-api'}`);
}

main().catch((e) => {
  console.error('render-release-compose: FATAL', e);
  process.exit(1);
});

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * VS GitHub identity contract guard (fleet-ops-e5o.5).
 *
 * Device agents (and primus) write to this repo as their OWN per-agent
 * GitHub App identities — the bundle delivers the App PEM
 * (github_app_pem -> config/github-app.pem) and the GH_APP_ID/GH_APP_SLUG
 * env lines; the 05-vs-github-identity boot hook derives the GIT_CONFIG_*
 * env lines; the vs-github-identity wrapper mints short-lived
 * installation tokens and fronts git (credential helper) and the REST
 * API. This guard pins:
 *
 *   1. BYTE-PARITY of the wrapper + hook + doc across the THREE copies:
 *      scripts/ (source of truth), balena/devices/agent/ (devices image
 *      context), and balena/registrar/ (primus image context) — the
 *      vendored-drift pattern (b1r/kh1 lineage: one source of truth,
 *      images vendor at build time, drift is a red CI run not a
 *      release-day discovery).
 *   2. BOTH Hermes images bake the wrapper at /usr/local/bin and the
 *      hook as cont-init 05- (after stage2's 01-, the queue join 03-,
 *      and the A2A wiring 04- — lexical order), with explicit chmod
 *      0755 (builder-agnostic exec bits).
 *   3. The hook's contract shape: fail-soft (no non-zero exit),
 *      with-contenv shebang, never a credential source, managed-key
 *      removal (identity dropped => env block dropped).
 *   4. The wrapper's contract shape: env-only config, public-CA TLS
 *      anchoring (never SSL_CERT_FILE — the composition pins that to
 *      the internal CA, which would poison GitHub TLS), no secrets in
 *      any output path, openssl fallback signing.
 *   5. The usage doc is vendored to BOTH images' /opt/vs/docs (with the
 *      existing docs drift list).
 *   6. FLEET-AGNOSTIC content (kh1): no origin-fleet agent, host, or
 *      gateway names in the wrapper, hook, or doc.
 *   7. The wrapper is FUNCTIONAL: a live behavioral test drives the
 *      token-mint flow against a loopback mock API with a real RSA key
 *      (both signing paths) — proving the wiring end to end without
 *      any real credential.
 *
 * Regeneration recipe (vendored-drift): after editing
 * scripts/vs-github-identity.{py,sh} or docs/vs-github.md, re-vendor:
 *   cp scripts/vs-github-identity.py balena/devices/agent/
 *   cp scripts/vs-github-identity.py balena/registrar/
 *   cp scripts/vs-github-identity.sh balena/devices/agent/
 *   cp scripts/vs-github-identity.sh balena/registrar/
 *   cp docs/vs-github.md balena/devices/docs/
 *   cp docs/vs-github.md balena/registrar/docs/
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/** File with full-line (`#`-prefixed) comment lines removed. */
function stripComments(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

/** The (source-of-truth, vendored) pairs guarded byte-exact. */
const DRIFT_PAIRS: Array<[string, string]> = [
  ['scripts/vs-github-identity.py', 'balena/devices/agent/vs-github-identity.py'],
  ['scripts/vs-github-identity.py', 'balena/registrar/vs-github-identity.py'],
  ['scripts/vs-github-identity.sh', 'balena/devices/agent/vs-github-identity.sh'],
  ['scripts/vs-github-identity.sh', 'balena/registrar/vs-github-identity.sh'],
  ['docs/vs-github.md', 'balena/devices/docs/vs-github.md'],
  ['docs/vs-github.md', 'balena/registrar/docs/vs-github.md'],
];

const wrapper = read('scripts/vs-github-identity.py');
const hook = read('scripts/vs-github-identity.sh');
const usageDoc = read('docs/vs-github.md');
const devicesDockerfile = read('balena/devices/Dockerfile.agent-hermes');
const registrarDockerfile = read('balena/registrar/Dockerfile.hermes');

/** Origin-fleet identity tokens that must NEVER appear in VS repo content. */
const FLEET_NAME_RE = /doombot|ultronbot|kangbot|thanosbot|lazybaer|thecabal/i;

describe('VS GitHub identity (fleet-ops-e5o.5): vendored byte-parity', () => {
  it('every source-of-truth file exists', () => {
    expect(exists('scripts/vs-github-identity.py')).toBe(true);
    expect(exists('scripts/vs-github-identity.sh')).toBe(true);
    expect(exists('docs/vs-github.md')).toBe(true);
  });

  it.each(DRIFT_PAIRS)('%s is vendored byte-exact to %s', (src, vendored) => {
    expect(read(src) === read(vendored), `${vendored} drifted from ${src}`).toBe(true);
  });
});

describe('VS GitHub identity (fleet-ops-e5o.5): image wiring', () => {
  it('the devices image bakes the wrapper + the 05- hook with exec bits', () => {
    const code = stripComments(devicesDockerfile);
    expect(code).toMatch(/COPY agent\/vs-github-identity\.py \/usr\/local\/bin\/vs-github-identity/);
    expect(code).toMatch(/COPY agent\/vs-github-identity\.sh \/etc\/cont-init\.d\/05-vs-github-identity/);
    expect(code).toMatch(/chmod 0755 \/usr\/local\/bin\/vs-github-identity \/etc\/cont-init\.d\/05-vs-github-identity/);
  });

  it('the primus (registrar) image bakes the same pair (one contract, both images)', () => {
    const code = stripComments(registrarDockerfile);
    expect(code).toMatch(/COPY vs-github-identity\.py \/usr\/local\/bin\/vs-github-identity/);
    expect(code).toMatch(/COPY vs-github-identity\.sh \/etc\/cont-init\.d\/05-vs-github-identity/);
    expect(code).toMatch(/chmod 0755 \/etc\/cont-init\.d\/05-vs-github-identity \/usr\/local\/bin\/vs-github-identity/);
  });

  it('the usage doc is vendored into both images with the docs set (COPY docs /opt/vs/docs)', () => {
    expect(stripComments(devicesDockerfile)).toMatch(/COPY docs \/opt\/vs\/docs/);
    expect(stripComments(registrarDockerfile)).toMatch(/COPY docs \/opt\/vs\/docs/);
    expect(exists('balena/devices/docs/vs-github.md')).toBe(true);
    expect(exists('balena/registrar/docs/vs-github.md')).toBe(true);
  });
});

describe('VS GitHub identity (fleet-ops-e5o.5): hook contract', () => {
  it('runs via with-contenv (the cont-init contract) and is fail-soft', () => {
    expect(hook).toMatch(/^#!\/command\/with-contenv sh/);
    // FAIL-SOFT: never brick the agent — every error path exits 0
    // (comment-stripped scan, the 03-/04- hook posture).
    const code = stripComments(hook);
    expect(code).not.toMatch(/exit [1-9]/);
  });

  it('is NEVER a credential source and never reads the PEM body', () => {
    // The hook only TESTS for the PEM's existence; the wrapper reads it
    // at mint time. No cat/grep/base64 of the PEM in the hook.
    const code = stripComments(hook);
    expect(code).not.toMatch(/cat .*pem|base64 .*pem|grep .*pem/);
  });

  it('derives the git identity env block (credential helper + [bot] identity)', () => {
    expect(hook).toMatch(/GH_APP_PEM_PATH/);
    expect(hook).toMatch(/GIT_CONFIG_COUNT/);
    expect(hook).toMatch(/credential\.helper/);
    expect(hook).toMatch(/user\.name/);
    expect(hook).toMatch(/user\.email/);
    expect(hook).toMatch(/users\.noreply\.github\.com/);
  });

  it('removes its managed keys when identity is absent (authoritative removal)', () => {
    // Both absence paths (no PEM; partial identity) must route to the
    // same wholesale removal — a dropped identity never leaves a stale
    // credential path behind.
    expect(hook).toMatch(/remove_managed/);
    expect(hook).toMatch(/MANAGED_KEYS=/);
    const removals = hook.match(/remove_managed/g) ?? [];
    expect(removals.length).toBeGreaterThanOrEqual(2);
  });

  it('treats a partial identity as absent (never wire half an identity)', () => {
    expect(hook).toMatch(/partial identity treated as absent/);
  });
});

describe('VS GitHub identity (fleet-ops-e5o.5): wrapper contract', () => {
  it('is env-config only (no config file owns identity)', () => {
    expect(wrapper).toMatch(/GH_APP_ID/);
    expect(wrapper).toMatch(/GH_APP_SLUG/);
    expect(wrapper).toMatch(/GH_APP_PEM_PATH/);
    // No identity file discovery outside the bundle delivery contract.
    expect(wrapper).not.toMatch(/gh-app\.env/);
  });

  it('anchors TLS to the PUBLIC CA bundle, never SSL_CERT_FILE (poisoning immunity)', () => {
    // The composition's 04- hook points SSL_CERT_FILE at the VS internal
    // CA (right for the gateway, wrong for api.github.com). The wrapper
    // must build an explicit public context and must never READ the env
    // var (comments legitimately document the hazard — the code must not
    // rely on it).
    expect(wrapper).toMatch(/create_default_context\(cafile=/);
    expect(wrapper).not.toMatch(/environ[^)]*SSL_CERT_FILE|SSL_CERT_FILE[^)]*environ/);
    expect(wrapper).not.toMatch(/os\.environ\.get\(["']SSL_CERT_FILE/);
  });

  it('signs with PyJWT when present, openssl dgst fallback otherwise (zero-dep)', () => {
    expect(wrapper).toMatch(/import jwt/);
    expect(wrapper).toMatch(/openssl.*dgst.*sha256|dgst.*-sha256/);
  });

  it('never prints secrets in the evidence path (whoami shape)', () => {
    // whoami prints names/ids only; the token subcommand is the ONLY
    // secret-printing surface (it exists to feed tooling, like the
    // origin pattern), and api/cred never echo credentials. The whoami
    // slice is bounded by cmd_whoami..cmd_token; "token expires" is a
    // timestamp label, not the secret.
    const whoami = wrapper.slice(wrapper.indexOf('def cmd_whoami'), wrapper.indexOf('def cmd_token'));
    expect(whoami).toMatch(/app:|bot login:|installation:|repos:/);
    expect(whoami).not.toMatch(/print\(f?"[^"]*(password|ghs_)/i);
  });

  it('supports the git credential helper mode (mint-on-demand, no storage)', () => {
    expect(wrapper).toMatch(/def cmd_cred/);
    // The wrapper answers git's credential protocol: username is the
    // App's [bot] login, password the minted token (never stored).
    expect(wrapper).toMatch(/username=\{cfg\['slug'\]\}\[bot\]/);
  });
});

describe('VS GitHub identity (fleet-ops-e5o.5): fleet-agnostic content (kh1)', () => {
  it('wrapper, hook, and doc carry no origin-fleet names', () => {
    for (const [label, blob] of [
      ['wrapper', wrapper],
      ['hook', hook],
      ['usage doc', usageDoc],
    ] as Array<[string, string]>) {
      expect(FLEET_NAME_RE.test(blob), `${label} carries an origin-fleet name`).toBe(false);
    }
  });
});

describe('VS GitHub identity (fleet-ops-e5o.5): behavioral proof (mock API + real RSA)', () => {
  // Drives the wrapper end to end against a loopback mock of the GitHub
  // API: the JWT mint (RS256, real key, both signing paths), the
  // installation-token mint, whoami, and the credential-helper mode.
  // No real credential is touched; the wrapper's API root is pointed at
  // the loopback via its CI-only override env (GH_API_ROOT).
  it('mints and authenticates against a mock installation', () => {
    const script = path.join(repoRoot, 'scripts/vs-github-identity.py');
    const out = execFileSync('node', [path.join(here, 'helpers', 'vs-github-identity.e2e.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, VS_GH_WRAPPER: script },
      timeout: 120_000,
    });
    // The harness prints PASS lines; assert the full chain ran.
    expect(out).toMatch(/PASS pyjwt-signing/);
    expect(out).toMatch(/PASS openssl-fallback-signing/);
    expect(out).toMatch(/PASS token-mint/);
    expect(out).toMatch(/PASS whoami-shape/);
    expect(out).toMatch(/PASS cred-helper/);
    expect(out).toMatch(/PASS tls-poisoning-immunity/);
  }, 180_000);
});
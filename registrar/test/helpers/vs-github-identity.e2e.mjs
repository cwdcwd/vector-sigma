#!/usr/bin/env node
/**
 * vs-github-identity behavioral harness (fleet-ops-e5o.5).
 *
 * Drives the REAL wrapper (images/common/bin/vs-github-identity.py) end to end
 * against a loopback mock of the GitHub API with a REAL RSA keypair
 * (openssl-generated per run): proves the JWT mint (RS256, both
 * signing paths), the installation-token mint, whoami's shape, the
 * credential-helper mode, and TLS-poisoning immunity (SSL_CERT_FILE
 * pointed at garbage must not break calls — the wrapper anchors to the
 * public CA bundle by construction). No real credential is touched;
 * the wrapper's API root is pointed at the loopback via its CI-only
 * override env (GH_API_ROOT).
 *
 * Prints one PASS line per proven fact (the test asserts them all).
 * Exits non-zero on the first failure with a FAIL line naming it.
 *
 * Also proves the FAIL-CLOSED contract on broken identity (AC3,
 * fleet-ops-1py.47.2): missing/invalid GH_APP_ID, invalid GH_APP_SLUG,
 * a PEM path that was never delivered, and garbage PEM content must all
 * die safely — non-zero exit, the failure named on stderr, an empty
 * success stdout, no API call attempted, and never a byte of the
 * fixture key in any output. All probe inputs are synthetic.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const WRAPPER = process.env.VS_GH_WRAPPER || path.join(import.meta.dirname, '..', '..', 'scripts', 'vs-github-identity.py');

if (!fs.existsSync(WRAPPER)) {
  console.error(`FAIL wrapper-not-found ${WRAPPER}`);
  process.exit(1);
}

// ── Real RSA keypair (openssl, per run) ─────────────────────────────────
const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-gh-identity-'));
const keyPath = path.join(sb, 'app.pem');
execFileSync('openssl', ['genrsa', '-out', keyPath, '2048'], { stdio: 'pipe' });
const pub = execFileSync('openssl', ['rsa', '-in', keyPath, '-pubout'], { encoding: 'utf8' });

// ── Mock GitHub API ─────────────────────────────────────────────────────
const calls = [];
let wrongTokenScope = false;
const srv = http.createServer((req, res) => {
  calls.push({ method: req.method, url: req.url, headers: req.headers });
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (req.method === 'GET' && req.url === '/app') {
    return send(200, { name: 'VectorSigma-Wheeljack', slug: 'vectorsigma-wheeljack', id: 5137401 });
  }
  if (req.method === 'GET' && req.url === '/app/installations') {
    return send(200, [{ id: 99, account: { login: 'cwdcwd' } }]);
  }
  if (req.method === 'POST' && req.url === '/app/installations/99/access_tokens') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const requestedRepositories = JSON.parse(body);
      calls[calls.length - 1].body = requestedRepositories;
      send(201, {
        token: 'ghs_mock_token_for_ci',
        expires_at: '2027-01-01T00:00:00Z',
        repositories: [{ full_name: wrongTokenScope ? 'cwdcwd/other-repo' : 'cwdcwd/vector-sigma' }],
      });
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/installation/repositories') {
    return send(200, {
      total_count: 1,
      repositories: [{ full_name: 'cwdcwd/vector-sigma' }],
    });
  }
  if (req.url.startsWith('/repos/cwdcwd/vector-sigma')) {
    return send(200, { full_name: 'cwdcwd/vector-sigma' });
  }
  send(404, { message: 'no' });
});
await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
const port = srv.address().port;

// ── Wrapper invocation helper ───────────────────────────────────────────
// ASYNC spawn (never spawnSync): the mock server runs on THIS process's
// event loop, and a synchronous spawn would block it — the wrapper's
// connections would sit in the accept backlog with nobody home, and
// every call would time out (proven the hard way).
import { spawn } from 'node:child_process';
function run(args, extraEnv, stdin) {
  const env = {
    ...process.env,
    GH_APP_ID: '5137401',
    GH_APP_SLUG: 'vectorsigma-wheeljack',
    GH_APP_PEM_PATH: keyPath,
    GH_API_ROOT: `http://127.0.0.1:${port}`,
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const p = spawn('python3', [WRAPPER, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    // `out` combines both streams (the failure channels read together);
    // `stdout` stays separate so the negative probes can assert the
    // SUCCESS channel is silent when config breaks.
    let out = '';
    let stdout = '';
    p.stdout.on('data', (d) => { out += d; stdout += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => resolve({ rc: -1, out: String(e), stdout: '' }));
    p.on('close', (code) => resolve({ rc: code, out, stdout }));
    if (stdin) p.stdin.end(stdin); else p.stdin.end();
  });
}

let failures = 0;
function pass(name) { console.log(`PASS ${name}`); }
function fail(name, detail) { console.error(`FAIL ${name} ${detail}`); failures++; }
const MAXDETAIL = Number(process.env.VS_GH_DEBUG ? 3000 : 300);

// ── 1: whoami (pyjwt path) — token mint + identity shape ────────────────
{
  // TLS poisoning probe FIRST: garbage in SSL_CERT_FILE rides the env for
  // every call below. A wrapper that trusted SSL_CERT_FILE would fail
  // here; the wrapper anchors to the public CA bundle by construction.
  fs.writeFileSync(path.join(sb, 'garbage-ca.pem'), 'NOT A CERT');
  const r = await run(['whoami'], { SSL_CERT_FILE: path.join(sb, 'garbage-ca.pem') });
  const installationRepos = calls.filter((call) => call.url === '/installation/repositories').at(-1);
  if (r.rc === 0 && /bot login:\s+vectorsigma-wheeljack\[bot\]/.test(r.out)
      && /installation: 99/.test(r.out) && /cwdcwd\/vector-sigma verified/.test(r.out)
      && installationRepos?.headers.authorization?.startsWith('token ghs_mock_token_for_ci')) {
    pass('whoami-shape');
  } else {
    fail('whoami-shape', JSON.stringify(r).slice(0, MAXDETAIL));
  }
  if (r.rc === 0) pass('tls-poisoning-immunity');
  else fail('tls-poisoning-immunity', 'wrapper failed with poisoned SSL_CERT_FILE');
}

// ── 2: token mint ───────────────────────────────────────────────────────
{
  const r = await run(['token']);
  const mint = calls.filter((call) => call.method === 'POST' && call.url === '/app/installations/99/access_tokens').at(-1);
  if (r.rc === 0 && r.out.includes('ghs_mock_token_for_ci')
      && JSON.stringify(mint?.body) === JSON.stringify({ repositories: ['vector-sigma'] })) {
    pass('token-mint-repository-scope');
  } else {
    fail('token-mint-repository-scope', JSON.stringify({ result: r, request: mint?.body }).slice(0, MAXDETAIL));
  }
}

// ── 2b: fail closed if GitHub reports a token scope broader than requested ──
{
  wrongTokenScope = true;
  const r = await run(['token']);
  wrongTokenScope = false;
  if (r.rc !== 0 && /not restricted to cwdcwd\/vector-sigma/.test(r.out)) {
    pass('token-scope-response-validation');
  } else {
    fail('token-scope-response-validation', JSON.stringify(r).slice(0, MAXDETAIL));
  }
}

// ── 3: JWT verification (RS256, real key, pyjwt path) ───────────────────
{
  const bearerCall = calls.find((c) => (c.headers['authorization'] || '').startsWith('Bearer ey'));
  if (!bearerCall) {
    fail('pyjwt-signing', 'no Bearer JWT reached the mock');
  } else {
    const jwtMod = (() => { try { return require('jwt-decode'); } catch { return null; } })();
    // Verify RS256 against the real public key using openssl (no jwt lib
    // needed in the harness): decode the segments and check the signature.
    const tok = bearerCall.headers.authorization.split(' ')[1];
    const [h, b, s] = tok.split('.');
    const signed = `${h}.${b}`;
    const sigFile = path.join(sb, 'sig.bin');
    fs.writeFileSync(sigFile, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    const pubFile = path.join(sb, 'pub.pem');
    fs.writeFileSync(pubFile, pub);
    const v = spawnSync('openssl', ['dgst', '-sha256', '-verify', pubFile, '-signature', sigFile],
      { input: signed, encoding: 'utf8' });
    if (v.status === 0) pass('pyjwt-signing');
    else fail('pyjwt-signing', v.stderr.slice(0, 200));
  }
}

// ── 4: openssl-fallback signing (jwt module blocked) ────────────────────
{
  const blockDir = path.join(sb, 'nopyjwt');
  fs.mkdirSync(blockDir, { recursive: true });
  fs.writeFileSync(path.join(blockDir, 'jwt.py'), "raise ImportError('blocked for test')\n");
  const before = calls.length;
  const r = await run(['token'], { PYTHONPATH: blockDir });
  if (r.rc === 0 && r.out.includes('ghs_mock_token_for_ci')) {
    // Verify the fallback JWT signature too
    const bearerCall = calls.slice(before).find((c) => (c.headers['authorization'] || '').startsWith('Bearer ey'));
    if (!bearerCall) fail('openssl-fallback-signing', 'no Bearer JWT from the fallback path');
    else {
      const tok = bearerCall.headers.authorization.split(' ')[1];
      const [h, b, s] = tok.split('.');
      const sigFile = path.join(sb, 'sig2.bin');
      fs.writeFileSync(sigFile, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
      const v = spawnSync('openssl', ['dgst', '-sha256', '-verify', path.join(sb, 'pub.pem'), '-signature', sigFile],
        { input: `${h}.${b}`, encoding: 'utf8' });
      if (v.status === 0) pass('openssl-fallback-signing');
      else fail('openssl-fallback-signing', v.stderr.slice(0, 200));
    }
  } else {
    fail('openssl-fallback-signing', JSON.stringify(r).slice(0, MAXDETAIL));
  }
}

// ── 5: credential helper mode ───────────────────────────────────────────
{
  const r = await run(['cred'], {}, 'protocol=https\nhost=github.com\n\n');
  if (r.rc === 0 && /username=vectorsigma-wheeljack\[bot\]/.test(r.out) && /password=ghs_mock_token_for_ci/.test(r.out)) {
    pass('cred-helper');
  } else {
    fail('cred-helper', JSON.stringify(r).slice(0, MAXDETAIL));
  }
}

// ── 6: missing/invalid credential-path probes (AC3, fleet-ops-1py.47.2) ──
// Every broken-identity configuration must fail SAFE at load time:
// non-zero exit, the failure named on stderr, NOTHING on the success
// stdout, no API call attempted, and never a byte of the fixture key in
// any output. All probe inputs are synthetic (empty env strings, bad
// formats, an absent path, a garbage PEM); no real credential is touched.
const negativeOutputs = [];
const callsBeforeNegative = calls.length;
function safeFail(r, mustMatch) {
  return r.rc !== 0 && mustMatch.test(r.out) && r.stdout === '';
}
{
  // 6a: identity env wholly absent (the undelivered-bundle case).
  const r = await run(['whoami'], { GH_APP_ID: '', GH_APP_SLUG: '' });
  negativeOutputs.push(r.out);
  if (safeFail(r, /GH_APP_ID and GH_APP_SLUG must be set/)
      && /No GitHub identity wired/.test(r.out)) pass('missing-app-identity');
  else fail('missing-app-identity', JSON.stringify(r).slice(0, MAXDETAIL));
}
{
  // 6b: malformed app ids (zero and non-numeric) must both be rejected.
  const r0 = await run(['whoami'], { GH_APP_ID: '0' });
  const rn = await run(['whoami'], { GH_APP_ID: 'not-numeric' });
  negativeOutputs.push(r0.out, rn.out);
  if (safeFail(r0, /GH_APP_ID must be a positive numeric/)
      && safeFail(rn, /GH_APP_ID must be a positive numeric/)) pass('invalid-app-id');
  else fail('invalid-app-id', JSON.stringify([r0, rn]).slice(0, MAXDETAIL));
}
{
  // 6c: a malformed slug format must be rejected before any mint.
  const r = await run(['whoami'], { GH_APP_SLUG: 'Bad_Slug!' });
  negativeOutputs.push(r.out);
  if (safeFail(r, /GH_APP_SLUG has an invalid format/)) pass('invalid-app-slug');
  else fail('invalid-app-slug', JSON.stringify(r).slice(0, MAXDETAIL));
}
{
  // 6d: the PEM never delivered at the configured path.
  const missing = path.join(sb, 'never-delivered.pem');
  const r = await run(['whoami'], { GH_APP_PEM_PATH: missing });
  negativeOutputs.push(r.out);
  if (safeFail(r, /App private key not found/) && r.out.includes(missing)) pass('missing-pem-path');
  else fail('missing-pem-path', JSON.stringify(r).slice(0, MAXDETAIL));
}
{
  // 6e: a PEM that holds garbage must fail closed on BOTH signing stacks —
  // the default one, and the openssl fallback with PyJWT import-blocked.
  const garbage = path.join(sb, 'garbage-key.pem');
  fs.writeFileSync(garbage, 'THIS IS NOT A PRIVATE KEY\n');
  const rJwt = await run(['whoami'], { GH_APP_PEM_PATH: garbage });
  const rFallback = await run(['whoami'], {
    GH_APP_PEM_PATH: garbage, PYTHONPATH: path.join(sb, 'nopyjwt'),
  });
  negativeOutputs.push(rJwt.out, rFallback.out);
  if ((rJwt.rc !== 0 && rJwt.stdout === '')
      && safeFail(rFallback, /openssl signing failed/)) pass('invalid-pem-content');
  else fail('invalid-pem-content', JSON.stringify({ rJwt, rFallback }).slice(0, MAXDETAIL));
}
{
  // 6f: aggregate — no fixture key byte anywhere in the failure output,
  // and not one API call attempted with a broken identity.
  const pemLines = fs.readFileSync(keyPath, 'utf8').split('\n')
    .filter((line) => line.length > 40 && !line.startsWith('-----'));
  const blob = negativeOutputs.join('\n');
  const leaked = pemLines.filter((line) => blob.includes(line));
  const attempted = calls.length - callsBeforeNegative;
  if (pemLines.length > 0 && leaked.length === 0 && attempted === 0) pass('negative-probe-redaction');
  else fail('negative-probe-redaction', JSON.stringify({ leaked: leaked.length, attempted }));
}

srv.close();
fs.rmSync(sb, { recursive: true, force: true });
if (failures > 0) process.exit(1);
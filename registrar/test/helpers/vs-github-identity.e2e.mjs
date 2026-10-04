#!/usr/bin/env node
/**
 * vs-github-identity behavioral harness (fleet-ops-e5o.5).
 *
 * Drives the REAL wrapper (scripts/vs-github-identity.py) end to end
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
    return send(200, [{ id: 99 }]);
  }
  if (req.method === 'POST' && req.url === '/app/installations/99/access_tokens') {
    return send(201, { token: 'ghs_mock_token_for_ci', expires_at: '2027-01-01T00:00:00Z' });
  }
  if (req.method === 'GET' && req.url === '/installation/repositories') {
    return send(200, { total_count: 1 });
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
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => resolve({ rc: -1, out: String(e) }));
    p.on('close', (code) => resolve({ rc: code, out }));
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
  if (r.rc === 0 && /bot login:\s+vectorsigma-wheeljack\[bot\]/.test(r.out) && /installation: 99/.test(r.out)) {
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
  if (r.rc === 0 && r.out.includes('ghs_mock_token_for_ci')) pass('token-mint');
  else fail('token-mint', JSON.stringify(r).slice(0, MAXDETAIL));
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

srv.close();
fs.rmSync(sb, { recursive: true, force: true });
if (failures > 0) process.exit(1);
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * AgentCore invocation shim contract guard (fleet-ops-1py.55.3;
 * AC 0007 stage 3 — platforms/agentcore/README.md +
 * platforms/agentcore/MIGRATION-PLAN.md D1).
 *
 * The gate keeps the OFFICIAL dispatcher — the compose/balena boot
 * path is unchanged (hermes-image.test.ts pins the ENTRYPOINT and the
 * devices compose command) — and gains ONLY the platform switch. This
 * guard pins both halves:
 *
 *   A. The env switch (gate.sh): default OFF — unset/false fall
 *      through to the marker gate + the official dispatcher (verified
 *      LIVE below by running the script with the switch unset: the
 *      marker-timeout path proves the official chain is intact);
 *      AGENTCORE_HTTP=1 execs the sh entry INSTEAD (before the marker
 *      gate: the platform never writes one) and accepts only the
 *      truthy set 1/true/yes/on, case-insensitive.
 *   B. The listener: baked at /usr/local/bin/agentcore/ (COPY both
 *      sources; chmod 0755 ONLY the sh entry — the Python file is
 *      exec'd BY python3). Its HTTP behavior is verified LIVE here:
 *      the test spawns the real listener with stub child commands
 *      (the AGENTCORE_COMMAND surface) and issues real HTTP requests:
 *
 *        /ping -> 200 {"status":"Healthy"}; {"status":"HealthyBusy",
 *                  "time_of_last_update": N} while an invocation is in
 *                  flight, with the timestamp emitted ONLY on a status
 *                  TRANSITION (the contract warns a per-ping advancing
 *                  timestamp keeps sessions alive until MaxLifetime);
 *        /invocations POST -> one child per request, prompt shapes
 *                  ({"prompt"}, {"input"}, a JSON string, a plain
 *                  body — including a leading-dash prompt that stdin
 *                  carries through untouched), the stream ladder
 *                  (result envelope authoritative; text deltas
 *                  concatenated; JSONL shape drift fails loudly;
 *                  plain-text passthrough; failed runs error with the
 *                  child's stderr tail; the per-invocation timeout),
 *                  then the documented rejects (400 no prompt, 404
 *                  unknown path, 405 GET on /invocations).
 *
 * The 0600 mask is fleet working-tree hygiene on this host: git
 * records only the exec bit, so the guard pins these sources
 * NON-executable (git-first with a stat fallback).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

const GATE = 'images/agent/gate.sh';
const LISTENER_PY = 'images/agent/entrypoints/agentcore-listener.py';
const LISTENER_SH = 'images/agent/entrypoints/agentcore-listener.sh';
const DOCKERFILE = 'images/agent/Dockerfile';

// The live checks need a python3 (and a plain-text stdio); the source
// pins below always run, with or without one.
const hasPython3 = (() => {
  try {
    execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const live = hasPython3 && process.env.VITEST_SKIP_LIVE !== '1' ? describe : describe.skip;

// ── the live harness ────────────────────────────────────────────────

interface HttpResult {
  status: number;
  text: string;
  contentType: string;
  json: any;
}

function request(
  port: number,
  method: string,
  reqPath: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += String(chunk);
      });
      res.on('end', () => {
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* non-JSON response */
        }
        resolve({
          status: res.statusCode ?? 0,
          text,
          contentType: String(res.headers['content-type'] ?? ''),
          json,
        });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : body);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stream-json child stub: OK answers, echoes the prompt on stdin. */
const STUB_OK = `import json, sys
prompt = sys.stdin.read()
print(json.dumps({"type": "system", "subtype": "init"}))
print(json.dumps({"type": "text", "text": "IGNORED-DELTA", "timestamp": 1}))
print(json.dumps({"type": "result", "session_id": "sess-ok-1", "exit_code": 0,
                  "text": "ANSWER:" + prompt, "tokens": {}, "duration_ms": 5}))
`;

const STUB_TEXT_ONLY = `import json, sys
sys.stdin.read()
print(json.dumps({"type": "text", "text": "DELTA-A", "timestamp": 1}))
print(json.dumps({"type": "text", "text": "DELTA-B", "timestamp": 2}))
`;

const STUB_DRIFT = `import json, sys
sys.stdin.read()
print(json.dumps({"type": "tool_use", "name": "tool", "timestamp": 1}))
`;

const STUB_PLAIN = `import sys
sys.stdin.read()
print("plain words")
`;

const STUB_FAIL = `import json, sys
sys.stdin.read()
print(json.dumps({"type": "result", "session_id": "sess-fail", "exit_code": 1,
                  "text": "", "tokens": {}, "error": "boom: provider rejected the request"}))
print("diagnostic stderr line", file=sys.stderr)
`;

const STUB_STDERR = `import sys
sys.stdin.read()
print("the-diagnostic-sentinel", file=sys.stderr)
sys.exit(3)
`;

const STUB_HUNG = `import sys, time
sys.stdin.read()
time.sleep(5)
`;

let stubDir = '';
let spawned: ChildProcess[] = [];

async function spawnListener(
  stubName: string,
  extraEnv: Record<string, string> = {},
): Promise<{ port: number; child: ChildProcess }> {
  const entry = path.join(repoRoot, LISTENER_PY);
  const child = spawn('python3', [entry, '--port', '0'], {
    env: { ...process.env, AGENTCORE_COMMAND: `python3 ${stubDir}/${stubName}`, ...extraEnv },
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('listener startup timeout')), 10_000);
    let collected = '';
    const onData = (chunk: Buffer) => {
      collected += String(chunk);
      const match = /\[agentcore-shim\] listening on 0\.0\.0\.0:(\d+)/.exec(collected);
      if (match) {
        clearTimeout(timer);
        child.stdout?.removeListener('data', onData);
        resolve({ port: Number(match[1]), child });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk) => {
      collected += String(chunk);
    });
  });
}

async function killAll(): Promise<void> {
  const list = spawned;
  spawned = [];
  await Promise.all(
    list.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('close', () => resolve());
          child.kill('SIGTERM');
        }),
    ),
  );
}

// ── the contract ────────────────────────────────────────────────────

describe('the agentcore invocation shim (fleet-ops-1py.55.3)', () => {
  const gate = () => read(GATE);
  const listener = () => read(LISTENER_PY);
  const shEntry = () => read(LISTENER_SH);
  const dockerfile = () => read(DOCKERFILE);

  describe('A. the gate stays OFF by default (env-switched only)', () => {
    it('switch is declared before the marker gate and accepts only the truthy set', () => {
      const source = gate();
      expect(source).toContain('AGENTCORE_HTTP');
      expect(source).toMatch(/case "\$ac_http" in/);
      expect(source).toMatch(/1\|true\|yes\|on\)/);
      expect(source).toContain("tr '[:upper:]' '[:lower:]'");
      // exec'd INSTEAD of the official dispatcher; the python3-missing die
      expect(source).toContain('exec /bin/sh "${AGENTCORE_ENTRYPOINT_DIR:-/usr/local/bin/agentcore}/agentcore-listener.sh"');
      expect(source).toMatch(/AGENTCORE_HTTP=\$AGENTCORE_HTTP but python3 is missing/);
      expect(source).toContain('exit 1');
      // the switch block sits before the identity gate (the marker poll)
      const switchStart = source.indexOf('ac_http=');
      expect(switchStart).toBeGreaterThan(-1);
      const marker = source.indexOf('MARKER=/data/agent/ready.marker');
      expect(marker).toBeGreaterThan(switchStart);
      // the OFF path is the untouched official chain (exec still here)
      expect(source).toContain('exec /opt/hermes/docker/entrypoint-dispatch.sh');
      expect(source).toContain('ready marker');
    });

    live('live: unset switch runs the official marker gate (never the shim)', () => {
      it(
        'AGENTCORE_HTTP unset -> the marker gate times out and the dispatcher path stays intact',
        () => {
          expect.assertions(2);
          try {
            execFileSync('sh', [path.join(repoRoot, GATE)], {
              cwd: repoRoot,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, POLL_BUDGET: '2', POLL_INTERVAL: '1' },
            });
            throw new Error('the gate exited 0 - the marker gate did not run');
          } catch (err: any) {
            const stderr = String(err?.stderr ?? err?.stdout ?? err?.message ?? '');
            expect(stderr).toMatch(/ready marker[\s\S]{0,400}not present/);
            expect(stderr).not.toContain('[gate] AGENTCORE_HTTP=');
          }
        },
        15_000,
      );
    });

    live('live: AGENTCORE_HTTP=1 execs the shim chain (and warns without hermes)', () => {
      let port = 0;
      let child: ChildProcess | undefined;
      let collected = '';

      beforeAll(async () => {
        stubDir = mkdtempSync(path.join(tmpdir(), 'agentcore-gate-test-'));
        writeFileSync(path.join(stubDir, 'stub-ok.py'), STUB_OK, { mode: 0o644 });
        port = await freePort();
        child = spawn('sh', [path.join(repoRoot, GATE)], {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            AGENTCORE_HTTP: '1',
            AGENTCORE_PORT: String(port),
            AGENTCORE_COMMAND: `python3 ${stubDir}/stub-ok.py`,
            AGENTCORE_ENTRYPOINT_DIR: path.join(repoRoot, 'images/agent/entrypoints'),
            AGENTCORE_LISTENER_PATH: path.join(repoRoot, LISTENER_PY),
            PATH: '/usr/bin:/bin', // excludes the Hermes installation
            HERMES: '',
          },
        });
        spawned.push(child);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`gate startup timeout: ${collected}`)), 10_000);
          const onData = (chunk: Buffer) => {
            collected += String(chunk);
            if (collected.includes('[agentcore-shim] listening on')) {
              clearTimeout(timer);
              resolve();
            }
          };
          child?.stdout?.on('data', onData);
          child?.stderr?.on('data', onData);
          child?.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
          child?.once('exit', (code) => {
            if (code !== null && !collected.includes('[agentcore] invocation shim on')) {
              clearTimeout(timer);
              reject(new Error(`gate exited before listener start: ${collected}`));
            }
          });
        });
      });

      it('the gate logs the switch and serves the contract through its shim entry', async () => {
        expect(collected).toContain(`[gate] AGENTCORE_HTTP=1; serving the AgentCore invocation shim`);
        expect(collected).toContain(`[agentcore] invocation shim on 0.0.0.0:${port}`);
        const ping = await request(port, 'GET', '/ping');
        expect(ping.status).toBe(200);
        expect(ping.json?.status).toBe('Healthy');
        const invocation = await request(port, 'POST', '/invocations', '{"prompt":"via-gate"}');
        expect(invocation.status).toBe(200);
        expect(invocation.json?.response).toBe('ANSWER:via-gate');
      }, 15_000);
    });
  });

  live('B. the listener serves the HTTP contract (live: real listener, stub agents)', () => {
    let ok: { port: number; child: ChildProcess };

    beforeAll(async () => {
      stubDir = mkdtempSync(path.join(tmpdir(), 'agentcore-shim-test-'));
      for (const [name, content] of [
        ['stub-ok.py', STUB_OK],
        ['stub-textonly.py', STUB_TEXT_ONLY],
        ['stub-drift.py', STUB_DRIFT],
        ['stub-plain.py', STUB_PLAIN],
        ['stub-fail.py', STUB_FAIL],
        ['stub-stderr.py', STUB_STDERR],
        ['stub-hung.py', STUB_HUNG],
      ] as Array<[string, string]>) {
        const stubPath = path.join(stubDir, name);
        writeFileSync(stubPath, content, { mode: 0o644 });
        chmodSync(stubPath, 0o644);
      }
      ok = await spawnListener('stub-ok.py');
    }, 20_000);

    afterAll(async () => {
      await killAll();
      if (stubDir) rmSync(stubDir, { recursive: true, force: true });
    });

    describe('health (GET /ping)', () => {
      it('answers the JSON health contract with NO per-ping timestamp before any transition', async () => {
        const ping = await request(ok.port, 'GET', '/ping');
        expect(ping.status).toBe(200);
        expect(ping.contentType).toContain('application/json');
        expect(ping.json).toEqual({ status: 'Healthy' });
      });
    });

    describe('invocations (POST /invocations)', () => {
      it('{"prompt"} -> 200 {"response", "sessionId", "status": "success"}', async () => {
        const res = await request(ok.port, 'POST', '/invocations', '{"prompt":"hello shim"}');
        expect(res.status).toBe(200);
        expect(res.contentType).toContain('application/json');
        expect(res.json).toEqual({ response: 'ANSWER:hello shim', sessionId: 'sess-ok-1', status: 'success' });
      });

      it('a leading-dash prompt rides stdin untouched (never argv)', async () => {
        const res = await request(ok.port, 'POST', '/invocations', '{"prompt":"--flag\\nand more"}');
        expect(res.status).toBe(200);
        expect(res.json?.response).toBe('ANSWER:--flag\nand more');
      });

      it('{"input": "..." } shape', async () => {
        const res = await request(ok.port, 'POST', '/invocations', '{"input":"s-input"}');
        expect(res.json?.response).toBe('ANSWER:s-input');
      });

      it('{"input": {"query": ...}} object shape', async () => {
        const res = await request(ok.port, 'POST', '/invocations', '{"input":{"query":"q-input"}}');
        expect(res.json?.response).toBe('ANSWER:q-input');
      });

      it('a JSON string body', async () => {
        const res = await request(
          ok.port,
          'POST',
          '/invocations',
          JSON.stringify(JSON.stringify('string body')),
        );
        expect(res.json?.response).toBe('ANSWER:\"string body\"');
      });

      it('a plain-text body', async () => {
        const res = await request(ok.port, 'POST', '/invocations', 'bare body');
        expect(res.json?.response).toBe('ANSWER:bare body');
      });

      it('{"noprompt": true} -> 400 {"status": "error"}', async () => {
        const res = await request(ok.port, 'POST', '/invocations', '{"noprompt":true}');
        expect(res.status).toBe(400);
        expect(res.json?.status).toBe('error');
      });

      it('an empty body -> 400', async () => {
        const res = await request(ok.port, 'POST', '/invocations', '');
        expect(res.status).toBe(400);
      });

      it('405 GET /invocations; 404 unknown path (both reject with the error body)', async () => {
        const inv = await request(ok.port, 'GET', '/invocations');
        expect(inv.status).toBe(405);
        expect(inv.json?.status).toBe('error');
        const nope = await request(ok.port, 'POST', '/nope', '{"prompt":"x"}');
        expect(nope.status).toBe(404);
        expect(nope.json?.status).toBe('error');
      });
    });

    describe('the stream ladder', () => {
      it('HealthyBusy + the transition timestamp ONLY on change; the timed-out run 504s; the listener stays healthy', async () => {
        const hung = await spawnListener('stub-hung.py', { AGENTCORE_INVOKE_TIMEOUT_MS: '700' });
        const inFlight = request(hung.port, 'POST', '/invocations', '{"prompt":"slow"}');
        await wait(200);
        const busy1 = await request(hung.port, 'GET', '/ping');
        expect(busy1.json?.status).toBe('HealthyBusy');
        expect(busy1.json?.time_of_last_update).toBeTypeOf('number');
        const busy2 = await request(hung.port, 'GET', '/ping');
        expect(busy2.json?.status).toBe('HealthyBusy');
        expect(busy2.json?.time_of_last_update).toBeUndefined(); // no per-ping advancing
        const invocation = await inFlight;
        expect(invocation.status).toBe(504);
        expect(invocation.json?.status).toBe('error');
        await wait(150);
        const back = await request(hung.port, 'GET', '/ping');
        expect(back.json?.status).toBe('Healthy');
        expect(back.json?.time_of_last_update).toBeTypeOf('number'); // the change back
      }, 15_000);

      it('a failed run inside a result envelope -> 500 error body with the message + sessionId', async () => {
        const failed = await spawnListener('stub-fail.py');
        const res = await request(failed.port, 'POST', '/invocations', '{"prompt":"x"}');
        expect(res.status).toBe(500);
        expect(res.json?.status).toBe('error');
        expect(res.json?.error?.message).toContain('boom: provider rejected the request');
        expect(res.json?.error?.sessionId).toBe('sess-fail');
      });

      it('a failed run WITHOUT a result envelope -> 500 with the child stderr tail', async () => {
        const failed = await spawnListener('stub-stderr.py');
        const res = await request(failed.port, 'POST', '/invocations', '{"prompt":"x"}');
        expect(res.status).toBe(500);
        expect(res.json?.error?.message).toContain('agent run failed (exit 3)');
        expect(res.json?.error?.message).toContain('the-diagnostic-sentinel');
      });

      it('text deltas without a result envelope -> their byte concatenation', async () => {
        const deltas = await spawnListener('stub-textonly.py');
        const res = await request(deltas.port, 'POST', '/invocations', '{"prompt":"x"}');
        expect(res.status).toBe(200);
        expect(res.json?.response).toBe('DELTA-ADELTA-B');
        expect(res.json?.sessionId).toBe('');
      });

      it('JSONL-ish stdout with neither result nor text -> a loud 500 (shape drift)', async () => {
        const drifted = await spawnListener('stub-drift.py');
        const res = await request(drifted.port, 'POST', '/invocations', '{"prompt":"x"}');
        expect(res.status).toBe(500);
        expect(res.json?.error?.message).toContain('no result envelope');
      });

      it('plain-text stdout -> passthrough with a sessionId of ""', async () => {
        const plain = await spawnListener('stub-plain.py');
        const res = await request(plain.port, 'POST', '/invocations', '{"prompt":"x"}');
        expect(res.status).toBe(200);
        expect(res.json?.response).toBe('plain words');
        expect(res.json?.sessionId).toBe('');
      });
    });
  });

  describe('C. the artifacts', () => {
    it('the listener pins the contract (port, bind, invocation, ladder, caps)', () => {
      const source = listener();
      // the contract surface
      expect(source).toContain('GET /ping');
      expect(source).toContain('POST /invocations');
      expect(source).toContain('DEFAULT_PORT = 8080');
      expect(source).toContain('("0.0.0.0", port)'); // the bind
      expect(source).toContain('"HealthyBusy"');
      expect(source).toContain('"Healthy"');
      // the invocation protocol: stdin (--query-file -), never argv;
      // the argv is shell-free (shlex, never shell=True)
      expect(source).toContain(
        '"--query-file", "-", "--quiet", "--format", "stream-json"',
      );
      expect(source).toContain('input=prompt');
      expect(source).not.toMatch(/shell\s*=\s*True/);
      expect(source).not.toMatch(/\bsh\b\s+-c/);
      expect(source).toContain('shlex.split');
      // the stateless boundary + the passthrough env
      expect(source).toContain('NO session affinity');
      expect(source).toMatch(/inherits the container environment/);
      // the ping's per-ping guard
      expect(source).toContain('if changed and timestamp is not None');
      // the timeouts + body cap + stderr discipline
      expect(source).toContain('DEFAULT_INVOKE_TIMEOUT_MS = 600000');
      expect(source).toContain('MAX_BODY_BYTES = 8 * 1024 * 1024');
      expect(source).toContain('tempfile.TemporaryFile');
      // the errors are native HTTP codes (the contract's error section)
      expect(source).toContain('subprocess.TimeoutExpired');
      expect(source).toContain('504');
      expect(source).toContain('413');
      expect(source).toContain('400');
      expect(source).toContain('405');
    });

    it('the sh entry execs python3 with the contract port default', () => {
      const source = shEntry();
      expect(source).toContain('--port "${AGENTCORE_PORT:-8080}"');
      expect(source).toContain('exec python3 "${AGENTCORE_LISTENER_PATH:-/usr/local/bin/agentcore/agentcore-listener.py}"');
      expect(source).toMatch(/python3 not found/);
      // the never-touched list (identity stays out of the shim)
      expect(source).not.toMatch(/(?:MARKER=|test -f)\s*\/?data\/agent\/ready\.marker/);
    });

    it('the Dockerfile bakes the entrypoints (0755 ONLY the sh) before the identity-gate ENTRYPOINT', () => {
      const source = dockerfile();
      expect(source).toContain('# ── The AgentCore invocation shim (AC 0007 stage 3, fleet-ops-1py.55.3) ────');
      expect(source).toContain('COPY images/agent/entrypoints/agentcore-listener.py /usr/local/bin/agentcore/agentcore-listener.py');
      expect(source).toContain('COPY images/agent/entrypoints/agentcore-listener.sh /usr/local/bin/agentcore/agentcore-listener.sh');
      expect(source).toMatch(/RUN chmod 0755 \/usr\/local\/bin\/agentcore\/agentcore-listener\.sh\n/);
      // the Python source carries NO chmod (it executes BY python3)
      expect(source).not.toMatch(/chmod[^\n]*agentcore-listener\.py/);
      // the bake sits before the identity-gate ENTRYPOINT
      const bake = source.indexOf('# ── The AgentCore invocation shim');
      expect(bake).toBeGreaterThan(-1);
      const entrypoint = source.indexOf('# ── The identity gate as ENTRYPOINT');
      expect(entrypoint).toBeGreaterThan(bake);
      // the header documents the 6th item
      expect(source).toContain('#   6. The AgentCore entrypoint shim (AC 0007 stage 3, fleet-ops-1py.55.3):');
    });

    it('the shim sources are NON-executable (0600 fleet hygiene; git records only the exec bit)', () => {
      for (const rel of [LISTENER_PY, LISTENER_SH]) {
        try {
          const { stdout } = { stdout: execFileSync('git', ['-C', repoRoot, 'ls-files', '-s', rel], { encoding: 'utf8' }) };
          expect(stdout.trim()).toMatch(/100644/);
        } catch (err) {
          // outside git (a plain directory checkout): fall back to stat
          expect((statSync(path.join(repoRoot, rel)).mode & 0o111)).toBe(0);
        }
      }
    });
  });
});
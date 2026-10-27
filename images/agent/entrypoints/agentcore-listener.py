#!/usr/bin/env python3
"""AgentCore invocation shim - HTTP listener (fleet-ops-1py.55.3; AC 0007 stage 3).

The gate (images/agent/gate.sh) execs the sh entry beside this file when
the AGENTCORE_HTTP platform switch is set, INSTEAD of the official
entrypoint dispatcher: the listener is the runtime's PID 1 and serves the
AWS Bedrock AgentCore HTTP protocol contract
(https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/
runtime-http-protocol-contract.html; verified against the live page on
2026-10-26):

  * binds 0.0.0.0:8080 (the contract's host+port; arch is carried by the
    ARM64 catalog image, the shim adds no arch decision),
  * GET /ping -> 200 application/json {"status": "Healthy"} - or
    {"status": "HealthyBusy", "time_of_last_update": ...} while at least
    one invocation is in flight, which keeps the runtime session alive
    across a long agent turn. time_of_last_update is emitted ONLY when
    the status actually changed since the last ping: the contract warns
    that a timestamp advancing on every ping prevents the idle-session
    timeout from ever firing (sessions then persist until MaxLifetime
    and can exhaust the session quota), so this listener timestamps the
    TRANSITION and reports it once.
  * POST /invocations -> prompt extraction - {"prompt": "..."} (the
    contract's documented example), the {"input": ...} shape (a string,
    or an object keyed by prompt/query/message/text), a JSON string
    body, or the raw body as plain text - then ONE child process per
    request:

        hermes chat --query-file - --quiet --format stream-json

    with the prompt on the child's STDIN. That is the pinned CLI's
    machine contract (hermes_cli/stream_json.py + the CLI reference),
    run against the live v0.22.5 CLI on 2026-10-26 two ways: the success
    path (init / text deltas / terminal result envelope) and a provider
    failure (result envelope with exit_code 1 + an error message). The
    prompt rides stdin, never argv - a leading-dash prompt can't be
    mis-parsed as a flag and never lands in a process list. The child's
    JSONL is consumed per this ladder:

      1. a terminal "result" envelope is authoritative: its exit_code
         decides, its text is the answer, its session_id is echoed;
      2. a clean exit with text deltas but no result envelope: the
         deltas concatenated (the emitter's own byte-for-byte
         guarantee) -> success, sessionId empty;
      3. JSONL-ish stdout WITHOUT any result/text event, on a clean
         exit: shape drift -> fail loudly with a 500 (a silent 200
         would answer garbage);
      4. non-JSONL stdout on a clean exit: plain-text passthrough
         (the override surface is a stub-under-test or a plain-text
         worker; its stdout IS the answer; a warning is logged);
      5. a failed run without a result envelope: 500 with the child's
         stderr tail.

    The response is the contract's JSON form
    {"response": "...", "status": "success"} plus a sessionId field
    (correlation only). SSE responses are NOT served - the contract
    lists both as "as supported by the application".

Errors are native HTTP codes, no protocol envelope (the contract's
"Error handling" section: unlike A2A/MCP/AG-UI, HTTP returns errors
directly): 400 malformed/empty prompt, 413 oversized body, 404 unknown
path, 405 GET on /invocations, 504 run timeout, 500 failed run - each
with a small {"error": {"message": ...}, "status": "error"} body for
the runtime's CloudWatch story (the service maps any container 4xx/5xx
to its 424 RuntimeClientError surface).

Statelessness and boundary (deliberate, one artifact for every
platform):

  * One CLI run per invocation; NO session affinity - sessionId is the
    CLI session's id, correlation only. Session mapping is a documented
    extension point for the AgentCore CDK stage, not this shim.
  * The child inherits the container environment UNCHANGED - the shim
    adds nothing (no HERMES_HOME default, no bundle wiring). The
    AgentCore-side identity delivery is the migration plan's stage
    (platforms/agentcore/MIGRATION-PLAN.md), not this shim's.
  * The base command is AGENTCORE_COMMAND (boot-resolved argv via
    shlex.split - never a shell line) or the DEFAULT_COMMAND; the
    invocation protocol flags are appended by the shim either way.
  * The child's stderr goes to a temp file: never merged into an HTTP
    response; it reaches the log (stdout) and the tail lands only in
    an error body. The request body/prompt is NEVER logged - method,
    path, status, exit and duration are the only logged facts.
  * Sources keep the repo's 0600 working-tree mask; only the sh entry
    is exec'd (the Dockerfile chmods it 0755). This file is exec'd BY
    python3, so it needs no +x (and carries no chmod in the image).
"""

import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import cast

# The contract port (AWS: "Port: 8080"). Overridable via AGENTCORE_PORT
# for tests; the sh entry passes the env value through (default 8080) -
# deliberately NAMESPACED (never the bare PORT) so no sibling runtime's
# port key can re-wire this listener by accident.
DEFAULT_PORT = 8080

# The base command: the pinned CLI's chat surface. AGENTCORE_COMMAND
# replaces ONLY this argv prefix (boot-resolved, shlex-split); the
# invocation protocol flags are appended by the shim either way.
DEFAULT_COMMAND = "hermes chat"

# The invocation protocol, appended to the base command's argv: the
# --query-file form takes the prompt on STDIN (arbitrary text, nothing
# shell-interpreted, no argv parsing of the prompt); --format
# stream-json is the machine contract consumed below; --quiet is
# implied by --format but passed explicitly (the CLI reference form).
INVOCATION_ARGS = ("--query-file", "-", "--quiet", "--format", "stream-json")

# Invocation body cap: prompts are text; 8 MiB is generous and keeps a
# runaway client from pinning the listener's memory.
MAX_BODY_BYTES = 8 * 1024 * 1024

# The child's stderr tail that lands in an ERROR BODY (the full text is
# logged to stdout regardless).
STDERR_EXCERPT_CHARS = 2000

# Per-invocation ceiling; the AgentCore runtime side governs sessions
# independently (this default sits under its 15-minute ceiling).
DEFAULT_INVOKE_TIMEOUT_MS = 600000


def _env_int(name, default):
    """int env read; a bad value logs and falls back (shim stays up)."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        print("[agentcore-shim] %s=%r is not an int; using %d" % (name, raw, default), file=sys.stderr)
        return default


def _stderr_tail(captured_stderr):
    """The tail of the child's captured stderr ('' when empty)."""
    captured_stderr = (captured_stderr or "").strip()
    if not captured_stderr:
        return ""
    return captured_stderr[-STDERR_EXCERPT_CHARS:]


def extract_prompt(raw):
    """Invocations prompt extraction (see module docstring); None = reject."""
    if raw is None or not raw.strip():
        return None
    body = raw.decode("utf-8", errors="replace")
    try:
        req = json.loads(body)
    except ValueError:
        req = None
    if isinstance(req, str):
        return req if req.strip() else None
    if isinstance(req, dict):
        prompt = req.get("prompt")
        if isinstance(prompt, str):
            return prompt if prompt.strip() else None
        inp = req.get("input")
        if isinstance(inp, str):
            return inp if inp.strip() else None
        if isinstance(inp, dict):
            for key in ("prompt", "query", "message", "text"):
                value = inp.get(key)
                if isinstance(value, str) and value.strip():
                    return value
        return None
    if isinstance(req, str):
        return req.strip() if req.strip() else None
    return body.strip()


def respond_from_stream(exit_code, stdout_text, stderr_tail, log=lambda _m: None):
    """The JSONL -> HTTP response ladder (see module docstring).

    Returns (payload, http_status). Pure: no I/O; the caller feeds the
    child's captured stdout and the stderr TAIL. log is the shim's log
    sink for the soft (warning-bearing) paths.
    """
    result_event = None
    text_parts = []
    json_lines = 0
    other_lines = 0
    for raw_line in stdout_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            other_lines += 1
            continue
        json_lines += 1
        if not isinstance(event, dict):
            continue
        etype = event.get("type")
        if etype == "result" and result_event is None:
            result_event = event
        elif etype == "text" and isinstance(event.get("text"), str):
            text_parts.append(event["text"])

    # 1. The terminal result envelope is authoritative (the pinned
    #    emitter writes it exactly once, on success AND failure).
    if result_event is not None:
        text = str(result_event.get("text") or "")
        session_id = str(result_event.get("session_id") or "")
        try:
            code = int(result_event.get("exit_code") or 0)
        except (TypeError, ValueError):
            code = 0  # treat a malformed exit as success; the text still answers
        if code == 0:
            return ({"response": text, "sessionId": session_id, "status": "success"}, 200)
        message = str(result_event.get("error") or "")
        if not message:
            message = text  # the failure's own narration
        if not message:
            message = "agent run failed (exit %d)" % code
        return ({"error": {"message": message[:STDERR_EXCERPT_CHARS], "sessionId": session_id},
                 "status": "error"}, 500)

    # 2. Clean exit, text deltas, no result envelope: the deltas
    #    concatenated byte for byte (the emitter's contract for text
    #    events), sessionId unknown.
    if exit_code == 0 and text_parts:
        log("clean exit without a result envelope; %d text delta(s) concatenated" % len(text_parts))
        return ({"response": "".join(text_parts), "sessionId": "", "status": "success"}, 200)

    # 3. JSONL-ish stdout, no result and no text events: shape drift -
    #    fail loudly (an unmarked 200 would answer garbage).
    if json_lines:
        return ({"error": {"message": "agent stream carried %d JSONL event(s) but no result envelope "
                                      "(exit %d; CLI output-shape drift?)" % (json_lines, exit_code)},
                 "status": "error"}, 500)

    # 4. Non-JSONL stdout on a clean exit: plain-text passthrough.
    if exit_code == 0 and other_lines:
        log("clean exit with non-JSONL stdout; passing the plain text through")
        return ({"response": stdout_text.strip(), "sessionId": "", "status": "success"}, 200)

    # 5. A failed run without a result envelope: 500 with the stderr tail.
    message = "agent run failed (exit %d)" % exit_code + (": %s" % stderr_tail if stderr_tail else "")
    return ({"error": {"message": message}, "status": "error"}, 500)


class AgentCoreListener(ThreadingHTTPServer):
    """The contract server: per-request worker threads, PID 1 (the gate
    execed this path), carrying the invocation protocol's state."""

    # A SIGTERM tear-down must not be held hostage by a mid-flight child.
    daemon_threads = True

    def __init__(self, address, command_argv):
        super().__init__(address, InvocationHandler)
        self.command_argv = list(command_argv)
        self.state_lock = threading.Lock()
        self.in_flight: int = 0
        self.last_change_unix: int | None = None
        self.reported_status: str | None = None

    def begin_invocation(self):
        """The 0 -> 1 Healthy/HealthyBusy transition (ping timestamp source)."""
        with self.state_lock:
            self.in_flight += 1
            if self.in_flight == 1:
                self.last_change_unix = int(time.time())

    def end_invocation(self):
        with self.state_lock:
            self.in_flight -= 1
            if self.in_flight == 0:
                self.last_change_unix = int(time.time())


class InvocationHandler(BaseHTTPRequestHandler):
    """The HTTP surface: /ping GET + /invocations POST; everything else
    is a documented rejection. HTTP/1.1 with explicit Content-Length on
    EVERY response (keep-alive-safe framing)."""

    protocol_version = "HTTP/1.1"
    server_version = "vs-agentcore-shim"

    # The handler always runs against the AgentCoreListener above; the
    # call sites narrow self.server with a cast - the base class's
    # `server` attribute declaration stays untouched.

    def log_message(self, format, *args):
        # The shim's log stream is stdout. Method/path/status only - the
        # request body and the prompt are NEVER logged.
        sys.stdout.write("[agentcore-shim] %s %s\n" % (self.address_string(), format % args))
        sys.stdout.flush()

    def do_GET(self):
        path = self._path()
        if path == "/ping":
            self._send_json(200, self._ping_body())
            return
        if path == "/invocations":
            self._send_error_json(405, "the invocation contract is a POST (/invocations); /ping is a GET")
            return
        self._send_error_json(404, "unknown path %r (this shim serves POST /invocations and GET /ping)" % path)

    def do_POST(self):
        path = self._path()
        if path != "/invocations":
            self._drain_body()
            self._send_error_json(404, "unknown path %r (this shim serves POST /invocations and GET /ping)" % path)
            return
        length = self._content_length()
        if length is None:
            self._send_error_json(400, "missing or malformed Content-Length")
            return
        if length > MAX_BODY_BYTES:
            self.close_connection = True  # un-drained body poisons the keep-alive session
            self._send_error_json(413, "invocation body exceeds %d bytes" % MAX_BODY_BYTES)
            return
        try:
            raw = self.rfile.read(length)
        except (OSError, ValueError):
            self.close_connection = True
            return  # the client is gone; nothing to answer
        prompt = extract_prompt(raw)
        if prompt is None:
            self._send_error_json(400, 'no prompt found (expected {"prompt": ...}, the {"input": ...} '
                                       "shape, a JSON string, or a plain-text body; all non-empty)")
            return
        self._run_invocation(prompt)

    # ── internals ─────────────────────────────────────────────────────

    def _path(self):
        return self.path.split("?", 1)[0].rstrip("/") or "/"

    def _content_length(self):
        raw_header = self.headers.get("Content-Length")
        if not raw_header:
            return None
        try:
            return int(raw_header)
        except ValueError:
            return None

    def _drain_body(self):
        """Read and discard the declared body (keep-alive framing sanity)."""
        length = self._content_length()
        if length is not None and 0 < length <= MAX_BODY_BYTES:
            try:
                self.rfile.read(length)
            except (OSError, ValueError):
                self.close_connection = True

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True  # peer went away mid-response

    def _send_error_json(self, status, message, session_id=None):
        error = {"message": message}
        if session_id:
            error["sessionId"] = session_id
        self._send_json(status, {"error": error, "status": "error"})

    def _ping_body(self):
        server = cast(AgentCoreListener, self.server)
        with server.state_lock:
            busy = server.in_flight > 0
            status_word = "HealthyBusy" if busy else "Healthy"
            changed = server.reported_status != status_word
            if changed:
                server.reported_status = status_word
            timestamp = server.last_change_unix if changed else None
        body: dict[str, object] = {"status": status_word}
        # The contract's warning: a per-ping advancing timestamp keeps
        # sessions alive until MaxLifetime. Set ONLY on a real change.
        if changed and timestamp is not None:
            body["time_of_last_update"] = timestamp
        return body

    def _run_invocation(self, prompt):
        server = cast(AgentCoreListener, self.server)
        argv = list(server.command_argv) + list(INVOCATION_ARGS)
        timeout_ms = _env_int("AGENTCORE_INVOKE_TIMEOUT_MS", DEFAULT_INVOKE_TIMEOUT_MS)
        stderr_log = tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace")
        started = time.time()
        failure = None  # (payload, status) when the run never got a result
        server.begin_invocation()
        try:
            try:
                proc = subprocess.run(
                    argv,
                    input=prompt,  # the prompt rides stdin (--query-file -), never argv
                    stdout=subprocess.PIPE,
                    stderr=stderr_log,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=timeout_ms / 1000.0,
                )
                exit_code = proc.returncode
                stdout_text = proc.stdout or ""
            except subprocess.TimeoutExpired:
                failure = ({"error": {"message": "the agent run exceeded %d ms" % timeout_ms},
                            "status": "error"}, 504)
                exit_code, stdout_text = None, ""
            except OSError as exc:
                failure = ({"error": {"message": "the agent command could not start: %s" % exc},
                            "status": "error"}, 500)
                exit_code, stdout_text = None, ""
        finally:
            server.end_invocation()
            captured = ""
            try:
                stderr_log.seek(0)
                captured = stderr_log.read().strip()
            finally:
                stderr_log.close()
            if captured:
                print("[agentcore-shim] child stderr: %s" % captured)
        if failure is not None:
            self._send_json(failure[1], failure[0])
            return

        # Always log the run's facts (never the prompt).
        duration_ms = int((time.time() - started) * 1000)
        self.log_message('POST "%s" -> run exit=%d (duration_ms=%d)', self._path(), exit_code, duration_ms)

        payload, status = respond_from_stream(
            exit_code, stdout_text, _stderr_tail(captured), log=self._shim_log)
        self._send_json(status, payload)

    def _shim_log(self, message):
        print("[agentcore-shim] %s" % message)


def main(argv):
    """Boot: resolve --port (the default is the contract port 8080; 0 is
    an ephemeral test port), resolve the base command from
    AGENTCORE_COMMAND (a shlex argv, never a shell line), bind 0.0.0.0,
    and serve until SIGTERM/SIGINT."""
    port = _env_int("AGENTCORE_PORT", DEFAULT_PORT)
    if len(argv) >= 2 and argv[0] == "--port":
        try:
            port = int(argv[1])
        except ValueError:
            print("[agentcore-shim] --port %r is not an int" % argv[1], file=sys.stderr)
            return 2
        argv = argv[2:]
    if len(argv) >= 1 and argv[0] == "--port":
        print("[agentcore-shim] --port given twice", file=sys.stderr)
        return 2

    command = shlex.split(os.environ.get("AGENTCORE_COMMAND") or DEFAULT_COMMAND)
    if not command:
        print("[agentcore-shim] AGENTCORE_COMMAND resolved to an empty argv", file=sys.stderr)
        return 2

    server = AgentCoreListener(("0.0.0.0", port), command)

    def _shutdown(signum, frame):
        raise SystemExit(0)  # unwinds serve_forever; daemon_threads drops mid-flight children

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    print("[agentcore-shim] listening on 0.0.0.0:%d; base command: %s %s"
          % (server.server_address[1], " ".join(server.command_argv), " ".join(INVOCATION_ARGS)),
          flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except SystemExit:
        pass  # the signal handler's shutdown
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
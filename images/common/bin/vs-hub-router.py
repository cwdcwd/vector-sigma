"""vs-hub-router: the VS hub-assigned dispatch spool (design: queue conventions).

Three commands:
  vs-hub-router dispatch --queue-dir DIR [--file FILE]   validate + enqueue ONE message
  vs-hub-router serve   --queue-dir DIR [--once]         deliver pending, retry, park failures
  vs-hub-router show     --queue-dir DIR                 print the spool state as JSON
"""

import argparse
import json
import os
import re
import secrets
import socket
import sys
import time
import urllib.error
import urllib.request

# The ONLY network target in this script: the a2a-guard's outbound listener on
# loopback. A queued message is delivered as
#     POST <OUTBOUND_URL_BASE><target>
# which signs it with this agent's own mesh key and routes it through the
# mesh gateway — the exact path the runtime's own outbound a2a call takes.
# Everything below is transport only: this script holds no routing policy of
# its own, reads no tracker, writes no shared-queue state and stores no
# credential — the delivery target comes from the wiring hook's derived
# environment (bundle -> a2a.json -> hub_router_agent) and the bearer token
# is the guard's own outbound token, read from the boot-managed environment.
OUTBOUND_URL_BASE = "http://127.0.0.1:9902/peer/"

# Fleet-standard A2A agent-to-agent timeout (the managed a2a_agents value).
DEFAULT_TIMEOUT_S = 1200.0
POLL_SECONDS = 15.0
MAX_ATTEMPTS = 8
# Seconds between attempts, indexed by failures already recorded. A refused
# POST is a transient route problem (peer busy, gateway restarting), not a
# verdict — the message is retried with this schedule and only parked when
# the whole budget is spent, never dropped silently.
BACKOFF_SECONDS = (15.0, 60.0, 300.0, 900.0, 1800.0, 3600.0, 7200.0, 14400.0)

PENDING = "pending"
SENT = "sent"
DEAD = "dead"

# Peer names follow the fleet's agent naming: lowercase, digits, hyphens.
AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

ENVELOPE_SUFFIX = ".json"


def log(text):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), text, flush=True)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def validate_message(message):
    """A hub dispatch is a bare JSON-RPC invoke: method, no params, no response shape."""
    if not isinstance(message, dict):
        raise ValueError("the delivered payload must be a JSON-RPC message object")
    if message.get("jsonrpc") != "2.0":
        raise ValueError('"jsonrpc": "2.0" is required')
    method = message.get("method")
    if not isinstance(method, str) or not method.strip():
        raise ValueError('"method" must be a non-empty string')
    if "params" in message and message.get("params") not in (None, {}, []):
        raise ValueError("hubs send bare invokes: params must be empty or absent")
    if "result" in message or "error" in message:
        raise ValueError("the payload must be a request, not a response")
    if method.startswith("internal/"):
        raise ValueError("internal methods are refused")
    return message


def write_json(path, data):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def queue_dirs(queue_dir):
    for sub in (PENDING, SENT, DEAD):
        os.makedirs(os.path.join(queue_dir, sub), exist_ok=True)


def enqueue_message(queue_dir, message, target):
    """Validate, then atomically append one envelope to the pending spool."""
    validate_message(message)
    if not AGENT_RE.fullmatch(target or ""):
        raise ValueError(f"the routing target must be a bare peer name, got {target!r}")
    queue_dirs(queue_dir)
    stamp = f"{time.time_ns():016x}-{secrets.token_hex(6)}"
    now = now_iso()
    envelope = {
        "id": f"hub-{stamp}",
        "created_at": now,
        "updated_at": now,
        "target": target,
        "attempt": 0,
        "next_attempt_at": 0.0,
        "last_error": "",
        "message": message,
    }
    path = os.path.join(queue_dir, PENDING, stamp + ENVELOPE_SUFFIX)
    write_json(path, envelope)
    return envelope, path


def park_envelope(path, queue_dir, dest, reason=None, extra=None):
    """Move an envelope into sent/ or dead/ (same volume, atomic)."""
    if reason or extra:
        envelope = read_json(path)
        if envelope is not None:
            envelope["last_error"] = reason
            envelope["updated_at"] = now_iso()
            if extra:
                envelope.update(extra)
            try:
                write_json(path, envelope)
            except OSError as e:
                log(f"could not record envelope state before parking: {e}")
    dest_dir = os.path.join(queue_dir, dest, os.path.basename(path))
    try:
        os.replace(path, dest_dir)
    except OSError as e:
        log(f"WARN: could not park envelope in {dest}: {e}")


def deliver(envelope, token, timeout_s):
    """Deliver one message through the signed outbound peer route.

    Returns (delivered, detail). A read timeout after the POST counts as
    delivered: the peer works asynchronously and reports on the board.
    """
    payload = json.dumps(envelope["message"]).encode()
    request = urllib.request.Request(
        OUTBOUND_URL_BASE + envelope["target"],
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as r:
            r.read(256)
        return True, "ok"
    except socket.timeout:
        return True, "sent (read timeout after POST)"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:  # connect refused, DNS/SSL/other route failure
        return False, f"{type(e).__name__}: {str(e)[:120]}"


def serve_once(queue_dir, token, timeout_s, max_attempts, timestamp=None):
    """One delivery pass over the spool. Returns (delivered, retried, parked)."""
    queue_dirs(queue_dir)
    pending_dir = os.path.join(queue_dir, PENDING)
    timestamp = timestamp or time.time()
    delivered = retried = parked = 0
    for name in sorted(os.listdir(pending_dir)):
        if not name.endswith(ENVELOPE_SUFFIX):
            continue
        path = os.path.join(pending_dir, name)
        envelope = read_json(path)
        if envelope is None:
            log(f"WARN: unparseable envelope {name} — parking")
            parked += 1
            park_envelope(path, queue_dir, DEAD, "unparseable envelope")
            continue
        target = envelope.get("target") or ""
        message = envelope.get("message")
        try:
            validate_message(message)
            if not AGENT_RE.fullmatch(target):
                raise ValueError(f"invalid routing target {target!r}")
        except ValueError as e:
            log(f"WARN: envelope {name} refused at the gate: {e} — parking")
            parked += 1
            park_envelope(path, queue_dir, DEAD, f"rejected: {e}")
            continue
        if timestamp < float(envelope.get("next_attempt_at") or 0.0):
            continue
        delivered_ok, detail = deliver(envelope, token, timeout_s)
        attempt = int(envelope.get("attempt") or 0) + 1
        if delivered_ok:
            attempt_note = {"attempt": attempt, "updated_at": now_iso()}
            park_envelope(path, queue_dir, SENT, None, attempt_note)
            log(f"delivered {envelope.get('id')} -> {target} (attempt {attempt}): {detail}")
            delivered += 1
        elif attempt >= max_attempts:
            attempt_note = {"attempt": attempt, "updated_at": now_iso()}
            log(f"FAILED {envelope.get('id')} -> {target}: {detail} — parked after {attempt} attempt(s)")
            parked += 1
            park_envelope(path, queue_dir, DEAD, f"final: {detail}", attempt_note)
        else:
            wait_s = BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)]
            envelope["attempt"] = attempt
            envelope["next_attempt_at"] = timestamp + wait_s
            envelope["last_error"] = detail
            envelope["updated_at"] = now_iso()
            write_json(path, envelope)
            log(f"retry {envelope.get('id')} -> {target} in {wait_s:.0f}s: {detail}")
            retried += 1
    return delivered, retried, parked


def serve(queue_dir, token, timeout_s, poll_seconds, max_attempts, once=False):
    log(f"hub router serving: target={os.environ.get('VS_HUB_TARGET_AGENT', '')}")
    while True:
        serve_once(queue_dir, token, timeout_s, max_attempts)
        if once:
            return
        time.sleep(poll_seconds)


def show(queue_dir):
    summary = {PENDING: [], SENT: [], DEAD: []}
    for sub in summary:
        sub_dir = os.path.join(queue_dir, sub)
        names = sorted(os.listdir(sub_dir)) if os.path.isdir(sub_dir) else []
        for name in names:
            envelope = read_json(os.path.join(sub_dir, name))
            if envelope is None:
                summary[sub].append({"file": name, "unparseable": True})
                continue
            summary[sub].append({
                "file": name,
                "id": envelope.get("id"),
                "target": envelope.get("target"),
                "attempt": envelope.get("attempt"),
                "next_attempt_at": envelope.get("next_attempt_at"),
                "last_error": envelope.get("last_error"),
            })
    print(json.dumps(summary, indent=1))


def read_payload_arg(args):
    if args.file:
        with open(args.file) as f:
            return f.read()
    data = sys.stdin.read()
    if not data.strip():
        raise ValueError("no message on stdin (deliver the raw JSON-RPC message)")
    return data


def main(argv=None):
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("dispatch", "serve", "show"):
        p = sub.add_parser(name)
        p.add_argument("--queue-dir", default=os.environ.get("VS_HUB_QUEUE_DIR", ""), required=False)
        if name == "dispatch":
            p.add_argument("--file", default=None)
        if name == "serve":
            p.add_argument("--once", action="store_true")
    args = ap.parse_args(argv)

    if not args.queue_dir:
        print("no spool: pass --queue-dir or set VS_HUB_QUEUE_DIR", file=sys.stderr)
        return 2

    if args.cmd == "show":
        show(args.queue_dir)
        return 0

    if args.cmd == "dispatch":
        target = os.environ.get("VS_HUB_TARGET_AGENT", "").strip()
        raw = read_payload_arg(args)
        try:
            message = json.loads(raw)
        except ValueError as e:
            print(f"refused: not JSON ({e})", file=sys.stderr)
            return 2
        try:
            envelope, _ = enqueue_message(args.queue_dir, message, target)
        except ValueError as e:
            print(f"refused: {e}", file=sys.stderr)
            return 2
        log(f"queued {envelope['id']} -> {target}")
        return 0

    # serve: readiness-gated — no target or no outbound token, no routing.
    target = os.environ.get("VS_HUB_TARGET_AGENT", "").strip()
    token = os.environ.get("A2A_GUARD_OUTBOUND_TOKEN", "").strip()
    if not target or not AGENT_RE.fullmatch(target):
        print(f"refused: VS_HUB_TARGET_AGENT is not a bare peer name ({target!r})", file=sys.stderr)
        return 2
    if not token:
        print("refused: A2A_GUARD_OUTBOUND_TOKEN is not set (signed identity off)", file=sys.stderr)
        return 2
    serve(args.queue_dir, token, DEFAULT_TIMEOUT_S, POLL_SECONDS, MAX_ATTEMPTS, once=args.once)
    return 0


if __name__ == "__main__":
    sys.exit(main())
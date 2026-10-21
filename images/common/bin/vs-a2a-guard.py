#!/usr/bin/env python3
"""vs-a2a-guard: Ed25519-signed agent identity for Hermes A2A (docs/a2a-signed-identity.md).

A per-agent sidecar between Hermes and the mesh, supervised by s6 as the `a2a-guard` service and
configured by the 04-vs-a2a-wiring hook. Each agent owns one Ed25519 key pair generated on its own
data volume; the private key never leaves it. Peers know each other only by PUBLIC key (the
registrar-delivered `peer_keys`), so a compromised device leaks its own identity and nothing else.

  inbound   :9900          -> verify X-A2A-Sig against the peer registry -> forward to Hermes on
                              127.0.0.1:9901 with a LOCAL per-peer bearer token (A2A_PEER_TOKENS
                              entries generated on the device, never in a bundle)
  outbound  127.0.0.1:9902 -> Hermes's a2a_agents point here (/peer/<name>); the guard signs,
                              adds the agent's mesh key, forwards to the mesh edge, and rewrites
                              peer Agent Cards back to itself

The signature binds the message CONTENT, not the raw body: the LiteLLM gateway re-serializes
JSON-RPC (key order, added `configuration`, a new JSON-RPC id, dropped part mediaType) but keeps
messageId, contextId, role and text byte-identical. Signed string (UTF-8, newline-joined):

  a2a-guard/v1, kid, aud, ts, nonce, method-class, sha256(canonical content)

Header (single line): X-A2A-Sig: v1;kid=<sender>;aud=<receiver>;ts=<unix>;nonce=<b64url>;sig=<b64url>
Through the gateway it travels as `x-a2a-<receiver>-x-a2a-sig`, which LiteLLM forwards to the
backend as `x-a2a-sig` (convention forwarding; matches the agent name or id).

  vs-a2a-guard keygen --state-dir DIR          create key (idempotent), print public key
  vs-a2a-guard pubkey --state-dir DIR          print public key
  vs-a2a-guard serve  --config guard.json      run both listeners
  vs-a2a-guard sign   --state-dir DIR --kid K --aud A --body FILE   print a header value

Needs only the stdlib and `cryptography` (present in Hermes's venv). Same wire format as the
reference implementation it was proven with.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.client
import json
import logging
import os
import secrets
import signal
import socketserver
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

log = logging.getLogger("a2a-guard")

SCHEME = "a2a-guard/v1"
SIG_HEADER = "x-a2a-sig"
MAX_BODY = 1 << 20          # 1 MiB request cap
DEFAULT_SKEW = 300          # seconds either side of now
NONCE_TTL = 2 * DEFAULT_SKEW + 60

# JSON-RPC method spellings (A2A v1.0 PascalCase and v0.3 wire) -> signed method class.
# Only message-bearing methods are signable: they are all the fleet sends (Hermes a2a_call),
# and their content survives the gateway's re-serialization. Anything else fails closed.
METHOD_CLASS = {"SendMessage": "send", "message/send": "send",
                "SendStreamingMessage": "stream", "message/stream": "stream"}
# Hop-by-hop / framing headers never copied between hops.
_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
        "transfer-encoding", "upgrade", "host", "content-length"}


class Server(ThreadingHTTPServer):
    """ThreadingHTTPServer without HTTPServer.server_bind's socket.getfqdn() reverse-DNS
    lookup, which can stall startup for many seconds on a host with slow or hijacked DNS."""

    daemon_threads = True

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = str(self.server_address[0]), self.server_address[1]


class GuardError(Exception):
    """A request the guard refuses; `code` is the HTTP status to answer with."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


# ── keys ──────────────────────────────────────────────────────────────────────

def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def key_path(state_dir: Path) -> Path:
    return state_dir / "ed25519.key"


def keygen(state_dir: Path) -> Ed25519PrivateKey:
    """Load the host key, creating it (mode 0600, dir 0700) on first use. Never overwrites."""
    state_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(state_dir, 0o700)
    path = key_path(state_dir)
    if path.exists():
        return load_private_key(path)
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption())
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(pem)
    return key


def load_private_key(path: Path) -> Ed25519PrivateKey:
    if path.stat().st_mode & 0o077:
        raise GuardError(500, f"{path} is group/other readable; chmod 600 it")
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise GuardError(500, f"{path} is not an Ed25519 key")
    return key


def public_key_text(key: Ed25519PrivateKey) -> str:
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return _b64u(raw)


def fingerprint(public_text: str) -> str:
    return hashlib.sha256(_unb64u(public_text)).hexdigest()[:16]


def load_public_key(text: str) -> Ed25519PublicKey:
    raw = _unb64u(text)
    if len(raw) != 32:
        raise ValueError("Ed25519 public key must be 32 bytes")
    return Ed25519PublicKey.from_public_bytes(raw)


# ── canonical content + signature ─────────────────────────────────────────────

def method_class(method: Any) -> str:
    cls = METHOD_CLASS.get(method) if isinstance(method, str) else None
    if cls is None:
        raise GuardError(403, f"method {method!r} is not signable through a2a-guard")
    return cls


# Role spellings (v1.0 enum / v0.3 wire) -> signed role class.
ROLE_CLASS = {"ROLE_USER": "user", "user": "user", "ROLE_AGENT": "agent", "agent": "agent"}
# Every field a signable request may carry. Anything else is REFUSED rather than ignored, so no
# field outside the signed set can be altered under a replayed signature.
# `kind` is the v0.3 type tag; `configuration: {}` is what LiteLLM 1.105.1 adds in transit.
_RPC_KEYS = {"jsonrpc", "id", "method", "params"}
_PARAMS_KEYS = {"message", "configuration", "tenant"}
_MESSAGE_KEYS = {"messageId", "contextId", "taskId", "role", "parts", "kind"}
_PART_KEYS = {"text", "kind", "mediaType"}
# Hermes sends text parts as {"text", "mediaType": "text/plain"} and LiteLLM drops mediaType in
# transit, so it cannot be signed. It is accepted only as a plain-text type, so all an attacker
# could vary is the plain-text media label on text the signature still covers.
_TEXT_MEDIA_TYPES = {"text/plain", "text/markdown"}


def _empty(value: Any) -> bool:
    return value in (None, {}, [], "")


def canonical_content(rpc: dict) -> bytes:
    """The signed content of a message: ids, role class, tenant and the ordered text parts.

    Exactly these survive the gateway byte-for-byte (LiteLLM re-serializes the rest). Any other
    non-empty field is refused, not ignored. Non-text parts are refused too: their v0.3 and
    v1.0 shapes differ, so they would not verify after a version conversion, and the fleet
    sends text only."""
    # Top level: `id` is unsigned by necessity (the gateway replaces it), `method` is bound via the
    # method class, `jsonrpc` must be "2.0", and nothing else may ride along.
    if rpc.get("jsonrpc") != "2.0":
        raise GuardError(400, "jsonrpc must be \"2.0\"")
    extra = [k for k, v in rpc.items() if k not in _RPC_KEYS and not _empty(v)]
    params = rpc.get("params")
    message = params.get("message") if isinstance(params, dict) else None
    if not isinstance(message, dict):
        raise GuardError(400, "params.message missing")
    extra += [k for k, v in params.items() if k not in _PARAMS_KEYS and not _empty(v)]
    extra += [f"message.{k}" for k, v in message.items() if k not in _MESSAGE_KEYS and not _empty(v)]
    if not _empty(params.get("configuration")):
        extra.append("configuration")
    # `kind` is the v0.3 type tag. Its only valid value here is "message"; it is validated, not
    # signed, because v1.0 omits it and the gateway may convert versions.
    if message.get("kind", "message") != "message":
        raise GuardError(400, f"message.kind {message.get('kind')!r} not accepted")
    parts = message.get("parts")
    if not isinstance(parts, list) or not parts:
        raise GuardError(400, "message has no parts")
    texts = []
    for part in parts:
        if not isinstance(part, dict) or not isinstance(part.get("text"), str):
            raise GuardError(400, "only text parts can be signed")
        if part.get("kind", "text") != "text":
            raise GuardError(400, "only text parts can be signed")
        if not _empty(part.get("mediaType")) and part["mediaType"] not in _TEXT_MEDIA_TYPES:
            raise GuardError(400, f"text part mediaType {part['mediaType']!r} not accepted")
        extra += [f"part.{k}" for k, v in part.items() if k not in _PART_KEYS and not _empty(v)]
        texts.append(part["text"])
    if extra:
        raise GuardError(400, "unsigned fields present: " + ", ".join(sorted(set(extra))))
    role = ROLE_CLASS.get(message.get("role"))
    if role is None:
        raise GuardError(400, f"unknown message role {message.get('role')!r}")
    content = {"contextId": message.get("contextId") or "", "messageId": message.get("messageId") or "",
               "role": role, "taskId": message.get("taskId") or "", "tenant": params.get("tenant") or "",
               "text": texts}
    if not content["messageId"]:
        raise GuardError(400, "message.messageId missing")
    return json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def signing_input(kid: str, aud: str, ts: int, nonce: str, rpc: dict) -> bytes:
    digest = hashlib.sha256(canonical_content(rpc)).hexdigest()
    return "\n".join([SCHEME, kid, aud, str(ts), nonce, method_class(rpc.get("method")), digest]).encode("utf-8")


def sign(key: Ed25519PrivateKey, kid: str, aud: str, rpc: dict, now: Optional[float] = None) -> str:
    ts = int(now if now is not None else time.time())
    nonce = _b64u(secrets.token_bytes(16))
    sig = key.sign(signing_input(kid, aud, ts, nonce, rpc))
    return f"v1;kid={kid};aud={aud};ts={ts};nonce={nonce};sig={_b64u(sig)}"


def parse_header(value: str) -> dict:
    fields = dict(item.split("=", 1) for item in value.split(";")[1:] if "=" in item)
    if not value.startswith("v1;") or not all(fields.get(k) for k in ("kid", "aud", "ts", "nonce", "sig")):
        raise GuardError(401, "malformed X-A2A-Sig")
    return fields


class NonceCache:
    """Seen (kid, nonce) pairs inside the acceptance window; bounded by the window itself."""

    def __init__(self, ttl: int = NONCE_TTL):
        self.ttl, self._seen, self._lock = ttl, {}, threading.Lock()

    def check_and_add(self, kid: str, nonce: str, now: float) -> bool:
        with self._lock:
            for k in [k for k, exp in self._seen.items() if exp < now]:
                del self._seen[k]
            if (kid, nonce) in self._seen:
                return False
            self._seen[(kid, nonce)] = now + self.ttl
            return True


def verify(header_value: str, rpc: dict, registry: dict, me: str, nonces: NonceCache,
           skew: int = DEFAULT_SKEW, now: Optional[float] = None) -> str:
    """Return the verified sender name, or raise GuardError(401/403)."""
    now = time.time() if now is None else now
    f = parse_header(header_value)
    kid = f["kid"]
    if f["aud"] != me:
        raise GuardError(401, f"signature is for {f['aud']!r}, not {me!r}")
    try:
        ts = int(f["ts"])
    except ValueError as e:
        raise GuardError(401, "bad ts") from e
    if abs(now - ts) > skew:
        raise GuardError(401, "signature outside the time window (check NTP)")
    entry = registry.get(kid)
    if not entry:
        # Same answer as a bad signature, so :9900 is not a registry-membership oracle; the
        # specific reason goes to the guard's own log.
        log.warning("unknown signer %r", kid)
        raise GuardError(401, "bad signature")
    try:
        entry["key"].verify(_unb64u(f["sig"]), signing_input(kid, f["aud"], ts, f["nonce"], rpc))
    except (InvalidSignature, ValueError) as e:
        raise GuardError(401, "bad signature") from e
    if not nonces.check_and_add(kid, f["nonce"], now):
        raise GuardError(401, "replayed nonce")
    return kid


def load_bundle_registry(path: Path) -> tuple[dict, bool]:
    """a2a.json {"peer_keys": {name: "<b64url>"}, "strict": bool} -> (registry, strict).
    A malformed key is skipped (logged) rather than taking the whole registry down."""
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError("bundle a2a.json is not a JSON object")
    peer_keys = data.get("peer_keys")
    if peer_keys is None:
        peer_keys = {}  # absent: no signed peers (a legitimate bundle state)
    elif not isinstance(peer_keys, dict):
        raise ValueError("bundle peer_keys is not an object")  # malformed: keep the last good state
    out = {}
    for name, pub in peer_keys.items():
        try:
            out[name] = {"key": load_public_key(pub), "pub": pub}
        except (ValueError, TypeError):
            log.error("bundle peer_keys: ignoring malformed key for %r", name)
    return out, bool(data.get("strict", False))


def load_registry(path: Path) -> dict:
    """{"peers": {"agent-a": {"ed25519": "<b64url>"}, ...}} -> {name: {"key": Ed25519PublicKey, "pub": str}}"""
    data = json.loads(path.read_text())
    out = {}
    for name, entry in (data.get("peers") or {}).items():
        out[name] = {"key": load_public_key(entry["ed25519"]), "pub": entry["ed25519"]}
    return out


# ── config ────────────────────────────────────────────────────────────────────

class Config:
    """guard.json — written by the 04-vs-a2a-wiring hook; see docs/a2a-signed-identity.md."""

    def __init__(self, path: Path):
        raw = json.loads(path.read_text())
        base = path.parent
        rel = lambda p: (base / p) if not os.path.isabs(p) else Path(p)  # noqa: E731
        self.me: str = raw["agent_name"]
        self.state_dir = rel(raw.get("state_dir", "."))
        self.registry_path = rel(raw.get("registry", "a2a-keys.json"))
        self.inbound = raw.get("inbound") or {}
        self.outbound = raw.get("outbound") or {}
        self.skew = int(raw.get("max_skew_seconds", DEFAULT_SKEW))
        self.legacy_bearer = bool(raw.get("legacy_bearer", False))
        # Local secrets live in files next to the key, never in guard.json.
        self.local_tokens_path = self.state_dir / "local-peer-tokens.json"
        self.outbound_token_path = self.state_dir / "outbound-token"
        self.gateway_key_env = self.outbound.get("gateway_key_env", "A2A_OWN_IDENTITY_KEY")
        self.env_file = rel(raw["env_file"]) if raw.get("env_file") else None
        # VS bundle mode: peer public keys and the fleet `strict` switch come from the LIVE
        # registrar-delivered a2a.json (the registrant's watcher rewrites it on rotation), so
        # revocation and the strict flip land without a container recreate.
        self.bundle_a2a = rel(raw["bundle_a2a"]) if raw.get("bundle_a2a") else None
        self.reload_seconds = max(1, int(raw.get("reload_seconds", 15)))
        self.status_path = self.state_dir / "status.json"


def read_env_value(name: str, env_file: Optional[Path]) -> str:
    """Environment first, then a dotenv-style file (KEY=value, optional quotes)."""
    if os.environ.get(name):
        return os.environ[name].strip()
    if env_file and env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip("'\"")
    return ""


def read_secret_text(path: Path) -> str:
    """A local secret file: refused unless only its owner can read it (mode 0600 or tighter)."""
    if path.stat().st_mode & 0o077:
        raise GuardError(500, f"{path} is group/other readable; chmod 600 it")
    return path.read_text().strip()


def read_secret_json(path: Path) -> dict:
    return json.loads(read_secret_text(path))


# ── HTTP plumbing ─────────────────────────────────────────────────────────────

def _relay(handler: BaseHTTPRequestHandler, method: str, url: str, body: Optional[bytes], headers: dict,
           rewrite_card=None, timeout: float = 900) -> None:
    """Forward one request and stream the response back (SSE-safe)."""
    u = urllib.parse.urlsplit(url)
    conn_cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(u.hostname, u.port, timeout=timeout)
    path = urllib.parse.urlunsplit(("", "", u.path or "/", u.query, ""))
    try:
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        if rewrite_card is not None and resp.status == 200:
            payload = resp.read()
            try:
                payload = json.dumps(rewrite_card(json.loads(payload))).encode("utf-8")
            except ValueError:
                pass
            handler.send_response(resp.status)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(payload)))
            handler.end_headers()
            handler.wfile.write(payload)
            return
        handler.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() not in _HOP:
                handler.send_header(k, v)
        length = resp.getheader("Content-Length")
        if length is not None:
            handler.send_header("Content-Length", length)
            handler.end_headers()
            handler.wfile.write(resp.read())
        else:  # streamed (SSE): relay chunks as they arrive, then close
            handler.send_header("Connection", "close")
            handler.end_headers()
            while chunk := resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536):
                handler.wfile.write(chunk)
                handler.wfile.flush()
            handler.close_connection = True
    finally:
        conn.close()


def _jsonrpc_error(handler: BaseHTTPRequestHandler, code: int, message: str, rpc_id: Any = None) -> None:
    body = json.dumps({"jsonrpc": "2.0", "id": rpc_id,
                       "error": {"code": -32050 if code in (401, 403) else -32600, "message": f"a2a-guard: {message}"}}
                      ).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_json_body(handler: BaseHTTPRequestHandler) -> tuple[bytes, dict]:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0 or length > MAX_BODY:
        raise GuardError(413 if length > MAX_BODY else 400, "body missing or too large")
    raw = handler.rfile.read(length)
    try:
        rpc = json.loads(raw)
    except ValueError as e:
        raise GuardError(400, "body is not JSON") from e
    if not isinstance(rpc, dict):
        raise GuardError(400, "body is not a JSON-RPC object")
    return raw, rpc


def _copy_headers(src, drop: set) -> dict:
    return {k: v for k, v in src.items() if k.lower() not in _HOP and k.lower() not in drop}


class Guard:
    """Shared state for both listeners; registry and local tokens hot-reload on SIGHUP."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.key = load_private_key(key_path(cfg.state_dir))
        self.nonces = NonceCache(ttl=2 * cfg.skew + 60)
        self.counts = {"verified": 0, "legacy": 0, "refused": 0}
        self._source_mtime = None
        self.reload()

    def _source(self) -> Path:
        return self.cfg.bundle_a2a or self.cfg.registry_path

    def reload(self) -> None:
        if self.cfg.bundle_a2a:
            self.registry, strict = load_bundle_registry(self.cfg.bundle_a2a)
            if self.cfg.legacy_bearer == strict:
                log.warning("strict mode %s (from the bundle)", "ON" if strict else "OFF")
            self.cfg.legacy_bearer = not strict
        else:
            self.registry = load_registry(self.cfg.registry_path)
        self._source_mtime = self._source_stamp()
        self.local_tokens = read_secret_json(self.cfg.local_tokens_path) if self.cfg.local_tokens_path.exists() else {}
        self.outbound_token = (read_secret_text(self.cfg.outbound_token_path)
                               if self.cfg.outbound_token_path.exists() else "")
        log.info("loaded %d registry peers, %d local peer tokens", len(self.registry), len(self.local_tokens))

    def _source_stamp(self):
        """(mtime, inode, size): also catches an atomic replace within one mtime tick."""
        try:
            st = self._source().stat()
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_ino, st.st_size)

    def tick(self) -> None:
        """Reload when the key source changed (bundle rotations land live), then write status.
        Any reload failure keeps the last good registry and strict setting: the live bundle is
        delivered from outside, so a malformed one must never stop the guard."""
        stamp = self._source_stamp()
        if stamp != self._source_mtime:
            try:
                self.reload()
            except Exception as e:  # noqa: BLE001 - keep serving the last good state
                log.error("reload failed, keeping the previous registry: %s", e)
                self._source_mtime = stamp  # don't retry the same bad file every tick
        self.write_status()

    def write_status(self) -> None:
        """Readiness for the registrant to report (docs/a2a-signed-identity.md, Strict mode)."""
        status = {"schema": "vs.a2a-guard.status/1", "agent": self.cfg.me, "running": True,
                  "pid": os.getpid(), "strict": not self.cfg.legacy_bearer,
                  "peers": sorted(self.registry), "local_tokens": sorted(self.local_tokens),
                  "outbound_peers": sorted((self.cfg.outbound.get("peers") or {})
                                           if self.cfg.outbound.get("enabled", True) else {}),
                  "counts": dict(self.counts), "updated_at": int(time.time())}
        try:
            tmp = self.cfg.status_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(status))
            os.replace(tmp, self.cfg.status_path)
        except OSError as e:
            log.warning("could not write %s: %s", self.cfg.status_path, e)


def _point_card_at(url: str):
    """Rewrite an Agent Card's endpoints (legacy `url` + v1.0 supportedInterfaces) to `url`."""

    def rewrite(card: dict) -> dict:
        if isinstance(card.get("url"), str):
            card["url"] = url
        for iface in card.get("supportedInterfaces") or []:
            if isinstance(iface, dict) and iface.get("url"):
                iface["url"] = url
        return card

    return rewrite


def _is_card_path(path: str) -> bool:
    return urllib.parse.urlsplit(path).path.rstrip("/").endswith(
        ("/.well-known/agent-card.json", "/.well-known/agent.json"))


def _inbound_public_url(inbound: dict) -> str:
    """The URL this guard's served card advertises. Never derived from the request's Host header
    (attacker-controlled): the configured public_url, else the concrete listen address."""
    if inbound.get("public_url"):
        return inbound["public_url"]
    host = inbound.get("listen_host", "0.0.0.0")
    if host in ("0.0.0.0", "::", ""):
        return ""  # no safe default: cards are refused until public_url is configured
    return f"http://{host}:{int(inbound.get('listen_port', 9900))}/"


def make_inbound(guard: Guard):
    upstream = guard.cfg.inbound.get("upstream", "http://127.0.0.1:9901")
    public_url = _inbound_public_url(guard.cfg.inbound)

    class Inbound(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            log.debug("inbound %s " + fmt, self.client_address[0], *args)

        def do_GET(self):  # Agent Cards / health: public, never carry a peer credential upstream
            # GETs are public: no credential is ever forwarded upstream, in either mode (legacy
            # passthrough is for POST only). Hermes serves the card unauthenticated anyway; auth only
            # adds a served-agents list on / and /health. X-A2A-Verified-Peer is the guard's own
            # assertion and is stripped on every method.
            drop = {SIG_HEADER, "x-a2a-verified-peer", "authorization"}
            # The card must advertise THIS guard: the gateway posts to the URL in the backend's own
            # card, so a card naming Hermes's private port would route around (or break) the guard.
            if _is_card_path(self.path) and not public_url:
                log.error("refusing to serve an Agent Card: set inbound.public_url (listening on a wildcard)")
                return _jsonrpc_error(self, 503, "inbound.public_url not configured")
            _relay(self, "GET", upstream + self.path, None, _copy_headers(self.headers, drop),
                   rewrite_card=_point_card_at(public_url) if _is_card_path(self.path) else None)

        def do_POST(self):
            rpc_id = None
            try:
                raw, rpc = _read_json_body(self)
                rpc_id = rpc.get("id")
                sig = self.headers.get(SIG_HEADER)
                headers = _copy_headers(self.headers, {"authorization", SIG_HEADER, "x-a2a-verified-peer"})
                if sig:
                    peer = verify(sig, rpc, guard.registry, guard.cfg.me, guard.nonces, guard.cfg.skew)
                    token = guard.local_tokens.get(peer)
                    if not token:
                        raise GuardError(403, f"{peer!r} is verified but has no local token on this host")
                    headers["Authorization"] = f"Bearer {token}"
                    headers["X-A2A-Verified-Peer"] = peer
                    guard.counts["verified"] += 1
                    log.info("verified %s -> %s (%s)", peer, guard.cfg.me, method_class(rpc.get("method")))
                elif guard.cfg.legacy_bearer and self.headers.get("Authorization"):
                    headers["Authorization"] = self.headers["Authorization"]  # Hermes checks it, as before
                    guard.counts["legacy"] += 1
                    log.info("legacy bearer passthrough (unsigned) from %s", self.client_address[0])
                else:
                    raise GuardError(401, "unsigned request (no X-A2A-Sig)")
                headers["Content-Type"] = "application/json"
                _relay(self, "POST", upstream + self.path, raw, headers)
            except GuardError as e:
                log.warning("inbound refused: %s", e)
                guard.counts["refused"] += 1
                _jsonrpc_error(self, e.code, str(e), rpc_id)

    return Inbound


def make_outbound(guard: Guard):
    peers: dict = guard.cfg.outbound.get("peers") or {}
    listen_port = int(guard.cfg.outbound.get("listen_port", 9902))

    def gateway_key() -> str:
        return read_env_value(guard.cfg.gateway_key_env, guard.cfg.env_file)

    class Outbound(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            log.debug("outbound " + fmt, *args)

        def _route(self) -> tuple[str, dict, str]:
            parts = urllib.parse.urlsplit(self.path).path.split("/", 3)  # "", "peer", name, rest
            if len(parts) < 3 or parts[1] != "peer" or parts[2] not in peers:
                raise GuardError(404, "unknown peer route")
            if not guard.outbound_token or not hmac.compare_digest(
                    (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip(), guard.outbound_token):
                raise GuardError(401, "outbound token required")
            rest = "/" + parts[3] if len(parts) > 3 else ""
            return parts[2], peers[parts[2]], rest

        def _upstream_headers(self, peer: dict) -> dict:
            headers = _copy_headers(self.headers, {"authorization", SIG_HEADER})
            key = gateway_key()
            if peer.get("via_gateway", True):
                if not key:
                    raise GuardError(500, f"{guard.cfg.gateway_key_env} not set; cannot authenticate to the gateway")
                headers["Authorization"] = f"Bearer {key}"
            return headers

        def do_GET(self):
            try:
                name, peer, rest = self._route()
                local = f"http://127.0.0.1:{listen_port}/peer/{name}"  # Hermes posts back through us
                _relay(self, "GET", peer["url"].rstrip("/") + rest, None, self._upstream_headers(peer),
                       rewrite_card=_point_card_at(local) if _is_card_path(rest) else None)
            except GuardError as e:
                _jsonrpc_error(self, e.code, str(e))

        def do_POST(self):
            rpc_id = None
            try:
                name, peer, rest = self._route()
                raw, rpc = _read_json_body(self)
                rpc_id = rpc.get("id")
                value = sign(guard.key, guard.cfg.me, peer.get("aud", name), rpc)
                headers = self._upstream_headers(peer)
                headers["Content-Type"] = "application/json"
                if peer.get("gateway_agent_id"):  # LiteLLM convention forwarding -> x-a2a-sig at the backend
                    headers[f"x-a2a-{peer['gateway_agent_id']}-{SIG_HEADER}"] = value
                else:  # direct to a peer guard
                    headers[SIG_HEADER] = value
                _relay(self, "POST", peer["url"].rstrip("/") + rest, raw, headers)
            except GuardError as e:
                log.warning("outbound refused: %s", e)
                _jsonrpc_error(self, e.code, str(e), rpc_id)

    return Outbound


def serve(cfg: Config) -> None:
    guard = Guard(cfg)
    servers = []
    if cfg.inbound.get("enabled", True):
        host, port = cfg.inbound.get("listen_host", "0.0.0.0"), int(cfg.inbound.get("listen_port", 9900))
        servers.append(Server((host, port), make_inbound(guard)))
    if cfg.outbound.get("enabled", True):
        port = int(cfg.outbound.get("listen_port", 9902))
        servers.append(Server(("127.0.0.1", port), make_outbound(guard)))
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
        log.info("listening on %s:%d", *s.server_address[:2])
    signal.signal(signal.SIGHUP, lambda *_: guard.reload())
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    guard.write_status()
    try:
        while not stop.wait(cfg.reload_seconds):  # live key source + status heartbeat
            guard.tick()
    except KeyboardInterrupt:
        pass
    for s in servers:
        s.shutdown()
        s.server_close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("keygen", "pubkey"):
        p = sub.add_parser(name)
        p.add_argument("--state-dir", type=Path, required=True)
    p = sub.add_parser("serve")
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("-v", "--verbose", action="store_true")
    p = sub.add_parser("sign")
    p.add_argument("--state-dir", type=Path, required=True)
    p.add_argument("--kid", required=True)
    p.add_argument("--aud", required=True)
    p.add_argument("--body", type=Path, required=True)
    args = ap.parse_args(argv)
    if args.cmd == "keygen":
        pub = public_key_text(keygen(args.state_dir))
        print(json.dumps({"ed25519": pub, "fingerprint": fingerprint(pub)}))
    elif args.cmd == "pubkey":
        pub = public_key_text(load_private_key(key_path(args.state_dir)))
        print(json.dumps({"ed25519": pub, "fingerprint": fingerprint(pub)}))
    elif args.cmd == "sign":
        key = load_private_key(key_path(args.state_dir))
        print(sign(key, args.kid, args.aud, json.loads(args.body.read_text())))
    else:
        logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                            format="%(asctime)s a2a-guard %(levelname)s %(message)s")
        serve(Config(args.config))
    return 0


if __name__ == "__main__":
    sys.exit(main())

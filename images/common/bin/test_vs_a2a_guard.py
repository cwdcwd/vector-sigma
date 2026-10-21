#!/usr/bin/env python3
"""vs-a2a-guard: signature rules, gateway re-serialization tolerance, and both listeners live."""
import copy
import importlib.util
import json
import os
import stat
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("a2a_guard", ROOT / "vs-a2a-guard.py")
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

# Exactly what Hermes's tools._send_task sends (protocol.text_part adds mediaType; LiteLLM drops it).
HERMES_V1 = {"jsonrpc": "2.0", "id": "task-abc123", "method": "SendMessage",
             "params": {"message": {"role": "ROLE_USER",
                                    "parts": [{"text": "Hello \"peer\" — é ✓\nline2", "mediaType": "text/plain"}],
                                    "messageId": "5f0c1d2e3a4b", "contextId": "ctx-0011223344556677"}}}


def litellm_reserialized(rpc):
    """What LiteLLM 1.105.1 forwarded in the harness: new JSON-RPC id, added configuration,
    different key order; message ids/text untouched."""
    msg = rpc["params"]["message"]
    return json.loads(json.dumps({"method": rpc["method"], "params": {
        "message": {"messageId": msg["messageId"], "contextId": msg["contextId"], "role": msg["role"],
                    "parts": [{"text": p["text"]} for p in msg["parts"]]},  # mediaType dropped in transit
        "configuration": {}}, "id": "efff9ae5-new-id", "jsonrpc": "2.0"}))


def as_v03(rpc):
    """The v0.3 wire shape of the same message (kind fields, lower-case role, slash method)."""
    msg = rpc["params"]["message"]
    return {"jsonrpc": "2.0", "id": "x", "method": "message/send", "params": {"message": {
        "kind": "message", "role": "user", "messageId": msg["messageId"], "contextId": msg["contextId"],
        "parts": [{"kind": "text", "text": p["text"]} for p in msg["parts"]]}}}


class Keys(unittest.TestCase):
    def test_keygen_is_private_and_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            sd = Path(d) / "state"
            k1 = g.keygen(sd)
            mode = stat.S_IMODE(os.stat(g.key_path(sd)).st_mode)
            self.assertEqual(mode, 0o600)
            self.assertEqual(stat.S_IMODE(os.stat(sd).st_mode), 0o700)
            self.assertEqual(g.public_key_text(k1), g.public_key_text(g.keygen(sd)))  # never overwritten

    def test_world_readable_key_refused(self):
        with tempfile.TemporaryDirectory() as d:
            sd = Path(d)
            g.keygen(sd)
            os.chmod(g.key_path(sd), 0o644)
            with self.assertRaises(g.GuardError):
                g.load_private_key(g.key_path(sd))

    def test_world_readable_local_secrets_refused(self):
        # Both local secret files get the same 0600 rule as the key.
        with tempfile.TemporaryDirectory() as d:
            for name, content in (("outbound-token", "tok"), ("local-peer-tokens.json", "{}")):
                p = Path(d) / name
                p.write_text(content)
                os.chmod(p, 0o644)
                with self.subTest(name), self.assertRaisesRegex(g.GuardError, "chmod 600"):
                    g.read_secret_text(p)
                os.chmod(p, 0o600)
                self.assertEqual(g.read_secret_text(p), content)


class Signatures(unittest.TestCase):
    def setUp(self):
        self.alice = g.Ed25519PrivateKey.generate()
        self.mallory = g.Ed25519PrivateKey.generate()
        self.registry = {"alice": {"key": self.alice.public_key()}}
        self.nonces = g.NonceCache()

    def check(self, header, rpc, me="bob", now=None):
        return g.verify(header, rpc, self.registry, me, self.nonces, now=now)

    def test_roundtrip(self):
        self.assertEqual(self.check(g.sign(self.alice, "alice", "bob", HERMES_V1), HERMES_V1), "alice")

    def test_survives_gateway_reserialization(self):
        h = g.sign(self.alice, "alice", "bob", HERMES_V1)
        self.assertEqual(self.check(h, litellm_reserialized(HERMES_V1)), "alice")

    def test_survives_v1_to_v03_conversion(self):
        h = g.sign(self.alice, "alice", "bob", HERMES_V1)
        self.assertEqual(self.check(h, as_v03(HERMES_V1)), "alice")

    def test_tampered_text_rejected(self):
        h = g.sign(self.alice, "alice", "bob", HERMES_V1)
        bad = copy.deepcopy(HERMES_V1)
        bad["params"]["message"]["parts"][0]["text"] += " and rm -rf"
        with self.assertRaisesRegex(g.GuardError, "bad signature"):
            self.check(h, bad)

    def test_swapped_context_rejected(self):
        h = g.sign(self.alice, "alice", "bob", HERMES_V1)
        bad = copy.deepcopy(HERMES_V1)
        bad["params"]["message"]["contextId"] = "ctx-other"
        with self.assertRaises(g.GuardError):
            self.check(h, bad)

    def test_wrong_audience_rejected(self):
        h = g.sign(self.alice, "alice", "carol", HERMES_V1)
        with self.assertRaisesRegex(g.GuardError, "not 'bob'"):
            self.check(h, HERMES_V1)

    def test_forged_kid_rejected(self):  # mallory claims to be alice
        h = g.sign(self.mallory, "alice", "bob", HERMES_V1)
        with self.assertRaisesRegex(g.GuardError, "bad signature"):
            self.check(h, HERMES_V1)

    def test_unknown_signer_rejected_like_a_bad_signature(self):
        # Same 401 as a bad signature: :9900 must not answer "is X in the registry?"
        h = g.sign(self.mallory, "mallory", "bob", HERMES_V1)
        with self.assertRaisesRegex(g.GuardError, "bad signature") as ctx:
            self.check(h, HERMES_V1)
        self.assertEqual(ctx.exception.code, 401)

    def test_role_is_bound(self):
        h = g.sign(self.alice, "alice", "bob", HERMES_V1)
        flipped = copy.deepcopy(HERMES_V1)
        flipped["params"]["message"]["role"] = "ROLE_AGENT"
        with self.assertRaisesRegex(g.GuardError, "bad signature"):
            self.check(h, flipped)

    def test_fields_outside_the_signed_set_are_refused_not_ignored(self):
        # a captured header replayed with extra params / message / part fields
        # must not verify. Each mutation is refused outright, before any signature check.
        h = g.sign(self.alice, "alice", "bob", HERMES_V1)
        mutations = {
            "top-level extra": lambda r: r.__setitem__("x-admin", True),
            "params extra": lambda r: r["params"].__setitem__("pushNotification", {"url": "http://evil"}),
            "params metadata": lambda r: r["params"].__setitem__("metadata", {"x": 1}),
            "message metadata": lambda r: r["params"]["message"].__setitem__("metadata", {"priority": "root"}),
            "message extensions": lambda r: r["params"]["message"].__setitem__("extensions", ["x"]),
            "part extras": lambda r: r["params"]["message"]["parts"][0].__setitem__("metadata", {"x": 1}),
            "non-empty configuration": lambda r: r["params"].__setitem__("configuration", {"blocking": False}),
        }
        for label, mutate in mutations.items():
            rpc = copy.deepcopy(HERMES_V1)
            mutate(rpc)
            with self.subTest(label), self.assertRaisesRegex(g.GuardError, "unsigned fields"):
                self.check(h, rpc)

    def test_jsonrpc_version_required(self):
        h = g.sign(self.alice, "alice", "bob", HERMES_V1)
        for value in ("1.0", None):
            rpc = copy.deepcopy(HERMES_V1)
            rpc["jsonrpc"] = value
            with self.subTest(value), self.assertRaisesRegex(g.GuardError, "jsonrpc"):
                self.check(h, rpc)

    def test_empty_and_null_extras_are_tolerated(self):
        # LiteLLM adds `configuration: {}`; empty/None values carry nothing to tamper with.
        h = g.sign(self.alice, "alice", "bob", HERMES_V1)
        rpc = copy.deepcopy(HERMES_V1)
        rpc["params"]["metadata"] = None
        rpc["params"]["message"]["metadata"] = {}
        self.assertEqual(self.check(h, rpc), "alice")

    def test_tenant_is_bound(self):
        rpc = copy.deepcopy(HERMES_V1)
        rpc["params"]["tenant"] = "team-a"
        h = g.sign(self.alice, "alice", "bob", rpc)
        rpc["params"]["tenant"] = "team-b"
        with self.assertRaisesRegex(g.GuardError, "bad signature"):
            self.check(h, rpc)

    def test_type_tags_cannot_change_under_a_captured_signature(self):
        # message.kind flipped to "task" used to verify unchanged.
        h = g.sign(self.alice, "alice", "bob", as_v03(HERMES_V1))
        for label, mutate, err in (
                ("message.kind", lambda r: r["params"]["message"].__setitem__("kind", "task"), "message.kind"),
                ("part.kind", lambda r: r["params"]["message"]["parts"][0].__setitem__("kind", "data"), "text parts")):
            rpc = as_v03(HERMES_V1)
            mutate(rpc)
            with self.subTest(label), self.assertRaisesRegex(g.GuardError, err):
                self.check(h, rpc)
        self.assertEqual(self.check(h, as_v03(HERMES_V1)), "alice")  # untouched v0.3 still verifies

    def test_media_type_limited_to_plain_text(self):
        h = g.sign(self.alice, "alice", "bob", HERMES_V1)
        rpc = copy.deepcopy(HERMES_V1)
        rpc["params"]["message"]["parts"][0]["mediaType"] = "application/json"
        with self.assertRaisesRegex(g.GuardError, "mediaType"):
            self.check(h, rpc)

    def test_empty_parts_refused(self):
        rpc = copy.deepcopy(HERMES_V1)
        rpc["params"]["message"]["parts"] = []
        with self.assertRaisesRegex(g.GuardError, "no parts"):
            g.sign(self.alice, "alice", "bob", rpc)

    def test_replay_rejected(self):
        h = g.sign(self.alice, "alice", "bob", HERMES_V1)
        self.check(h, HERMES_V1)
        with self.assertRaisesRegex(g.GuardError, "replayed"):
            self.check(h, HERMES_V1)

    def test_stale_and_future_rejected(self):
        for offset in (-1000, 1000):
            h = g.sign(self.alice, "alice", "bob", HERMES_V1, now=1_700_000_000 + offset)
            with self.assertRaisesRegex(g.GuardError, "time window"):
                self.check(h, HERMES_V1, now=1_700_000_000)

    def test_method_is_bound(self):
        h = g.sign(self.alice, "alice", "bob", HERMES_V1)
        streamed = copy.deepcopy(HERMES_V1)
        streamed["method"] = "SendStreamingMessage"
        with self.assertRaises(g.GuardError):
            self.check(h, streamed)

    def test_unsignable_inputs_fail_closed(self):
        for rpc in ({**HERMES_V1, "method": "GetTask"},
                    {**HERMES_V1, "params": {"message": {**HERMES_V1["params"]["message"],
                                                         "parts": [{"file": {"uri": "x"}}]}}},
                    {**HERMES_V1, "params": {}}):
            with self.assertRaises(g.GuardError):
                g.sign(self.alice, "alice", "bob", rpc)

    def test_malformed_header(self):
        for value in ("", "v2;kid=a", "v1;kid=alice;aud=bob"):
            with self.assertRaises(g.GuardError):
                self.check(value, HERMES_V1)


class _Upstream(BaseHTTPRequestHandler):
    """Stand-in for Hermes (inbound side) or the gateway (outbound side): records and answers."""
    seen = []
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _reply(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        type(self).seen.append(("GET", self.path, dict(self.headers), b""))
        self._reply({"name": "peer", "url": "https://gateway.example/a2a/uuid-b",
                     "supportedInterfaces": [{"url": "https://gateway.example/a2a/uuid-b", "protocolBinding": "JSONRPC"}]})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        type(self).seen.append(("POST", self.path, dict(self.headers), body))
        self._reply({"jsonrpc": "2.0", "id": json.loads(body).get("id"), "result": {"ok": True}})


def _start(handler_cls):
    srv = g.Server(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _http(url, body=None, headers=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **(headers or {})},
                                 method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        with e:  # close the response it carries (Python 3.14 warns otherwise)
            return e.code, json.loads(e.read())


class Listeners(unittest.TestCase):
    """bob's inbound guard in front of a fake Hermes; alice's outbound guard aimed at bob directly."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.hermes = type("Hermes", (_Upstream,), {"seen": []})
        self.hermes_srv = _start(self.hermes)
        keys = {}
        for who in ("alice", "bob"):
            sd = base / who
            keys[who] = g.public_key_text(g.keygen(sd))
        registry = base / "a2a-keys.json"
        registry.write_text(json.dumps({"peers": {w: {"ed25519": k} for w, k in keys.items()}}))
        # bob: local token for alice (what bob's Hermes A2A_PEER_TOKENS would hold)
        tok = base / "bob" / "local-peer-tokens.json"
        tok.write_text(json.dumps({"alice": "local-alice-token"}))
        os.chmod(tok, 0o600)
        (base / "bob" / "guard.json").write_text(json.dumps({
            "agent_name": "bob", "state_dir": ".", "registry": "../a2a-keys.json",
            "inbound": {"upstream": f"http://127.0.0.1:{self.hermes_srv.server_address[1]}",
                        "public_url": "http://bob.test:9900/"}}))
        self.bob = g.Guard(g.Config(base / "bob" / "guard.json"))
        self.bob_srv = _start(g.make_inbound(self.bob))
        bob_url = f"http://127.0.0.1:{self.bob_srv.server_address[1]}"
        (base / "alice" / "outbound-token").write_text("alice-outbound")
        os.chmod(base / "alice" / "outbound-token", 0o600)
        (base / "alice" / "guard.json").write_text(json.dumps({
            "agent_name": "alice", "state_dir": ".", "registry": "../a2a-keys.json",
            "outbound": {"listen_port": 0, "peers": {"bob": {"url": bob_url, "via_gateway": False}}}}))
        self.alice = g.Guard(g.Config(base / "alice" / "guard.json"))
        self.alice_srv = _start(g.make_outbound(self.alice))
        self.alice_url = f"http://127.0.0.1:{self.alice_srv.server_address[1]}"
        self.bob_url = bob_url

    def tearDown(self):
        for s in (self.hermes_srv, self.bob_srv, self.alice_srv):
            s.shutdown()
            s.server_close()
        self.tmp.cleanup()

    def test_signed_call_reaches_hermes_with_local_token_only(self):
        code, resp = _http(self.alice_url + "/peer/bob", HERMES_V1, {"Authorization": "Bearer alice-outbound"})
        self.assertEqual(code, 200, resp)
        method, _, headers, body = self.hermes.seen[-1]
        h = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(h["authorization"], "Bearer local-alice-token")
        self.assertEqual(h["x-a2a-verified-peer"], "alice")
        self.assertNotIn("x-a2a-sig", h)
        self.assertEqual(json.loads(body)["params"], HERMES_V1["params"])

    def test_unsigned_inbound_refused_without_legacy(self):
        code, resp = _http(self.bob_url + "/", HERMES_V1, {"Authorization": "Bearer some-old-peer-key"})
        self.assertEqual(code, 401)
        self.assertIn("unsigned", resp["error"]["message"])
        self.assertEqual(self.hermes.seen, [])

    def test_legacy_mode_passes_bearer_through(self):
        self.bob.cfg.legacy_bearer = True
        code, _ = _http(self.bob_url + "/", HERMES_V1, {"Authorization": "Bearer some-old-peer-key"})
        self.assertEqual(code, 200)
        self.assertEqual({k.lower(): v for k, v in self.hermes.seen[-1][2].items()}["authorization"],
                         "Bearer some-old-peer-key")

    def test_spoofed_verified_peer_header_is_stripped(self):
        # On every method and in both modes.
        for legacy in (True, False):
            self.bob.cfg.legacy_bearer = legacy
            if legacy:
                _http(self.bob_url + "/", HERMES_V1, {"Authorization": "Bearer x", "X-A2A-Verified-Peer": "primus"})
                self.assertNotIn("x-a2a-verified-peer", {k.lower() for k in self.hermes.seen[-1][2]})
            for path in ("/.well-known/agent-card.json", "/health"):
                with self.subTest(legacy=legacy, path=path):
                    _http(self.bob_url + path, None, {"X-A2A-Verified-Peer": "primus"})
                    self.assertNotIn("x-a2a-verified-peer", {k.lower() for k in self.hermes.seen[-1][2]})

    def test_outbound_requires_local_token(self):
        code, _ = _http(self.alice_url + "/peer/bob", HERMES_V1, {"Authorization": "Bearer wrong"})
        self.assertEqual(code, 401)
        code, _ = _http(self.alice_url + "/peer/nobody", HERMES_V1, {"Authorization": "Bearer alice-outbound"})
        self.assertEqual(code, 404)

    def test_outbound_rewrites_agent_card_to_itself(self):
        code, card = _http(self.alice_url + "/peer/bob/.well-known/agent-card.json", None,
                           {"Authorization": "Bearer alice-outbound"})
        self.assertEqual(code, 200)
        local = f"http://127.0.0.1:{self.alice.cfg.outbound['listen_port']}/peer/bob"
        self.assertEqual(card["url"], local)
        self.assertEqual(card["supportedInterfaces"][0]["url"], local)

    def test_inbound_get_never_forwards_credentials(self):
        # In BOTH modes: legacy passthrough is for POST only.
        for legacy in (False, True):
            self.bob.cfg.legacy_bearer = legacy
            for path in ("/.well-known/agent-card.json", "/health", "/"):
                with self.subTest(legacy=legacy, path=path):
                    _http(self.bob_url + path, None, {"Authorization": "Bearer legacy-get-canary"})
                    self.assertNotIn("authorization", {k.lower() for k in self.hermes.seen[-1][2]})

    def test_inbound_card_advertises_the_guard_not_hermes(self):
        # Regression: the gateway posts to the URL in the backend's own
        # card, so a pass-through card let calls skip the guard entirely.
        code, card = _http(self.bob_url + "/.well-known/agent-card.json", None, {"Host": "evil.example"})
        self.assertEqual(code, 200)
        self.assertEqual(card["url"], "http://bob.test:9900/")  # configured, never the Host header
        self.assertEqual(card["supportedInterfaces"][0]["url"], "http://bob.test:9900/")

    def test_card_url_never_comes_from_the_host_header(self):
        # with no public_url, a wildcard listener has no safe URL -> refuse the card;
        # a concrete listen address is used as-is.
        self.assertEqual(g._inbound_public_url({"listen_host": "0.0.0.0"}), "")
        self.assertEqual(g._inbound_public_url({"listen_host": "203.0.113.21", "listen_port": 9900}),
                         "http://203.0.113.21:9900/")
        self.bob.cfg.inbound.pop("public_url")
        srv = _start(g.make_inbound(self.bob))  # public_url is resolved when the handler is built
        try:
            code, resp = _http(f"http://127.0.0.1:{srv.server_address[1]}/.well-known/agent.json", None,
                               {"Host": "evil.example"})
            self.assertEqual(code, 503)
            self.assertIn("public_url", resp["error"]["message"])
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()


class BundleMode(unittest.TestCase):
    """VS bundle mode: peer keys + `strict` come from the LIVE a2a.json and hot-reload on tick()."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.hermes = type("Hermes", (_Upstream,), {"seen": []})
        self.hermes_srv = _start(self.hermes)
        self.alice_key = g.keygen(base / "alice")
        g.keygen(base / "bob")
        self.a2a = base / "config-a2a.json"
        self.write_bundle({"alice": g.public_key_text(self.alice_key)}, strict=False)
        tok = base / "bob" / "local-peer-tokens.json"
        tok.write_text(json.dumps({"alice": "local-alice-token"}))
        os.chmod(tok, 0o600)
        (base / "bob" / "guard.json").write_text(json.dumps({
            "agent_name": "bob", "state_dir": ".", "bundle_a2a": str(self.a2a),
            "inbound": {"upstream": f"http://127.0.0.1:{self.hermes_srv.server_address[1]}",
                        "public_url": "http://bob.test:9900/"}, "outbound": {"enabled": False}}))
        self.bob = g.Guard(g.Config(base / "bob" / "guard.json"))
        self.srv = _start(g.make_inbound(self.bob))
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}/"

    def tearDown(self):
        for s in (self.hermes_srv, self.srv):
            s.shutdown()
            s.server_close()
        self.tmp.cleanup()

    _clock = [int(time.time() * 1e9)]

    def _bump(self):
        # strictly increasing mtimes, independent of wall-clock granularity (deterministic reloads)
        self._clock[0] += 1_000_000_000
        os.utime(self.a2a, ns=(self._clock[0], self._clock[0]))

    def write_raw(self, text):
        tmp = self.a2a.with_suffix(".tmp")  # the registrant writes tmp + rename too
        tmp.write_text(text)
        os.replace(tmp, self.a2a)
        self._bump()

    def write_bundle(self, peer_keys, strict):
        self.write_raw(json.dumps({"identity_key": "unused-here", "peer_keys": peer_keys, "strict": strict}))

    def signed(self):
        return _http(self.url, HERMES_V1, {g.SIG_HEADER: g.sign(self.alice_key, "alice", "bob", HERMES_V1)})

    def test_peer_keys_and_dual_mode_come_from_the_bundle(self):
        self.assertEqual(self.signed()[0], 200)
        self.assertEqual(_http(self.url, HERMES_V1, {"Authorization": "Bearer legacy"})[0], 200)  # dual

    def test_strict_flip_lands_live(self):
        self.write_bundle({"alice": g.public_key_text(self.alice_key)}, strict=True)
        self.bob.tick()
        self.assertEqual(_http(self.url, HERMES_V1, {"Authorization": "Bearer legacy"})[0], 401)
        self.assertEqual(self.signed()[0], 200)
        self.write_bundle({"alice": g.public_key_text(self.alice_key)}, strict=False)  # rollback, live
        self.bob.tick()
        self.assertEqual(_http(self.url, HERMES_V1, {"Authorization": "Bearer legacy"})[0], 200)

    def test_revocation_lands_live(self):
        self.assertEqual(self.signed()[0], 200)
        self.write_bundle({}, strict=True)
        self.bob.tick()
        code, resp = self.signed()
        self.assertEqual(code, 401)
        self.assertIn("bad signature", resp["error"]["message"])

    def test_status_file_reports_readiness(self):
        self.signed()
        _http(self.url, HERMES_V1, {"Authorization": "Bearer legacy"})
        self.bob.tick()
        st = json.loads(self.bob.cfg.status_path.read_text())
        self.assertEqual(st["schema"], "vs.a2a-guard.status/1")
        self.assertEqual((st["agent"], st["strict"], st["peers"], st["local_tokens"]),
                         ("bob", False, ["alice"], ["alice"]))
        self.assertEqual(st["counts"], {"verified": 1, "legacy": 1, "refused": 0})

    def test_malformed_key_is_skipped_not_fatal(self):
        self.write_bundle({"alice": g.public_key_text(self.alice_key), "mallory": "not-a-key"}, strict=False)
        self.bob.tick()
        self.assertEqual(sorted(self.bob.registry), ["alice"])
        self.assertEqual(self.signed()[0], 200)

    def test_broken_bundle_keeps_last_good_state(self):
        # Review: structurally wrong JSON must not stop the guard either.
        self.write_bundle({"alice": g.public_key_text(self.alice_key)}, strict=True)
        self.bob.tick()
        for broken in ("{not json", "[]", "null", '{"peer_keys": []}', '{"peer_keys": "x"}', '"str"'):
            with self.subTest(broken):
                self.write_raw(broken)
                self.bob.tick()  # must not raise
                self.assertEqual(sorted(self.bob.registry), ["alice"])
                self.assertFalse(self.bob.cfg.legacy_bearer)  # strict kept
                self.assertEqual(self.signed()[0], 200)
                self.assertEqual(_http(self.url, HERMES_V1, {"Authorization": "Bearer legacy"})[0], 401)

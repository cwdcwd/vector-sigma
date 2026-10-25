#!/usr/bin/env python3
"""Tests for the Primus (and device) boot workflows — fleet-ops-1py.47.3.

What this suite proves, hermetically and offline (no docker, no real
queues, no real credentials — SYNTHETIC FIXTURES ONLY, per the dev-ack on
the bead):

  1. The boot-time cont-init hooks do what their headers claim, by RUNNING
     the real hook scripts in a sandboxed $HERMES_HOME fixture:
       - 03-vs-queue-join (images/hermes/vs-queue-join.sh): first-boot-only
         queue join seed, never bd init, repeat-boot idempotency, fail-soft
         on every broken path (bead AC1: "clean boot, restart/idempotency").
       - 04-vs-a2a-wiring: bundle env merge, A2A_* derivation from a2a.json,
         bind-safety when no identity key exists (inbound stays OFF),
         fail-soft on broken JSON.
       - 05-vs-github-identity: derives the GIT_CONFIG_* managed block from
         a bundle identity, removes it wholesale when the identity is
         absent/partial (no stale credential path), stays 0600, never reads
         the PEM into memory.
       - 06-vs-memory-tools: installs the baked plugin (stale-copy refresh,
         __pycache__ exclusion), fail-soft without the baked source.
  2. The s6 longrun service contracts: dark-until-configured (run exits 0,
     finish returns 125 so s6 leaves the slot down), configured => finish 0,
     runtime-user drop, token-file pickup — behaviorally, in a sandbox.
  3. The baked queue join stays contract-aligned with the hub router's
     constants (drift guard), and the boot surface carries no secrets.
  4. The GitHub identity wrapper (vs-github-identity.py) behind a FAKE
     GitHub API on loopback: happy-path minting, permission denial
     (fail-closed), over-broad token scope refused WITHOUT EVER ECHOING
     THE TOKEN (the "no credential leakage to logs or artifacts" gate),
     the repository/API path allowlist, the git credential helper contract
     and JWT shape (bead AC2).

Out of scope on purpose (covered elsewhere, named for the reader):
  - Router routing behavior (stage transitions, invalid handoffs,
    queue-unavailable parking, retry) — images/common/bin/test_vs_hub_router.py
    drives those contracts against FakeBoard/fake-bd fixtures.
  - The 06- config-seed happy path (needs the image's venv python + PyYAML)
    and the full container boot — the compose E2E proves both on the REAL
    image: e2e.sh AC16 (plugin + allow-list seeded) and AC20 (repeat-boot
    idempotency, queue outage recovery, hub handoffs against the real
    throwaway board).
"""

import base64
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOOKS = HERE.parent / "hooks"
S6 = HERE.parent / "s6"
COMMON = HERE.parent
HERMES_IMG = COMMON.parent / "hermes"

QUEUE_JOIN_HOOK = HERMES_IMG / "vs-queue-join.sh"
A2A_WIRING_HOOK = HOOKS / "vs-a2a-wiring.sh"
GITHUB_HOOK = HOOKS / "vs-github-identity.sh"
MEMORY_HOOK = HOOKS / "vs-memory-tools.sh"
ROUTER_RUN = S6 / "vs-hub-router" / "run"
ROUTER_FINISH = S6 / "vs-hub-router" / "finish"
GUARD_RUN = S6 / "a2a-guard" / "run"
GUARD_FINISH = S6 / "a2a-guard" / "finish"
WRAPPER_PATH = HERE / "vs-github-identity.py"

# Standard PATH every hook fixture runs with: the stub dir (bd etc.) is
# PREPENDED by the fixture; the real /usr dirs stay available for
# cp/grep/sed/python3/openssl — the hooks are POSIX sh + image tools.
BASE_PATH = ("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:"
             "/sbin:/bin")

# The canonical vs_ops join contract (fixture-shaped values; the REAL
# contract lives in images/common/queue-join/.beads/metadata.json and is
# asserted against the router constants in BakedJoinContractTests).
FIXTURE_JOIN = {
    "database": "vs_ops",
    "backend": "dolt",
    "dolt_mode": "server",
    "dolt_server_host": "dolt",
    "dolt_server_user": "vs",
    "dolt_database": "vs_ops",
    "project_id": "bcde5891-5482-4eb0-a223-8533504832d6",
    "dolt_server_port": 3306,
}

FAKE_TOKEN = "ghs_fixture0001notarealtoken"
FAKE_APP = {"name": "Fixture App", "slug": "fixture-agent", "id": 5137374}
FAKE_INSTALLATION = [{"id": 42, "account": {"login": "cwdcwd"}}]

# Scenario state for the fake GitHub (the running test mutates it).
SCENARIO = {}


def read_env_file(path):
    env = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key] = value
    return env


class BootFixtureMixin(unittest.TestCase):
    """Sandbox helpers shared by the hook and service tests."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vs-boot-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.stub_bin = self.tmp / "stub-bin"
        self.stub_bin.mkdir()
        self.home = self.tmp / "hermes-home"
        self.home.mkdir()
        self.env = {
            "PATH": f"{self.stub_bin}:{BASE_PATH}",
            "HERMES_HOME": str(self.home),
            # Deterministic ownership: the hooks chown to THIS uid/gid
            # (the container's stage2 remap in production — HERMES_UID).
            "HERMES_UID": str(os.getuid()),
            "HERMES_GID": str(os.getgid()),
            "HOME": str(self.tmp),
        }

    def stub_bd(self, version_output="bd version 1.2.2 (6c124203e)"):
        """A bd stub that records argv (never touches a real queue)."""
        log = self.tmp / "bd-argv.log"
        log.write_text("")
        stub = self.stub_bin / "bd"
        stub.write_text(
            "#!/bin/sh\n"
            f"printf '%s\\0' \"$@\" >> {log}\n"
            "if [ \"$1\" = '--version' ]; then\n"
            f"  printf '{version_output}\\n'\n"
            "  exit 0\n"
            "fi\n"
            "echo 'stub bd: unexpected verb' >&2; exit 98\n")
        stub.chmod(0o755)
        return log

    def bd_argv(self, log_path):
        return [a for a in Path(log_path).read_text().split("\0") if a]

    def hook_py_has_yaml(self):
        """Does the python the HOOK resolves (the fixture's PATH) import
        yaml? — the branch the 06- seed takes; NOT the test interpreter."""
        probe = subprocess.run(
            ["/bin/sh", "-c",
             'command -v python3 >/dev/null 2>&1 || exit 97; '
             'exec python3 -c "import yaml"'],
            env=self.env, capture_output=True, timeout=30)
        return probe.returncode == 0

    def run_hook(self, source_path, env, mutations=()):
        """Run a REAL hook script on a sandboxed copy.

        `mutations` are literal (old, new) replacements for the fixed image
        paths a hook hardcodes (e.g. /opt/vs/queue-join — the script runs
        unmodified apart from pointing at the fixture). Every `old` literal
        is assert-checked first: a refactor that renames the path breaks
        loudly here instead of silently un-exercising the sandbox.
        """
        source = Path(source_path).read_text()
        copy = self.tmp / (Path(source_path).stem + ".sandbox.sh")
        rendered = source
        for old, new in mutations:
            self.assertIn(
                old, rendered,
                f"hook source drifted: literal {old!r} not found in "
                f"{source_path} — update the fixture mutation")
            rendered = rendered.replace(old, new)
        copy.write_text(rendered)
        copy.chmod(0o755)
        return subprocess.run(
            ["/bin/sh", str(copy)], env=env, capture_output=True, text=True,
            timeout=60)


class QueueJoinHookTests(BootFixtureMixin, unittest.TestCase):
    """03-vs-queue-join — the first-boot queue join seed (primus image)."""

    def setUp(self):
        super().setUp()
        self.src_beads = self.tmp / "opt" / "vs" / "queue-join" / ".beads"
        self.workspace = self.home / "vs-queue"
        self.stub_log = self.stub_bd()
        self.mutations = ((
            "/opt/vs/queue-join", str(self.tmp / "opt" / "vs" / "queue-join")
        ),)

    def _bake_join(self):
        self.src_beads.mkdir(parents=True, exist_ok=True)
        (self.src_beads / "metadata.json").write_text(
            json.dumps(FIXTURE_JOIN, indent=2) + "\n")
        (self.src_beads / "dolt-server.port").write_text("3306")

    def _hook_cmd(self):
        return self.run_hook(QUEUE_JOIN_HOOK, self.env, self.mutations)

    def test_first_boot_seeds_join_config(self):
        self._bake_join()
        proc = self._hook_cmd()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(
            "bcde5891-5482-4eb0-a223-8533504832d6",
            (self.workspace / ".beads" / "metadata.json").read_text())
        self.assertEqual(
            (self.workspace / ".beads" / "dolt-server.port").read_text()
            .strip(), "3306")
        config = (self.workspace / ".beads" / "config.yaml").read_text()
        self.assertIn('actor: "primus"', config)
        self.assertIn("enabled: false", config)
        self.assertEqual(
            os.stat(self.workspace / ".beads").st_mode & 0o777, 0o700)
        self.assertIn("seeded", proc.stdout)
        self.assertIn("bd status", proc.stdout)

    def test_first_boot_never_runs_bd_init(self):
        """The join is config-only: bd may only be asked for --version."""
        self._bake_join()
        proc = self._hook_cmd()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.bd_argv(self.stub_log), ["--version"])

    def test_repeat_boot_is_idempotent(self):
        """Second boot leaves the seeded workspace byte-identical."""
        self._bake_join()
        first = self._hook_cmd()
        self.assertEqual(first.returncode, 0, first.stderr)
        manifest = {
            str(p.relative_to(self.workspace)): p.read_bytes()
            for p in sorted(self.workspace.rglob("*")) if p.is_file()}
        second = self._hook_cmd()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("already seeded", second.stdout)
        after = {
            str(p.relative_to(self.workspace)): p.read_bytes()
            for p in sorted(self.workspace.rglob("*")) if p.is_file()}
        self.assertEqual(manifest, after)

    def test_missing_baked_source_failsoft(self):
        """A broken image (no baked join) logs loudly and boots without
        queue tooling — never bricks the agent (rc 0, no seed)."""
        proc = self._hook_cmd()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("skipping seed", proc.stdout)
        self.assertFalse(self.workspace.exists())

    def test_unwritable_volume_failsoft(self):
        """A not-ready volume is skipped the same way (rc 0, loud log)."""
        self._bake_join()
        locked = self.tmp / "locked-home"
        locked.mkdir()
        os.chmod(locked, 0o555)
        self.addCleanup(os.chmod, locked, 0o755)
        proc = self.run_hook(
            QUEUE_JOIN_HOOK, dict(self.env, HERMES_HOME=str(locked)),
            self.mutations)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertFalse(
            (locked / "vs-queue" / ".beads" / "metadata.json").exists())

    def test_bd_pin_drift_fails_loudly_at_boot(self):
        """A baked bd answering anything but 1.2.2 logs a WARNING (the
        fleet pin is absolute) but never blocks boot (fail-soft posture)."""
        self._bake_join()
        self.stub_bd(version_output="bd version 9.9.9 (drifted)")
        proc = self._hook_cmd()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("WARNING", proc.stdout)
        self.assertIn("9.9.9", proc.stdout)
        # The seed itself still completed.
        self.assertTrue((self.workspace / ".beads" / "metadata.json").exists())


class GithubIdentityHookTests(BootFixtureMixin, unittest.TestCase):
    """05-vs-github-identity — bundle identity -> git env managed block."""

    APP_SLUG = "fixture-app"
    APP_ID = "5137374"

    def setUp(self):
        super().setUp()
        self.bundle = self.home / "config"
        self.bundle.mkdir(parents=True, exist_ok=True)
        self.env_file = self.home / ".env"
        # A fake PEM: content is opaque to the hook (existence check only).
        self.pem_mark = "TEST-ONLY-FIXTURE-NOT-A-KEY"
        (self.bundle / "github-app.pem").write_text(
            f"-----BEGIN {self.pem_mark}-----\nc3lub3RoZXRpYw==\n"
            "-----END-----\n")
        (self.bundle / "agent.env").write_text(
            f"GH_APP_ID={self.APP_ID}\nGH_APP_SLUG={self.APP_SLUG}\n")

    def _run(self):
        return self.run_hook(GITHUB_HOOK, self.env)

    def test_identity_present_derives_git_config_block(self):
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        env = read_env_file(self.env_file)
        self.assertEqual(env["GH_APP_PEM_PATH"],
                         str(self.bundle / "github-app.pem"))
        self.assertEqual(env["GIT_CONFIG_COUNT"], "3")
        self.assertEqual(env["GIT_CONFIG_KEY_0"], "credential.helper")
        self.assertEqual(env["GIT_CONFIG_VALUE_0"],
                         "!/usr/local/bin/vs-github-identity cred")
        self.assertEqual(env["GIT_CONFIG_KEY_1"], "user.name")
        self.assertEqual(env["GIT_CONFIG_VALUE_1"], "fixture-app[bot]")
        self.assertEqual(env["GIT_CONFIG_KEY_2"], "user.email")
        self.assertEqual(
            env["GIT_CONFIG_VALUE_2"],
            "5137374+fixture-app[bot]@users.noreply.github.com")
        # Identity env lives in a 0600 file.
        self.assertEqual(
            os.stat(self.env_file).st_mode & 0o777, 0o600)
        self.assertIn("identity present", proc.stdout)
        # The PEM is never read into a variable, never logged, never copied.
        self.assertNotIn(self.pem_mark, proc.stdout + proc.stderr)
        self.assertNotIn(self.pem_mark, self.env_file.read_text())

    def test_repeat_boot_is_idempotent(self):
        self._run()
        first = read_env_file(self.env_file)
        self._run()
        again = read_env_file(self.env_file)
        self.assertEqual(first, again)
        # No duplicated managed lines.
        raw = self.env_file.read_text()
        for key in ("GH_APP_PEM_PATH", "GIT_CONFIG_COUNT"):
            self.assertEqual(
                len([l for l in raw.splitlines()
                     if l.startswith(key + "=")]), 1)

    def test_identity_absent_removes_managed_block(self):
        self.env_file.write_text("GH_APP_PEM_PATH=stale\nGIT_CONFIG_COUNT=9\n"
                                 "OPERATOR_KEY=keep-me\n")
        (self.bundle / "github-app.pem").unlink()
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        env = read_env_file(self.env_file)
        self.assertNotIn("GH_APP_PEM_PATH", env)
        self.assertNotIn("GIT_CONFIG_COUNT", env)
        self.assertNotIn("GIT_CONFIG_KEY_0", env)
        self.assertEqual(env.get("OPERATOR_KEY"), "keep-me")
        self.assertEqual(
            os.stat(self.env_file).st_mode & 0o777, 0o600)

    def test_partial_identity_treated_as_absent(self):
        (self.bundle / "agent.env").write_text("GH_APP_ID=5137374\n")
        self.env_file.write_text("GH_APP_PEM_PATH=stale\nOPERATOR=keep\n")
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        env = read_env_file(self.env_file)
        self.assertNotIn("GH_APP_PEM_PATH", env)
        self.assertEqual(env.get("OPERATOR"), "keep")

    def test_managed_keys_match_the_hook_contract(self):
        """The wholesale-removal key list is exactly the derived block."""
        source = GITHUB_HOOK.read_text()
        for key in ("GH_APP_PEM_PATH", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
                    "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1",
                    "GIT_CONFIG_VALUE_1", "GIT_CONFIG_KEY_2",
                    "GIT_CONFIG_VALUE_2"):
            self.assertIn(key, source)
        for literal in ("/usr/local/bin/vs-github-identity", "remove_managed"):
            self.assertIn(literal, source)


class A2aWiringHookTests(BootFixtureMixin, unittest.TestCase):
    """04-vs-a2a-wiring — bundle env merge + A2A_* wiring + bind-safety.

    The hook's interpreter is the image's venv python; the fixture
    substitutes it (a single self-checked mutation). The signed-guard
    section stays inert in the sandbox: /usr/local/bin/vs-a2a-guard does
    not exist there, and the hook skips the section when the binary is
    missing — which is itself one of the tested dark-posture contracts.
    """

    PY_MUTATION = ("/opt/hermes/.venv/bin/python", sys.executable)

    def setUp(self):
        super().setUp()
        self.bundle = self.home / "config"
        self.bundle.mkdir(parents=True)
        self.env_file = self.home / ".env"

    def _run(self):
        return self.run_hook(A2A_WIRING_HOOK, self.env, (self.PY_MUTATION,))

    def test_bundle_env_lines_merge_and_replace(self):
        (self.bundle / "agent.env").write_text(
            "AGENT_NAME=fixture-agent\nGATEWAY_URL=http://gateway.test\n")
        (self.bundle / "secrets.env").write_text(
            "GATEWAY_API_KEY=fk-fixture-not-a-key\n")
        self.env_file.write_text("API_SERVER_KEY=operator-seeded\n"
                                 "GATEWAY_URL=http://stale-value\n")
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        env = read_env_file(self.env_file)
        self.assertEqual(env.get("AGENT_NAME"), "fixture-agent")
        self.assertEqual(env.get("GATEWAY_URL"), "http://gateway.test")
        self.assertEqual(env.get("GATEWAY_API_KEY"), "fk-fixture-not-a-key")
        # Operator/image-seeded keys outside the bundle are preserved.
        self.assertEqual(env.get("API_SERVER_KEY"), "operator-seeded")

    def test_malformed_bundle_line_is_skipped_loudly(self):
        (self.bundle / "agent.env").write_text(
            "not-kv-line\nBAD KEY=a fine value\nGOOD_KEY=kept\n")
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        env = read_env_file(self.env_file)
        self.assertNotIn("not-kv-line", env)
        self.assertEqual(env.get("GOOD_KEY"), "kept")

    def test_identity_key_wires_a2a_env(self):
        (self.bundle / "agent.env").write_text("AGENT_NAME=fixture-agent\n")
        (self.bundle / "a2a.json").write_text(json.dumps({
            "identity_key": "fx-mesh-key",
            "peer_tokens": {"peerbot": "pk-fixture"},
            "trusted_peers": ["peerbot"],
            "public_url": "http://fixture:9900",
        }))
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        env = read_env_file(self.env_file)
        self.assertEqual(env.get("A2A_OWN_IDENTITY_KEY"), "fx-mesh-key")
        self.assertEqual(env.get("A2A_PEER_TOKENS"), "peerbot:pk-fixture")
        self.assertEqual(env.get("A2A_TRUSTED_PEERS"), "peerbot")
        self.assertEqual(env.get("A2A_PUBLIC_URL"), "http://fixture:9900")
        self.assertEqual(env.get("A2A_PORT"), "9900")
        self.assertEqual(env.get("A2A_HOST"), "0.0.0.0")
        self.assertEqual(
            os.stat(self.env_file).st_mode & 0o777, 0o600)
        self.assertIn("A2A inbound wired", proc.stdout)

    def test_no_identity_never_starts_inbound(self):
        """Bind-safety: no identity key -> the A2A_* server env is removed
        (a pre-existing stale key must not survive an un-keyed boot)."""
        (self.bundle / "agent.env").write_text("AGENT_NAME=fixture-agent\n")
        self.env_file.write_text(
            "A2A_OWN_IDENTITY_KEY=stale\nA2A_PORT=9900\n"
            "A2A_PEER_TOKENS=stale:tok\nA2A_TRUSTED_PEERS=stale\n"
            "A2A_HOST=0.0.0.0\nA2A_PUBLIC_URL=http://stale\n")
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        env = read_env_file(self.env_file)
        for key in ("A2A_OWN_IDENTITY_KEY", "A2A_PORT", "A2A_PEER_TOKENS",
                    "A2A_TRUSTED_PEERS", "A2A_HOST", "A2A_PUBLIC_URL"):
            self.assertNotIn(key, env)
        self.assertIn("inbound stays OFF", proc.stdout)

    def test_broken_a2a_json_failsoft(self):
        (self.bundle / "agent.env").write_text("AGENT_NAME=fixture-agent\n")
        (self.bundle / "a2a.json").write_text("{not json")
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("A2A_OWN_IDENTITY_KEY", read_env_file(self.env_file))

    def test_no_bundle_skips_wiring(self):
        shutil.rmtree(self.bundle)
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("wiring skipped", proc.stdout)
        self.assertFalse(self.env_file.exists())

    def test_guard_section_stays_dark_without_the_binary(self):
        """Without /usr/local/bin/vs-a2a-guard the signed-identity section
        is skipped and no guard state is written — the documented posture
        (in prod, peer_keys also switches the gateway to signed mode; the
        guard's own suite owns those behaviors)."""
        (self.bundle / "agent.env").write_text(
            "AGENT_NAME=fixture-agent\nGATEWAY_URL=http://gateway.test\n")
        (self.bundle / "a2a.json").write_text(json.dumps(
            {"identity_key": "fx-mesh-key"}))
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # The a2a.json payload ran (A2A_* landed) with the substituted PY.
        self.assertEqual(read_env_file(self.env_file).get("A2A_PORT"), "9900")
        # …but no guard state appeared and no guard call was attempted.
        self.assertFalse((self.home / "a2a-guard" / "guard.json").exists())
        source = A2A_WIRING_HOOK.read_text()
        for literal in ("/usr/local/bin/vs-a2a-guard", "peer_keys",
                        "/opt/hermes/.venv/bin/python"):
            self.assertIn(literal, source)


class MemoryToolsHookTests(BootFixtureMixin, unittest.TestCase):
    """06-vs-memory-tools — the plugin install hook (fail-soft + refresh).

    The config-seed happy path needs the image's venv python + PyYAML; the
    real-container proof is the compose E2E's AC16. Here the hook runs on
    its PATH-python fallback and the fixture asserts the documented
    behavior for this interpreter: plugin copy always; seeding only when
    `yaml` is importable AND config.yaml already exists.
    """

    def setUp(self):
        super().setUp()
        self.src = self.tmp / "opt" / "vs" / "gateway-memory"
        self.plugins = self.home / "plugins"
        self.config = self.home / "config.yaml"

    def _bake_plugin(self):
        (self.src / "skills" / "gateway-memory").mkdir(parents=True,
                                                       exist_ok=True)
        (self.src / "tools.py").write_text("# fixture plugin\n")
        (self.src / "skills" / "gateway-memory" / "SKILL.md").write_text(
            "fixture skill\n")
        # Build-host junk the hook must keep OUT of the install.
        (self.src / "__pycache__").mkdir(exist_ok=True)
        (self.src / "__pycache__" / "tools.cpython-313.pyc").write_text(
            "junk")
        (self.src / "skills" / "gateway-memory" / "__pycache__").mkdir(
            exist_ok=True)
        (self.src / "skills" / "gateway-memory" / "__pycache__" /
         "x.cpython-313.pyc").write_text("junk")

    def _install_dir(self):
        return self.plugins / "gateway-memory"

    def _run(self):
        return self.run_hook(MEMORY_HOOK, self.env, ((
            "/opt/vs/gateway-memory", str(self.src)),))

    def test_plugin_installed_without_pycache(self):
        self._bake_plugin()
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue((self._install_dir() / "tools.py").exists())
        self.assertTrue(
            (self._install_dir() / "skills" / "gateway-memory" / "SKILL.md")
            .exists())
        self.assertFalse((self._install_dir() / "__pycache__").exists())
        self.assertFalse(
            (self._install_dir() / "skills" / "gateway-memory" /
             "__pycache__").exists())
        self.assertIn("plugin installed", proc.stdout)
        if self.hook_py_has_yaml():
            # The hook's python imports yaml: the seed step runs against
            # the sandbox and warns that config.yaml hasn't been created
            # yet (stage2 didn't run here; the live proof is AC16).
            self.assertIn(
                "config.yaml absent — cannot seed plugins.enabled",
                proc.stdout)
        else:
            self.assertIn("no yaml module — cannot seed plugins.enabled",
                          proc.stdout)
        self.assertFalse(self.config.exists())

    def test_repeat_boot_refreshes_the_install(self):
        self._bake_plugin()
        first = self._run()
        self.assertEqual(first.returncode, 0, first.stderr)
        stale = self._install_dir() / "stale-from-old-image.py"
        stale.write_text("stale")
        second = self._run()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertFalse(stale.exists())
        self.assertTrue((self._install_dir() / "tools.py").exists())

    def _stub_yaml_python(self):
        """Make the fixture's `python3` (stub dir wins PATH) import yaml:
        a throwaway venv with PyYAML behind a shim. Returns True on
        success (graceful skip only if venv/pip is unusable)."""
        try:
            venv = self.tmp / "pyyaml-venv"
            subprocess.run([sys.executable, "-m", "venv", str(venv)],
                           check=True, capture_output=True, timeout=180)
            subprocess.run(
                [str(venv / "bin" / "python"), "-m", "pip", "install",
                 "--quiet", "--disable-pip-version-check", "pyyaml"],
                check=True, capture_output=True, timeout=300)
        except (subprocess.SubprocessError, OSError):
            return False
        shim = self.stub_bin / "python3"
        shim.write_text(
            f"#!/bin/sh\nexec '{venv / 'bin' / 'python3'}' \"$@\"\n")
        shim.chmod(0o755)
        return True

    def test_seeding_appends_to_an_existing_allowlist_when_yaml_exists(self):
        """With a yaml-importable python AND an existing config.yaml, the
        hook APPENDS gateway-memory to plugins.enabled (never destroys
        operator entries). The venv shim makes this fixture-driven: it
        runs wherever venv+pip work (skip otherwise — and the live proof
        remains AC16 on the real image)."""
        self._bake_plugin()
        if not (self.hook_py_has_yaml() or self._stub_yaml_python()):
            self.skipTest("cannot stand up a yaml-importable python — "
                          "the seed path is proven in the compose E2E (AC16)")
        self.config.write_text("plugins:\n  enabled:\n    - other-plugin\n")
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        text = self.config.read_text()
        self.assertIn("gateway-memory", text)
        self.assertIn("other-plugin", text)
        self.assertIn("plugins.enabled seeded", proc.stdout)

    def test_missing_baked_plugin_failsoft(self):
        proc = self._run()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("memory tools unavailable", proc.stdout)
        self.assertFalse((self.plugins / "gateway-memory").exists())


class S6ServiceContractTests(BootFixtureMixin, unittest.TestCase):
    """The s6 longrun slots: dark until configured, no restart loops."""

    @classmethod
    def setUpClass(cls):
        cls.router_run = ROUTER_RUN.read_text()
        cls.router_finish = ROUTER_FINISH.read_text()
        cls.guard_run = GUARD_RUN.read_text()
        cls.guard_finish = GUARD_FINISH.read_text()

    def test_types_and_dependency_blobs(self):
        self.assertEqual((S6 / "vs-hub-router" / "type").read_text().strip(),
                         "longrun")
        self.assertEqual((S6 / "a2a-guard" / "type").read_text().strip(),
                         "longrun")
        for service in ("vs-hub-router", "a2a-guard"):
            self.assertTrue((S6 / service / "dependencies.d" / "base")
                            .exists(), f"{service}: dependencies.d/base")

    def test_router_run_dark_without_roster(self):
        """No VS_HUB_AGENTS and no baked binary: the longrun exits 0
        BEFORE anything else — behaviorally (the fixture sandbox makes
        /usr/local/bin/vs-hub-router absent)."""
        proc = self.run_hook(ROUTER_RUN, self.env)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("idle", proc.stderr)

    def test_router_run_defaults_workspace_to_the_queue_join(self):
        self.assertIn('VS_QUEUE_DIR="${VS_QUEUE_DIR:-${HERMES_HOME:-'
                      '/opt/data}/vs-queue}"', self.router_run)
        self.assertIn("s6-setuidgid hermes", self.router_run)
        self.assertIn("vs-hub-router serve", self.router_run)

    def test_router_token_file_fallback(self):
        self.assertIn("a2a-guard/outbound-token", self.router_run)
        self.assertIn('VS_HUB_NOTIFY="${VS_HUB_NOTIFY:-0}"', self.router_run)

    def test_router_finish_exit_codes(self):
        self.assertEqual(
            self._sh(self.router_finish), 125,
            "dark router finish must return 125 (slot stays down)")
        self.assertEqual(
            self._sh(self.router_finish, extra={"VS_HUB_AGENTS": "1"}),
            0,
            "configured router finish must return 0 (restartable)")

    def test_guard_run_dark_without_guard_json(self):
        proc = self.run_hook(GUARD_RUN, self.env)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("serve --config", self.guard_run)
        self.assertIn("a2a-guard/guard.json", self.guard_run)

    def test_guard_finish_exit_codes(self):
        self.assertEqual(
            self._sh(self.guard_finish), 125,
            "dark guard finish must return 125 (slot stays down)")
        (self.home / "a2a-guard").mkdir(parents=True, exist_ok=True)
        (self.home / "a2a-guard" / "guard.json").write_text("{}")
        self.assertEqual(
            self._sh(self.guard_finish), 0,
            "configured guard finish must return 0 (restartable)")

    def _sh(self, script, extra=None):
        env = dict(os.environ)
        env.update(self.env)
        env.update(extra or {})
        env.setdefault("HERMES_HOME", str(self.home))
        path = self.tmp / "s6-script.sh"
        path.write_text(script)
        return subprocess.run(["/bin/sh", str(path)], env=env,
                              capture_output=True, text=True,
                              timeout=30).returncode


class BakedJoinContractTests(unittest.TestCase):
    """Repo-static drift guards between the boot artifacts."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            "vs_hub_router_contract", HERE / "vs-hub-router.py")
        assert spec and spec.loader, "router module spec missing"
        cls.router = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.router)
        cls.join_meta = json.loads(
            (COMMON / "queue-join" / ".beads" / "metadata.json").read_text())

    def test_baked_join_matches_router_constants(self):
        for key, expected in self.router.CANONICAL_CONTRACT.items():
            self.assertEqual(
                str(self.join_meta.get(key)), str(expected),
                f"baked queue join drifted from the router's contract "
                f"constant {key!r} — one side must change, not both")

    def test_dolt_server_port_file_matches(self):
        self.assertEqual(
            (COMMON / "queue-join" / ".beads" / "dolt-server.port")
            .read_text().strip(), "3306")

    def test_baked_join_never_carries_origin_fleet_markers(self):
        raw = json.dumps(self.join_meta)
        self.assertNotIn("fleet_ops", raw)
        self.assertNotIn(
            "e3796a22", raw,
            "the origin fleet's project id leaked into the baked join — "
            "the router would refuse everything")

    def test_wrapper_repository_scope_constant(self):
        source = WRAPPER_PATH.read_text()
        match = re.search(r'TARGET_REPOSITORY = "([^"]+)"', source)
        if match is None:
            self.fail(
                "vs-github-identity.py lost TARGET_REPOSITORY — the "
                "wrapper's least-privilege scope constant")
        self.assertEqual(match.group(1), "cwdcwd/vector-sigma")

    def test_boot_surface_carries_no_credential_shaped_values(self):
        paths = [QUEUE_JOIN_HOOK]
        paths += [p for p in HOOKS.iterdir() if p.is_file()]
        paths += [p for p in S6.rglob("*") if p.is_file()]
        secret_shape = re.compile(
            r"ghp_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|"
            r"sk-[A-Za-z0-9-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----")
        for path in paths:
            self.assertIsNone(
                secret_shape.search(path.read_text()),
                f"credential-shaped value in boot surface: {path}")

    def test_cont_init_queue_hooks_are_lexical_in_both_images(self):
        """The boot chain (queue join -> a2a wiring -> github identity ->
        memory tools) must stay lexically ordered: cont-init.d runs hooks
        in filename order."""
        for dockerfile, stages in (
                (HERMES_IMG / "Dockerfile", (3, 4, 5, 6)),
                (COMMON.parent / "agent" / "Dockerfile", (4, 5, 6))):
            copied = []
            for line in Path(dockerfile).read_text().splitlines():
                match = re.match(
                    r"COPY .*cont-init\.d/0([1-9])-vs-([a-z0-9-]+)", line)
                if match:
                    copied.append((int(match.group(1)),
                                   match.group(2)))
            found = sorted(stage for stage, _ in copied)
            self.assertEqual(
                sorted(set(found)), list(stages),
                f"{dockerfile}: the 0N-vs hook COPY set drifted "
                f"(got {found}) — expected {list(stages)}")
            # Each stage COPYed exactly once; file order is lexical.
            self.assertEqual(
                found, list(stages),
                f"{dockerfile}: duplicate or reordered cont-init COPY "
                f"(got {found}) — boot order must stay lexical")
            self.assertEqual(
                [name for _, name in sorted(copied)],
                ["queue-join", "a2a-wiring", "github-identity",
                 "memory-tools"] if stages[0] == 3 else
                ["a2a-wiring", "github-identity", "memory-tools"],
                f"{dockerfile}: hook-name ordering drifted")


class _FakeGitHubHandler(BaseHTTPRequestHandler):
    """Scenario-driven fake of the routes the identity wrapper touches.

    SCENARIO keys honored per request:
      app_status / installations_status / repos_status: force error paths
      installations: the installation list (default FAKE_INSTALLATION)
      mint_status / mint_token / mint_repositories: the access_tokens POST
    Every request is logged (method, path, Authorization, body) so tests
    assert mint counts and exactly how each credential kind was used.
    """

    def log_message(self, format, *args):  # keep test output clean
        pass

    def _record(self, body=b""):
        SCENARIO.setdefault("requests", []).append({
            "method": self.command,
            "path": self.path.split("?")[0],
            "authorization": self.headers.get("Authorization"),
            "body": body.decode() if body else "",
        })

    def _send(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/vnd.github+json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def do_GET(self):
        self._record()
        path = self.path.split("?")[0]
        if path == "/app":
            return self._send(SCENARIO.get("app_status", 200), FAKE_APP)
        if path == "/app/installations":
            return self._send(SCENARIO.get("installations_status", 200),
                              SCENARIO.get("installations",
                                           FAKE_INSTALLATION))
        if path == "/installation/repositories":
            return self._send(SCENARIO.get("repos_status", 200), {
                "total_count": 1,
                "repositories": [{"full_name": "cwdcwd/vector-sigma"}],
            })
        if path.startswith("/repos/cwdcwd/vector-sigma/"):
            # repo_status: force the cmd_api error path AFTER a mint; the
            # error body is the standard GitHub shape.
            status = SCENARIO.get("repo_status", 200)
            payload = ({"fixture_path": path, "ok": True} if status == 200
                       else {"message": "Not Found", "status": status})
            return self._send(status, payload)
        return self._send(404, {"message": "Not Found"})

    def do_POST(self):
        body = self._body()
        self._record(body)
        path = self.path.split("?")[0]
        if re.fullmatch(r"/app/installations/\d+/access_tokens", path):
            return self._send(SCENARIO.get("mint_status", 201), {
                "token": SCENARIO.get("mint_token", FAKE_TOKEN),
                "expires_at": "2030-01-01T00:00:00Z",
                "repositories": [
                    {"full_name": repo} for repo in SCENARIO.get(
                        "mint_repositories", ["cwdcwd/vector-sigma"])],
            })
        if path.startswith("/repos/cwdcwd/vector-sigma/"):
            return self._send(200, {"fixture_path": path, "ok": True})
        return self._send(404, {"message": "Not Found"})


def _fixture_pem():
    """A REAL synthetic RSA key (the wrapper must parse it for JWTs) plus
    a distinct body line used as the canary for 'the key never leaks'."""
    if shutil.which("openssl") is None:
        return None
    pem_dir = Path(tempfile.mkdtemp(prefix="vs-boot-pem-"))
    pem = pem_dir / "fixture.pem"
    subprocess.run(
        ["openssl", "genpkey", "-algorithm", "RSA",
         "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(pem)],
        check=True, capture_output=True, timeout=120)
    body = [line for line in pem.read_text().splitlines()
            if line and not line.startswith("-----")]
    assert body, "synthetic pem has no body lines"
    return pem, body[len(body) // 2]


class GithubIdentityWrapperFakeApiTests(unittest.TestCase):
    """vs-github-identity.py against the loopback fake GitHub (bead AC2:
    permission denial fails closed; the minted token never reaches logs,
    stdout, stderr or any artifact)."""

    @classmethod
    def setUpClass(cls):
        pem = _fixture_pem()
        if pem is None:
            raise unittest.SkipTest("openssl not available")
        cls.pem_path, cls.pem_canary = pem
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0),
                                         _FakeGitHubHandler)
        cls.server.daemon_threads = True
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever,
                                      daemon=True)
        cls.thread.start()

        def _stop_server():
            cls.server.shutdown()  # ask the loop to exit, WAIT for it, …
            cls.thread.join(timeout=5)  # …then collect the thread
        cls.addClassCleanup(_stop_server)
        cls.addClassCleanup(
            lambda: shutil.rmtree(cls.pem_path.parent, ignore_errors=True))

    def setUp(self):
        SCENARIO.clear()
        SCENARIO["requests"] = []
        self.env = {
            "PATH": BASE_PATH,
            "GH_APP_ID": "5137374",
            "GH_APP_SLUG": "fixture-agent",
            "GH_APP_PEM_PATH": str(self.pem_path),
            "GH_API_ROOT": f"http://127.0.0.1:{self.port}",
        }

    def tearDown(self):
        SCENARIO.clear()

    def _run_wrapper(self, *argv, stdin=None, env=None):
        return subprocess.run(
            [sys.executable, str(WRAPPER_PATH), *argv],
            input=stdin, env=env or self.env, capture_output=True,
            text=True, timeout=60)

    def _requests(self):
        return SCENARIO.get("requests", [])

    def _mints(self):
        return [r for r in self._requests()
                if r["method"] == "POST" and "/access_tokens" in r["path"]]

    def test_whoami_reports_identity_without_secrets(self):
        proc = self._run_wrapper("whoami")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("bot login:", proc.stdout)
        self.assertIn("fixture-agent[bot]", proc.stdout)
        self.assertIn("cwdcwd/vector-sigma", proc.stdout)
        combined = proc.stdout + proc.stderr
        self.assertNotIn(FAKE_TOKEN, combined)
        self.assertNotIn(self.pem_canary, combined)
        # The JWT bearer flowed; the minted token was used only for the
        # repo verification call (GET /installation/repositories).
        self.assertTrue(
            any((r["authorization"] or "").startswith("Bearer eyJ")
                for r in self._requests()))
        token_auth_calls = [r for r in self._requests()
                            if FAKE_TOKEN in (r["authorization"] or "")]
        self.assertEqual(
            [r["path"] for r in token_auth_calls],
            ["/installation/repositories"])

    def test_token_verb_prints_only_the_token(self):
        proc = self._run_wrapper("token")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), FAKE_TOKEN)
        self.assertEqual(len(self._mints()), 1)

    def test_permission_denied_installations_fails_closed(self):
        """GitHub withholding the installation lookup = identity disabled;
        no half-minted token anywhere in the streams."""
        SCENARIO["installations"] = []
        proc = self._run_wrapper("whoami")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("expected exactly one", proc.stderr)
        self.assertIn("identity is disabled", proc.stderr)
        self.assertEqual(proc.stdout.strip(), "")
        self.assertNotIn(FAKE_TOKEN, proc.stdout + proc.stderr)
        self.assertEqual(self._mints(), [])

    def test_installation_lookup_error_fails_closed(self):
        """HTTP 403 on the installation lookup — the fake-GitHub
        permission-denial shape (not merely an empty list)."""
        SCENARIO["installations_status"] = 403
        proc = self._run_wrapper("token")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("installation lookup failed (403)", proc.stderr)
        self.assertEqual(proc.stdout.strip(), "")
        self.assertEqual(self._mints(), [])

    def test_overbroad_token_scope_refused_without_leakage(self):
        """The minted token's bytes must never reach logs/stderr when the
        scope check refuses an over-broad grant."""
        leaked = "ghs_fakewide0001LEAKPROBE"
        SCENARIO["mint_token"] = leaked
        SCENARIO["mint_repositories"] = ["cwdcwd/other-repo"]
        proc = self._run_wrapper("token")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not restricted to cwdcwd/vector-sigma",
                      proc.stderr)
        self.assertIn("identity is disabled", proc.stderr)
        self.assertNotIn(leaked, proc.stdout + proc.stderr)

    def test_api_failure_never_prints_the_token(self):
        """cmd_api exits 1 on a 4xx and prints the API's error body — but
        never the freshly minted token (mint -> failing call)."""
        leaked = "ghs_fakemint0002LEAKPROBE"
        SCENARIO["mint_token"] = leaked
        SCENARIO["repo_status"] = 401
        proc = self._run_wrapper(
            "api", "GET", "/repos/cwdcwd/vector-sigma/contents/README")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("Not Found", proc.stdout)
        self.assertNotIn(leaked, proc.stdout + proc.stderr)

    def test_cred_helper_mints_on_get_only(self):
        get = self._run_wrapper(
            "cred", "get", stdin="protocol=https\nhost=github.com\n\n")
        self.assertEqual(get.returncode, 0, get.stderr)
        self.assertIn("username=fixture-agent[bot]", get.stdout)
        self.assertIn(f"password={FAKE_TOKEN}", get.stdout)
        self.assertEqual(len(self._mints()), 1)
        # erase/store are no-ops (mint-on-demand: nothing to store).
        erase = self._run_wrapper(
            "cred", "erase", stdin="protocol=https\nhost=github.com\n\n")
        self.assertEqual(erase.returncode, 0, erase.stderr)
        self.assertEqual(erase.stdout.strip(), "")
        self.assertEqual(len(self._mints()), 1)
        # A non-github.com host never mints.
        off = self._run_wrapper(
            "cred", "get", stdin="protocol=https\nhost=gitlab.com\n\n")
        self.assertEqual(off.returncode, 0, off.stderr)
        self.assertEqual(off.stdout.strip(), "")
        self.assertEqual(len(self._mints()), 1)

    def test_path_allowlist_blocks_out_of_scope_before_http(self):
        """Every out-of-scope API path must die before a single request —
        including the mint call."""
        blocked = {
            # wrong repo
            "/repos/cwdcwd/other-repo/contents/x":
                "restricted to",
            # 5th segment outside the content allowlist
            "/repos/cwdcwd/vector-sigma/labels": "restricted to",
            # traversal
            "/repos/cwdcwd/vector-sigma/../other/x": "restricted to",
            # encoded separators
            "/repos/cwdcwd/vector-sigma/contents/x%2F..%2Fy":
                "encoded path separators",
        }
        for path, needle in blocked.items():
            with self.subTest(path=path):
                proc = self._run_wrapper("api", "GET", path)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn(needle, proc.stderr)
        # Nothing — not even a mint — reached the fake.
        self.assertEqual(self._requests(), [],
                         "an out-of-scope path hit the network")

    def test_allowed_repo_paths_reach_the_fake(self):
        allowed = (
            "/repos/cwdcwd/vector-sigma/contents/README.md",
            "/repos/cwdcwd/vector-sigma/pulls",
            "/repos/cwdcwd/vector-sigma/commits/abc123",
            "/repos/cwdcwd/vector-sigma/git/blobs/x",
        )
        for path in allowed:
            with self.subTest(path=path):
                proc = self._run_wrapper("api", "GET", path)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertIn(path, proc.stdout)

    def test_config_failures_fail_closed_and_clean(self):
        cases = [
            {k: v for k, v in self.env.items() if k != "GH_APP_ID"},
            dict(self.env, GH_APP_SLUG="Bad Slug!"),
            dict(self.env, GH_APP_PEM_PATH="/nowhere/fixture.pem"),
            dict(self.env, GH_APP_ID="not-a-number"),
        ]
        for env in cases:
            with self.subTest(env=[
                    k for k, v in env.items()
                    if (self.env.get(k) != v) or k not in self.env]):
                proc = subprocess.run(
                    [sys.executable, str(WRAPPER_PATH), "token"],
                    input="", env=env, capture_output=True, text=True,
                    timeout=60)
                self.assertNotEqual(proc.returncode, 0)
                self.assertNotIn("Traceback", proc.stdout + proc.stderr)
                self.assertIn("vs-github-identity:", proc.stderr)
        # A missing-GH_APP_ID failure must name the wiring chain (the
        # operator-facing hint in die()).
        proc = subprocess.run(
            [sys.executable, str(WRAPPER_PATH), "token"], input="",
            env={k: v for k, v in self.env.items() if k != "GH_APP_ID"},
            capture_output=True, text=True, timeout=60)
        self.assertIn("05-vs-github-identity", proc.stderr)

    def test_jwt_shape_via_openssl_fallback(self):
        """The image runs the wrapper's zero-dependency path (no PyJWT in
        the venv): RS256 header, iss = App id, iat/exp the documented
        windows."""
        spec = importlib.util.spec_from_file_location(
            "vs_github_identity_under_test", WRAPPER_PATH)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        jwt_token = module.make_jwt({
            "app_id": self.env["GH_APP_ID"],
            "slug": self.env["GH_APP_SLUG"],
            "pem_path": str(self.pem_path)})
        header, payload, sig = jwt_token.split(".")
        decode = lambda blob: json.loads(base64.urlsafe_b64decode(  # noqa: E731
            blob + "=" * (-len(blob) % 4)))
        self.assertEqual(decode(header), {"alg": "RS256", "typ": "JWT"})
        body = decode(payload)
        self.assertEqual(body["iss"], "5137374")
        self.assertEqual(body["exp"] - body["iat"], 660)
        self.assertLessEqual(int(time.time()) - body["iat"], 120)
        self.assertGreater(len(sig), 0)


if __name__ == "__main__":
    unittest.main()
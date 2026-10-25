#!/usr/bin/env python3
"""Tests for vs-hub-router.py — the VS-local hub router on the vs_ops queue.

Contract under test (bead fleet-ops-1py.47.1, epic fleet-ops-1py.47):

  1. Routing starts only after the existing VS queue join/readiness gate: the
     workspace contract (the exact baked join metadata — canonical project
     id, dolt server backend, vs_ops database) plus a working bd server
     connection, re-verified every tick.
  2. Eligible work advances through explicit VS stages (dev -> test -> review
     -> merge) with role-label eligibility, per-agent WIP caps, handoff
     validation, retry (re-ping) and owner-blocked handling; repeated starts
     never duplicate a dispatch or a notification.
  3. Every queue operation targets vs_ops ONLY: a workspace whose contract
     names the origin fleet's queue (fleet_ops) or any other project id is
     REFUSED before a single bd call is made, and the bd argv surface is an
     explicit allowlist that excludes the one-time project initialization and
     raw-sql verbs — no boot path ever reruns queue initialization.

The suite is hermetic: the board behind the router is either an in-memory
fake (logic tests) or the real Board wrapper driven by a synthetic `bd`
fixture on PATH (subprocess contract tests) — never the host's queues.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROUTER_PATH = HERE / "vs-hub-router.py"

_spec = importlib.util.spec_from_file_location("vs_hub_router", ROUTER_PATH)
vr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vr)

JOIN_CONTRACT = json.loads(
    (HERE.parent / "queue-join" / ".beads" / "metadata.json").read_text())
FOREIGN_JOIN_META = {
    "database": "fleet_ops",
    "dolt_database": "fleet_ops",
    "backend": "dolt",
    "dolt_mode": "server",
    "dolt_server_user": "root",
    "project_id": "e3796a22-6b3b-42a0-b1a9-4db5d4d0a55c",
}

NOW = datetime(2026, 10, 26, 12, 0, 0, tzinfo=timezone.utc)
ROSTER = {"dev": "builder-a", "test": "tester-a", "review": "reviewer-a"}


# ------------------------------------------------------------------ helpers


def iso_at(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_ago(hours: float, now=NOW) -> str:
    return iso_at(now - timedelta(hours=hours))


def issue(iid, *, title=None, status="open", priority=2, itype="task",
          assignee=None, labels=(), metadata=None, desc="", created=NOW):
    return {
        "id": iid,
        "title": title or iid,
        "description": desc,
        "status": status,
        "priority": priority,
        "issue_type": itype,
        "assignee": assignee,
        "labels": list(labels),
        "owner": "primus",
        "created_at": iso_at(created) if isinstance(created, datetime) else created,
        "updated_at": iso_at(created) if isinstance(created, datetime) else created,
        "metadata": metadata,
        "dependencies": [],
        "parent": None,
    }


def comment(iid, author, text, at):
    return {
        "id": "c-" + iid + "-" + str(abs(hash((author, at, text[:20])))),
        "issue_id": iid,
        "author": author,
        "text": text,
        "created_at": at,
    }


class FakeBoard:
    """In-memory Board stand-in with the router's mutation surface."""

    def __init__(self, issues=(), ready=(), comments=()):
        self.issues = {i["id"]: dict(i) for i in issues}
        self.ready_ids = [i["id"] if isinstance(i, dict) else i for i in ready]
        self._comment_rows = {}
        for c in comments:
            self._comment_rows.setdefault(c["issue_id"], []).append(c)
        self.updates = []
        self.posted = []
        self.log = []

    def list_issues(self):
        self.log.append("list")
        return [dict(v) for v in self.issues.values()]

    def ready(self):
        self.log.append("ready")
        return [dict(self.issues[i]) for i in self.ready_ids if i in self.issues]

    def comments(self, iid):
        self.log.append("comments " + iid)
        return [dict(c) for c in self._comment_rows.get(iid, [])]

    def update(self, iid, *, assignee=None, status=None, set_meta=None,
               unset_meta=None):
        self.updates.append({"id": iid, "assignee": assignee, "status": status,
                             "set_meta": dict(set_meta or {}),
                             "unset_meta": list(unset_meta or [])})
        row = self.issues[iid]
        if assignee is not None:
            row["assignee"] = assignee
        if status is not None:
            row["status"] = status
        meta = row.get("metadata") or {}
        meta.update(set_meta or {})
        for k in (unset_meta or []):
            meta.pop(k, None)
        row["metadata"] = meta

    def comment(self, iid, text):
        self.posted.append({"id": iid, "text": text})


def make_workspace(tmp: Path, *, overrides=None) -> str:
    """A synthetic join workspace whose contract matches the baked join, or a
    (deliberately foreign) variant when overrides are passed."""
    base = tmp.iterdir() if tmp.exists() else []
    ws = tmp / ("vs-queue-" + str(len(list(base))))
    meta = dict(JOIN_CONTRACT)
    meta.update(overrides or {})
    ws.mkdir(parents=True)
    (ws / ".beads").mkdir()
    (ws / ".beads" / "metadata.json").write_text(json.dumps(meta, indent=1))
    return str(ws)


class FakeBd:
    """Synthetic `bd` fixture on PATH: records argv lines, serves board
    fixtures, and refuses the verbs the router must never run."""

    def __init__(self, tmp: Path, *, list_rows=(), ready_rows=(), comments=(),
                 status_ok=True):
        n = len(list(tmp.iterdir())) if tmp.exists() else 0
        self.dir = tmp / ("fakebd-" + str(n))
        self.dir.mkdir()
        self.calls = self.dir / "calls.tsv"
        for name, rows in (("list.json", list_rows), ("ready.json", ready_rows)):
            (self.dir / name).write_text(json.dumps(list(rows)))
        cmap = {}
        for c in comments:
            cmap.setdefault(c["issue_id"], []).append(c)
        (self.dir / "comments.json").write_text(json.dumps(cmap))
        self.status_ok = status_ok
        (self.dir / "bd").write_text(textwrap.dedent(f"""
            #!/bin/sh
            printf '%s\\n' "$*" >> "{self.calls}"
            case "$1" in
              status)
                if [ "${{BD_STATUS_OK:-1}}" = "1" ]; then
                  printf 'header\\nIssue Database Status\\n'
                else
                  echo "synthetic bd: connection refused for fixture" >&2
                  exit 1
                fi ;;
              list)     cat "{self.dir}/list.json" ;;
              ready)    cat "{self.dir}/ready.json" ;;
              comments) cat "{self.dir}/comments.json" ;;
              update|comment|close) exit 0 ;;
              init|sql) echo "fixture forbids bd $1" >&2; exit 98 ;;
              *)        echo "unexpected fixture command: $1" >&2; exit 97 ;;
            esac
        """).lstrip())
        (self.dir / "bd").chmod(0o755)

    def env(self, base=None):
        env = dict(base or {})
        env["PATH"] = str(self.dir) + ":" + os.environ.get("PATH", "")
        env["BD_STATUS_OK"] = "1" if self.status_ok else "0"
        env.setdefault("BEADS_DOLT_PASSWORD", "synthetic-password")
        return env

    def argvs(self):
        if not self.calls.exists():
            return []
        return self.calls.read_text().splitlines()

    def bd_verbs(self):
        verbs = []
        for line in self.argvs():
            toks = line.split(" ")
            if toks and " " not in toks[0]:
                verbs.append(toks[0])
        return verbs


def env_for(ws, *, roster=True, **over):
    env = dict(os.environ)
    env["PATH"] = "/usr/bin:/bin:/usr/sbin"  # hermetic: no real bd reachable
    env["BEADS_ACTOR"] = "primus"
    env["VS_QUEUE_DIR"] = ws
    if roster:
        env["VS_HUB_AGENTS"] = json.dumps(ROSTER if roster is True else roster)
    else:
        env["VS_HUB_AGENTS"] = ""
    env.setdefault("VS_HUB_NOTIFY", "0")  # board-only mode in tests by default
    for k, v in over.items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = str(v)
    return env.copy()


def run_router(args, env):
    return subprocess.run(
        [sys.executable, str(ROUTER_PATH), *args], env=env,
        capture_output=True, text=True, timeout=120)


def logic_board(rows, cfg, notify=None, ready=(), comments=()):
    b = FakeBoard(issues=rows, ready=ready, comments=comments)
    return b, vr.Sweep(b, cfg, notify=notify)


def cfg_env(**over):
    return {"VS_HUB_AGENTS": json.dumps(ROSTER), "VS_HUB_NOTIFY": "0", **over}


# --------------------------------------------------- gate 1: contract gates


class ContractGates(unittest.TestCase):
    """The join-contract gate refuses foreign workspaces before any bd call."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vsr-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_gate_ok_on_canonical_join_workspace(self):
        ws = make_workspace(self.tmp)
        r = run_router(["gate"], env_for(ws))
        self.assertEqual(r.returncode, 0)
        self.assertIn("ok", r.stdout)
        self.assertNotIn("refused", r.stdout)

    def test_gate_refused_when_workspace_absent(self):
        r = run_router(["gate"], env_for(str(self.tmp / "nope")))
        self.assertEqual(r.returncode, 2)
        self.assertIn("refused", r.stdout)

    def test_gate_refused_on_origin_fleets_queue(self):
        ws = make_workspace(self.tmp, overrides=FOREIGN_JOIN_META)
        r = run_router(["gate"], env_for(ws))
        self.assertEqual(r.returncode, 2)
        self.assertIn("refused", r.stdout)

    def test_gate_refused_on_foreign_project_id(self):
        ws = make_workspace(self.tmp, overrides={
            "project_id": "00000000-0000-0000-0000-000000000000"})
        r = run_router(["gate"], env_for(ws))
        self.assertEqual(r.returncode, 2)
        self.assertIn("refused", r.stdout)

    def test_gate_refused_on_non_dolt_backend(self):
        ws = make_workspace(self.tmp, overrides={
            "backend": "jsonl", "dolt_mode": "file"})
        r = run_router(["gate"], env_for(ws))
        self.assertEqual(r.returncode, 2)
        self.assertIn("refused", r.stdout)

    def test_gate_refused_when_foreign_queue_named_anywhere(self):
        # A join copy that accidentally absorbed the origin fleet's note.
        raw = dict(JOIN_CONTRACT)
        raw["_comment2"] = "copied from the origin workspace (fleet_ops)"
        n = len(list(self.tmp.iterdir()))
        ws = self.tmp / ("vs-q-" + str(n))
        ws.mkdir(parents=True)
        (ws / ".beads").mkdir()
        (ws / ".beads" / "metadata.json").write_text(json.dumps(raw))
        r = run_router(["gate"], env_for(str(ws)))
        self.assertEqual(r.returncode, 2)
        self.assertIn("refused", r.stdout)


class ReadinessGate(unittest.TestCase):
    """The bd server connection is part of the gate, re-checked every tick."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vsr-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_gate_not_ready_while_bd_is_down(self):
        ws = make_workspace(self.tmp)
        fake = FakeBd(self.tmp, status_ok=False)
        env = fake.env(env_for(ws, roster=False))
        env["VS_HUB_AGENTS"] = json.dumps(ROSTER)
        r = run_router(["gate"], env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not ready", r.stdout)

    def test_once_refuses_to_write_while_bd_down(self):
        ws = make_workspace(self.tmp)
        fake = FakeBd(self.tmp, status_ok=False)
        env = fake.env(env_for(ws))
        r = run_router(["once"], env)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(fake.bd_verbs(), ["status"])  # only the probe ran


class DarkWithoutRoster(unittest.TestCase):
    """Without the owner's roster the router is a strict no-op."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vsr-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_once_without_roster_never_touches_the_board(self):
        ws = make_workspace(self.tmp)
        fake = FakeBd(self.tmp)
        r = run_router(["once"], fake.env(env_for(ws, roster=False)))
        self.assertEqual(r.returncode, 3)
        self.assertIn("unconfigured", r.stdout)
        self.assertEqual(fake.argvs(), [])

    def test_once_with_unusable_roster_refused(self):
        ws = make_workspace(self.tmp)
        env = env_for(ws, roster=False)
        env["VS_HUB_AGENTS"] = "{not json"
        r = run_router(["once"], env)
        self.assertEqual(r.returncode, 2)
        self.assertIn("refused", r.stdout)

    def test_bd_argv_surface_is_an_allowlist(self):
        # Across a full tick: every bd call is one of the board verbs — the
        # one-time initialization and raw-sql verbs are structurally absent.
        ws = make_workspace(self.tmp)
        beads = [issue("vs-1", labels=["role:builder"], priority=1)]
        fake = FakeBd(self.tmp, list_rows=beads, ready_rows=beads)
        r = run_router(["once"], fake.env(env_for(ws)))
        self.assertEqual(r.returncode, 0)
        allowed = {"status", "list", "ready", "comments", "update", "comment"}
        for verb in fake.bd_verbs():
            self.assertIn(verb, allowed)


# -------------------------------------------------- gate 2: intake/dispatch


class IntakeAndDispatch(unittest.TestCase):
    """Eligibility -> staged dispatch: WIP-capped, idempotent, one ping."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vsr-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cfg(self, **over):
        return vr.Config.from_env(cfg_env(**over))

    def test_role_builder_bead_dispatched_to_dev_agent(self):
        bead = issue("vs-1", labels=["role:builder"], desc="the work", priority=1)
        b, sw = logic_board([bead], self.cfg(), ready=[bead])
        res = sw.tick(NOW)
        upd = [u for u in b.updates if u["id"] == "vs-1"]
        self.assertEqual(len(upd), 1)
        self.assertEqual(upd[0]["assignee"], "builder-a")
        self.assertEqual(upd[0]["status"], "in_progress")
        self.assertEqual(upd[0]["set_meta"].get("hub_stage"), "dev")
        self.assertEqual(upd[0]["set_meta"].get("hub_pending"), 0)
        self.assertIn("hub_dispatched_at", upd[0]["set_meta"])
        self.assertEqual(res["dispatched"], 1)
        self.assertEqual(b.issues["vs-1"]["status"], "in_progress")

    def test_repeated_ticks_never_restamp_dispatch(self):
        bead = issue("vs-1", labels=["role:builder"])
        b, sw = logic_board([bead], self.cfg(), ready=[bead])
        sw.tick(NOW)
        res2 = sw.tick(NOW + timedelta(minutes=5))
        self.assertEqual(res2["dispatched"], 0)
        self.assertEqual(len(b.updates), 1)  # no second update at all

    def test_wip_cap_parks_overflow(self):
        running = [issue("vs-run" + str(i), status="in_progress",
                         assignee="builder-a",
                         metadata={"hub_stage": "dev",
                                   "hub_dispatched_at": iso_ago(1)})
                   for i in range(2)]
        bead = issue("vs-new", labels=["role:builder"])
        b, sw = logic_board([*running, bead], self.cfg(VS_HUB_WIP="2"),
                            ready=[bead])
        res = sw.tick(NOW)
        self.assertEqual(res["dispatched"], 0)
        self.assertFalse([u for u in b.updates if u["id"] == "vs-new"])

    def test_one_notify_per_agent_per_tick(self):
        b1 = issue("vs-1", labels=["role:builder"], priority=1)
        b2 = issue("vs-2", labels=["role:builder"], priority=2)
        sent = []
        b, sw = logic_board([b1, b2], self.cfg(), notify=lambda a, t: sent.append((a, t)),
                            ready=[b1, b2])
        sw.tick(NOW)
        pings = [s for s in sent if s[0] == "builder-a"]
        self.assertEqual(len(pings), 1)
        self.assertIn("vs-1", pings[0][1])
        self.assertIn("vs-2", pings[0][1])

    def test_tester_bead_without_pr_evidence_stays(self):
        bead = issue("vs-3", labels=["role:tester"])
        b, sw = logic_board([bead], self.cfg(), ready=[bead])
        res = sw.tick(NOW)
        self.assertEqual(res["dispatched"], 0)
        self.assertFalse(b.updates)

    def test_tester_bead_with_pr_evidence_dispatched(self):
        bead = issue("vs-4", labels=["role:tester"],
                     desc="merge https://github.com/cwdcwd/vs/pull/77")
        b, sw = logic_board([bead], self.cfg(), ready=[bead])
        res = sw.tick(NOW)
        self.assertEqual(res["dispatched"], 1)
        self.assertEqual([u for u in b.updates if u["id"] == "vs-4"][0]["assignee"],
                         "tester-a")

    def test_owner_call_beads_never_dispatched(self):
        bead = issue("vs-5", labels=["role:builder", "owner-call"])
        b, sw = logic_board([bead], self.cfg(), ready=[bead])
        res = sw.tick(NOW)
        self.assertEqual(res["dispatched"], 0)
        self.assertFalse(b.updates)

    def test_epics_and_closed_and_assigned_candidates_excluded(self):
        rows = [issue("e1", itype="epic", labels=["role:builder"]),
                issue("cl", status="closed", labels=["role:builder"]),
                issue("as", assignee="someone", labels=["role:builder"])]
        b, sw = logic_board(rows, self.cfg(), ready=rows)
        res = sw.tick(NOW)
        self.assertEqual(res["dispatched"], 0)
        self.assertFalse(b.updates)

    def test_notify_failure_reverts_dispatch_to_pending(self):
        bead = issue("vs-1", labels=["role:builder"])

        def boom(agent, text):
            raise RuntimeError("synthetic post failure")

        b, sw = logic_board([bead], self.cfg(), notify=boom, ready=[bead])
        res = sw.tick(NOW)
        self.assertEqual(res["reverted"], 1)
        row = b.issues["vs-1"]
        self.assertEqual(row["status"], "open")
        self.assertEqual(row["assignee"], "primus")
        self.assertEqual(row["metadata"].get("hub_pending"), 1)
        self.assertEqual(row["metadata"].get("hub_stage"), "dev")
        self.assertNotIn("hub_dispatched_at", row["metadata"])
        # ... and the reverted bead is re-dispatched on a later tick.
        ok = lambda a, t: None
        b2 = FakeBoard(issues=[dict(row)], ready=[])
        sw2 = vr.Sweep(b2, self.cfg(), notify=ok)
        res2 = sw2.tick(NOW + timedelta(minutes=5))
        self.assertEqual(res2["dispatched"], 1)

    def test_required_notify_unavailable_blocks_all_dispatch(self):
        bead = issue("vs-1", labels=["role:builder"])
        # notify_mode auto (required) but the route did not resolve (None).
        b, sw = logic_board([bead], self.cfg(VS_HUB_NOTIFY="1"), notify=None,
                            ready=[bead])
        res = sw.tick(NOW)
        self.assertEqual(res["dispatched"], 0)
        self.assertFalse(b.updates)

    def test_board_only_mode_dispatches_without_notify(self):
        bead = issue("vs-1", labels=["role:builder"])
        b, sw = logic_board([bead], self.cfg(VS_HUB_NOTIFY="0"), notify=None,
                            ready=[bead])
        res = sw.tick(NOW)
        self.assertEqual(res["dispatched"], 1)

    def test_stage_without_roster_agent_never_dispatched(self):
        bead = issue("vs-1", labels=["role:reviewer"],
                     desc="https://github.com/cwdcwd/vs/pull/7")
        b, sw = logic_board([bead], self.cfg(VS_HUB_AGENTS=json.dumps(
            {"dev": "builder-a"})), ready=[bead])
        res = sw.tick(NOW)
        self.assertEqual(res["dispatched"], 0)
        self.assertFalse(b.updates)

    def test_priority_order_of_intake(self):
        lo = issue("vs-lo", labels=["role:builder"], priority=3)
        hi = issue("vs-hi", labels=["role:builder"], priority=0)
        cfg_capped = vr.Config.from_env(dict(cfg_env(), VS_HUB_WIP="1"))
        board2 = FakeBoard(issues=[lo, hi], ready=[lo, hi])
        sw2 = vr.Sweep(board2, cfg_capped, notify=None)
        res = sw2.tick(NOW)
        upd_hi = [u for u in board2.updates if u["id"] == "vs-hi"]
        upd_lo = [u for u in board2.updates if u["id"] == "vs-lo"]
        self.assertEqual(len(upd_hi), 1)
        self.assertFalse(upd_lo)


class ConfigParsing(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vsr-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_defaults(self):
        env = {"VS_HUB_AGENTS": '{"dev": "a"}', "HERMES_HOME": "/h"}
        # workspace joins HERMES_HOME
        cfg = vr.Config.from_env(env)
        self.assertEqual(cfg.workspace, "/h/vs-queue")
        self.assertEqual(cfg.wip, 2)
        self.assertEqual(cfg.owner, "owner")
        self.assertEqual(cfg.interval, 300)
        self.assertEqual(cfg.grace_hours, 8)
        self.assertEqual(cfg.reping_hours, 12)
        self.assertEqual(cfg.silent_hours, 48)
        self.assertFalse(cfg.notify_mode == "off")
        self.assertIn("lazybaer", cfg.owner_authors)

    def test_overrides(self):
        env = {"VS_HUB_AGENTS": '{"dev": "a", "test": "b", "review": "c"}',
               "VS_QUEUE_DIR": "/q", "VS_HUB_WIP": "5", "VS_HUB_OWNER": "me",
               "VS_HUB_OWNER_AUTHORS": "x,y", "VS_HUB_NOTIFY": "0",
               "VS_HUB_INTERVAL": "30", "VS_HUB_GRACE_HOURS": "1",
               "VS_HUB_REPING_HOURS": "2", "VS_HUB_SILENT_HOURS": "3"}
        cfg = vr.Config.from_env(env)
        self.assertEqual(cfg.workspace, "/q")
        self.assertEqual(cfg.wip, 5)
        self.assertEqual(cfg.owner, "me")
        self.assertEqual(cfg.owner_authors, {"x", "y"})
        self.assertTrue(cfg.notify_mode == "off")
        self.assertEqual(cfg.interval, 30)

    def test_bad_json_is_config_error(self):
        with self.assertRaises(vr.ConfigError):
            vr.Config.from_env({"VS_HUB_AGENTS": "{nope"})

    def test_bad_numeric_is_config_error(self):
        with self.assertRaises(vr.ConfigError):
            vr.Config.from_env({"VS_HUB_AGENTS": '{"dev": "a"}',
                                "VS_HUB_WIP": "zero"})

    def test_nonstring_roster_value_is_config_error(self):
        with self.assertRaises(vr.ConfigError):
            vr.Config.from_env({"VS_HUB_AGENTS": '{"dev": 17}'})


# --------------------------------------------- gate 3: handoffs/blocked etc.


class HandoffProcessing(unittest.TestCase):
    def setUp(self):
        self.cfg = vr.Config.from_env(cfg_env())

    def cfg2(self, **over):
        return vr.Config.from_env(dict(cfg_env(), **over))

    @staticmethod
    def dispatched(iid, agent, stage, hours_ago=1.0):
        return issue(iid, status="in_progress", assignee=agent,
                     metadata={"hub_stage": stage,
                               "hub_dispatched_at": iso_ago(hours_ago)})

    def board(self, rows, comments=(), cfg=None, notify=None):
        b = FakeBoard(issues=rows, comments=comments)
        return b, vr.Sweep(b, cfg or self.cfg, notify=notify)

    def test_dev_done_moves_bead_to_test_pending(self):
        i = self.dispatched("vs-1", "builder-a", "dev")
        hand = comment("vs-1", "builder-a",
                       "HANDOFF: dev-done https://github.com/cwdcwd/vs/pull/9",
                       iso_ago(0.5))
        b, sw = self.board([i], [hand])
        sw.tick(NOW)
        upd = [u for u in b.updates if u["id"] == "vs-1"][0]
        self.assertEqual(upd["assignee"], "tester-a")
        self.assertEqual(upd["status"], "open")
        self.assertEqual(upd["set_meta"].get("hub_stage"), "test")
        self.assertEqual(upd["set_meta"].get("hub_pending"), 1)
        self.assertIn("hub_dispatched_at", upd["unset_meta"])

    def test_pending_stage_bead_dispatched_same_tick(self):
        i = issue("vs-1", status="open", assignee="tester-a",
                  metadata={"hub_stage": "test", "hub_pending": 1})
        sent = []
        b, sw = self.board([i], notify=lambda a, t: sent.append((a, t)))
        res = sw.tick(NOW)
        upd = [u for u in b.updates if u["id"] == "vs-1"][0]
        self.assertEqual(upd["status"], "in_progress")
        self.assertIn("hub_dispatched_at", upd["set_meta"])
        self.assertIn("hub_pending", upd["unset_meta"])
        self.assertEqual(res["dispatched"], 1)
        self.assertEqual(
            len([s for s in sent if s[0] == "tester-a" and "vs-1" in s[1]]), 1)

    def test_test_fail_returns_bead_to_dev(self):
        i = self.dispatched("vs-1", "tester-a", "test")
        hand = comment("vs-1", "tester-a", "HANDOFF: test-fail 3 cases red",
                       iso_ago(0.5))
        b, sw = self.board([i], [hand])
        sw.tick(NOW)
        upd = [u for u in b.updates if u["id"] == "vs-1"][0]
        self.assertEqual(upd["assignee"], "builder-a")
        self.assertEqual(upd["set_meta"].get("hub_stage"), "dev")

    def test_review_accepted_parks_at_merge_for_owner(self):
        i = self.dispatched("vs-1", "reviewer-a", "review")
        hand = comment("vs-1", "reviewer-a", "HANDOFF: review-accepted ok",
                       iso_ago(0.5))
        b, sw = self.board([i], [hand])
        sw.tick(NOW)
        upd = [u for u in b.updates if u["id"] == "vs-1"][0]
        self.assertEqual(upd["assignee"], "owner")
        self.assertEqual(upd["status"], "open")
        self.assertEqual(upd["set_meta"].get("hub_stage"), "merge")
        self.assertTrue(any(c["id"] == "vs-1" and "merge" in c["text"]
                            for c in b.posted))

    def test_changes_requested_returns_to_dev(self):
        i = self.dispatched("vs-1", "reviewer-a", "review")
        hand = comment("vs-1", "reviewer-a", "HANDOFF: changes-requested nits",
                       iso_ago(0.5))
        b, sw = self.board([i], [hand])
        sw.tick(NOW)
        upd = [u for u in b.updates if u["id"] == "vs-1"][0]
        self.assertEqual(upd["assignee"], "builder-a")
        self.assertEqual(upd["set_meta"].get("hub_stage"), "dev")

    def test_blocked_handoff_parks_with_owner(self):
        i = self.dispatched("vs-1", "builder-a", "dev", hours_ago=0.2)
        hand = comment("vs-1", "builder-a",
                       "HANDOFF: blocked the dolt service is unreachable",
                       iso_ago(0.1))
        b, sw = self.board([i], [hand])
        sw.tick(NOW)
        upd = [u for u in b.updates if u["id"] == "vs-1"][0]
        self.assertEqual(upd["status"], "blocked")
        self.assertEqual(upd["assignee"], "owner")
        self.assertEqual(upd["set_meta"].get("hub_blocked_from"), "dev")
        self.assertIn("hub_blocked_at", upd["set_meta"])
        self.assertTrue(any(c["id"] == "vs-1" for c in b.posted))

    def test_invalid_verb_for_stage_is_owner_blocked(self):
        i = self.dispatched("vs-1", "builder-a", "dev")
        hand = comment("vs-1", "builder-a",
                       "HANDOFF: review-accepted premature skip", iso_ago(0.5))
        b, sw = self.board([i], [hand])
        sw.tick(NOW)
        upd = [u for u in b.updates if u["id"] == "vs-1"][0]
        self.assertEqual(upd["status"], "blocked")
        self.assertEqual(upd["assignee"], "owner")

    def test_handoff_by_other_agent_ignored(self):
        i = self.dispatched("vs-1", "builder-a", "dev")
        hand = comment("vs-1", "stray", "HANDOFF: dev-done early", iso_ago(0.5))
        b, sw = self.board([i], [hand])
        sw.tick(NOW)
        self.assertFalse([u for u in b.updates if u["id"] == "vs-1"])

    def test_stale_handoff_ignored(self):
        i = self.dispatched("vs-1", "builder-a", "dev", hours_ago=2.0)
        hand = comment("vs-1", "builder-a", "HANDOFF: dev-done stale-link",
                       iso_ago(5.0))
        b, sw = self.board([i], [hand])
        sw.tick(NOW)
        self.assertFalse([u for u in b.updates if u["id"] == "vs-1"])

    def test_handoff_to_stage_without_agent_parks_owner(self):
        cfg = self.cfg2(VS_HUB_AGENTS='{"dev": "builder-a"}')
        i = self.dispatched("vs-1", "builder-a", "dev")
        hand = comment("vs-1", "builder-a", "HANDOFF: dev-done the-link",
                       iso_ago(0.5))
        b, sw = self.board([i], [hand], cfg=cfg)
        sw.tick(NOW)
        upd = [u for u in b.updates if u["id"] == "vs-1"][0]
        self.assertEqual(upd["assignee"], "owner")
        self.assertEqual(upd["status"], "blocked")

    def test_grace_handback_parks_dormant_bead_with_owner(self):
        i = self.dispatched("vs-1", "builder-a", "dev", hours_ago=9.0)
        cfg = self.cfg2(VS_HUB_GRACE_HOURS="8")
        b, sw = self.board([i], cfg=cfg)
        sw.tick(NOW)
        upd = [u for u in b.updates if u["id"] == "vs-1"][0]
        self.assertEqual(upd["status"], "blocked")
        self.assertEqual(upd["assignee"], "owner")
        self.assertEqual(upd["set_meta"].get("hub_blocked_from"), "dev")

    def test_working_chatter_resets_grace_clock(self):
        i = self.dispatched("vs-1", "builder-a", "dev", hours_ago=9.0)
        chatter = comment("vs-1", "builder-a", "WORKING: still on it",
                          iso_ago(0.2))
        cfg = self.cfg2(VS_HUB_GRACE_HOURS="8")
        b, sw = self.board([i], [chatter], cfg=cfg)
        sw.tick(NOW)
        self.assertFalse([u for u in b.updates if u["id"] == "vs-1"])

    def test_guidance_from_owner_resumes_bead(self):
        i = issue("vs-1", status="blocked", assignee="owner",
                  metadata={"hub_stage": "dev", "hub_blocked_from": "dev",
                            "hub_blocked_at": iso_ago(1.0)})
        g = comment("vs-1", "lazybaer",
                    "GUIDANCE: retry now, the dolt service is back", iso_ago(0.1))
        b, sw = self.board([i], [g])
        sw.tick(NOW)
        upd = [u for u in b.updates if u["id"] == "vs-1"][0]
        self.assertEqual(upd["assignee"], "builder-a")
        self.assertEqual(upd["status"], "open")
        self.assertEqual(upd["set_meta"].get("hub_pending"), 1)
        self.assertIn("hub_blocked_from", upd["unset_meta"])
        self.assertIn("hub_blocked_at", upd["unset_meta"])

    def test_guidance_from_non_owner_ignored(self):
        i = issue("vs-1", status="blocked", assignee="owner",
                  metadata={"hub_stage": "dev", "hub_blocked_from": "dev",
                            "hub_blocked_at": iso_ago(1.0)})
        g = comment("vs-1", "builder-a", "GUIDANCE: self-resume attempt",
                    iso_ago(0.1))
        b, sw = self.board([i], [g])
        sw.tick(NOW)
        self.assertFalse(b.updates)

    def test_stale_guidance_ignored(self):
        i = issue("vs-1", status="blocked", assignee="owner",
                  metadata={"hub_stage": "dev", "hub_blocked_from": "dev",
                            "hub_blocked_at": iso_ago(0.05)})
        stale = comment("vs-1", "lazybaer", "GUIDANCE: from before the block",
                        iso_ago(2.0))
        b, sw = self.board([i], [stale])
        sw.tick(NOW)
        self.assertFalse(b.updates)

    def test_reping_after_aging_and_silent_escalation(self):
        stale = self.dispatched("vs-1", "builder-a", "dev", hours_ago=13)
        dead = self.dispatched("vs-2", "builder-a", "dev", hours_ago=50)
        sent = []
        cfg = self.cfg2(VS_HUB_REPING_HOURS="12", VS_HUB_SILENT_HOURS="48",
                        VS_HUB_GRACE_HOURS="24")
        b, sw = self.board([stale, dead], cfg=cfg,
                           notify=lambda a, t: sent.append((a, t)))
        res = sw.tick(NOW)
        self.assertEqual([1 for s in sent if s[0] == "builder-a" and "vs-1" in s[1]]
                         .count(1), 1)
        upd_dead = [u for u in b.updates if u["id"] == "vs-2"][0]
        self.assertEqual(upd_dead["status"], "blocked")
        self.assertEqual(upd_dead["assignee"], "owner")
        upd_stale = [u for u in b.updates if u["id"] == "vs-1"]
        self.assertFalse(upd_stale)

    def test_owner_park_on_silent_does_not_loop(self):
        # After the owner-park, the bead is blocked + owner-assigned: the next
        # tick neither re-parks it nor re-dispatches it.
        i = self.dispatched("vs-1", "builder-a", "dev", hours_ago=50)
        cfg = self.cfg2(VS_HUB_SILENT_HOURS="48")
        b, sw = self.board([i], cfg=cfg)
        sw.tick(NOW)
        n1 = len(b.updates)
        res2 = sw.tick(NOW + timedelta(minutes=5))
        self.assertEqual(res2["parked"], 0)
        self.assertEqual(n1, 1)
        self.assertEqual(len(b.updates), 1)


# ------------------------------------------------------- notify wire (real)


class NotifyWire(unittest.TestCase):
    """The notify route: guard peer route or legacy gateway route over real
    HTTP with synthetic tokens on loopback."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vsr-"))
        self.hits = []
        holder = self.hits

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length).decode()
                holder.append({"path": self.path,
                               "auth": self.headers.get("Authorization", ""),
                               "body": body})
                if self.path.endswith("boom"):
                    self.send_response(500)
                else:
                    self.send_response(200)
                self.end_headers()

            def log_message(self, format, *args):  # noqa: A002 - stdlib signature
                del format, args

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.base = "http://127.0.0.1:%d" % self.srv.server_port
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_guard_route_with_local_token(self):
        env = {"A2A_GUARD_OUTBOUND_TOKEN": "synthetic-guard-token",
               "VS_HUB_NOTIFY_BASE": self.base}
        n = vr.build_notify(env)
        self.assertIsNotNone(n)
        ok = n("tester-a", "dispatch vs-1")
        self.assertEqual(self.hits[-1]["path"], "/peer/tester-a")
        self.assertIn("Bearer synthetic-guard-token", self.hits[-1]["auth"])
        self.assertEqual(ok, True)

    def test_legacy_gateway_route_fallback(self):
        env = {"A2A_OWN_IDENTITY_KEY": "synthetic-own-key",
               "GATEWAY_URL": self.base}
        n = vr.build_notify(env)
        self.assertIsNotNone(n)
        n("builder-a", "dispatch vs-2")
        self.assertEqual(self.hits[-1]["path"], "/a2a/builder-a")
        self.assertIn("Bearer synthetic-own-key", self.hits[-1]["auth"])

    def test_no_route_when_no_tokens(self):
        self.assertIsNone(vr.build_notify({}))

    def test_a2a_envelope_shape(self):
        env = {"A2A_GUARD_OUTBOUND_TOKEN": "t",
               "VS_HUB_NOTIFY_BASE": self.base}
        n = vr.build_notify(env)
        n("builder-a", "hello")
        body = json.loads(self.hits[-1]["body"])
        self.assertEqual(body["jsonrpc"], "2.0")
        self.assertEqual(body["method"], "message/send")
        msg = body["params"]["message"]
        self.assertIn(msg["role"], ("user", "ROLE_USER"))
        self.assertEqual(msg["parts"][0]["text"], "hello")

    def test_post_failure_raises_for_revert(self):
        env = {"A2A_GUARD_OUTBOUND_TOKEN": "t",
               "VS_HUB_NOTIFY_BASE": self.base}
        n = vr.build_notify(env)
        with self.assertRaises(Exception):
            n("builder-a-boom", "x")
        self.assertEqual(self.hits[-1]["path"], "/peer/builder-a-boom")


# ------------------------------------------------------------ CLI behaviors


class CliBehaviors(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vsr-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_gate_verdict_strings(self):
        ws = make_workspace(self.tmp)
        fake = FakeBd(self.tmp, status_ok=False)
        env = fake.env(env_for(ws))
        r = run_router(["gate"], env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("not ready", r.stdout)

    def test_once_summary_reported(self):
        ws = make_workspace(self.tmp)
        beads = [issue("vs-1", labels=["role:builder"], priority=1)]
        fake = FakeBd(self.tmp, list_rows=beads, ready_rows=beads)
        r = run_router(["once"], fake.env(env_for(ws)))
        self.assertEqual(r.returncode, 0)
        self.assertIn("sweep:", r.stdout)
        self.assertIn("dispatched=1", r.stdout)

    def test_lock_blocks_a_second_run(self):
        ws = make_workspace(self.tmp)
        fake = FakeBd(self.tmp, list_rows=[], ready_rows=[])
        env = fake.env(env_for(ws))
        lock = Path(ws) / ".vs-hub" / "router.lock"
        lock.parent.mkdir(parents=True, exist_ok=True)
        f = os.open(str(lock), os.O_RDONLY | os.O_CREAT, 0o600)
        try:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            r = run_router(["once"], env)
            self.assertEqual(r.returncode, 4)
            self.assertIn("busy", r.stdout)
            self.assertEqual(fake.argvs(), [])
        finally:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_UN)
            os.close(f)

    def test_gate_reports_busy_free_state(self):
        ws = make_workspace(self.tmp)
        fake = FakeBd(self.tmp, list_rows=[], ready_rows=[])
        r = run_router(["gate"], fake.env(env_for(ws)))
        self.assertEqual(r.returncode, 0)  # gate takes no lock by design


class ServeLoop(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vsr-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_serve_ticks_on_interval_and_exits_on_sigterm(self):
        ws = make_workspace(self.tmp)
        beads = [issue("vs-1", labels=["role:builder"], priority=1)]
        fake = FakeBd(self.tmp, list_rows=beads, ready_rows=beads)
        env = fake.env(env_for(ws, VS_HUB_INTERVAL="1"))
        proc = subprocess.Popen(
            [sys.executable, str(ROUTER_PATH), "serve"], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        import time
        import signal as _signal
        time.sleep(2.5)
        proc.send_signal(_signal.SIGTERM)
        out, _ = proc.communicate(timeout=20)
        self.assertEqual(proc.returncode, 0)
        ticks = out.count("sweep:")
        self.assertGreaterEqual(ticks, 2)


# ------------------------------------------------------ static source guard


class StaticSourceContract(unittest.TestCase):
    """The router's source carries the vs_ops contract constants and never
    assembles a queue-initialization verb (comment-stripped scan)."""

    def test_no_queue_init_or_sql_verb_in_code(self):
        src = ROUTER_PATH.read_text()
        code_lines = [l for l in src.splitlines()
                      if l.strip() and not l.strip().startswith("#")]
        code = "\n".join(code_lines)
        self.assertNotRegex(code, r"\bbd\s+init\b")
        self.assertNotRegex(code, r'"(init|sql)"\s*\]')  # no argv entry
        self.assertNotRegex(code, r"subprocess.*sql")

    def test_contract_constants_present(self):
        src = ROUTER_PATH.read_text()
        self.assertIn(JOIN_CONTRACT["project_id"], src)
        self.assertIn('"vs_ops"', src)
        self.assertIn("9902", src)  # the guard peer route base

    def test_only_known_bd_verbs_constructed(self):
        src = ROUTER_PATH.read_text()
        verbs = {"status", "list", "ready", "comments", "update", "comment"}
        found = set()
        for m in __import__("re").finditer(
                r'\["(status|list|ready|comments|update|comment|init|sql)'
                r'(?:",?)', src):
            found.add(m.group(1))
        self.assertTrue(found <= verbs, found)

    def test_no_secrets_in_source(self):
        src = ROUTER_PATH.read_text()
        for needle in ("BEGIN RSA PRIVATE KEY", "sk-", "ghp_", "gho_"):
            self.assertNotIn(needle, src)


if __name__ == "__main__":
    unittest.main()
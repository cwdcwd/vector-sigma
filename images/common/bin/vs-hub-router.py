#!/usr/bin/env python3
"""vs-hub-router: the VS-local hub router on the vs_ops queue.

The device's own hub. Every tick it advances the board pipeline the fleet's
hub sweep assigns work by: eligible beads enter explicit stages (dev, test,
review), stage agents post HANDOFF comments when a stage is done, and this
router validates those handoffs, moves each bead onward (or back), re-pings
stale work and hands permanently stuck work to the owner.

Design constants live in docs/vs-hub-router.md and docs/queue-conventions.md.

* The ONLY queue this router may touch is the VS queue join baked at build
  time: the workspace contract in .beads/metadata.json must match the join's
  canonical project id and the dolt server backend with the vs_ops database.
  A workspace that names any other project — including the origin fleet's
  own hub workspace — is refused before a single bd subcommand runs; the
  router performs board operations only, never the one-time queue
  initialization verb and never arbitrary raw queries: the bd argv surface
  is a fixed allowlist.
* Stages and eligibility: a ready, unassigned task enters `dev` with the
  role:builder label, `test` with role:tester (only with PR evidence), and
  `review` with role:reviewer (only with PR evidence). Beads labeled
  owner-call are never dispatched. Each stage agent is WIP-capped.
* Handoffs: the stage agent on a hub-dispatched bead posts ONE comment whose
  first line starts with ``HANDOFF:`` — dev-done / test-pass / test-fail /
  review-accepted / changes-requested / blocked, validated per stage. An
  invalid handoff (a verb the stage may not post) parks the bead with the
  owner.
* Guidance: only the owner's accounts may resume an owner-blocked bead by
  posting a ``GUIDANCE:`` comment.
* Fail-safety: dispatches are reverted to pending when their wake-up ping
  cannot be delivered; the ping goes through the signed outbound route the
  a2a-guard wiring provides (the loopback peer route, bearer read from the
  boot-managed environment). No router code path is a security boundary:
  enabling routing is the owner's choice via VS_HUB_AGENTS — without a
  roster the router is dark and performs no board operations at all.
"""

import argparse
import fcntl
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

# ------------------------------------------------------------------ contract

# The baked VS queue join (images/common/queue-join/.beads/metadata.json).
# The router verifies the workspace against these literals at every tick.
CANONICAL_PROJECT_ID = "bcde5891-5482-4eb0-a223-8533504832d6"
CANONICAL_CONTRACT = {
    "database": "vs_ops",
    "backend": "dolt",
    "dolt_mode": "server",
    "dolt_server_host": "dolt",
    "dolt_server_port": "3306",
    "dolt_server_user": "vs",
    "dolt_database": "vs_ops",
    "project_id": CANONICAL_PROJECT_ID,
}

# The handoff (comment first line) each stage may post.
STAGE_VERBS = {
    "dev": ("dev-done", "blocked"),
    "test": ("test-pass", "test-fail", "blocked"),
    "review": ("review-accepted", "changes-requested", "blocked"),
}
STAGE_ROLES = {
    "dev": "role:builder",
    "test": "role:tester",
    "review": "role:reviewer",
}
HANDOFF_TARGET_STAGE = {
    "dev-done": "test",
    "test-pass": "review",
    "test-fail": "dev",
    "changes-requested": "dev",
    "review-accepted": "merge",
}

HANDOFF_PREFIX = "HANDOFF:"
GUIDANCE_PREFIX = "GUIDANCE:"
PR_EVIDENCE_RE = re.compile(r"https?://\S+/pull/\d+", re.I)

# Defaults overridable through the container environment (owner-controlled).
DEFAULT_GUARD_BASE = "http://127.0.0.1:9902/peer/"
DEFAULT_WIP = 2
DEFAULT_OWNER = "owner"
DEFAULT_OWNER_AUTHORS = "lazybaer"
DEFAULT_INTERVAL_S = 300
DEFAULT_GRACE_HOURS = 8.0
DEFAULT_REPING_HOURS = 12.0
DEFAULT_SILENT_HOURS = 48.0
DEFAULT_ACTOR = "primus"

# Metadata keys this router owns on the board.
KEY_STAGE = "hub_stage"                # dev | test | review | merge
KEY_DISPATCHED = "hub_dispatched_at"   # ISO Z stamp of the last stage dispatch
KEY_PENDING = "hub_pending"            # 1 = staged, waiting for its wake-up
KEY_BLOCKED_FROM = "hub_blocked_from"  # stage the bead was owner-blocked in
KEY_BLOCKED_AT = "hub_blocked_at"      # when the owner park happened

# The bd argv allowlist: routing reads the board (server status, work lists,
# comment threads) and applies targeted item edits (assignment, status,
# metadata, comments). The one-time project setup verb and the raw query
# passthrough are deliberately absent — no boot path may re-initialize or
# query the queue outside these verbs.
BOARD_VERBS = ("status", "list", "ready", "comments", "update", "comment")


class BoardError(RuntimeError):
    """A board operation failed."""


class ConfigError(ValueError):
    """The owner's routing configuration is unusable."""


def log(text):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), text, flush=True)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text):
    if not text or not isinstance(text, str):
        return None
    try:
        parsed = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def base_name(name):
    """Normalize an agent/account label for identity comparisons.

    The board mixes fleet naming styles; route identity is the bare lowercase
    name: email domains, mesh prefixes and bot suffixes are presentation.
    """
    if not name or not isinstance(name, str):
        return ""
    cleaned = name.strip().lower()
    if "@" in cleaned:
        cleaned = cleaned.split("@", 1)[0]
    if cleaned.endswith("[bot]"):
        cleaned = cleaned[:-5]
    if cleaned.startswith("thecabal-"):
        cleaned = cleaned[len("thecabal-"):]
    if cleaned.endswith("-bot"):
        cleaned = cleaned[:-4]
    return cleaned


def parse_roster(raw):
    """VS_HUB_AGENTS: {"dev": "…", "test": "…", "review": "…"} (partial OK)."""
    if raw is None or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError as e:
        raise ConfigError(f"VS_HUB_AGENTS is not JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise ConfigError("VS_HUB_AGENTS must be a JSON object of stage -> agent")
    roster = {}
    for stage, agent in parsed.items():
        if stage not in STAGE_VERBS:
            raise ConfigError(
                f"VS_HUB_AGENTS stage {stage!r} is not a routing stage;"
                " expected one of dev, test, review")
        if (not isinstance(agent, str) or not agent.strip()
                or agent.strip() != agent or "[" in agent):
            raise ConfigError(
                f"VS_HUB_AGENTS stage {stage!r} must map to a bare agent"
                f" name, got {agent!r}")
        roster[stage] = agent.strip().lower()
    return roster


def _env_float(env, key, default, *, minimum=0.0):
    raw = (env.get(key) or "").strip()
    if not raw:
        return float(default)
    try:
        value = float(raw)
    except ValueError as e:
        raise ConfigError(f"env {key}={raw!r} is not a number") from e
    if value < minimum:
        raise ConfigError(f"env {key}={raw!r} must be >= {minimum}")
    return value


def _env_int(env, key, default, *, minimum=1):
    raw = (env.get(key) or "").strip()
    if not raw:
        return int(default)
    try:
        value = int(raw)
    except ValueError as e:
        raise ConfigError(f"env {key}={raw!r} is not an integer") from e
    if value < minimum:
        raise ConfigError(f"env {key}={raw!r} must be >= {minimum}")
    return value


class Config:
    """Resolved routing configuration from the container environment."""

    def __init__(self, *, workspace, roster, wip, owner, owner_authors,
                 notify_mode, notify_base, interval, grace_hours, reping_hours,
                 silent_hours, actor):
        self.workspace = workspace
        self.roster = roster
        self.wip = wip
        self.owner = owner
        self.owner_authors = owner_authors
        self.notify_mode = notify_mode
        self.notify_base = notify_base
        self.interval = interval
        self.grace_hours = grace_hours
        self.reping_hours = reping_hours
        self.silent_hours = silent_hours
        self.actor = actor

    @classmethod
    def from_env(cls, env):
        roster = parse_roster(env.get("VS_HUB_AGENTS"))
        workspace = (env.get("VS_QUEUE_DIR") or "").strip() or os.path.join(
            (env.get("HERMES_HOME") or "/opt/data").strip() or "/opt/data",
            "vs-queue")
        authors_raw = (env.get("VS_HUB_OWNER_AUTHORS")
                       or DEFAULT_OWNER_AUTHORS).strip() or DEFAULT_OWNER_AUTHORS
        notify_raw = (env.get("VS_HUB_NOTIFY") or "").strip()
        notify_mode = "off" if notify_raw in ("0", "off", "false") else "auto"
        return cls(
            workspace=workspace,
            roster=roster,
            wip=_env_int(env, "VS_HUB_WIP", DEFAULT_WIP),
            owner=(env.get("VS_HUB_OWNER") or DEFAULT_OWNER).strip() or DEFAULT_OWNER,
            owner_authors={base_name(p) for p in authors_raw.split(",")
                           if base_name(p)},
            notify_mode=notify_mode,
            notify_base=(env.get("VS_HUB_NOTIFY_BASE")
                         or DEFAULT_GUARD_BASE).strip(),
            interval=_env_int(env, "VS_HUB_INTERVAL", DEFAULT_INTERVAL_S),
            grace_hours=_env_float(env, "VS_HUB_GRACE_HOURS", DEFAULT_GRACE_HOURS),
            reping_hours=_env_float(env, "VS_HUB_REPING_HOURS", DEFAULT_REPING_HOURS),
            silent_hours=_env_float(env, "VS_HUB_SILENT_HOURS", DEFAULT_SILENT_HOURS),
            actor=(env.get("VS_HUB_ACTOR") or DEFAULT_ACTOR).strip() or DEFAULT_ACTOR,
        )

    def agent_for(self, stage):
        return self.roster.get(stage)


# -------------------------------------------------------------- board access


class Board:
    """bd board access — the subcommand allowlist is the scoping contract.

    The router touches the queue through exactly the read verbs below (board
    server status, work lists, comment threads) run in the join workspace,
    plus the targeted item-edit verbs for assignment/status/metadata and
    comments.
    """

    def __init__(self, workspace, env=None):
        self.workspace = workspace
        self.env = dict(env if env is not None else os.environ)

    def _run(self, argv):
        try:
            proc = subprocess.run(
                ["bd", *argv], cwd=self.workspace, env=self.env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                timeout=120)
        except FileNotFoundError as e:
            raise BoardError(f"bd is not available on PATH: {e}") from e
        except subprocess.TimeoutExpired:
            raise BoardError(f"bd {argv[0]} timed out") from None
        if proc.returncode != 0:
            detail = (proc.stderr or "").strip()[-200:]
            raise BoardError(f"bd {argv[0]} failed: {detail}")
        return proc.stdout

    def _run_json(self, argv):
        out = self._run(argv)
        try:
            return json.loads(out)
        except ValueError:
            raise BoardError(
                f"bd {argv[0]} returned non-JSON output: {out[:120]!r}") from None

    def status_ok(self):
        """True when the dolt-backed server answers a board read.

        A missing bd harness is not a board outage (contract-only boots still
        gate the workspace); connectivity is probed whenever the harness
        exists on PATH.
        """
        try:
            out = self._run(["status"])
        except BoardError as e:
            if "available on PATH" in str(e):
                return True
            return False
        return "Issue Database Status" in (out or "")

    def list_issues(self):
        return self._run_json(["list", "-n", "0", "--json"])

    def ready(self):
        return self._run_json(["ready", "-n", "0", "--exclude-type", "epic",
                               "--json"])

    def comments(self, iid):
        return self._run_json(["comments", iid, "--json"])

    def update(self, iid, *, assignee=None, status=None, set_meta=None,
               unset_meta=None):
        argv = ["update", iid]
        if assignee is not None:
            argv += ["-a", assignee]
        if status is not None:
            argv += ["-s", status]
        for key, value in (set_meta or {}).items():
            argv += ["--set-metadata", f"{key}={value}"]
        for key in (unset_meta or []):
            argv += ["--unset-metadata", key]
        argv += ["-q"]
        self._run(argv)

    def comment(self, iid, text):
        self._run(["comment", iid, text, "-q"])


def load_contract_violation(workspace):
    """Return the refusal reason for a foreign/malformed workspace, or None
    when it is the canonical vs_ops join."""
    if not workspace or not os.path.isdir(workspace):
        return "workspace directory does not exist"
    path = os.path.join(workspace, ".beads", "metadata.json")
    try:
        with open(path) as f:
            raw = f.read()
    except OSError as e:
        return f"no queue join contract present ({getattr(e, 'strerror', str(e))})"
    try:
        meta = json.loads(raw)
    except ValueError:
        return "queue join contract is not JSON"
    if not isinstance(meta, dict):
        return "queue join contract is not an object"
    if "fleet_ops" in raw:
        return ("this workspace carries the origin fleet's queue contract,"
                " not the device's vs_ops queue")
    if "e3796a22" in raw:
        return ("this workspace is registered to the origin fleet's project,"
                " not the device's vs_ops queue")
    for key, expected in CANONICAL_CONTRACT.items():
        actual = meta.get(key)
        if str(actual) != str(expected):
            return f"join contract mismatch on {key}: {actual!r} != {expected!r}"
    return None


# --------------------------------------------------------------- wake-up ping


def _a2a_envelope(message_id, text):
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "method": "message/send",
        "params": {
            "message": {
                "role": "user",
                "messageId": message_id,
                "parts": [{"kind": "text", "text": text}],
            }
        },
    }


def _post(url, token, text, timeout_s=20.0):
    message_id = "vs-hub-router-" + str(time.time_ns())
    request = urllib.request.Request(
        url,
        data=json.dumps(_a2a_envelope(message_id, text)).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        response.read(256)
    return True


def build_notify(env):
    """Resolve the agent wake-up route from the wiring hook's environment.

    Preferred: the a2a-guard's signed outbound peer route on loopback,
    bearer A2A_GUARD_OUTBOUND_TOKEN. Fallback for agents without the signed
    mesh identity: the gateway's A2A endpoint with the agent's own identity
    key. Returns callable(agent, text), or None when no route is configured.
    """
    guard_token = (env.get("A2A_GUARD_OUTBOUND_TOKEN") or "").strip()
    base = (env.get("VS_HUB_NOTIFY_BASE") or DEFAULT_GUARD_BASE).strip()
    if guard_token:
        peer_base = base.rstrip("/")
        if not peer_base.endswith("/peer"):
            peer_base += "/peer"
        return lambda agent, text: _post(
            f"{peer_base}/{agent}", guard_token, text)
    legacy_token = (env.get("A2A_OWN_IDENTITY_KEY") or "").strip()
    gateway = (env.get("GATEWAY_URL") or "").strip()
    if legacy_token and gateway:
        url_base = gateway.rstrip("/") + "/a2a/"
        return lambda agent, text: _post(url_base + agent, legacy_token, text)
    return None


# ----------------------------------------------------------------- the sweep


def handoff_verb(text):
    """The handoff verb from a comment's first line, or None (plain chatter)."""
    lines = (text or "").strip().splitlines()
    if not lines:
        return None
    line = lines[0].strip()
    if not line.startswith(HANDOFF_PREFIX):
        return None
    rest = line[len(HANDOFF_PREFIX):].strip()
    if not rest:
        return None
    verb = rest.split(" ", 1)[0].strip().lower()
    return verb or None


def stage_of_candidate(row):
    """The intake stage of a ready candidate: None when not eligible."""
    labels = set(row.get("labels") or [])
    if "owner-call" in labels:
        return None
    for stage in ("review", "test", "dev"):
        if STAGE_ROLES[stage] in labels:
            return stage
    return None


def has_pr_evidence(row, comments):
    if PR_EVIDENCE_RE.search(row.get("description") or ""):
        return True
    for c in comments or ():
        if PR_EVIDENCE_RE.search(c.get("text") or ""):
            return True
    return False


def fmt_hours(delta):
    seconds = max(delta.total_seconds(), 0.0)
    if seconds >= 3600 * 96:
        return f"{seconds / 3600.0:.0f}h"
    return f"{seconds / 3600.0:.1f}h"


class Sweep:
    """One board sweep per tick.

    Pass order: handoff validation -> owner-guidance resume -> grace/re-ping
    on dispatched work -> intake selection -> dispatch (WIP-capped, one
    wake-up per agent, reverted to pending when the wake-up cannot post).
    """

    def __init__(self, board, cfg, notify):
        self.board = board
        self.cfg = cfg
        self.notify = notify
        self.now = datetime.now(timezone.utc)
        self.counters = {}
        self.acted = set()
        self.reping = []
        self.log = []

    # -- helpers -------------------------------------------------------

    def _comments_since(self, row, since=None):
        parsed = []
        for c in self.board.comments(row["id"]):
            at = parse_iso(c.get("created_at"))
            if at is None:
                continue
            if since is not None and at <= since:
                continue
            parsed.append((at, c))
        parsed.sort(key=lambda item: item[0])
        return parsed

    def _comment(self, iid, text):
        first = text.splitlines()[0][:120] if text else ""
        self.log.append(f"commented {iid}: {first}")
        self.board.comment(iid, text)

    def _stamp(self):
        """UTC stamp for board metadata, from the sweep's own clock."""
        return self.now.strftime("%Y-%m-%dT%H:%M:%SZ")

    def _park_owner(self, row, stage, reason):
        meta = {KEY_BLOCKED_FROM: stage, KEY_BLOCKED_AT: self._stamp()}
        self.board.update(row["id"], assignee=self.cfg.owner, status="blocked",
                          set_meta=meta,
                          unset_meta=[KEY_DISPATCHED, KEY_PENDING])
        self._comment(
            row["id"],
            f"owner-blocked: {reason}. The bead is parked with the owner;"
            " resume it with a GUIDANCE: comment.")
        self.counters["parked"] += 1
        self.acted.add(row["id"])
        self.log.append(f"parked {row['id']} at stage {stage}: {reason}")

    def _resume_for_guidance(self, row, stage):
        agent = self.cfg.agent_for(stage)
        if not agent:
            self.log.append(
                f"guidance for {row['id']}: stage {stage} has no agent;"
                " bead stays owner-blocked")
            return
        self.board.update(row["id"], assignee=agent, status="open",
                          set_meta={KEY_PENDING: 1},
                          unset_meta=[KEY_BLOCKED_FROM, KEY_BLOCKED_AT])
        self.acted.add(row["id"])
        self.log.append(
            f"resuming {row['id']} into stage {stage} for {agent} after GUIDANCE")

    # -- passes ---------------------------------------------------------

    def _pass_handoffs(self, rows):
        cfg = self.cfg
        for row in rows:
            meta = row.get("metadata") or {}
            stage = meta.get(KEY_STAGE)
            dispatched_at = parse_iso(meta.get(KEY_DISPATCHED))
            if (row.get("status") != "in_progress" or stage not in STAGE_VERBS
                    or dispatched_at is None):
                continue
            assignee = base_name(row.get("assignee"))
            if not assignee or assignee == base_name(cfg.owner):
                continue
            latest_handoff = None
            for at, c in self._comments_since(row, since=dispatched_at):
                if base_name(c.get("author")) != assignee:
                    continue
                verb = handoff_verb(c.get("text"))
                if verb:
                    latest_handoff = (at, verb)
            if latest_handoff is None:
                continue
            _, verb = latest_handoff
            if verb not in STAGE_VERBS.get(stage, ()):
                self._park_owner(
                    row, stage,
                    f"invalid handoff {verb!r} from stage {stage} (allowed:"
                    f" {', '.join(STAGE_VERBS[stage])})")
                continue
            self.counters["handoffs"] += 1
            self.acted.add(row["id"])
            self._apply_handoff(row, stage, verb)

    def _apply_handoff(self, row, stage, verb):
        cfg = self.cfg
        target = HANDOFF_TARGET_STAGE.get(verb)
        if target == "merge":
            self.board.update(row["id"], assignee=cfg.owner, status="open",
                              set_meta={KEY_STAGE: "merge"},
                              unset_meta=[KEY_DISPATCHED, KEY_PENDING,
                                          KEY_BLOCKED_FROM, KEY_BLOCKED_AT])
            self._comment(
                row["id"],
                "review accepted — handed to the owner for merge; the router"
                " does not write GitHub (the owner pushes or closes).")
            self.log.append(f"{row['id']}: {stage} -> merge (owner hand)")
            return
        agent = cfg.agent_for(target)
        if not agent:
            self._park_owner(row, stage,
                             f"no agent is configured for stage {target}"
                             f" (handoff {verb}); the bead is staged in"
                             f" {target}")
            return
        self.board.update(row["id"], assignee=agent, status="open",
                          set_meta={KEY_STAGE: target, KEY_PENDING: 1},
                          unset_meta=[KEY_DISPATCHED, KEY_BLOCKED_FROM,
                                      KEY_BLOCKED_AT])
        self.log.append(
            f"{row['id']}: {stage} -> {target} ({verb}); pending for {agent}")

    def _pass_guidance(self, rows):
        cfg = self.cfg
        for row in rows:
            meta = row.get("metadata") or {}
            stage_from = meta.get(KEY_BLOCKED_FROM)
            blocked_at = parse_iso(meta.get(KEY_BLOCKED_AT))
            if (row.get("status") != "blocked"
                    or stage_from not in STAGE_VERBS or blocked_at is None):
                continue
            for _, c in self._comments_since(row, since=blocked_at):
                if base_name(c.get("author")) not in cfg.owner_authors:
                    continue
                if (c.get("text") or "").strip().startswith(GUIDANCE_PREFIX):
                    self._resume_for_guidance(row, stage_from)
                break

    def _pass_grace_and_reping(self, rows):
        cfg = self.cfg
        now = self.now
        grace = timedelta(hours=cfg.grace_hours)
        reping = timedelta(hours=cfg.reping_hours)
        silent = timedelta(hours=cfg.silent_hours)
        for row in rows:
            meta = row.get("metadata") or {}
            stage = meta.get(KEY_STAGE)
            dispatched_at = parse_iso(meta.get(KEY_DISPATCHED))
            if (row.get("status") != "in_progress" or stage not in STAGE_VERBS
                    or dispatched_at is None or row["id"] in self.acted):
                continue
            assignee = base_name(row.get("assignee"))
            last_activity = dispatched_at
            if assignee:
                for at, c in self._comments_since(row, since=dispatched_at):
                    if base_name(c.get("author")) == assignee:
                        last_activity = at
            if now - dispatched_at > silent:
                self._park_owner(
                    row, stage,
                    f"silent for {fmt_hours(now - dispatched_at)}"
                    " — no handoff and no comment; handed to the owner")
                continue
            if now - last_activity > grace:
                self._park_owner(
                    row, stage,
                    f"no handoff within the {fmt_hours(grace)} grace window")
                continue
            if self.notify is not None and now - last_activity > reping:
                self.reping.append((row.get("assignee") or assignee, row))

    def _candidates(self, rows_by_id):
        """Ready, unassigned, correctly-labeled work the hub may take in."""
        cfg = self.cfg
        candidates = []
        for row in self.board.ready():
            if not isinstance(row, dict) or not row.get("id"):
                continue
            if row.get("issue_type") == "epic":
                continue
            if row.get("status") != "open":
                continue
            if row.get("assignee"):
                continue
            if (row.get("metadata") or {}).get(KEY_STAGE):
                continue
            stage = stage_of_candidate(row)
            if stage is None:
                continue
            if not cfg.agent_for(stage):
                continue
            if stage in ("test", "review") and not has_pr_evidence(
                    row, self.board.comments(row["id"])):
                self.log.append(
                    f"intake held back {row['id']}: stage {stage} needs merge"
                    " evidence (a PR link in the description or comments)")
                continue
            candidates.append((row, stage))
        return candidates

    def _prioritized(self, rows_by_id, extra_candidates=()):
        """Owner-pending beads first (oldest ticket first), then candidates."""
        cfg = self.cfg
        work = []
        seen = set()
        for row in rows_by_id.values():
            meta = row.get("metadata") or {}
            if (row.get("status") == "open" and meta.get(KEY_PENDING)
                    and meta.get(KEY_STAGE) in STAGE_VERBS
                    and cfg.agent_for(meta[KEY_STAGE])):
                work.append((row, meta[KEY_STAGE]))
                seen.add(row["id"])
        for row, stage in extra_candidates:
            if row.get("id") not in seen:
                work.append((row, stage))
                seen.add(row["id"])
        return sorted(
            work,
            key=lambda item: (
                item[0].get("priority") if item[0].get("priority") is not None
                else 9_999,
                item[0].get("id") or ""))

    def _pass_dispatch(self, rows_by_id, candidates):
        cfg = self.cfg
        if cfg.notify_mode == "auto" and self.notify is None:
            self.log.append(
                "dispatch disabled: no wake-up route is configured; set"
                " VS_HUB_NOTIFY=0 for board-only dispatch or configure the"
                " signed outbound token")
            return
        work = self._prioritized(rows_by_id, candidates)
        stamped = {}
        for row, stage in work:
            if row["id"] in self.acted:
                continue
            agent = cfg.agent_for(stage)
            running = sum(
                1 for r in rows_by_id.values()
                if base_name(r.get("assignee")) == base_name(agent)
                and r.get("status") == "in_progress"
                and (r.get("metadata") or {}).get(KEY_STAGE))
            running += len(stamped.get(agent, []))
            if running >= cfg.wip:
                self.log.append(
                    f"WIP cap {cfg.wip} reached for {agent}; {row['id']}"
                    " stays waiting")
                continue
            pending_now = bool((row.get("metadata") or {}).get(KEY_PENDING))
            self.board.update(
                row["id"], assignee=agent, status="in_progress",
                set_meta={KEY_STAGE: stage, KEY_DISPATCHED: self._stamp(),
                          KEY_PENDING: 0},
                unset_meta=[KEY_PENDING] if pending_now else [])
            stamped.setdefault(agent, []).append(
                (row["id"], row.get("title") or row["id"]))
            self.acted.add(row["id"])
            self.counters["dispatched"] += 1
        self._send_wakeups(stamped)

    def _send_wakeups(self, stamped):
        agents = {base_name(a) for a, _row in self.reping}
        agents.update(stamped)
        for agent in sorted(a for a in agents if a):
            if self.notify is None:
                continue
            items = stamped.get(agent, [])
            parts = [f"dispatch {iid} — {title}" for iid, title in items]
            parts += [f"re-ping {row['id']} — hand off or report"
                      for a, row in self.reping
                      if base_name(a) == agent]
            if not parts:
                continue
            text = ("hub dispatch from " + self.cfg.actor + ":\n"
                    + "\n".join("  " + part for part in parts))
            try:
                self.notify(agent, text)
            except Exception as e:  # transport failure: fail closed
                self.log.append(
                    f"wake-up to {agent} failed ({type(e).__name__}):"
                    f" {str(e)[:120]}; reverting {len(items)} dispatch(es)"
                    " to pending")
                for iid, _title in items:
                    self.board.update(iid, assignee=self.cfg.actor,
                                      status="open",
                                      set_meta={KEY_PENDING: 1},
                                      unset_meta=[KEY_DISPATCHED])
                    self.counters["reverted"] += 1

    # -- orchestration ----------------------------------------------------

    def tick(self, now=None):
        self.now = now or datetime.now(timezone.utc)
        self.counters = {"dispatched": 0, "handoffs": 0, "reverted": 0,
                         "parked": 0}
        self.acted = set()
        self.reping = []
        self.log = []
        rows = [r for r in self.board.list_issues()
                if isinstance(r, dict) and r.get("id")]
        by_id = {r["id"]: r for r in rows}
        self._pass_handoffs(rows)
        self._pass_guidance(rows)
        self._pass_grace_and_reping(rows)
        candidates = self._candidates(by_id)
        self._pass_dispatch(by_id, candidates)
        return dict(self.counters)


# ------------------------------------------------------------------ CLI


def _load_cfg_or_none():
    try:
        return Config.from_env(os.environ)
    except ConfigError as e:
        print(f"refused: {e}")
        return None


def _acquire_lock(workspace):
    """Take the router's own lock inside the (contract-verified) workspace.

    Returns the lock fd, or None when another router instance holds it — a
    single lock keeps the service and any operator-driven run from running
    interleaved sweeps against the same queue.
    """
    holder = os.path.join(workspace, ".vs-hub")
    os.makedirs(holder, exist_ok=True)
    fd = os.open(os.path.join(holder, "router.lock"), os.O_RDWR | os.O_CREAT,
                 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    return fd


def _release_lock(lock):
    fcntl.flock(lock, fcntl.LOCK_UN)
    os.close(lock)


def _gate_verdict(cfg):
    """The ordered readiness checks. Returns (verdict_text, board, exit)."""
    if not cfg.roster:
        return ("unconfigured — no VS_HUB_AGENTS roster; the router is dark",
                None, 3)
    violation = load_contract_violation(cfg.workspace)
    if violation:
        return f"refused: {violation}", None, 2
    board = Board(cfg.workspace)
    if not board.status_ok():
        return "not ready — the board server connection failed", None, 1
    return ("ok — the vs_ops queue join is verified and the board answers",
            board, 0)


def _run_tick(board, cfg):
    notify = build_notify(os.environ) if cfg.notify_mode == "auto" else None
    sweep = Sweep(board, cfg, notify)
    summary = sweep.tick()
    print("sweep: dispatched={dispatched} handoffs={handoffs} parked={parked}"
          " reverted={reverted}".format(**summary))
    for line in sweep.log:
        print("  " + line)
    return summary


def cmd_gate():
    cfg = _load_cfg_or_none()
    if cfg is None:
        return 2
    verdict, _board, code = _gate_verdict(cfg)
    print(f"gate: {verdict}")
    return code


def cmd_once():
    cfg = _load_cfg_or_none()
    if cfg is None:
        return 2
    if not cfg.roster:
        print("once: unconfigured — no VS_HUB_AGENTS roster; the router is"
              " dark")
        return 3
    violation = load_contract_violation(cfg.workspace)
    if violation:
        print(f"once: refused: {violation}")
        return 2
    lock = _acquire_lock(cfg.workspace)
    if lock is None:
        print("once: busy — another vs-hub-router instance holds the lock")
        return 4
    try:
        board = Board(cfg.workspace)
        if not board.status_ok():
            print("once: not ready — the board server connection failed;"
                  " nothing routed")
            return 1
        _run_tick(board, cfg)
    except BoardError as e:
        print(f"once: failed: {e}", file=sys.stderr)
        return 1
    finally:
        _release_lock(lock)
    return 0


def cmd_serve():
    cfg = _load_cfg_or_none()
    if cfg is None:
        return 2
    if not cfg.roster:
        print("serve: unconfigured — no VS_HUB_AGENTS roster; nothing to serve")
        return 3

    import signal as _signal

    def _stop(_sig, _frame):
        raise SystemExit(0)

    _signal.signal(_signal.SIGTERM, _stop)
    _signal.signal(_signal.SIGINT, _stop)

    lock = _acquire_lock(cfg.workspace)
    if lock is None:
        print("serve: busy — another vs-hub-router instance holds the lock")
        return 4
    try:
        while True:
            verdict, board, _code = _gate_verdict(cfg)
            if board is None:
                # Park loud, touch nothing: the queue contract or its board
                # server is unavailable; re-verify on the next interval.
                print(f"serve: parked — {verdict}")
                time.sleep(cfg.interval)
                continue
            try:
                _run_tick(board, cfg)
            except BoardError as e:
                print(f"serve: tick failed ({e}); retrying next interval",
                      file=sys.stderr)
            time.sleep(cfg.interval)
    finally:
        _release_lock(lock)


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="vs-hub-router",
        description="the VS-local hub router on the vs_ops queue")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("gate", help="print the routing-gate verdict and exit")
    sub.add_parser("once", help="run one sweep and exit")
    sub.add_parser("serve", help="run sweeps on the configured interval")
    args = ap.parse_args(argv)
    if args.cmd == "gate":
        return cmd_gate()
    if args.cmd == "once":
        return cmd_once()
    return cmd_serve()


if __name__ == "__main__":
    sys.exit(main())
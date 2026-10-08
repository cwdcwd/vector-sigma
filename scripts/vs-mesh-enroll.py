#!/usr/bin/env python3
"""vs-mesh-enroll — the primus one-command A2A mesh enroll CLI
(fleet-ops-j7g.1 shape B).

Thin by design: ALL mint logic lives in the registrar's mesh-enroll
action (server-side). This CLI authenticates with primus's scoped
MESH_ENROLL_KEY — delivered in the registrar bundle's config/agent.env
(never an image layer) — and POSTs one enroll request. The API returns
{alias, action, merged, bundle_version} ONLY: key material never
crosses back (the capability's own constraint).

Auth resolution order (first hit wins):
  1. $MESH_ENROLL_KEY (explicit env — e.g. a service variable)
  2. $HERMES_HOME/config/agent.env line MESH_ENROLL_KEY=...
     (the registrar-delivered bundle — the canonical device path)

Usage:
  vs-mesh-enroll <agent-name> [--origin-url URL] [--public-url URL] [--status]

Defaults: --origin-url and --public-url derive from $A2A_PUBLIC_URL
(also bundle-delivered): origin = <edge>/a2a/<agent>, public = <edge>.
--status is the cheap liveness probe (GET /v1/mesh-enroll/status) —
no mint, no merge.

Exit codes: 0 success (or status-ok), 1 usage error, 2 auth missing,
3 API failure (message on stderr).
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

ENV_KEY_NAME = "MESH_ENROLL_KEY"
ENV_PUBLIC_URL = "A2A_PUBLIC_URL"
DEFAULT_REGISTRAR = "http://registrar:3000"


def read_env_file(path: str) -> dict:
    """Parse KEY=VALUE lines (comments/blank skipped)."""
    out = {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                out[key.strip()] = value.strip()
    except OSError:
        pass
    return out


def resolve_auth() -> str | None:
    key = os.environ.get(ENV_KEY_NAME, "").strip()
    if key:
        return key
    home = os.environ.get("HERMES_HOME", "").strip()
    if home:
        env = read_env_file(os.path.join(home, "config", "agent.env"))
        key = env.get(ENV_KEY_NAME, "").strip()
        if key:
            return key
    return None


def resolve_registrar() -> str:
    """REGISTRAR_URL wins; else the compose-internal default (primus)."""
    url = os.environ.get("REGISTRAR_URL", "").strip().rstrip("/")
    return url if url else DEFAULT_REGISTRAR


def resolve_public_url() -> str | None:
    url = os.environ.get(ENV_PUBLIC_URL, "").strip()
    if url:
        return url
    home = os.environ.get("HERMES_HOME", "").strip()
    if home:
        env = read_env_file(os.path.join(home, "config", "agent.env"))
        url = env.get(ENV_PUBLIC_URL, "").strip()
        if url:
            return url
    return None


def call(registrar: str, key: str, method: str, path: str, body: dict | None = None):
    url = f"{registrar}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {key}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = resp.read().decode("utf-8", "replace")
            return resp.status, payload
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")
    except urllib.error.URLError as err:
        print(f"vs-mesh-enroll: cannot reach the registrar at {registrar}: {err.reason}", file=sys.stderr)
        sys.exit(3)


def main() -> int:
    parser = argparse.ArgumentParser(prog="vs-mesh-enroll", description=(__doc__ or "").split("\n")[1])
    parser.add_argument("agent", nargs="?", help="the agent name to enroll (e.g. optimus-prime)")
    parser.add_argument("--origin-url", help="the enrollee's A2A origin the gateway dials (default <edge>/a2a/<agent>)")
    parser.add_argument("--public-url", help="the mesh edge written to the bundle public_url (default $A2A_PUBLIC_URL)")
    parser.add_argument("--status", action="store_true", help="liveness probe only (no mint, no merge)")
    args = parser.parse_args()

    key = resolve_auth()
    if key is None:
        print(
            f"vs-mesh-enroll: no {ENV_KEY_NAME} — set it as a service variable or deliver it in the "
            f"bundle's config/agent.env (the registrar console mints one: Admin → Mesh-enroll keys)",
            file=sys.stderr,
        )
        return 2

    registrar = resolve_registrar()

    if args.status:
        status, body = call(registrar, key, "GET", "/v1/mesh-enroll/status")
        if status == 200:
            print(f"mesh-enroll surface: OK ({body.strip()})")
            return 0
        print(f"vs-mesh-enroll: status probe answered {status}: {body.strip()}", file=sys.stderr)
        return 3

    if not args.agent:
        print("vs-mesh-enroll: agent name required (or --status)", file=sys.stderr)
        return 1

    public_url = args.public_url or resolve_public_url()
    if not public_url:
        print(
            "vs-mesh-enroll: no --public-url and no $A2A_PUBLIC_URL — the mesh edge is required",
            file=sys.stderr,
        )
        return 1
    public_url = public_url.rstrip("/")
    origin_url = args.origin_url or f"{public_url}/a2a/{args.agent}"

    status, body = call(
        registrar,
        key,
        "POST",
        "/v1/mesh-enroll",
        {
            "agent_name": args.agent,
            "origin_url": origin_url,
            "public_url": public_url,
        },
    )
    if status != 200:
        print(f"vs-mesh-enroll: enroll failed ({status}): {body.strip()}", file=sys.stderr)
        return 3
    try:
        parsed = json.loads(body)
        print(
            f"enrolled {parsed.get('agent', args.agent)}: alias={parsed.get('alias')} "
            f"action={parsed.get('action')} merged={parsed.get('merged')} "
            f"bundle_version={parsed.get('bundle_version')}"
        )
    except json.JSONDecodeError:
        print(f"enrolled (raw): {body.strip()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
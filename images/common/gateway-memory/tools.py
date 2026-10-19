"""Tool handlers — talk to the gateway's /v1/memory API.

Scope selection just picks which gateway virtual key signs the request:
- "shared": GATEWAY_MEMORY_SHARED_KEY (team-scoped) -> row visible to the
  whole team, writable only by whoever created it.
- "private": GATEWAY_MEMORY_PRIVATE_KEY (no team_id on that key at all)
  -> row invisible to every other identity, including teammates. The
  gateway stamps user_id/team_id from the calling key's own identity and
  gives non-admin callers no way to opt a single key out of its own team
  scope per-request, so "shared" and "private" must be different keys.

Both keys are dedicated, route-restricted (allowed_routes=["/v1/memory",
"/v1/memory/*" — matching is exact-or-prefix, so "/v1/memory" alone also
covers "/v1/memory/<key>") memory-only keys — deliberately separate from
this agent's main GATEWAY_API_KEY (used for LLM/MCP calls), because the
gateway's `allowed_routes` is a hard global allowlist once non-empty: it
cannot be used to *add* one extra route to a key that also needs
unrestricted LLM access.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

_DEFAULT_BASE_URL = ""  # no default gateway: unset env fails loud, never
# silently targets another fleet's store (cross-fleet leak guard).
_TIMEOUT_SECONDS = 10


def _base_url() -> str:
    return os.environ.get("FLEET_MEMORY_BASE_URL", _DEFAULT_BASE_URL).rstrip("/")


def _key_for_scope(scope: str):
    if scope == "private":
        return os.environ.get("GATEWAY_MEMORY_PRIVATE_KEY")
    return os.environ.get("GATEWAY_MEMORY_SHARED_KEY")


def _missing_key_error(scope: str) -> dict:
    var = "GATEWAY_MEMORY_PRIVATE_KEY" if scope == "private" else "GATEWAY_MEMORY_SHARED_KEY"
    return {"error": f"{var} is not set on this host — {scope} fleet memory is unavailable."}


def _request(method: str, path: str, scope: str, body: dict | None = None):
    """Returns (result_dict_or_None, error_dict_or_None). Never raises."""
    api_key = _key_for_scope(scope)
    if not api_key:
        return None, _missing_key_error(scope)

    base = _base_url()
    if not base:
        return None, {"error": "FLEET_MEMORY_BASE_URL is not set on this host — the memory gateway location is unset; memory tools are unavailable until the bundle delivers it."}

    url = f"{base}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            raw = resp.read().decode("utf-8")
            return (json.loads(raw) if raw else {}), None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, {"not_found": True}
        raw = e.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(raw).get("detail", raw)
        except Exception:
            detail = raw
        return None, {"error": f"HTTP {e.code}: {detail}"}
    except urllib.error.URLError as e:
        return None, {"error": f"Could not reach the memory gateway: {e.reason}"}
    except Exception as e:  # noqa: BLE001 - handlers must never raise
        return None, {"error": f"Unexpected error: {e}"}


def _validate_scope(scope: str, allowed=("shared", "private")) -> str | None:
    if scope not in allowed:
        return f"scope must be one of {list(allowed)}, got {scope!r}"
    return None


def memory_get(args: dict, **kwargs) -> str:
    del kwargs
    key = (args.get("key") or "").strip()
    scope = args.get("scope") or "shared"
    if not key:
        return json.dumps({"error": "key is required"})
    err = _validate_scope(scope)
    if err:
        return json.dumps({"error": err})

    result, err = _request("GET", f"/memory/{urllib.parse.quote(key, safe='')}", scope)
    if err:
        if err.get("not_found"):
            return json.dumps({"found": False, "key": key, "scope": scope})
        return json.dumps(err)
    return json.dumps({
        "found": True,
        "key": result.get("key"),
        "value": result.get("value"),
        "metadata": result.get("metadata"),
        "scope": scope,
        "updated_at": result.get("updated_at"),
        "updated_by": result.get("updated_by"),
    })


def memory_set(args: dict, **kwargs) -> str:
    del kwargs
    key = (args.get("key") or "").strip()
    value = args.get("value")
    scope = args.get("scope") or "shared"
    metadata = args.get("metadata")
    if not key or value is None:
        return json.dumps({"error": "key and value are required"})
    err = _validate_scope(scope)
    if err:
        return json.dumps({"error": err})

    body = {"value": value}
    if metadata is not None:
        body["metadata"] = metadata

    result, err = _request("PUT", f"/memory/{urllib.parse.quote(key, safe='')}", scope, body=body)
    if err:
        return json.dumps(err)
    return json.dumps({
        "success": True,
        "key": result.get("key"),
        "scope": scope,
        "updated_at": result.get("updated_at"),
    })


def memory_list(args: dict, **kwargs) -> str:
    del kwargs
    prefix = args.get("key_prefix")
    scope = args.get("scope") or "all"
    scopes = ["shared", "private"] if scope == "all" else [scope]
    err = _validate_scope(scope, allowed=("shared", "private", "all"))
    if err:
        return json.dumps({"error": err})

    entries = []
    errors = {}
    for s in scopes:
        qs = f"?key_prefix={urllib.parse.quote(prefix)}" if prefix else ""
        result, err = _request("GET", f"/memory{qs}", s)
        if err:
            if not err.get("not_found"):
                errors[s] = err.get("error", "unknown error")
            continue
        for row in result.get("memories", []):
            entries.append({
                "key": row.get("key"),
                "scope": s,
                "updated_at": row.get("updated_at"),
                "preview": (row.get("value") or "")[:200],
            })

    out = {"entries": entries}
    if errors:
        out["errors"] = errors
    return json.dumps(out)
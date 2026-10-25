#!/usr/bin/env python3
"""vs-github-identity — VS agent GitHub App identity wrapper (fleet-ops-e5o.5).

Mints short-lived (1h) GitHub installation tokens from this agent's OWN
GitHub App private key (delivered via the registrar bundle — never
baked, never in chat) and fronts git / REST operations, so every write
lands as <app-slug>[bot] with the actor distinguishable from humans and
from every other agent.

Zero dependencies beyond the pinned official image's tooling: signs
with PyJWT when the runtime venv provides it, else falls back to
`openssl dgst` (RS256). Requires: python3, openssl, and (for git
pushes) git — all shipped by the official Hermes base image.

CONFIG IS ENV-ONLY (the registrar delivery contract — no file owns
identity besides the bundle):
    GH_APP_ID       numeric App id (e.g. 5137374)
    GH_APP_SLUG     App slug — the [bot] login without the suffix
    GH_APP_PEM_PATH path to the App private key (default
                    $HERMES_HOME/config/github-app.pem)

TLS: the composition's A2A wiring hook exports SSL_CERT_FILE pointing
at the VS internal CA (correct for gateway traffic, WRONG for the
public GitHub API — it would silently poison TLS verification). Every
call this wrapper makes is anchored to the PUBLIC trust bundle instead:
certifi when importable, else the system bundle — independent of
whatever SSL_CERT_FILE says.

Usage:
    vs-github-identity whoami     identity summary (names/ids only —
                                  the safe evidence shape; no secrets)
    vs-github-identity token      mint a fresh installation token
                                  (stdout; 1h TTL)
    vs-github-identity api METHOD /repos/... '["json", "body"]'
                                  REST call as the App's installation
    vs-github-identity cred       git credential helper mode (wired via
                                  GIT_CONFIG_* env lines by the boot
                                  hook; store/erase are no-ops)
"""
import argparse
import base64
import datetime
import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


# Primus and device identities are scoped to this single repository. The
# installation token is additionally minted for this repository only.
TARGET_REPOSITORY = "cwdcwd/vector-sigma"
TARGET_REPOSITORY_NAME = "vector-sigma"

# The public API root, overridable ONLY for in-repo CI simulation (the
# functional wrapper test mocks the API on a loopback server). Production
# never sets it; the default is the real API.
API_ROOT = os.environ.get("GH_API_ROOT", "https://api.github.com")

# The public trust anchor for GitHub TLS. See the docstring: the boot
# hooks point SSL_CERT_FILE at the VS internal CA; that must not apply
# to calls to api.github.com. certifi when importable, else the system
# bundle the base image ships.
try:
    import certifi  # type: ignore

    PUBLIC_CA_BUNDLE = certifi.where()
except Exception:
    PUBLIC_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"


def die(msg, code=1):
    print(f"vs-github-identity: {msg}", file=sys.stderr)
    sys.exit(code)


def load_config():
    app_id = os.environ.get("GH_APP_ID", "").strip()
    slug = os.environ.get("GH_APP_SLUG", "").strip()
    pem_path = os.environ.get(
        "GH_APP_PEM_PATH",
        os.path.join(os.environ.get("HERMES_HOME", "/data/agent"),
                     "config", "github-app.pem"))
    if not app_id or not slug:
        die("GH_APP_ID and GH_APP_SLUG must be set (registrar bundle -> "
            "05-vs-github-identity hook -> .env). No GitHub identity wired.")
    if not re.fullmatch(r"[1-9][0-9]*", app_id):
        die("GH_APP_ID must be a positive numeric App id; identity is disabled.")
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?", slug):
        die("GH_APP_SLUG has an invalid format; identity is disabled.")
    if not os.path.isfile(pem_path):
        die(f"App private key not found at {pem_path} (bundle field "
            "github_app_pem delivers it to config/github-app.pem — ask "
            "the owner through the lane).")
    return {"app_id": app_id, "slug": slug, "pem_path": pem_path}


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def rs256_sign(signing_input: bytes, key_path: str) -> bytes:
    """Sign with openssl dgst (the zero-dependency fallback)."""
    p = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", key_path],
        input=signing_input, capture_output=True, timeout=15)
    if p.returncode != 0:
        die(f"openssl signing failed: {p.stderr.decode(errors='replace')[:200]}")
    return p.stdout


def make_jwt(cfg) -> str:
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + 600, "iss": cfg["app_id"]}
    try:
        import jwt  # type: ignore

        with open(cfg["pem_path"], "rb") as f:
            return jwt.encode(payload, f.read(), algorithm="RS256")
    except ImportError:
        header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
        body = b64url(json.dumps(payload).encode())
        signing_input = f"{header}.{body}".encode()
        sig = rs256_sign(signing_input, cfg["pem_path"])
        return f"{header}.{body}.{b64url(sig)}"


class _NoAuthRedirect(urllib.request.HTTPRedirectHandler):
    """Strip the Authorization header when a redirect leaves api.github.com.

    GitHub log/asset endpoints 302 to pre-signed blob URLs; a replayed
    Authorization header voids the URL signature (Azure AuthenticationFailed).
    """
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is not None and "api.github.com" not in newurl:
            for key in list(new_req.headers):
                if key.lower() == "authorization":
                    del new_req.headers[key]
        return new_req


def _opener():
    """Opener whose HTTPS layer is anchored to the PUBLIC CA bundle —
    never whatever SSL_CERT_FILE the composition pinned (internal CA)."""
    ctx = ssl.create_default_context(cafile=PUBLIC_CA_BUNDLE)
    return urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ctx), _NoAuthRedirect())


def api(path, data=None, method=None, token=None, bearer=None):
    """One GitHub API call. Returns (status, parsed-body-or-str)."""
    url = f"{API_ROOT}{path}" if path.startswith("/") else path
    req = urllib.request.Request(
        url, data=json.dumps(data).encode() if data is not None else None,
        method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent",
                   f"vs-github-identity-{os.environ.get('GH_APP_SLUG', 'agent')}")
    if token:
        req.add_header("Authorization", f"token {token}")
    elif bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    try:
        with _opener().open(req, timeout=30) as r:
            raw = r.read().decode()
            status = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        status = e.code
    try:
        return status, json.loads(raw) if raw else {}
    except Exception:
        return status, raw


def as_json_list(body):
    return body if isinstance(body, list) else []


def as_json_obj(body):
    return body if isinstance(body, dict) else {}


def parse_expiry(s) -> float:
    if not isinstance(s, str):
        return time.time()
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def installation_id(cfg, jwt_token) -> str:
    st, body = api("/app/installations", bearer=jwt_token)
    insts = as_json_list(body)
    if st != 200:
        die(f"installation lookup failed ({st}); identity is disabled.")
    matches = []
    for installation in insts:
        item = as_json_obj(installation)
        account = as_json_obj(item.get("account"))
        if account.get("login", "").lower() == "cwdcwd":
            matches.append(item)
    if len(matches) != 1 or not matches[0].get("id"):
        die("expected exactly one GitHub App installation for cwdcwd; "
            "identity is disabled.")
    return str(matches[0]["id"])


def installation_token(cfg, jwt_token):
    """Mint a one-hour token scoped to this installation and repository."""
    inst = installation_id(cfg, jwt_token)
    st, body = api(f"/app/installations/{inst}/access_tokens",
                   data={"repositories": [TARGET_REPOSITORY_NAME]},
                   method="POST", bearer=jwt_token)
    obj = as_json_obj(body)
    if st != 201 or "token" not in obj:
        die(f"token mint failed ({st}); identity is disabled.")
    repositories = obj.get("repositories")
    if (not isinstance(repositories, list)
            or [as_json_obj(repo).get("full_name", "").lower() for repo in repositories]
            != [TARGET_REPOSITORY]):
        die(f"installation token is not restricted to {TARGET_REPOSITORY}; "
            "identity is disabled.")
    return obj["token"], parse_expiry(obj.get("expires_at"))


def validate_repository_path(path):
    """Reject every API path outside the one repo this fleet identity serves."""
    parsed = urlsplit(path)
    if parsed.scheme or parsed.netloc or parsed.fragment:
        die("API path must be a repository-relative path; identity is disabled.")
    segments = parsed.path.split("/")
    if (len(segments) < 4 or segments[0] != "" or segments[1] != "repos"
            or segments[2].lower() != "cwdcwd" or segments[3].lower() != "vector-sigma"
            or any(segment in (".", "..") for segment in segments)):
        die(f"API access is restricted to {TARGET_REPOSITORY}; identity is disabled.")
    if "\\" in parsed.path or "%" in parsed.path:
        die("encoded path separators are not permitted; identity is disabled.")
    if len(segments) > 4 and segments[4].lower() not in {
            "contents", "pulls", "git", "commits"}:
        die("API access is restricted to repository content and pull requests; "
            "identity is disabled.")
    return parsed.path + (("?" + parsed.query) if parsed.query else "")


def cmd_whoami(cfg, _args):
    jwt_token = make_jwt(cfg)
    st, app_body = api("/app", bearer=jwt_token)
    app = as_json_obj(app_body)
    if st != 200:
        die(f"app lookup failed ({st}): {str(app_body)[:200]}")
    inst = installation_id(cfg, jwt_token)
    tok, exp = installation_token(cfg, jwt_token)
    st2, repos_body = api("/installation/repositories", token=tok)
    repos = as_json_obj(repos_body)
    print(f"app:          {app.get('name')} ({app.get('slug')}, id {app.get('id')})")
    print(f"bot login:    {app.get('slug')}[bot]")
    print(f"installation: {inst} (token expires "
          f"{datetime.datetime.fromtimestamp(exp, datetime.timezone.utc).isoformat()})")
    installed_repositories = repos.get("repositories", [])
    repository_names = [
        as_json_obj(repo).get("full_name", "").lower()
        for repo in installed_repositories if isinstance(installed_repositories, list)
    ]
    if st2 != 200 or TARGET_REPOSITORY not in repository_names:
        die(f"GitHub App installation lacks access to {TARGET_REPOSITORY}; "
            "identity is disabled.")
    print(f"repos:        {repos.get('total_count', '?')} accessible; "
          f"{TARGET_REPOSITORY} verified")


def cmd_token(cfg, _args):
    tok, _ = installation_token(cfg, make_jwt(cfg))
    print(tok)


def cmd_api(cfg, args):
    path = validate_repository_path(args.path)
    tok, _ = installation_token(cfg, make_jwt(cfg))
    body = json.loads(args.json) if args.json else None
    st, out = api(path, data=body, method=args.method.upper(), token=tok)
    print(json.dumps(out, indent=2) if isinstance(out, (dict, list)) else out)
    sys.exit(0 if st < 300 else 1)


def cmd_cred(cfg, args):
    """git credential helper mode: protocol fields on stdin.

    Wired via the GIT_CONFIG_* env lines (05-vs-github-identity hook):
      credential.helper = !/usr/local/bin/vs-github-identity cred
    Tokens are mint-on-demand and never stored; store/erase are no-ops.
    """
    lines = sys.stdin.read()
    info = dict(l.split("=", 1) for l in lines.splitlines() if "=" in l)
    op = args.operation[0] if args.operation else "get"
    if op != "get" or "github.com" not in info.get("host", ""):
        return
    tok, _ = installation_token(cfg, make_jwt(cfg))
    print(f"username={cfg['slug']}[bot]")
    print(f"password={tok}")


def main():
    ap = argparse.ArgumentParser(prog="vs-github-identity")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami").set_defaults(fn=cmd_whoami)
    sub.add_parser("token").set_defaults(fn=cmd_token)
    p = sub.add_parser("api")
    p.add_argument("method")
    p.add_argument("path")
    p.add_argument("json", nargs="?")
    p.set_defaults(fn=cmd_api)
    p2 = sub.add_parser("cred")
    p2.add_argument("operation", nargs="*")
    p2.set_defaults(fn=cmd_cred)
    args = ap.parse_args()
    cfg = load_config()
    args.fn(cfg, args)


if __name__ == "__main__":
    main()
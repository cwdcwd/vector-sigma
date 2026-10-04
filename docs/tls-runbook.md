# TLS runbook — the serve-only edge (fleet-ops-f57.13 → fleet-ops-lnf,
# j7g phase 2; owner GO on caddy retirement 2026-10-04)

The master device's TLS front door is **tailscale serve**: the
composition's own `tailscale` service (host network namespace, the
containerboot contract) terminates TLS at the MagicDNS names and
proxies the three management surfaces over the device's loopback
publishes. Certificates are **Let's Encrypt**, auto-provisioned and
renewed by tailscaled — browser-trusted everywhere, zero root
installs, zero owner-run scripts.

This supersedes the entire f57.13 design (caddy + `tls internal` +
the internal-CA custody trade + `VS_CA_CERT_B64` fleet trust). The
caddy service, its `Caddyfile`, its data volume, the internal CA, the
basic_auth layer and every CA-related fleet variable are **retired**.
The f57.13 runbook's history is recoverable from git history.

## The edge contract

| Surface | MagicDNS name | Proxy target (loopback) |
|---|---|---|
| registrar (admin console + `/v1` API) | `https://vector-sigma.tailb7207e.ts.net` (:443) | `http://127.0.0.1:3000` |
| VS gateway (`/ui`, `/v1/*`, `/a2a/*`, `/health/*`) | `https://vector-sigma.tailb7207e.ts.net:8443` | `http://127.0.0.1:4000` |
| scotty queue UI | `https://vector-sigma.tailb7207e.ts.net:8444` | `http://127.0.0.1:3306` |

- The names and ports are **exactly what the phase-1b flipped fleet
  variables already carry** (`REGISTRAR_URL`,
  `GATEWAY_URL`/`A2A_PUBLIC_URL`): no variable flips in this release.
- The serve config is `balena/registrar/serve-config.json`, baked into
  the master's tailscale image (`Dockerfile.tailscale`, FROM the same
  pinned `v1.102.5` tag the devices fleet uses) and pointed at by the
  `TS_SERVE_CONFIG` environment variable — the supervisor cannot
  bind-mount (the f57.12 precedent).
- Devices join the tailnet and serve nothing; the devices fleet's
  tailscale service stays on the stock image.
- **scotty's lock is the tailnet ACL tag + TLS identity alone.**
  basic_auth died with caddy (the owner GO accepted this
  consequence). The tailnet ACLs — `autogroup:member` →
  `tag:vs-master:*` — are the auth layer; TLS identity (Let's
  Encrypt) is the transport layer.
- The **dolt server keeps its `:3326` LAN publish** (bd clients, not
  HTTP; the queue contract — see scripts/vs-queue-bootstrap.md). It is
  the composition's one remaining LAN-reachable port, documented as
  such.

## Owner steps (first setup)

1. **Prerequisite — tailnet HTTPS** (Tailscale admin console → DNS →
   *MagicDNS* → **HTTPS Certificates** → enable). Serve refuses to
   apply its config with a log line ("not able to issue TLS certs")
   until this is on; once enabled, tailscaled provisions the Let's
   Encrypt certificate for the machine's MagicDNS name automatically.
2. **Deploy** — tag `registrar-v*` per the usual flow; the master
   device pulls the release, the tailscale container starts, and
   containerboot applies the baked serve config on the first netmap
   update.
3. **Verify** — from a tailnet client (the owner's Mac):
   `https://vector-sigma.tailb7207e.ts.net/healthz` answers 200 with a
   browser-trusted certificate (no `--cacert` needed — that is the
   point). The canary checklist (docs/tailscale-runbook.md) carries
   the full sequence.
4. **Fleet advance** — pin the canary, verify, advance the fleet pin,
   clear the canary, then tag `devices-v*` (the devices app release
   carries only the registrant's retired-CA code changes).
5. **Variable cleanup** (balenaCloud dashboard, after both fleets
   run the new release): delete the retired fleet variables —
   `VS_CA_CERT_B64` (devices fleet), `SCOTTY_BASIC_AUTH_HASH`,
   `TLS_HOSTNAME`, `TS_MASTER_DNS` (registrar fleet). Nothing
   consumes them anymore; leaving them set would mislead the next
   operator.

## Rotation

Nothing to do. tailscaled renews the Let's Encrypt certificate
automatically on its own schedule. There is no fleet-variable update
and no service restart, and because the CA is public, no device ever
needs its trust store touched for a renewal.

## "CA roll"

The concept is retired. A suspected-key-exposure rotation of a public
CA is not an owner action — if a certificate is compromised, revoke it
at the CA and tailscaled re-issues. To force a fresh serve state,
purge the `ts-state` volume (balena dashboard: tailscale service → ⋯
→ **Purge data**) and restart: the device re-auths with its reusable
key and serve re-provisions — note this mints a NEW tailnet node
identity (see docs/tailscale-runbook.md's blast-radius note), so
prefer leaving `ts-state` alone unless the canary says otherwise.

## Failure notes

- **serve never answers / "not able to issue TLS certs" in the
  tailscale container logs**: tailnet HTTPS is disabled (owner step 1)
  — the fix is the admin console, not the device.
- **The tailnet name resolves but the device is not joined**:
  `TS_AUTHKEY` is missing (the phase-1a posture — the container parks
  keyless; see docs/tailscale-runbook.md).
- **`curl` from a NON-tailnet LAN host fails to reach the ts.net
  name**: correct — MagicDNS serves tailnet clients only. Join the
  tailnet (that is the access path for every dashboard now, the owner
  GO accepted this consequence) or probe the loopback publishes from
  the device itself.
- **LAN front door (80/443/8443/8444) refuses connections**: the
  intended end state — nothing listens on the LAN IPs anymore. Only
  dolt's `:3326` (bd clients) remains LAN-reachable.
- **A device fails TLS handshake**: wrong clock (cert not-yet-valid
  from the device's view — the clock gate's own contract; wait for
  NTP). There is no fleet CA variable to go stale anymore.
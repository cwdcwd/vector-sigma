# TLS runbook — the VS-own internal CA and the caddy edge (fleet-ops-f57.13)

The master device's composition (registrar + postgres + the VS gateway)
is fronted by caddy; TLS is served from a VS-own internal CA — the fleet
never trusts a third party for device identity, and the CA key is
owner-custodied exactly like the Cabal's. This is the complete owner-side
runbook; the generation script (`scripts/gen-vs-ca.sh`) and the Caddyfile
ship in-repo, the key material never does.

## What is where

| Piece | Lives where | Secret? |
|---|---|---|
| CA key (`vs-ca.key`) | Owner's machine only, 600, never repo/image/chat | **YES — crown jewel** |
| CA cert (`vs-ca.crt`) | Owner's machine; shipped to devices via `VS_CA_CERT_B64` | No (public material) |
| Leaf cert + key (`vs-leaf.*`) | Generated from the CA; delivered to caddy via `TLS_CERT_B64`/`TLS_KEY_B64` balena fleet variables | Key: yes |
| `scripts/gen-vs-ca.sh` | repo | No |
| `balena/registrar/Caddyfile` | repo, baked into the caddy image | No |
| `certs-init` service | master device composition; decodes the two B64 fleet vars into the caddy-certs volume | No |

## Certificate lifetimes (the window-driven pattern)

Mirrors the Cabal's `ai_lan_tls_check` posture:

- **CA: 180 days.** Roll the CA = delete `vs-ca.key`, re-run the script,
  re-trust every device (see "Device trust"). Rare; do it on a schedule
  you control, not an expiry emergency.
- **Leaf: 30 days**, SAN = the master hostname only. Rotation is a leaf
  re-mint from the SAME CA: run the script again (it reuses the CA),
  paste the two new `TLS_CERT_B64`/`TLS_KEY_B64` values, restart
  `certs-init` + `caddy`. **Run it every ~25 days** — the window guard.

## Owner steps (first setup)

1. **Generate** — on a trusted host, from the repo root:

   ```bash
   scripts/gen-vs-ca.sh vsigma.lan
   # (hostname is YOUR pick — it must match the Pi-hole record below;
   #  vsigma.lan is the standing example throughout the docs)
   ```

   Output lands in `./vs-tls/`. **Custody `vs-tls/vs-ca.key`** — move it
   somewhere owner-only, back it up like a password.

2. **DNS** — add the Pi-hole record: `vsigma.lan -> <master device LAN
   IP>`. (Local DNS only; the hostname never needs to be public.)

3. **Fleet variables** (balenaCloud dashboard, `registrar` fleet scope):

   | Variable | Value | Notes |
   |---|---|---|
   | `TLS_HOSTNAME` | `vsigma.lan` | the Caddyfile's `{$TLS_HOSTNAME:...}` |
   | `TLS_CERT_B64` | single line from `vs-tls/b64-cert.env` | paste as-is |
   | `TLS_KEY_B64` | single line from `vs-tls/b64-cert.env` | paste as-is |

   The dashboard editor is single-line-safe for these (the script emits
   `-w0` base64 — no wrapping, no newlines).

4. **Deploy** — tag the release carrying f57.13 (e.g. `registrar-v1.1.0`),
   wait for the device to pull it, confirm caddy serves:

   ```bash
   curl -s https://vsigma.lan/healthz --cacert vs-tls/vs-ca.crt
   # {"status":"ok"}
   ```

5. **Flip the devices** — the `devices` fleet's `REGISTRAR_URL` becomes
   `https://vsigma.lan` (port 443 = registrar's front door; no port
   suffix). **Sequencing hazard (the f57.9 class):** a device
   bootstrapping between the release landing and the variable flip fails
   — its https URL has no edge yet, or its old http URL hits caddy's
   redirect. Order: release lands → verify caddy → THEN flip.

## Device trust (the devices fleet)

Each VS device needs the CA cert to trust `https://vsigma.lan`. Set ONE
fleet variable on the `devices` fleet:

```
VS_CA_CERT_B64=<single-line base64 of vs-ca.crt>
```

The registrant image's entrypoint shim decodes it to
`NODE_EXTRA_CA_CERTS` before the registrant starts. The registrant's
config layer enforces the contract fail-loud: an https `REGISTRAR_URL`
with no CA provisioned aborts startup naming the variables (no silent
public-CA fallback — the f57.8 posture). `http` URLs (compose-internal,
pre-TLS topologies) boot unchanged.

**The clock gate is now load-bearing:** a device with a wrong clock fails
the cert validity window before it can bootstrap — time-sync-before-TLS
is exactly the guard the clock gate was built for (the engineering
spec's "TLS is the natural guard" note, now enforced by the edge).

## Rotation (leaf, every ~25 days)

```bash
scripts/gen-vs-ca.sh vsigma.lan        # reuses the CA, mints a fresh 30d leaf
# paste the two new TLS_CERT_B64 / TLS_KEY_B64 fleet vars
# restart certs-init + caddy services on the device (dashboard or CLI)
```

Devices keep working through the swap (the CA is unchanged; their trust
is in the CA, not the leaf).

## CA roll (rare, ~every 6 months)

1. Re-run with a fresh CA: `rm vs-tls/vs-ca.key && scripts/gen-vs-ca.sh vsigma.lan`
2. Update `TLS_CERT_B64`/`TLS_KEY_B64` AND the devices fleet's
   `VS_CA_CERT_B64` (new CA cert).
3. Restart the composition + devices' registrant services. Devices with
   a cached old CA reject the new leaf until re-provisioned — expected;
   the restart re-decodes the new CA from the fleet variable.

## Failure notes

- **caddy restart-looping, `certs-init` failed**: the B64 variables are
  truncated or contain a stray newline — re-paste from
  `vs-tls/b64-cert.env` (each is ONE line).
- **Device fails TLS handshake**: wrong clock (cert not-yet-valid /
  expired from the device's view — wait for NTP) or stale
  `VS_CA_CERT_B64` (re-paste after a CA roll).
- **`curl` from the LAN without `--cacert` fails**: correct — that is
  the posture. Trust the CA or stay out.
- The balenaCloud **public URL** (tunnels device port 80) now lands on
  caddy's redirect-to-TLS: plain-HTTP console access through the tunnel
  is dead by design. Use https from a trusted host, or enable the
  public-URL toggle only for the https port if you need remote access.
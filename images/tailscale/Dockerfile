# images/tailscale/Dockerfile — the master's tailscale overlay
# service image (j7g phase 2, fleet-ops-lnf: the serve-only edge).
#
# The devices fleet's tailscale service stays on the STOCK pinned image
# (platforms/balena/devices/docker-compose.yml) — devices JOIN the tailnet and serve
# nothing. The master, from this lane on, SERVES the management layer
# (registrar / gateway / scotty) at the MagicDNS names, so its tailscale
# container must carry the declarative serve config — and the balena
# supervisor cannot bind-mount files (the f57.12 precedent), so the config
# is BAKED here and pointed at by the TS_SERVE_CONFIG environment
# variable on the compose's tailscale service.
#
# Dialect note (verified from the pinned image's own source, v1.102.5 —
# cmd/containerboot/serve.go readServeConfig): TS_SERVE_CONFIG is a raw
# ipn.ServeConfig JSON file, NOT the tailscaled config-file (hujson)
# dialect newer clients (1.52+) accept. Shape (ipn/serve.go at the tag):
#   TCP  — map keyed by PORT number ("443"), value { "HTTPS": true }
#   Web  — map keyed "SNI:port" ("${TS_CERT_DOMAIN}:443" after the
#          substitution below — there is NO implicit port 443 in this
#          dialect), each a Handlers map keyed by mount point, "/"
#          proxying the loopback publish of the target service.
# The ${TS_CERT_DOMAIN} placeholder IS used here (fleet-ops-1py.14, per
# the merged image-exposure plan's two-way verification): containerboot
# substitutes it with the node's own cert domain (its MagicDNS FQDN) on
# ANY node type — cmd/containerboot/serve.go readServeConfig does
# bytes.ReplaceAll of ${TS_CERT_DOMAIN} with certDomain, and
# cmd/containerboot/main.go sets certDomain from the netmap's
# CertDomains[0] on non-kube nodes (falling back to a no-HTTPS sentinel
# only when empty). The devices fleet's serve config has used the same
# placeholder form on this same pinned tag since j7g.1, serving live —
# the master's cert domain is its own MagicDNS FQDN, so NO deployment
# value is baked into this image (the earlier literal bake and the
# k8s-only comment it rested on were wrong; corrected here). CANARY NOTE:
# the placeholder form on the MASTER is proven by the same live
# mechanism the devices rely on; the plan requires a canary prove of
# the form on the master before the corrected image ships — the
# release/deploy sequence (plan section B/C) carries that gate; this
# repo change only fixes the bytes.
#
# Application semantics (cmd/containerboot/main.go + serve.go, v1.102.5):
#   - at startup containerboot UNSETS any previous serve config, then
#     applies this file on the first netmap update (the certDomain change
#     triggers the watcher's first read-apply); a file change re-applies
#     via fsnotify (with a 5s-ticker fallback), so the baked bytes are
#     also the recovery path after any drift.
#   - the apply is REFUSED with a log line ("not able to issue TLS
#     certs ... ensure that HTTPS is enabled for your tailnet") when the
#     tailnet has HTTPS certificates disabled — the admin-console
#     prerequisite documented in docs/tailscale-runbook.md. The serve
#     config requests Let's Encrypt certificates for the MagicDNS name
#     automatically once enabled; they renew inside tailscaled.

FROM tailscale/tailscale:v1.102.5

COPY images/tailscale/serve-config.json /serve-config.json
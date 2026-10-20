# images/postgres/Dockerfile — the postgres service's own image with
# the VS gateway's database provisioning folded in (fleet-ops-anc; owner
# ruling 2026-09-29: consolidate, kill the one-shot litellm-init container).
#
# The wrapper it ships runs the IDENTICAL provisioning SQL the retired
# litellm-init service ran, on every boot, idempotent, safe on the live
# pgdata volume (no initdb.d split: the master device's volume already
# holds device bundles — a fresh initdb must never run there).
#
# Same base image as before (postgres:16-alpine), same CMD pass-through:
# only the entrypoint is wrapped, so the stock initdb/volume semantics are
# untouched and docker logs look like plain postgres plus wrapper lines.

FROM postgres:16-alpine

# Release CVE gate: the upstream image's gosu is built on Go 1.24.6 (a fixable
# CRITICAL in the Go stdlib; gosu 1.19, the latest, is still on that Go).
# su-exec is Alpine's tiny C equivalent with the SAME calling convention
# (`<user> <command> [args...]`), so the official entrypoint's
# `exec gosu postgres ...` works unchanged against it.
# The old binary is DELETED (a whiteout) and the shim lives at /usr/bin/gosu,
# next on PATH: overwriting /usr/local/bin/gosu in place leaves scanners
# attributing the base layer's Go binary to that path.
RUN apk add --no-cache su-exec \
    && rm -f /usr/local/bin/gosu \
    && ln -s /sbin/su-exec /usr/bin/gosu

COPY images/postgres/postgres-entrypoint.sh /usr/local/bin/postgres-wrapper.sh
RUN chmod +x /usr/local/bin/postgres-wrapper.sh

# Stock args pass through: the wrapper execs nothing itself — it starts
# the stock docker-entrypoint.sh as its child and forwards signals to it.
ENTRYPOINT ["/usr/local/bin/postgres-wrapper.sh"]
CMD ["postgres"]
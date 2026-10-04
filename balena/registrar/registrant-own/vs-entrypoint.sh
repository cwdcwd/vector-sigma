#!/bin/sh
# vs-entrypoint.sh — generic VS container entrypoint shim (fleet-ops-f57.13;
# reworked fleet-ops-lnf, j7g phase 2: the serve-only edge).
#
# Historically this shim provisioned the VS internal CA into Node's trust
# store from VS_CA_CERT_B64 / VS_CA_CERT before exec'ing the service. The
# internal-CA machinery RETIRED with caddy (phase 2): the edge is
# tailscale serve, whose certificates are Let's Encrypt — publicly
# trusted, present in every stock CA bundle, so no trust provisioning is
# needed anywhere in the composition. The VS_CA_* variables are GONE
# (the devices' fleet variables are deleted by the coordinator after the
# fleet advance; the bundle never carried them).
#
# The shim itself REMAINS as the image-carried entrypoint point (a plain
# exec pass-through): the deploy/ image, the devices registrant image and
# the registrar's registrant-own image all ship it as ENTRYPOINT, and
# keeping the pass-through preserves the one-file-three-targets contract
# (registrant/test/vendored-drift.test.ts byte-pins all three copies).
# Removing the ENTRYPOINT instead would fork the three images' shapes
# for zero gain.
#
# No inputs. Exec the service command unchanged.

set -eu

exec "$@"
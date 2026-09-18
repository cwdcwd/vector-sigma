# Vector Sigma — two-fleet balena architecture (owner ruling 2026-09-18)

Vector Sigma deploys as **two balena fleets in one balenaCloud account**:

1. **`registrar` fleet — 1 device.** The registrar + its own Postgres
   container (the `deploy/` compose pattern). No registrant service —
   the registrar *is* the identity source, not a client of itself.
2. **`devices` fleet — 3–4 devices.** Agent runtime + registrant per
   the device-app section of this spec.

Rationale: the registrar is the crown jewel *and* the entire
reflash-recovery path (a device without identity has no recovery until
the registrar returns). Running it as its own balena-managed appliance
gives it the same OTA + remote-management + unattended-reflash story as
every device it serves, on its own failure domain — and keeps it
off any single fleet host that hosts anything else. Deployments stay
uniform: every release, for either fleet, is a balena release built by
remote builders.

Free-tier note: the account limit is 10 devices **shared across all
fleets in the account**; 1 + 4 = 5 fits.

## Fleet app layout (repo)

```
balena/
├── registrar/    # fleet 1 app: registrar + postgres compose
└── devices/       # fleet 2 app: agent + registrant compose
```

One dir per fleet, one deploy workflow per dir. Each app is a standard
balena multi-container compose app; balena remote builders build every
image — never device-side.

## Releases (tags-only)

Every release is cut by pushing a git tag:

- `registrar-v*` → builds a **final** release for the `registrar` fleet
- `devices-v*` → builds a **final** release for the `devices` fleet

No PR-draft releases. Canaries are done by pinning, not by drafts: pin
the canary device to the new release via CLI (`balena device pin
<UUID> <COMMIT>`), verify, then advance the fleet pin deliberately.
All devices stay pinned to an explicit release; nothing auto-tracks
`latest` (a fresh fleet's default `latest` tracking is switched off at
provisioning time by pinning every device to the current release).

Tag scheme is per-fleet so either side ships independently: a registrar
patch never rebuilds or redeploys device apps, and vice versa.

## GitHub Actions

Three workflows, `.github/workflows/`:

- **`ci.yml`** — every PR: typecheck + unit tests across
  `shared/`, `registrar/`, `registrant/` (pg-mem in-process, no
  Postgres service needed) + the compose-simulated device E2E
  (`deploy/e2e.sh --up`) on a compose-capable runner.
- **`deploy-registrar.yml`** — tag `registrar-v*`: build + deploy
  the `balena/registrar/` app to the registrar fleet.
- **`deploy-devices.yml`** — tag `devices-v*`: build + deploy the
  `balena/devices/` app to the devices fleet.

Deploy workflows use `balena-io/deploy-to-balena-action` **pinned to a
release tag** (`v2.3.1`), never `@master`. `balena_token` is a repo
Actions secret; fleet slugs are workflow inputs (per-instance values —
names of the org/fleets live in the workflow dispatch args or repo
variables, not in code). Balena remote builders do the actual builds,
so runner minutes stay low and the remote-build-only rule holds
everywhere, CI included.

## Secrets posture

`BALENA_TOKEN` is the only Actions secret the deploys need. The balena
provisioning key inside the flashed image, and the per-device
`REGISTRAR_KEY` balena variable, follow the spec's secrets rules —
nothing new lands in image layers or repo files.

## Owner-side prerequisites (UI-only, do once)

1. balenaCloud account + org; create both fleets
   (registrar fleet: Raspberry Pi 5; devices fleet: Raspberry Pi 5).
2. In the vector-sigma GitHub repo: Settings → Secrets and variables →
   Actions → new secret `BALENA_TOKEN` (from balenaCloud dashboard:
   Preferences → Access tokens → Create API key — name it
   `vector-sigma-gha`, copy once).
3. Flash the spare Pi 5 for the registrar fleet; flash devices fleet
   hardware as it arrives.
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

One dir per fleet, one release workflow per dir. Each app is a standard
balena multi-container compose app; images are built by GitHub Actions
runners (rung 2: prebuilts in GHCR, `balena deploy` uploads them) —
never device-side, never balena remote builders.

## Releases (tags-only)

Every release is cut by pushing a git tag:

- `registrar-v*` → builds a **final** release for the `registrar` fleet
- `devices-v*` → builds a **final** release for the `devices` fleet

No PR-draft releases. Canaries are done by pinning, not by drafts:

1. The new release is built as **final** by the tag push.
2. Pin the canary device to it: `balena device pin <UUID> <COMMIT>`
   (a device pin overrides the fleet target — only that device moves).
3. Verify on the canary (including the SIGTERM/WAL evidence standard).
4. Advance the fleet: `balena fleet pin <FLEET_SLUG> <COMMIT>` — every
   device not itself pinned updates to the pinned release.
5. Clear the canary's pin so it rejoins fleet policy:
   `balena device track-fleet <UUID>` — a left-behind device pin keeps
   that device on the old release and blocks the next canary cycle.

Release policy: the **fleet** is pinned, never the individual devices.
A fresh balena fleet auto-tracks `latest` — switch that off at
provisioning time with `balena fleet pin <FLEET_SLUG> <COMMIT>`, so no
built release deploys without the pin being advanced deliberately.

Tag scheme is per-fleet so either side ships independently: a registrar
patch never rebuilds or redeploys device apps, and vice versa.

## GitHub Actions

Five workflows, `.github/workflows/`:

- **`ci.yml`** — every PR: typecheck + unit tests across
  `shared/`, `registrar/`, `registrant/` (pg-mem in-process, no
  Postgres service needed) + the compose-simulated device E2E
  (`deploy/e2e.sh --up`) on a compose-capable runner.
- **`build-images.yml`** — every push to `main`: builds all 8 components
  x amd64/arm64 on native runners (no QEMU) and pushes
  `<sha>-<arch>` tags to GHCR (`ghcr.io/cwdcwd/vector-sigma/<component>`).
- **`release-registrar.yml`** — tag `registrar-v*`: build the 7
  registrar-app components on native runners → GHCR → trivy
  CRITICAL/HIGH gate → boot-path smoke gate → render the
  digest-pinned compose (arm64 child digests) → `balena deploy` of
  the prebuilt images to the registrar fleet. No source leaves
  the repo for builds.
- **`release-devices.yml`** — tag `devices-v*`: same pipeline for the
  devices app (agent + registrant + the devices tailscale bake).

Release workflows use pinned actions only (`docker/build-push-action@v6`,
`docker/login-action@v3`, etc.), a sha256-pinned balena CLI tarball, and
`GITHUB_TOKEN` for GHCR auth within the run that built the images.
`balena_token` is a repo Actions secret; fleet slugs are repo variables
(`REGISTRAR_FLEET`, `DEVICES_FLEET`). Runner minutes stay low — no
remote-builder minutes are spent, and the prebuilts are uploaded to the
balenaCloud registry by `balena deploy` itself; devices pull from
balena, never from GHCR.

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
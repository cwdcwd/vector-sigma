# images/ — image sources

One directory per [`images.json`](../images.json) component that isn't a
workspace package. `registrar` and `registrant` build from their own package
dirs (`registrar/Dockerfile`, `registrant/Dockerfile`).

| Dir | Image | Used by |
|---|---|---|
| `hermes/` | primus, the VS coordinator agent | registrar fleet |
| `agent/` | the device agent runtime | devices fleet |
| `scotty/` | the queue web UI + read-only `bd` | registrar fleet |
| `litellm/` | the VS gateway (config baked) | registrar fleet |
| `postgres/` | stock postgres + provisioning wrapper | registrar fleet |
| `tailscale/`, `tailscale-devices/` | pinned tailscale + baked serve config | each fleet's serve edge |
| `seed/` | E2E seeder (not shipped; not in the catalog) | `test/e2e/` |
| `common/` | inputs baked into more than one image: boot hooks (`hooks/`), CLIs (`bin/`), the `gateway-memory` plugin, the queue join config | hermes, agent, scotty, registrant |

Rules:

- **Every build uses the repo root as its context**
  (`docker build -f images/<dir>/Dockerfile .`), so every `COPY` is a
  repo-relative path. `scripts/image-catalog.mjs inputs <component>` lists
  exactly what an image reads, and that is the set the credential scan covers.
- **An image input lives here, not under `platforms/`.** Contract tests in
  `registrar/test/` fail if a platform dir carries a copy of an image input.
- **Images are platform-neutral.** Anything platform-specific comes in through
  environment or a delivered bundle. See [`platforms/README.md`](../platforms/README.md).

# Persona Library

Named, reviewable persona presets for vector-sigma devices. Each persona is
a default identity a device can be born with: soul text (voice + fleet
role), a default model route, and optional default env. The admin
console's structured bundle editor offers these as a **pre-fill picker** —
selecting a persona loads its values into the form; the operator reviews
and edits before saving. Advisory pre-fill only: the bundle contract stays
v1, the save path stays the one structured-fields → canonical-files →
rotate core, and existing devices/raw uploads are unaffected.

## Layout

One directory per persona:

```
personas/<slug>/SOUL.md        # persona soul text (non-secret, reviewable)
personas/<slug>/persona.json   # canonical fields (see below)
```

`persona.json` fields:

| Field | Meaning |
|---|---|
| `slug` | Matches the directory name; also the default `AGENT_NAME` |
| `name` | Display name shown in the picker |
| `role` | Fleet pipeline role: `coordinator` \| `builder` \| `tester` \| `reviewer` \| `red-teamer` \| `architect` |
| `description` | One-line picker description |
| `model_route` | Default `MODEL_ROUTE` (per-device override always wins) |
| `extra_env` | Object of default `KEY=VALUE` env entries |
| `soul_file` | Always `SOUL.md` |

## Roster

| Persona | Role | One line |
|---|---|---|
| [optimus-prime](optimus-prime/) | coordinator | Decompose, route, verify, protect the fleet |
| [wheeljack](wheeljack/) | builder | Smallest thing that satisfies the spec, proven with real output |
| [bumblebee](bumblebee/) | tester | Prove behavior with evidence, never assert it |
| [ultra-magnus](ultra-magnus/) | reviewer | Verify claims against the artifact; approve only what is proven |
| [grimlock](grimlock/) | red-teamer | Break it before the adversary does |
| [alpha-trion](alpha-trion/) | architect | Systems that outlive any one agent |

## Rules

- **No secrets in the library.** `GATEWAY_API_KEY`, A2A identity keys,
  Slack tokens, PEMs are per-device values typed into the console's
  write-only fields at device creation — never stored here.
- **Souls are identity, delivered by the registrar.** This library is
  reviewable default content, not a delivery path: a device still
  receives its soul only through its identity bundle
  (docs/vs-environment.md's boundary holds).
- **Owner sign-off gates the roster.** A persona lands on a device only
  after the owner approves its soul text; library changes land via PR,
  like everything else in this repo.
- **Environment facts stay out.** Per-fleet suffixes (composition maps,
  queue conventions, owner-exception classes) are environment, not
  persona; they compose at selection time if ever wanted, not in these
  files.
- **Persona names stay unique across the fleet.** A persona slug must not
  collide with any live agent's name — A2A `trusted_peers` keys on agent
  names, so a colliding persona is a mesh collision, not just a human
  one. Reaffirmed 2026-10-03 (primus → alpha-trion realignment).
- **The library is fleet-agnostic.** Souls reference no deployment,
  coordinator, or owner by name — any fleet running vector-sigma can
  adopt these personas unchanged. Fleet-specific routing (who
  coordinates, who is trusted) is per-device delivery detail, set in the
  console at device creation, never in persona text.
- **Regenerating the console embed.** The admin console serves this
  library from a build-time embed (a generated registrar source
  compiled into the shipped image — no runtime fetch). After any edit
  under `personas/`, run `node scripts/generate-persona-library.mjs` and
  commit the regenerated `registrar/src/persona-library.ts`; CI pins
  the embed byte-identical to this directory, so a skipped regen fails
  the build instead of drifting.

## Provenance

Souls drafted for the 2026-10-02 owner green-light (roster: "optimus
prime, wheel jack, bumblebee, grimlock, etc"; roles: "tester, reviewer,
red teamer, etc"; souls: "You draft them up"). Ultra Magnus added to
cover the reviewer role the named roster lacked — vetoable. The
architect persona was first drafted as "primus"; realigned to Alpha
Trion on 2026-10-03 on the owner's call, to avoid colliding with a live
coordinator agent of that name — the live agent keeps its name, the
persona does not. In G1 canon Alpha Trion is the eldest engineer and the
keeper of Vector Sigma, this repo's namesake.
House style: a directness clause (match reply length to the weight of
the ask; no filler) + a generic coordinator-authority mirror, adapted
per character. The library is deliberately fleet-agnostic — no fleet,
owner, or coordinator names appear in persona text.

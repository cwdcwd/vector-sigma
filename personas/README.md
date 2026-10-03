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
| [primus](primus/) | architect | Systems that outlive any one agent |

## Rules

- **No secrets in the library.** `GATEWAY_API_KEY`, A2A identity keys,
  Slack tokens, PEMs are per-device values typed into the console's
  write-only fields at device creation — never stored here.
- **Souls are identity, delivered by the registrar.** This library is
  reviewable default content, not a delivery path: a device still
  receives its soul only through its identity bundle
  (docs/vs-environment.md's boundary holds).
- **Owner sign-off gates the roster.** A persona lands on a device only
  after lazybaer approves its soul text; library changes land via PR,
  like everything else in this repo.
- **Environment facts stay out.** Per-fleet suffixes (VS composition,
  queue conventions, owner-exception classes) are environment, not
  persona; they compose at selection time if ever wanted, not in these
  files.

## Provenance

Drafted by ultronbot under owner green-light 2026-10-02 (roster: "optimus
prime, wheel jack, bumblebee, grimlock, etc"; roles: "tester, reviewer,
red teamer, etc"; souls: "You draft them up"). Ultra Magnus added by
ultronbot to cover the reviewer role the named roster lacked — vetoable.
House style follows the Cabal souls (directness clause + ADR 0001
coordinator-authority mirror), adapted per character.
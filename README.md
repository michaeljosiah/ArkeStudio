<div align="center">

<img src=".github/assets/readme-banner.png" alt="Arke Studio. The world is the asset. Build the world once. Develop every production from it." width="100%">

Build your world once as a durable creative foundation. Every story, film, episode and
interactive experience you make from it draws on the same source and stays consistent
because they share it.

[![CI](https://github.com/michaeljosiah/ArkeStudio/actions/workflows/ci.yml/badge.svg)](https://github.com/michaeljosiah/ArkeStudio/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/michaeljosiah/ArkeStudio?label=release)](https://github.com/michaeljosiah/ArkeStudio/releases/latest)
[![Licence](https://img.shields.io/badge/licence-AGPL--3.0-black)](LICENSE)

</div>

---

## The idea

Most creative tools are organised around *projects*. You make a short film, and when it's
finished the film is the artefact. The world it was set in exists only in your head and
across a folder of notes.

Arke Studio inverts that. **Your world is the foundation.** Productions — novels, films,
episodes, interactive experiences — are what you develop from it.

That inversion is the whole product. Because the world is a real, versioned record rather
than a folder of documents, it can be *consulted*: asked whether something contradicts
what's already true, told what changes when a character does, and cited automatically by
everything it produces. Canon, characters, locations and visual identity are shared across
every work you make from that world, without being copied or forked.

## Three mechanics

Everything else is surface.

**1. Authored facts enter through an accept.** Sheet edits, canon entries and scene drafts
arrive as *proposals*. Each is checked against canon, each shows what it would ripple into,
and each waits. Generated takes and operational records land as work happens; acceptance
controls what the authored work cites and uses.

**2. Canon refuses rather than guesses.** The world answers only from what is written, with
a citation per claim. Asked something it cannot support, it says so, cites the closest
entries it has, and offers to open a thread. It never invents behind your back.

**3. Identity travels.** A character is a main photo and one composite sheet. Those two
images follow them into every frame, on every provider that accepts references, so
consistency is structural rather than a function of prompt luck.

## Core concepts

| | |
|---|---|
| **World** | The asset. Holds the cast, the places, the factions, the canon, the tone and the look. |
| **Canon** | What is true. Versioned, typed (rule, lore, timeline, faction, tone), and answerable, including "the canon doesn't know, and won't guess." |
| **Art direction** | The world's visual language: a master look, a style description, a version. Every image inherits it; every exception says where it came from. |
| **Sheet** | A character, location or faction. Versioned, with a voice and an identity kit of two images. Sketch until you lock it. |
| **Production** | A story, film, album or game drawn from the world. Shares the cast and canon by reference. Nothing is copied, nothing is forked. |
| **Scene → Shot → Take** | The unit of work is the shot. Each is its own brief and its own retry. Accepted takes assemble the cut. |
| **Artifact** | Recordings, documents, references. Filed by provenance, so anything that cited a sheet lands against it automatically. |

## How it works

Every authoring surface in Arke Studio follows one loop:

```
   talk it through  ──▶  a proposal  ──▶  checked against canon  ──▶  accept or discard
                                              │
                                              └── what else this changes, before you decide
```

You describe what you want in your own words. Arke drafts it, tells you what it checked
and what it would ripple into (*"14 reference images predate this change; scene 4's brief
re-renders its cast block; 3 productions pick it up on their next dispatch"*), and then
waits.

**Nothing enters the authored record without an accept.** Jobs, reviews and generated takes
exist as operational records; the gate controls authored facts and what the work cites.

## What you can make

One world, two production families, all starring the same characters in the same places under the
same rules. Interactive is a Video kind, not a third family:

- **Story** · novels, novellas, short fiction, screenplays and audio-first scripts, drafted with the canon as editor
- **Video** · *Microdrama* (short-form episodic drama), films, music videos, and interactive branching narratives, with boards and shots dispatched to video models with references attached

Visual assets — concept art, character references, storyboards and promotional material — travel
with every production as they develop.

A change to a character lands in all of them.

## Get it

Currently unsigned Windows installers are on the [releases page](https://github.com/michaeljosiah/ArkeStudio/releases/latest).
Windows 11, x64 and ARM64. Free.

First run downloads the local runtimes it needs (Ollama for local text, Kokoro for speech,
Whisper for dictation). Cloud providers are optional and you supply your own keys.

## Principles

**Your world remains yours.** Arke Studio runs on your machine. Worlds live on your disk in
a readable, portable format. Nothing leaves except the generations you explicitly approve.
An account is never required to open, create or continue a world.

**You decide what becomes true.** Arke can propose boldly, but it cannot quietly rewrite
accepted work. Material changes remain visible proposals, shown with what they would disturb,
until you approve them.

**Canon that distinguishes fact from invention.** The world answers from what is written, with
a citation per claim. Asked something it cannot support, it says so, cites the closest entries
it has, and offers to open a thread. It never invents behind your back.

**Choose how and where intelligence runs.** Use local models, bring your own provider accounts,
or choose managed access. Costs remain visible in real currency before anything is spent. The
managed route is a convenience, never the only easy path.

## How this is built

For a first code-reading session, start with [AGENTS.md](AGENTS.md) and the
[developer index](docs/development/README.md): package relationships, workflow traces,
test selection and generated-file ownership.

Arke is specified before it is written. [`docs/specification.md`](docs/specification.md) is
the master product spec; [`docs/specifications/`](docs/specifications) breaks it into
capability specs, each with its requirements, its design reasoning and its decision log.

Where a spec and the code disagree, that is a bug in one of them, and the specs say plainly
what is designed but not yet built.

Two references are read off the source rather than the specs.
[`docs/architecture/`](docs/architecture/index.html) is an illustrated guide to how Arke is built —
the files on disk, the model behind worlds and productions, the accept gate, generation and spend,
and the program itself — written to be readable without a background in code.
[`docs/filesystem-operations.md`](docs/filesystem-operations.md) is the exact list of what each
operation creates, replaces, appends, moves or removes.

| | |
|---|---|
| `packages/contracts` | Zod schemas and the pure judgements the client and coordinator share |
| `packages/coordinator` | The world on disk, the accept gate, canon, jobs and dispatch |
| `packages/client` | The React app |
| `packages/adapter-opencode` | The writing harness |
| `packages/adapter-claude` | The bring-your-own harness, over the Claude Agent SDK |
| `packages/providers` | Provider clients, the model manifest and the ledger |
| `packages/voice` | The Voxa sidecar client |
| `apps/desktop` | The Electron shell that embeds the coordinator |
| `design-system` | The prototype, the design template and proposal pages |

## Status

**Core trust foundations are built.** Worlds as folders you own, canon with verified quotations
and typed refusals, proposals staged with ripple computation, reference sets that travel into
every dispatch, real currency shown before spend, and durable execution tracking.

**Cloud experience is named but not yet connected.** The launch screen already offers "Arke Studio
Cloud — access your worlds anywhere. Sync, collaborate, create" but integration with Aonik
(the platform foundation) is not yet complete.

**The audience journey is incomplete.** Episode creation and episode detail/chat screens have
implementation, but do not yet establish a complete season-production and audience-publishing
workflow. See the [implementation status notes](docs/development/status.md) for evidence and limits.

This repository holds the code, the specifications and the design system. For the product's
direction and requirements, see the [master specification](docs/specification.md) and its linked
capability specifications.

## Contributing

Bug reports, fixes and specification amendments are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for how changes are shaped and tested.

Every contributor signs the [Contributor Licence Agreement](CLA.md) before their first change is
merged. You keep the copyright in your work; the grant is broad enough that the project can ship
it under the AGPL and under commercial terms alongside it. That is how the work is funded, and it
is stated plainly rather than buried.

## Licence

AGPL-3.0-only. See [LICENSE](LICENSE).

You may use, modify and run it, including commercially. If you distribute it, or offer it to
others over a network, AGPL §13 requires you to make your source available to those users under
the same terms. Third-party components and their obligations are recorded in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

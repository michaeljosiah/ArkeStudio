# Documentation and agent navigation audit

Follow-up: the navigation guides and scoped agent instructions recommended here were added on
5 September 2026, and the listed setup/status drift was addressed. Start at the
[developer index](../development/README.md). The observations below preserve the audit baseline.
That baseline included unmerged audio/performance work. The developer guides were checked against
main when isolated for the documentation PR; audio-branch-only entry points are not presented there
as merged implementation.

Inspected 5 September 2026 against the local working tree, including existing uncommitted changes. This is a targeted source and documentation review, not an exhaustive behavior audit. No application tests were run. Existing changes were left untouched.

## Finding

The repository has substantial product specifications, architectural explanations and useful operational guidance. The gap is a concise developer entry point that connects those documents to implementation, tests and change boundaries. A fresh session currently has to reconstruct those connections through source searches.

There is no root or package-level `AGENTS.md` in the inspected repository. [CLAUDE.md](../../CLAUDE.md) contains valuable cross-agent guidance, but explicitly says it is not an architecture tour. The [README](../../README.md) maps packages at a high level. The [illustrated architecture guide](../architecture/index.html) explains the system well, but is longer than a first-read navigation guide and is aimed at a broader audience.

## Prioritized gaps

| Priority | Gap and evidence | Recommended change |
|---|---|---|
| High | No `AGENTS.md`; worktree isolation, shared stash, formatting, authentication, ownership and journal rules live in CLAUDE.md. | Add a short root AGENTS.md with a reading order, package boundaries, validation commands and links to the existing operational rules. Maintain one authoritative copy of shared instructions. |
| High | No compact feature-to-source-to-test map. Routes, command helpers, wire schemas, command handling, domain operations and event reduction live in different packages. | Add `docs/development/code-map.md`, organized by the change a developer wants to make. Include concrete symbols and neighboring tests. |
| High | Startup is assembled separately in [desktop main](../../apps/desktop/src/main.ts) and [dev.ts](../../packages/coordinator/src/dev.ts). Authentication has different desktop and browser handoffs. | Document both startup paths, resource ownership and shutdown, linking the existing authentication guidance rather than duplicating token instructions. |
| High | A domain change can affect both [coordinator read-model.ts](../../packages/coordinator/src/read-model.ts) and [client store.ts](../../packages/client/src/lib/store.ts). The store also holds transient and request-related state. | Document persisted state, snapshots, events, derived views and UI-local state separately; explain which reductions must agree and which state intentionally differs. |
| High | Ownership and durability details are spread across source, specs, CLAUDE.md, ADRs and the filesystem reference. | Give persistence changes a short reading route: WorldStore, Committer, WriteQueue/atomic writes, ownership, scan/watcher reconciliation, proposal gate, journals and derived SQLite caches. Preserve the distinction between authored acceptance and operational writes. |
| Medium | Package roles are documented, but placement guidance within the large coordinator and client packages is mostly implicit. | Add targeted local AGENTS.md files for coordinator, client and desktop. Add contracts guidance if needed to make schema/pure-logic placement and compatibility rules explicit. Avoid empty guidance files in every folder. |
| Medium | Tests sit beside their workspace, but there is no compact test-selection guide. Client tests require the workspace cwd; tsx does not typecheck; Linux catches Windows path assumptions. | Add `docs/development/testing.md` with focused commands, fixture conventions, cleanup obligations, CI shards, native SQLite/desktop distinctions and the cases requiring an Electron smoke check. |
| Medium | Current implementation, product intent, proposed ADRs and historical reviews are distributed across several document collections. | Add a documentation index explaining each collection's role. For important partial features, record implemented/partial/designed status with source and test evidence. Date historical measurements and review recommendations. |
| Medium | Generated files and runtime/build assets are discoverable mostly from local comments and scripts. For example, fal-catalogue.generated.ts names its generator in its header. | Add a short maintenance map identifying generator inputs, commands and outputs, plus sample-world, bundled-runtime and packaging ownership. Do not reproduce generated catalogues in documentation. |

## Confirmed drift to repair

1. **Node requirement:** CONTRIBUTING.md and root package.json advertise Node >=20. The checked-in package-lock.json records Electron requiring >=22.12.0 and Vite requiring ^20.19.0 or >=22.12.0. CI uses Node 22. The documented minimum does not cover the locked desktop toolchain. Align setup and engines with the supported runtime.
2. **Validation instructions:** CONTRIBUTING.md says to run four checks, but its setup block lists typecheck, lint and tests without build. CI also runs build. It also says local green implies CI green, while CLAUDE.md correctly explains the platform differences. Reconcile these instructions.
3. **ADR status:** [the ADR index](../decisions/README.md) labels ADR-002 Proposed. [ADR-002 itself](../decisions/002-ownership-is-a-revision.md) now accepts bounded desktop checks while leaving hosted leases and atomic fencing proposed. The index loses this distinction.
4. **Feature status:** README says episodes are designed but not built. App.tsx contains EpisodeChatScreen/EpisodeDetailScreen routes, and coordinator has [episode-create.test.ts](../../packages/coordinator/test/productions/episode-create.test.ts). This establishes some implementation, not a finished audience journey. Replace the blanket statement with precise partial status.
5. **Static measurements:** the-program.html reports 232 test files. The current tree contains 402 matching `*.test.ts`, `*.test.tsx` and `*.test.mjs` files under packages/apps, excluding dependency/build directories. These are file counts, not passing-test counts. Label the old statistics with their measured baseline or remove them from evergreen guidance.
6. **Package description:** packages/voice/package.json still describes a typed skeleton whose protocol client arrives later. src/index.ts contains a concrete sidecar client and protocol schemas. Update the description to match implementation.
7. **Missing local destination:** README links to docs/vision.html on GitHub, but that path is absent from this checkout. Verify the intended destination before replacing the link; the remote destination was not checked in this audit.

## Source map a fresh session needs

Paths below are repository-relative. These are navigation starting points, not complete dependency lists.

| Work area | Start here | Follow into |
|---|---|---|
| Desktop startup/platform integration | `apps/desktop/src/main.ts` | `startup.ts`, `preload.ts`, `transport-auth.ts`; coordinator construction and injected platform services |
| Browser development | `packages/coordinator/src/dev.ts` | client `dev-session-plugin.ts`, `src/lib/dev-session.ts`, CONTRIBUTING.md session-link instructions |
| Screens and navigation | `packages/client/src/App.tsx` | `screens/registry.ts` for navigation-test sample paths; `screens/`, `components/`, `domain/connected.tsx` |
| Client commands and state | `packages/client/src/lib/store.ts` | `lib/selectors.ts`; contracts `frames.ts`, `events.ts`; coordinator `read-model.ts` |
| Shared data and pure calculations | `packages/contracts/src/index.ts` | Relevant schema/calculation module and contracts tests; validate affected client and coordinator consumers |
| Command routing | `packages/coordinator/src/coordinator.ts` | Search the exact wire `kind`; follow the imported domain operation rather than treating this file as the whole implementation |
| World access | coordinator `src/world-provider.ts` | Interface versus concrete `src/world/provider.ts`; `world/store.ts`, `scan.ts`, `watcher.ts`, `lock.ts`, `commit.ts` |
| Proposal acceptance | coordinator `src/gate/proposals.ts` | `gate/review.ts`, `merge.ts`, world commit path, SPEC-004 and gate/world tests |
| Jobs and spend | coordinator `src/queue/dispatcher.ts` | `queue/journal.ts`, `spend/ledger.ts`, `providers/call-store.ts`, `flushed-append.ts`; SPEC-009 crash model |
| Provider integration | `packages/providers/src/registry.ts` | `types.ts`, `manifest-data.ts`, `clients/`; coordinator `src/providers/service.ts` and queue dispatch |
| Writing harness | coordinator `src/harness/v2-launch.ts` | Concrete adapter packages; contracts `harness-env.ts`; `harness/authoring.ts`, `world-chat/` |
| Production editing/playback | client `screens/production.tsx`, `screens/scene-workspace/` | coordinator `productions/scene-commands.ts`, `plans.ts`, `timeline.ts`; contracts scene/timeline/render-plan modules; client playback helpers |
| Character audio/performance | coordinator `src/audio/` | Shared contracts, client performance components, desktop media tools; existing character-audio-foundation.md |
| Packaging/runtime delivery | `apps/desktop/package.json` | `apps/desktop/scripts/`, release/package workflows, native rebuild and licence verification |

### One traced workflow: accepting a proposal

1. `packages/client/src/screens/proposals.tsx` imports `acceptProposal` from `lib/store.ts`; connected proposal UI also lives in `domain/connected.tsx`.
2. `acceptProposal` sends the `proposal-accept` message defined in contracts `frames.ts`.
3. Coordinator `coordinator.ts` handles that exact message kind, checks active drafting and obtains the provider's gate.
4. `ProposalManager.accept` in `gate/proposals.ts` owns the acceptance decision. The handler also resolves conversation provenance when the proposal lands.
5. The handler emits `proposal.resolved` or `proposal.blocked` as appropriate, then refreshes the world snapshot. Follow contracts events, coordinator read-model and client store to understand the resulting UI.

A future guide should add equally concrete traces for world open/reconnect, generation through spend and take arrival, and a production edit through persistence and playback. Include failure/recovery paths and test entry points, not only the happy path.

## Proposed minimal documentation structure

```text
AGENTS.md                         Short mandatory orientation and shared-rule links
CLAUDE.md                         Existing operational guidance; avoid duplicate rules
docs/development/README.md        Reading order and document authority/status
docs/development/code-map.md      Package relationships, change map, workflow traces
docs/development/testing.md       Focused checks, fixtures, platform/runtime caveats
packages/coordinator/AGENTS.md    Domain placement, persistence and lifecycle boundaries
packages/client/AGENTS.md         Routing, state, components, navigation tests and styling
apps/desktop/AGENTS.md            Composition, preload, media, native runtime and packaging
```

Keep the root guide short enough to read every session. Link to the existing specs, ADRs and architecture pages for detailed reasoning. Update the map when entry points, ownership, wire behavior or validation commands change. A generated full file tree would add bulk without explaining the relationships that are currently expensive to rediscover.

This audit adds no operational instructions and changes no code or existing documentation. The proposed guidance files remain recommendations.

# Code map

Use this map to locate a change, then follow imports and exact message/event names. Paths in tables are relative to the repository root; workflow paths use the package prefixes stated in the text. This is an ownership map, not a full file inventory.

## Package relationships

The client and coordinator share contracts. Providers, voice and the two writing adapters also consume contracts. Desktop composes coordinator and platform integrations. Coordinator's supported dev entry composes providers/voice too, so those package dependencies are intentional. Shared harness assembly imports concrete adapters in `packages/coordinator/src/harness/v2-launch.ts`; Coordinator itself consumes contracts. Check package.json and actual imports when changing dependencies.

```text
Desktop main ──constructs──> Coordinator ──operates──> world folders / jobs / ledger
      │                          │
      │ preload                  │ authenticated snapshots and events
      └──────────────> React client ──commands──> Coordinator

Desktop and dev composition ──> provider / harness / voice integrations
Client, coordinator and integrations ──> shared contracts
```

## Change entry points

| Change | Implementation to follow | Relevant tests to start with |
|---|---|---|
| Route or screen | client `src/App.tsx` → `screens/registry.ts` → `screens/`, `components/`, `domain/connected.tsx` | client `test/routes.test.tsx`, matching screen test |
| Command/event | client `src/lib/store.ts` → contracts `src/frames.ts`, `events.ts` → coordinator `src/coordinator.ts` → owning domain | coordinator `test/transport.test.ts`, affected domain test; matching client test |
| World open or outside edits | coordinator `src/world-provider.ts` (interface), `world/provider.ts` (implementation), `world/store.ts`, `scan.ts`, `watcher.ts` | coordinator `test/world-provider.test.ts`, `test/world/watcher.test.ts`; client `test/world-open-failure.test.tsx` |
| Acceptance | coordinator `src/gate/proposals.ts`, `review.ts`, `merge.ts`; `world/commit.ts` | coordinator `test/gate/proposals.test.ts`, `test/world/commit.test.ts` |
| Job execution/recovery | coordinator `src/queue/dispatcher.ts`, `journal.ts`, `classify.ts`, `verify.ts` | coordinator `test/queue/dispatcher.test.ts`, `verify.test.ts`, `acknowledge.test.ts` |
| Provider/model | providers `src/registry.ts`, `types.ts`, `manifest-data.ts`, `clients/`; coordinator `src/providers/service.ts`, `call-store.ts` | providers `test/`; coordinator `test/queue/` and `test/spec008/` |
| Writing/chat | coordinator `src/harness/v2-launch.ts`, `harness/authoring.ts`, `world-chat/`; adapter packages | adapter `test/`; coordinator `test/world-chat/` |
| Production scene/plan | client `src/screens/production.tsx`, `screens/scene-workspace/`; coordinator `src/productions/scene-commands.ts`, `plans.ts`, `frame-run.ts`; contracts `src/scene.ts`, `planning.ts`, `pass-compiler.ts` | coordinator `test/productions/pass-compiler.test.ts`; client `test/scene-workspace.test.tsx`, `frame-run.test.tsx` |
| Timeline/playback | coordinator `src/productions/timeline.ts`; contracts `src/timeline.ts`, `render-plan.ts`; client `src/lib/plan-playback.ts`, `playback-engine.ts` | coordinator `test/productions/timeline.test.ts`; client `test/timeline-editing.test.tsx`, `plan-playback.test.ts` |
| Voice | coordinator `src/voice/service.ts`, `library.ts`; `packages/voice/src/index.ts`; desktop `src/voxa-runtime.ts` | voice `test/`; desktop `test/voxa-runtime.test.ts`; [SPEC-011](../specifications/011.voice.md) |
| Desktop/platform | desktop `src/main.ts`, `startup.ts`, `preload.ts`, `transport-auth.ts`; client `src/arke-bridge.d.ts` | desktop `test/startup.test.ts`, `transport-auth.test.ts`, `preload-auth.test.ts` |
| Derived search | coordinator `src/index-db/world-index.ts`, `app-index.ts`, `queries.ts`, `sqlite.ts` | coordinator `test/index-db/cache-contract.test.ts` |

For an unfamiliar feature, search its visible label in client source, follow the store helper's message kind into contracts and the coordinator switch, then follow the domain operation. Search the emitted event back into the client store. Use nearby tests to discover fixtures and failure cases.

## Startup and lifecycle

**Desktop:** [main.ts](../../apps/desktop/src/main.ts) assembles filesystem access, secrets, provider transports, harness/voice supervisors and media tools, then constructs Coordinator and starts its transport. [preload.ts](../../apps/desktop/src/preload.ts) bridges the renderer to trusted startup information. Client [main.tsx](../../packages/client/src/main.tsx), App and store supply the UI. For capability handling and media authorization, read [the shared transport rules](../../CLAUDE.md#the-coordinator-session-is-authenticated-issue-825).

**Browser dev:** the coordinator workspace dev script runs `dev-preflight.ts` then [dev.ts](../../packages/coordinator/src/dev.ts). Dev seeds an empty `.dev/root` from fixtures (overridable by `ARKE_STUDIO_ROOT`), constructs FsWorldProvider and integrations, and writes a private transport handoff. Vite's [dev-session-plugin.ts](../../packages/client/dev-session-plugin.ts) prints the session link consumed by client `lib/dev-session.ts`. Dev credentials use a per-run cipher; dev voice wiring is not identical to packaged Voxa. See [setup](../../CONTRIBUTING.md#getting-set-up) for ports and restart behavior.

**Shutdown:** desktop `shutdownConfirmed()` and `before-quit`, or dev SIGINT/SIGTERM, call `Coordinator.stop()`. It closes admission, stops transport, awaits active handlers, cancels/disposes services, drains tracked work and the queue, stops supervisors and closes owned resources. Read the method for ordering before adding work; do not infer that closing a window safely drains everything. Startup failure also has a separate cleanup path in main.ts.

## State and persistence ownership

| State | Owner and change path |
|---|---|
| World files and versioned authored records | `world/store.ts`, `world/commit.ts`, domain operations and the proposal gate; consult [filesystem operations](../filesystem-operations.md) for each write |
| Jobs, spend, provider call records | `queue/journal.ts`, `spend/ledger.ts`, `providers/call-store.ts`; operational records with explicit flush/recovery rules |
| Server projection | `read-model.ts` folds shared state; Coordinator supplies additional live-session data in outgoing snapshots |
| Wire state | `transport.ts` authenticates and sends sequenced snapshots/events defined by contracts |
| Client projection/request state | `client/src/lib/store.ts` validates frames, folds domain events and holds request/transient state; inspect both reducers for shared-state changes |
| Derived UI and local interaction | `lib/selectors.ts` and component state; local panel state need not become a persisted fact |
| Search caches | `index-db/` projects filesystem data into rebuildable SQLite indexes; it is not the authored source of truth |

For persistence work read WorldStore → Committer → `world/atomic.ts` and the WriteQueue defined in `change-log.ts`, then `world/lock.ts`, scan/watcher reconciliation and the applicable domain writer. Follow [ADR-002](../decisions/002-ownership-is-a-revision.md) for the bounded desktop ownership decision and [SPEC-009](../specifications/009.the-job-queue-and-dispatch.md) for journal crash guarantees. Authored proposals, direct production edits and operational records do not all share the same acceptance workflow.

## Workflow traces

### Accept a proposal

Client `screens/proposals.tsx` and `domain/connected.tsx` use `lib/store.ts`'s `acceptProposal`. It sends `proposal-accept` from contracts `frames.ts`. Coordinator's matching handler checks active drafting and calls `ProposalManager.accept` in `gate/proposals.ts`. The gate checks whether the candidate can land; the world commit path owns file/version changes. The handler records conversation resolution for a landed result, emits `proposal.resolved` or `proposal.blocked` as appropriate and refreshes the world snapshot.

Follow the refusal cases too: stale bases, pending review, unresolved choices/conflicts and active drafting do not become acceptance. Read `test/gate/proposals.test.ts`, `test/gate/settle-survives.test.ts` and `test/world/commit.test.ts` in coordinator for decision and persistence coverage.

### Open a world and reconnect

The client sends `open-world`; Coordinator uses the world provider. `world/provider.ts` opens the filesystem-backed store, while `world/store.ts` owns recovery, ownership, scanning/indexing and watcher lifecycle. Follow the provider's failure events and client `components/world-open-refusal.tsx` for refusal presentation. Disk changes feed reconciliation and refreshed state rather than becoming invisible mutations of client state.

On reconnect, `transport.ts` authenticates hello and sends a fresh snapshot regardless of the supplied last sequence. Sequence numbers are per connection; transient held events can be replayed after the snapshot. It is not a missing-event replay log. Read coordinator `test/transport.test.ts`, `test/world-provider.test.ts`, `test/world/watcher.test.ts` and client `test/world-open-failure.test.tsx`. Ownership loss requires the recovery policy in CLAUDE.md, not retries under the previous claim.

### Generate media and receive a take

For planned scene generation, start at client `screens/scene-workspace/workspace.tsx` and `lib/store.ts`'s `dispatchScenePlanned`, then follow `dispatch-scene-planned` in Coordinator. The store also exposes `dispatchScene` for the `dispatch-scene` path. Plan/reference validation precedes queue execution; do not equate a plan preview with a provider submission. `queue/dispatcher.ts` owns durable job transitions and invokes configured provider clients. Follow `spend/ledger.ts` and `providers/call-store.ts` for their separate accounting roles.

The dispatcher verifies returned artifacts through `queue/verify.ts`; Coordinator integrates take results via `takes/arrival.ts` (`recordTakesFromJob`). Generated arrival is distinct from accepting a take into authored work. For failures, inspect `queue/classify.ts`, journal recovery and reconciliation: loss of observation is an unknown outcome, not evidence that no charge occurred. Start tests at coordinator `test/queue/dispatcher.test.ts`, `test/queue/verify.test.ts` and client `test/dispatch-scene.test.tsx`.

### Edit a production timeline

Follow client timeline UI and store commands into contracts `timeline.ts`/`frames.ts`. Coordinator routes `timeline-command`, `timeline-move-picture` and `timeline-history` to `applyTimelineCommand` in `productions/timeline.ts`. That module validates and persists the operation; the handler refreshes world state. Playback reads the resulting data through shared render planning and client `lib/plan-playback.ts`/`playback-engine.ts`.

Inspect `TimelineCommandRefused` and existing migration/history handling when changing edits. A client drag preview is not a successful persisted edit. Start with coordinator `test/productions/timeline.test.ts`, `timeline-migration.test.ts` and client `test/timeline-editing-guards.test.tsx`, `plan-playback.test.ts`.

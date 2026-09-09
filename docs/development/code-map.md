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
| Settings status and preferences | client `screens/shell.tsx` (General defaults/narrator, Appearance theme, Harness selection), `screens/settings-providers.tsx`, `screens/settings-downloads.tsx`; coordinator `providers/service.ts`, `credentials/store.ts` (encrypted-record fingerprint), `setup/local-setup.ts` (shared file identity) | client `test/settings-general.test.tsx`, `providers.test.tsx`, `downloads.test.tsx`, `voice-line.test.tsx`; coordinator `test/spec008/providers.test.ts`, `setup/local-setup.test.ts` |
| World entity navigation / Props | client `src/screens/world.tsx` (`WorldLayout`, shared `SheetKindNav`) → `screens/props.tsx` (bounded form and prop list). Props sits under the Cast world tab alongside Characters, Locations and Factions (issue 999); its minimal name/states model follows [design turn 105f](../../design-system/Arke%20Studio.dc.html#105f) | client `test/routes.test.tsx` |
| Command/event | client `src/lib/store.ts` → contracts `src/frames.ts`, `events.ts` → coordinator `src/coordinator.ts` → owning domain | coordinator `test/transport.test.ts`, affected domain test; matching client test |
| World open or outside edits | coordinator `src/world-provider.ts` (interface), `world/provider.ts` (implementation), `world/store.ts`, `scan.ts`, `watcher.ts` | coordinator `test/world-provider.test.ts`, `test/world/watcher.test.ts`; client `test/world-open-failure.test.tsx` |
| Artifact retirement/restore | client `screens/world.tsx` Retired filter → `retire-artifact` / `restore-artifact` → coordinator `artifacts/filing.ts`; guarded sidecar commit preserves media and metadata | coordinator `test/artifacts/artifacts.test.ts`; client `test/artifact-viewers.test.tsx` |
| Acceptance | coordinator `src/gate/proposals.ts`, `review.ts`, `merge.ts`; `world/commit.ts`; `coordinator.ts` `refreshConversationOutcome` publishes the committed bundle after card acceptance | coordinator `test/gate/proposals.test.ts`, `test/world/commit.test.ts`, `test/arke-actions/review-regressions.test.ts` |
| Job execution/recovery | coordinator `src/queue/dispatcher.ts`, `journal.ts`, `classify.ts`, `verify.ts` | coordinator `test/queue/dispatcher.test.ts`, `verify.test.ts`, `acknowledge.test.ts` |
| Borrow a reference image | client `components/staged-reference-picker.tsx` in `generation-dialog.tsx` → `browse-reference-images` / `pick-staged-reference`; coordinator `world/provider.ts` lists image paths without opening a store; `coordinator.ts` copies and freezes origin; `world/scan.ts`, `references/takes.ts` and `takes/arrival.ts` preserve it | coordinator `test/references/borrowed-image.test.ts`; client `test/staged-reference-picker.test.tsx`; issue 960 |
| Provider/model | providers `src/registry.ts`, `types.ts`, `manifest-data.ts`, `clients/`; coordinator `src/providers/service.ts`, `call-store.ts` | providers `test/`; coordinator `test/queue/` and `test/spec008/` |
| Local Krea 2 images | providers `src/comfyui/krea2-recipe.ts`, `recipes.ts`, `clients/comfyui.ts`; offline node installer `scripts/install-comfyui-krea2.mjs` | providers `test/comfyui.test.ts`; [setup and GPU smoke check](krea2.md) |
| Add or replace a ComfyUI recipe | [Numbered authoring and verification procedure](comfyui-recipes.md) | Parameter bindings, publisher hashes, manifest projection, measured memory floors and real GPU evidence |
| Ollama / ComfyUI contention | coordinator `src/local-ai/gpu.ts`, `harness/local-gpu.ts`, `queue/dispatcher.ts`; provider `unload` methods | coordinator `test/local-gpu.test.ts`; providers Ollama checks in `test/clients.test.ts` |
| Local model residency warnings | provider `residency` probes → coordinator `refreshLocalResidency` → `local-ai.residency` → client `local-models.tsx` / `settings-models.tsx`; contracts `local-ai.ts` | providers residency tests; client `test/local-models.test.tsx` |
| Local H3 reference video | providers `src/comfyui/h3-reference-recipe.ts`, `reference-inputs.ts`, `clients/comfyui.ts`; contracts `reference-budget.ts`, `reference-prompt.ts`, `audio-reference.ts`; coordinator `media/prepare-references.ts`, `media/reference-media.ts`, `bench/service.ts` and queue preparation | providers `test/h3-reference.test.ts`; coordinator `test/media/reference-media.test.ts`, `test/bench/bench.test.ts`, `test/queue/dispatcher.test.ts`; [setup and GPU smoke check](h3-reference-video.md) |
| Writing/chat | client `src/components/conversation.tsx` (shared world/production transcript), `inline-markdown.tsx` (reply formatting); coordinator `src/harness/v2-launch.ts`, `harness/authoring.ts`, `world-chat/`; adapter packages | client `test/world-chat-fidelity.test.tsx`, `test/inline-markdown.test.tsx`; adapter `test/`; coordinator `test/world-chat/` |
| Production setup | coordinator `src/productions/setup.ts`, `setup-brief.ts`, `setup-plan.ts`; contracts `src/production-setup.ts` owns updates from chat and controls, `production-creation.ts` owns shared microdrama delivery defaults; client `src/screens/production-setup.tsx` | contracts `test/production-setup.test.ts`; coordinator `test/productions/setup-run.test.ts`; client `test/production-setup.test.tsx` |
| Authoring skill documents | contracts `src/skills.ts` selects metadata; coordinator `src/harness/skills.ts` reads shipped `harness/skills/*.md` during `session-files.ts` preparation; desktop `scripts/build.mjs` copies them to `dist/skills` | coordinator `test/harness/skills.test.ts`; contracts `test/skills.test.ts`; adapter session tests |
| Conversational video setup | contracts `production-setup.ts`, `production-creation.ts`, `production-narrative.ts`; coordinator `productions/setup*.ts`, `productions/ops.ts`, `productions/narrative.ts`; client `screens/production-setup.tsx`, `production-narrative.tsx`, `components/production-setup-outline.tsx` | contracts `test/production-setup.test.ts`; coordinator `test/productions/setup*.test.ts`; client `test/production-setup.test.tsx`; desktop `scripts/smoke-production-setup.mjs` |
| Production scene/plan | client `src/screens/production.tsx`, `screens/scene-workspace/`; coordinator `src/productions/scene-commands.ts`, `plans.ts`, `frame-run.ts`; contracts `src/scene.ts`, `planning.ts`, `pass-compiler.ts` | coordinator `test/productions/pass-compiler.test.ts`; client `test/scene-workspace.test.tsx`, `frame-run.test.tsx` |
| AI Stage construction and motion references | contracts `src/stage-camera.ts` (shared motion/coordinate evaluation), `src/stage-construction.ts`, `src/staging.ts`; coordinator `src/productions/stage-construction.ts` (bounded read-only model loop), `stage-playblast.ts` (measured filing/freshness), `world-chat/actions.ts`, `bench/subject.ts`; client `screens/scene-workspace/stage.tsx`, `stage-viewport.ts`, `components/conversation.tsx` | contracts `test/stage-scenes.test.ts`, `test/staging.test.ts`; coordinator `test/productions/stage-construction.test.ts`, `stage-playblast.test.ts`; [Stage evaluation](stage-evaluation.md) |
| Story dashboard and daily progress | client `src/screens/production.tsx` (`ProductionDashboardScreen`, shared outline rows); coordinator `src/productions/ops.ts` (`saveChapter` commits `progress.json` with the prose); contracts `StoryProgressSchema`, `storyProgressDay` | client `test/story-dashboard.test.tsx`; coordinator `test/productions/chapters.test.ts` |
| Chapter workspace (story) | client `src/screens/chapter-workspace.tsx` (open on demand, autosave against the base it read, restore, the staged draft or passage in the prose's place, the selection as the dock's subject, Arke docked on the production thread), `screens/production.tsx` (`ChapterTreeScreen` with its `Outline · Continuity` views, `useNewChapter`, the style cards on `OverviewStoryScreen`), `src/lib/continuity.ts` (the continuity table's carry, the stamps, the remembered view), `src/components/page-read.tsx` (`useProsePageRead` with the sources a voiced read names and the voice each block is read in), the `ManuscriptExportSheet` and `ManuscriptImportSheet` on `ChapterTreeScreen` (a manuscript out and in, turn 131); contracts `src/manuscript.ts` (`manuscriptDocument`, `paragraphRuns`, `runsToMarkdown`, `manuscriptChapters`: the little Markdown a novelist types as runs, and chapters found by heading level), `src/prose.ts` (`chapterParagraphs`, `countWords`, `targetWords`, `changedSpan`, `passageOf`, `occurrencesOf`, `voicedBlocks`, the `chapter-voiced` read source), `src/world.ts` (`ProseStyleSchema`, `ChapterContinuitySchema`, `ChapterContinuitySummarySchema`, `summariseContinuity`, `ChapterVoicesSchema`, `ChapterVoicesSummarySchema`, `summariseVoices`), the `create-chapter` / `open-chapter` / `save-chapter` / `restore-chapter` / `edit-chapter-plan` / `derive-continuity` / `stop-continuity` / `cast-voices` / `stop-voices` / `export-manuscript` / `pick-manuscript` / `reread-manuscript` / `import-manuscript` / `cancel-manuscript` / `open-exports-folder` frames and the `chapter.*`, `continuity.*`, `voices.*` and `manuscript.*` events; coordinator `src/productions/ops.ts` (`createChapter`, `openChapter`, `saveChapter`, `restoreChapter`, `setChapterRetired`, `reorderChapters`, `editChapterPlan`, `overviewSteer`), `src/productions/continuity.ts` (`deriveContinuity` in passes, `verifyContinuity`, `mergePasses`, `readContinuity`; the record at `productions/<id>/.continuity/<file>.json`, derived and unversioned, never in `.index/`), `src/productions/voices.ts` (`castLines` in passes, `verifyVoices`, `mergeVoicePasses`, `readVoices`; the cast at `productions/<id>/.voices/<file>.json` in the same discipline), `narrateVoicedPage` in `src/coordinator.ts` (a voiced read's blocks, each in the narrator's or its speaker's voice, priced once), `src/productions/manuscript.ts` (`writeDocx`, `writeEpub`, `readDocxDocument`, `exportManuscript` under `exports/` through staging and the ownership-checked write, `importManuscript` in one commit; the structured `.docx` read beside the flat one in `world-chat/document-text.ts`) and `src/productions/zip.ts` (a zip written by hand, the reader's twin), `src/world-chat/production-authoring.ts` (`production-chapter` with `passage`, applied at staging by `replacePassage`; `production-prose-style` staged to `prose-style.json`, a JSON track of its own), and the matching cases in `src/coordinator.ts`; `world-chat/chapter-brief.ts` assembles leased plan/ending/draw/style reads for the chapter subject before `world-chat/run.ts` starts the model | coordinator `test/world-chat/chapter-brief.test.ts`, `test/productions/chapters.test.ts`, `test/productions/continuity.test.ts`, `test/productions/voices.test.ts`, `test/productions/manuscript.test.ts`, `test/voice/chapter-read.test.ts`, `test/voice/voiced-read.test.ts`, `test/world-chat/chapter-passage.test.ts`, `test/gate/chapter-review.test.ts`; client `test/chapter-workspace.test.tsx`, `test/chapter-tree.test.tsx`, `test/manuscript.test.tsx`, `test/continuity.test.ts`, `test/prose-style-overview.test.tsx`; contracts `test/prose.test.ts`, `test/manuscript.test.ts`; [design turns 126–131](../../design-system/Arke%20Studio.dc.html#t131), issues 874, 882, 896, 901, 912, 915; SPEC-012 §2.4.1–2.4.3 |
| Timeline/playback | coordinator `src/productions/timeline.ts`; contracts `src/timeline.ts`, `editor-media.ts`, `render-plan.ts`; client `src/lib/plan-playback.ts`, `playback-engine.ts` | coordinator `test/productions/timeline.test.ts`; client `test/timeline-editing.test.tsx`, `plan-playback.test.ts` |
| Voice | coordinator `src/voice/service.ts`, `library.ts`; `packages/voice/src/index.ts`; desktop `src/voxa-runtime.ts` | voice `test/`; desktop `test/voxa-runtime.test.ts`; [SPEC-011](../specifications/011.voice.md) |
| Read aloud | client `src/components/read-aloud.tsx` and `page-read.tsx` → contracts `src/prose.ts` and the `read-prose` / `read-prose-page` / `stop-prose-page` / `read-sheet-section` / `read-bible-section` frames → coordinator `src/coordinator.ts` (`narrateSection`, `resolveProse`) and `voice/service.ts` (`authoritativeProseSpeech`, `authoritativeSheetSpeech`, `authoritativeBibleSpeech`, `chapterProseSpeech`). A screen names a source; the coordinator reads the authoritative record and narrates it with the app-level narrator, never a character’s voice. The `chapter` arm is the one read off disk rather than off the bundle (`openChapter`, once per page), because a chapter's body is not in the bundle; a page read of a chapter is one block per paragraph, and `stop-prose-page` ends it at the next block, local or cloud | coordinator `test/voice/service.test.ts`, `test/voice/page-read.test.ts`, `test/voice/chapter-read.test.ts`, `test/voice/chapter-speech.test.ts`; client `test/voice-line.test.tsx`, `test/page-read.test.tsx`; contracts `test/schemas.test.ts`, `test/prose.test.ts` |
| Founding depiction rules | contracts `src/genesis.ts`, `src/world.ts`, `src/founding-build.ts`; coordinator `src/harness/blueprint.ts`, `src/harness/genesis.ts`, `src/world/founding-build.ts`: `neverDepicted` survives the conversation and sheet acceptance, omits image work and supplies review notes | coordinator `test/world/founding-build.test.ts`; SPEC-031, issue 905 |
| Audio/performance | coordinator `src/audio/`; contracts audio/performance modules; client performance components; desktop media tools | coordinator `test/audio/`; desktop `test/media-tools.test.ts`; [audio integration notes](../architecture/character-audio-foundation.md) |
| Dialogue guidance/feedback | contracts `src/dialogue-assessment.ts`, `provider-guidance.ts`, `take-feedback.ts`; coordinator `src/productions/visual-facts.ts`, `takes/feedback.ts`; client dialogue components | contracts `test/dialogue-assessment.test.ts`; coordinator `test/takes/dialogue-feedback.test.ts`; client `test/dialogue-guidance.test.tsx` |
| Desktop/platform | desktop `src/main.ts`, `startup.ts`, `preload.ts`, `transport-auth.ts`; client `src/arke-bridge.d.ts` | desktop `test/startup.test.ts`, `transport-auth.test.ts`, `preload-auth.test.ts` |
| Shot prompts | contracts `src/planning.ts` selects the authored `promptOverride` for its image/video capability; existing `set-prompt-override` in coordinator `src/productions/scene-commands.ts` saves words and source versions; World Chat authors/revises them, `productions/ops.ts` requests them during standalone scene drafting, and the shot editor edits the same record | coordinator `test/productions/planning.test.ts`, `test/productions/scene-commands.test.ts`; client `test/scene-workspace.test.tsx` |
| World key art | contracts `src/art-direction.ts` (`keyArtIntent.prompt`); coordinator `src/harness/genesis.ts` authors the founding prompt, `references/key-art-references.ts` preserves it and assembles references, `references/prompt-review.ts` supplies world sources for alternatives; existing `plan-key-art` / `generate-world-image` review and dispatch | coordinator `test/references/key-art-composition.test.ts`, `test/world/founding-build.test.ts` |
| Generation reference slot | contracts `src/world-image-references.ts` supplies the image catalogue and roles; client `components/generation-dialog.tsx` embeds `reference-picker.tsx`; coordinator `pick-staged-reference` validates and writes a pointer, read by `world/scan.ts`; `FsWorldProvider.listReferenceImages` supplies local and borrowed catalogues, reuses `world/scan.ts` media hashing to verify aliases, and scans another world read-only; borrowing copies only the chosen image | coordinator `test/references/master-look.test.ts`; client `test/world-reference-slot.test.tsx`, `test/staged-reference-picker.test.tsx`; coordinator `test/references/borrowed-image.test.ts` |
| Derived search | coordinator `src/index-db/world-index.ts`, `app-index.ts`, `queries.ts`, `sqlite.ts` | coordinator `test/index-db/cache-contract.test.ts` |
| Artifact shelf import/removal | client `screens/world.tsx`, `components/artifact-viewer.tsx`, `lib/artifact-view.ts` (current-use names); contracts `artifact.ts` (`retiredAt`, shared pickers); coordinator `artifacts/filing.ts` (`retireArtifact`, dedup restoration). Retirement retains the complete bundle and media for existing citations | client `test/artifact-viewers.test.tsx`; coordinator `test/artifacts/artifacts.test.ts`, `upload-artifacts.test.ts`; SPEC-015 R-18/R-19 |
| Production artifact shelf | client `screens/production-artifacts.tsx` (the world's shelf and this production's own in one grid, `only here` on the card, `Remove`/`Lift facts` on owned files alone), `lib/artifact-view.ts` (`artifactsForProduction`, `productionShelf` — the set the page shows and the rail row counts); contracts `frames.ts` `upload-artifacts.production`; coordinator `upload-artifacts` files at that scope, world by default | client `test/production-artifacts.test.tsx`; coordinator `test/artifacts/upload-artifacts.test.ts`; SPEC-020 R-13, [design turn 134](../../design-system/Arke%20Studio.dc.html#t134) |

Chapter autosave recovery stays in client `screens/chapter-workspace.tsx`: file-hash changes refresh the base, while `parkedDrafts` retains unacknowledged or refused prose across navigation. Conflicting saved prose requires an explicit choice; the coordinator's base-hash guard is unchanged (issue 954).

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

Client `components/route-error-boundary.tsx` contains route render errors and resets on navigation.
World and production layouts wait for the routed world before mounting their outlets (issue 981).
Production navigation lives in `screens/production.tsx` (`ProductionLayout`); `screens/fidelity.css`
distinguishes the current rail item from hover. The rail omits retired Audio/Exports destinations;
`App.tsx` retains their redirects into the Cut (SPEC-039 R-1, issue 995). Every rail row addresses
the production: `Artifacts` reaches `p/<id>/artifacts` on all three branches and counts
`productionShelf`, the set that page shows (SPEC-020 R-13, design 134).

`WorldStore.checkCurrentHistorySnapshots` reports current snapshot conflicts as world problems;
the art-direction page shows its own history warning. Writable open repairs only the known
founding-v1 master-look addition against the committed baseline. New founding previews use
`commitUnserialised` to complete the record and snapshot in one recoverable transaction (issue 979).
Bible hashes join the existing scan manifest for history validation, while outside-edit
reconciliation still excludes this ungated document. Its change-log receipt or scan baseline
validates the snapshot before `adoptBibleIfMoved` may use it as the previous version.
`scanWorld` carries each file's latest hashed change receipt into these checks, reusing its one
change-log read; pending live edits are checked against their committed hashes and version stamps.

The client sends `open-world`; Coordinator uses the world provider. `world/provider.ts` opens the filesystem-backed store, while `world/store.ts` owns recovery, ownership, scanning/indexing and watcher lifecycle. Follow the provider's failure events and client `components/world-open-refusal.tsx` for refusal presentation. Disk changes feed reconciliation and refreshed state rather than becoming invisible mutations of client state.

On reconnect, `transport.ts` authenticates hello and sends a fresh snapshot regardless of the supplied last sequence. Sequence numbers are per connection; transient held events can be replayed after the snapshot. It is not a missing-event replay log. Read coordinator `test/transport.test.ts`, `test/world-provider.test.ts`, `test/world/watcher.test.ts` and client `test/world-open-failure.test.tsx`. Ownership loss requires the recovery policy in CLAUDE.md, not retries under the previous claim.

### Generate media and receive a take

For planned scene generation, start at client `screens/scene-workspace/workspace.tsx` and `lib/store.ts`'s `dispatchScenePlanned`, then follow `dispatch-scene-planned` in Coordinator. The store also exposes `dispatchScene` for the `dispatch-scene` path. Plan/reference validation precedes queue execution; do not equate a plan preview with a provider submission. `queue/dispatcher.ts` owns durable job transitions and invokes configured provider clients. Follow `spend/ledger.ts` and `providers/call-store.ts` for their separate accounting roles.

The dispatcher verifies returned artifacts through `queue/verify.ts`; Coordinator integrates take results via `takes/arrival.ts` (`recordTakesFromJob`). Generated arrival is distinct from accepting a take into authored work. For failures, inspect `queue/classify.ts`, journal recovery and reconciliation: loss of observation is an unknown outcome, not evidence that no charge occurred. Start tests at coordinator `test/queue/dispatcher.test.ts`, `test/queue/verify.test.ts` and client `test/dispatch-scene.test.tsx`.

### Edit a production timeline

Follow client timeline UI and store commands into contracts `timeline.ts`/`frames.ts`. Coordinator routes `timeline-command`, `timeline-move-picture` and `timeline-history` to `applyTimelineCommand` in `productions/timeline.ts`. That module validates and persists the operation; the handler refreshes world state. Playback reads the resulting data through shared render planning and client `lib/plan-playback.ts`/`playback-engine.ts`.

Editor imports route `upload-artifacts` with a destination and timeline revision into coordinator `productions/editor-import.ts`. World filing owns the copied media; contracts `editor-media.ts` builds Library and placement commands. The coordinator resolves semantic detachment under its write gate through contracts `timeline.ts`. Its `assembleTimelineScene` service plans scene assembly after reserving migrated legacy tracks. Audio track identity is separate from optional clip roles and future-only defaults (SPEC-043). Start with coordinator `test/productions/editor-import.test.ts`, client `test/independent-editor.test.tsx` and the desktop `smoke-editor-import.mjs` file-page check.

Client `screens/editor-clip-menu.tsx` shares the main/upper Picture context menu and new-track audio
extraction. Contracts `render-plan.ts` keeps video sound by default, resolves filed segments through
their measured parent media, and carries scoped missing-measurement notices into the export sheet
(issue #908). Regressions live in contracts `test/render-plan.test.ts` and client `test/exports.test.tsx`.

Inspect `TimelineCommandRefused` and existing migration/history handling when changing edits. A client drag preview is not a successful persisted edit. Start with coordinator `test/productions/timeline.test.ts`, `timeline-migration.test.ts` and client `test/timeline-editing-guards.test.tsx`, `plan-playback.test.ts`.

Render planning, migration and inspector validation receive the whole world's artifact catalog. Contracts `artifact-access.ts` (`resolveProductionArtifact`) distinguishes missing media from another production's scoped material; the same decision guards timeline/Library placement, editor-request preparation and legacy writes. Render planning's `legacyArtifactScopeRefusal` checks unmigrated audio and song masters before preview or export; `legacyCutArtifactReferences` normalizes both legacy audio encodings for the planner and bulk-save validation. New picker offers remain scoped to the current production, while existing unavailable Library memberships stay visible for removal (SPEC-020 R-13).


### Edit or draft a chapter

Client `screens/chapter-workspace.tsx` opens prose through `open-chapter`, saves against the file
hash through `save-chapter`, edits the frontmatter through `edit-chapter-plan`, and restores an
available snapshot through `restore-chapter`. Coordinator `productions/ops.ts` owns those writes;
`world/commit.ts` owns the chapter history and commits `progress.json` with a successful save.

The dock uses the production conversation, naming the chapter as its subject. `world-chat/run.ts`
asks `chapter-brief.ts` for leased reads of its plan, previous ending, draws and style, retaining
the normal receipts. `production-authoring.ts` stages a `production-chapter` action as a chapter
proposal; acceptance cuts a version. Its `outline` operation stages several planned chapters on
one card. Implies stays on the chapter until Propose sends its separate canon/sheet ask or Dismiss
removes an open item. See SPEC-012 R-53–R-61 and the chapter workspace, chapter brief, chapter
operations and story dashboard tests named above.

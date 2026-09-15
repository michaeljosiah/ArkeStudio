# Production module boundary decisions

Assessment for [issue 1160](https://github.com/michaeljosiah/ArkeStudio/issues/1160),
2026-09-15, against main `747d939b` after PR 1166. This records the next useful moves;
it does not implement them. The [original split](../issues/101.production-tsx-refactor.md)
is complete. File length is a navigation signal, not an acceptance target.

## Decisions

Counts include imports, comments and blank lines. Paths below are relative to
`packages/client/src/screens/`.

| Module | Lines | Decision | Reason |
|---|---:|---|---|
| `production-generate.tsx` | 1,441 | Split at existing component boundaries | Take review, dispatch and voice-line requests have separate state and lifecycles. Shared helpers also pull unrelated screens into the dependency graph. |
| `production-shell.tsx` | 1,406 | Split dashboard from layout; relocate the episode picker with take review | The dashboard is a route body, not part of layout state. The picker is consumed by generation, while shell imports its helpers from generation. |
| `cut.tsx` | 1,709 | Keep for now | Most of the file is one component coordinating selection, transport, optimistic edits, imports and command acknowledgement. A file move would not untangle those responsibilities. |
| `production-story.tsx` | 1,039 | Keep for now | Chapter creation contexts are shared with the layout. Manuscript sheets are a future seam, but no current change needs a separate module. |
| `editor-library.tsx` | 838 | Keep for now | Most of its size is ArtifactPanel and its existing callback contract. Resolve its closed-panel lifecycle before moving pieces. |

The first two decisions justify a small sequence of pure moves. They do not justify a generic
screen framework, new context, global UI store, lazy-loading scheme or a new service layer.
Moving source files alone does not establish fewer renders or a smaller bundle.

## Generation: keep each state owner intact

The current seams are visible without redesigning the components:

- `TakeTileMedia` and `TakesView` occupy lines 174–647. TakesView owns episode/scene/shot
  filtering, the picked take and playback coordination. Keep those declarations together in
  `production-takes.tsx`, with the unchanged TakesView props consumed by GenerateScreen.
- `GenerateScreen` occupies lines 648–1082. Keep it in `production-generate.tsx` with
  `passRow` and `ContactSheet`. It owns generator admission, request identity, subscriptions,
  the selected subject and navigation between views. Those stay in the parent.
- `VoiceLineDialogScreen` occupies lines 1094–1331. Move it intact to
  `production-voice-line.tsx`. Its pending request, delivery/model choice, remote-upload
  confirmation and result subscriptions belong to that dialog, not to a shared generation hook.

There is already a cycle: generation imports `EpisodePicker` and `decisionTone` from shell;
shell imports take-media and episode helpers from generation. There is also a cast/generation
cycle: cast imports look helpers from generation, and generation imports `carriedSubjects`
from cast. A split that leaves these edges in place only hides the coupling.

Before moving the components, give the existing helpers explicit homes:

| Existing names | Proposed owner | Consumers to repoint |
|---|---|---|
| `takeMediaView`, `takeMediaPath`, `decisionTone` | `lib/take-presentation.ts` | Generation, shell, editor library, world screen and Stage underlay; matching tests |
| `lookPickerLabels`, `lookOptionScope` | Existing `production-cast.tsx` | Used within cast; repoint wardrobe tests from generation |
| `TakeEpisodeOption`, `episodeLabel`, `filterTakeEpisodes`, `episodeThumbnailPath`, `EpisodePicker` | `production-episode-picker.tsx` | TakesView, shell/world thumbnail consumers and matching tests |

These are client presentation helpers, so they stay in the client. Preserve the existing
algorithms and types. In particular, do not change take ordering, frame/pass media resolution,
look labels or duplicate episode handling during a move. The episode picker keeps its own
search, open state, active option and keyboard behavior. Its module can depend on take
presentation, but must not import generation or shell.

## Shell: separate the route body from the route parent

Keep `ProductionLayout` and `ProductionSwitcher` together in `production-shell.tsx`.
Layout owns the rail, expansion state, route-dependent actions and the new-scene/new-chapter
providers surrounding the Outlet. A smaller rail component would add a broad prop interface
without creating a useful independent owner.

Move `ProductionHomeScreen`, `ProductionDashboardScreen`, `DeliveryAspect` and `DayOne`
together to `production-dashboard.tsx`. Their main block is lines 766–1184. Keeping them
together preserves the dashboard's day-boundary refresh and DayOne's composer state.
Repoint the route import to ProductionHomeScreen; do not change its key, nesting or redirects.

Keep the small `ProductionChatScreen` in shell for this pass. It can move when conversation
work benefits from a dedicated owner; moving every export is not a goal.

Shell and story also import each other: shell consumes the creation contexts and chapter
presentation; story consumes `defaultEpisodeFor`. Move that existing pure helper into
`lib/production-navigation.ts` and repoint both callers. Keep `NewSceneContext` and
`NewChapterContext` declared exactly once in story, with the same provider placement in
layout. Do not recreate a context or instantiate a second creation hook in a child to avoid
an import.

## Keep the editor and story boundaries for now

**Cut:** its render-plan derivation is memoised, but still assembled in the screen alongside
preview state, source lengths and playback spans. The shortcut block reads current selection,
command availability and action refs. Extracting that block cannot turn a roughly 1,500-line
component into an 800-line module, and extracting arbitrary hook groups would introduce a
large argument surface. Handle render-plan ownership in
[1158](https://github.com/michaeljosiah/ArkeStudio/issues/1158), then reassess the remaining
component using the resulting dependencies. Preserve optimistic timeline state and command
acknowledgement order throughout.

**Library:** ArtifactPanel has its own search/filter state, foreign-world browsing subscriptions
and locate bookkeeping, while Cut owns pending imports and the mutation callbacks.
AddToLibraryDialog already has an independent component boundary; moving its roughly 120
lines now offers little benefit. First resolve
[1157](https://github.com/michaeljosiah/ArkeStudio/issues/1157), including which state survives
closing and reopening the library. Retiring the separate legacy ClipLanes path remains
[1159](https://github.com/michaeljosiah/ArkeStudio/issues/1159).

**Story:** retain the shared creation hooks/contexts, overview, chapter tree and manuscript
sheets. The export/import sheets are plausible future moves because they already receive
props, but their caller controls opening and request presentation. Extract them when manuscript
work needs it, retaining that ownership and the existing direct-save/accepted-draft distinction.
No context extraction or new manuscript service is needed for this assessment.

## Delivery and verification

Implement the selected moves in this order when scheduling the follow-up:

1. Relocate the existing shared helpers and episode picker; repoint all consumers to remove
   the cycles identified above. Avoid a permanent re-export barrel.
2. Move TakesView/TakeTileMedia and the voice dialog, retaining parent-child boundaries.
3. Move the dashboard group, retaining layout providers and route structure.

Each commit should be readable as unchanged declarations at a new path, plus necessary
imports/exports. Preserve effect dependencies, hook order, component keys, subscription
cleanup and callback contracts. Update the code map when the moves actually land; this
assessment does not change the current ownership map.

For implementation, use existing client tests: `takes-view`, `scene-workspace`,
`production-wardrobe`, `voice-line`, `voice-line-result`, `remote-voice-upload`,
`development`, `story-dashboard`, `chapter-tree`, `manuscript`, `audiobook-door` and `routes`
(all under `packages/client/test/`, with the `.test.tsx` suffix). Tests should need import changes only.
Run the repository lint, typecheck, build and test gates from the
[testing guide](testing.md). Check browser routes for Generate, stills, voice, production
home and episode navigation; exercise switching a production with a pending operation.

This assessment changes documentation only. Validation is source inventory, dependency
inspection and local link checks; it makes no new application-test or performance claim.

# Audio Studio implementation

The approved [turn 226](../../design-system/Arke%20Studio.dc.html#t226) is the target design.
This first slice implements its chapter entry and editor shell, under SPEC-047 R-185.

From the Audiobook page menu, Audio Studio opens the listening chapter (or the first chapter).
The chapter's third view is now Audio Studio. Old Timing links and remembered Timing views
resolve to the same editor; other query parameters, including selected passages, are retained.
Opening this view neither generates audio nor writes an arrangement.

The studio uses the existing production rail and Cut layout, with Library on the left,
script above the chapter timeline, and shared Inspector / Arke tabs on the right. It reuses
the editor's compact layout and sheets. The manuscript remains mounted while hidden so a
pending draft and its autosave survive a view change.

The script and Library select existing chapter blocks. Library lists current chosen takes,
beds and sounds; unread passages stay visible in the script and timeline. Inspector edits
use existing acknowledged timing, reaction, bed and sound commands. Arke retains the existing
production conversation and timing proposal card. An unaccepted proposal disables timing and
sound edits, playback and export; the user can still stop a pending or playing mix.

Playback uses the existing chapter mixer and its mapping between estimated script time and
made-audio time. Export opens the existing chapter export sheet. This slice does not change
mix fidelity, source resolution, publication semantics or the video editor's frame clock.

## Arrangement and rendering foundation

The coordinator now exposes read, source preparation and revision-checked edit commands for
the next editor slice. A chapter can own a versioned 48 kHz stereo arrangement with exact
source hashes, conservative passage bindings and twenty durable undo steps. Opening a legacy
chapter derives its arrangement without writing. Its first edit saves the arrangement and
legacy recovery record together; schema floor 83 prevents older builds discarding it.

The native renderer preserves stereo channels and streams the chapter through a single master
gain. The pure sample plan owns placement, fades, loops and speech ducking. Source changes
produce named draft repairs and block final rendering. Saved arrangements feed chapter mixing,
Listen, web-player export and video export; exact-source word timings follow their clip windows.
The editor controls and private publication capture are still being connected. Existing UI
controls remain the initial shell above and cannot write legacy timing after migration.

Focused tests are `packages/contracts/test/audio-arrangement.test.ts` and coordinator
`test/productions/audio-studio.test.ts` / `audio-studio-mix.test.ts`. They cover stale edits,
atomic migration, durable undo, source replacement, stereo preservation and exact sample clocks.

## Remaining slices

1. Route the existing chapter timing controls through the new arrangement once migrated.
2. Connect shared editor gestures to that authority: free clip placement, trims, fixed-time
   and passage-linked cues, track controls, import, and persisted Undo/Redo.
3. Add Current/Suggested replacement review for longer takes, stale-base guards, and explicit
   downstream cue decisions. The existing timing proposal card is not this new review model.
4. Use one arrangement plan for preview, listening and export, including stereo fidelity,
   music loops, tails, mastering and publication readiness.

SPEC-047 R-186–R-190 records these target requirements. They are not implemented by this slice.

## Validation

From `packages/client`:

```text
node --import tsx --test test/chapter-timing.test.tsx test/chapter-workspace.test.tsx test/chapter-audiobook.test.tsx test/audiobook-door.test.tsx test/audiobook-show.test.tsx test/cut-layout.test.tsx
```

Coverage includes route aliases and remembered views, no authoring on opening, shared
selection, retained Inspector drafts, playback/review gating, book entry and compact panel
navigation. Run the repository lint, typecheck, build and tests for the complete gate.
Inspect the actual application at desktop, Fold and phone sizes; design fixture checks alone
do not verify application layout or real audio playback.

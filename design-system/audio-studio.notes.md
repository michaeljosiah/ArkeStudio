# Audio Studio design turn 226

Status: **Revision 2 · Approved for implementation**, 15 October 2026. The author approved this design and requested its commit and implementation. The design fixture itself does not change application behaviour. Revision 2 replaces the original alternative shell with the existing Cut editor layout.

Open the [interactive comparison](audio-studio.review.html). Switch between Existing video editor and Audio Studio to compare the same shell. Try script selection, cue attachment and a longer replacement take. The reuse table below distinguishes existing foundations from adaptations and new work.

The [design master](Arke%20Studio.dc.html#t226) holds ten HTML frames, **226a–226j**, and seventeen proposed rules. The [review index](design-review.html#226a) includes the same drawings with their review status. Frames cover the existing video reference, script preview, linked and fixed cues, replacement review, Apply/Undo, phone Details sheet, Fold, phone timeline and Arke.

## Recommendation

Make **Audio Studio** the advanced arrangement view of a story's audiobook. Keep writing, casting and directing in their existing places. Bring their chosen performances into a chapter workspace where the author can arrange voices, sound effects, ambience and music together.

Evolve the chapter's existing **Timing** view into Audio Studio. The Audiobook page remains the book-level destination for voices, chapter readiness, Listen and Publish. Add **Open Audio Studio** there and **Audio Studio** beside Manuscript and Audiobook inside a chapter. This keeps one story, one cast and one set of source takes. Opening the studio never generates audio or creates a second production.

Use the video editor's interaction vocabulary and extract useful shared controls. Keep an explicit audio arrangement adapter: the current video timeline is frame-based, while story timing follows passages and narration. Sharing those differences through a hidden Picture track or a second independently editable timeline would create avoidable drift.

## Where it fits

| Existing place | Proposed connection |
| --- | --- |
| Story production → Chapters | Open a chapter and choose Manuscript, Audiobook or Audio Studio. |
| Chapter → Audiobook | Assign speakers, direct or record performances, review takes, then open Audio Studio at the selected passage. |
| Production → Audiobook | Open Audio Studio at the last visited chapter, or a selected chapter; a fresh visit with no selection starts at the first chapter. |
| Audio Studio → Script | Select a passage to locate its clips; Edit text returns to that passage in Manuscript with the return context retained. |
| Audio Studio → Listen | Play the current committed chapter arrangement through the existing listener, retaining pictures and captions on the resolved audio clock. |
| Audio Studio → Export or Publish | Export defaults to this chapter. Publish remains the book's existing edition workflow and states the included chapters and arrangement revision. |

Old `view=timing` addresses should resolve to Audio Studio at the same chapter and selection. The proposed chapter view key is `view=audio-studio`; route admission, production rail highlighting and navigation fixtures must be updated together. Do not add another permanent production rail item in the first release.

## The chapter workspace

The desktop layout reuses the actual source-backed Cut drawing from turns 220–223 through `air-particles-220.native.mjs` and its styles. Preserve the centred Arke Studio wordmark, titlebar, folded production rail, Library at left, preview and timeline in the centre, and Inspector / Arke at right. The script occupies the video preview slot. There is no new logo or separate Script sidebar. The titlebar Chat entry follows turn 225; story destinations and their speaker/book marks follow the existing production shell.

Keep Media / Effects / Transitions, search and filters in Library. Keep Import media, selection/split/hand tools, Loop, Undo/Redo and zoom in their existing positions. Listen from top occupies Watch from top's position; Export audio occupies Export film's position. Passage attachment extends Placement below Start / End / Move to. Take replacement uses Source and the existing Current / Suggested review bar. Audio, Fades and Protection remain scrolling Inspector sections.

The header names the book and chapter and offers chapter switching, Listen and Export. The transport offers play, pause, seek, loop selection, zoom and a seconds/milliseconds ruler. A chapter is the editing unit; the book view joins committed chapters and shows their readiness. Cross-chapter beds and transitions are a later feature.

| Area | Behaviour |
| --- | --- |
| Script | The prose in order, with speaker and take status. Selecting a passage highlights every segment of its performance. Selecting a segment reveals its passage. Audio-only reactions have their own labels. |
| Library | Existing chosen takes, alternative takes, imported recordings, Music, Ambience and SFX. Import files into the world before placing them. Generation uses existing quotes, Activity and explicit take selection. |
| Timeline | Narrator and named-character tracks appear when needed; add ordinary audio tracks for effects, music or overlapping material. Track names organise the mix; a clip's role determines speech ducking and export stems. |
| Inspector | Source, speaker/role, passage attachment, placement, source trim, level, fades and looping. Stereo pan appears only once the renderer supports it. Typed controls accompany drag handles. |
| Arke | Uses the existing production conversation with chapter, passage, clip selection and arrangement revision as context. Suggestions arrive as reviewable changes. |

The first release supports moving, trimming, splitting, duplicating and removing clips; adjustable gaps and overlaps; fades and audio crossfades; clip and track levels; mute/solo; looping beds and automatic music ducking. Audio crossfades require their own overlap rules; the existing still-image crossfade implementation is not an audio mixer.

A split retains its source take and passage identity. Duplicate speech is visibly marked as repeated. Removing a performance from the arrangement leaves the manuscript and original take intact and creates an explicit omitted-passage state. A reviewer must acknowledge omissions before publication. A grouped multi-speaker recording stays one recording unless real boundaries permit non-destructive cuts; the UI must not imply that mixed voices can be independently moved or regenerated.

Fold keeps the existing compact editor: script in the preview slot, adjacent Inspector, shared transport, timeline and compact Arke rail. Phone keeps the chapter header, script preview, transport, timeline and Library / Inspect / Arke toolbar. Inspection opens the existing scrolling Details sheet with a fixed Done footer. Library uses the existing drawer. Horizontal zoom/scroll and numerical placement provide precision; do not introduce a separate stacked clip-list page. Touch targets, keyboard selection and focus return follow existing client conventions.

## Placement that survives revisions

Each clip has a source window and a placement rule. The ruler shows the resulting time, while the Inspector explains why it is there.

| Rule | Meaning | Example |
| --- | --- | --- |
| Follow passage | Attach to a passage start or end plus an offset. | A door closes at the end of Mara's line. |
| Follow range | Span two passage boundaries, with explicit loop and tail policy. | Harbour ambience lasts from arrival through departure. |
| Fixed time | Stay at an absolute chapter time until moved. | A musical accent stays at 00:12.000. |

The ordinary reading runs in manuscript order. A speech offset changes the interval from its predecessor, allowing an interruption. Deliberately moving speech away from that run changes its placement mode and is visible in the Inspector. Dragging a linked effect adjusts its offset; **Fix at this time** explicitly detaches it. Dragging onto another passage offers **Attach here**. Fixed clips never silently ripple. Moving a linked speech block to a new speaker track does not change the recorded voice: recasting is a separate, quoted generation action.

For the first release, anchors attach to passage boundaries. Word-level attachment follows when verified alignment exists for the exact selected audio and text. Estimated word timing must not masquerade as a stable cue. New durable passage identities are needed for advanced arrangements: today's paragraph keys and text hashes are useful migration evidence, but repeated text, splits and joins can be ambiguous. Preserve unresolved links for repair rather than guessing from matching words.

### Replacing a take

Selecting a replacement opens **Current / Suggested** with the affected region on one clock. Show the duration change, moving linked cues, stationary fixed cues, trims needing review and any overlap conflicts. The fixture changes Mara's take from five to seven seconds: the following exchange and the door cue move two seconds later; the background bed grows to the new chapter end. Choosing Fixed time keeps the door at twelve seconds.

A generated candidate never replaces the source underneath an arrangement automatically. Apply binds the exact reviewed take and changes its dependent placements in one undoable transaction. Discard retains Current. A changed manuscript, arrangement or source after preparation requires a fresh review before Apply. Missing media remains a labelled clip with a repair action.

Source trims are tied to the exact artifact. A replacement does not inherit old trim points blindly. Offer the full new take and flag the prior trim for review; preserve levels and attachment intent where valid. Deleted or ambiguous anchors stay unresolved, are excluded from confirmed playback and block publication until repaired or explicitly omitted. Draft listening may skip them only with a visible incomplete state.

## One arrangement and one audible result

Keep the chapter audiobook record as the source of selected performance takes and reading direction. Add a versioned arrangement section to that chapter record, with stable clip/track identities, source fingerprints, placement rules, mix settings and retained revision history. Exact field names require the implementation design; the important boundary is one authoritative arrangement per chapter.

When a legacy chapter is opened, derive an in-memory arrangement from its takes, timing, reactions, beds and sounds. Opening is read-only. The first accepted arrangement edit commits the migration and edit atomically, retaining the prior representation for recovery. Once migrated, both simple timing controls and Audio Studio issue commands against the arrangement; legacy timing fields cease to be a second write target. Unsupported or unresolved records produce a recoverable state, never an empty successful migration. Older app versions must refuse to edit the newer schema. Undo reverses authored changes without restoring an older schema version.

Use integer sample positions at a declared project sample rate for source windows and resolved arrangement time; display seconds and milliseconds. The existing video timeline keeps its frame contract. A clock adapter converts pointer/time coordinates and presentation, while exact sample arithmetic stays in contracts. Source sample rates are measured and resampled explicitly. Choose 48 kHz stereo for new advanced arrangements, preserving existing mono chapter rendering until migration is deliberately committed. This is a proposed engineering choice, not a claim about current capability.

One pure resolved audio plan must feed preview, cached chapter mixes, Listen, captions, video-with-story-audio and publication. Plan identity includes the arrangement revision, source hashes, renderer version and delivery settings. Preview gain curves and final rendering must share their calculation. Final loudness treatment belongs after summing the complete mix; do not normalise every clip independently or apply mastering twice.

The existing chapter mixer explicitly decodes to 24 kHz mono. Stereo preservation, panning and sample-accurate interactive playback therefore need renderer work before advanced stereo export can be advertised. The first implementation spike must demonstrate these, plus preview/export parity, using real media. The existing video browser player is a useful lifecycle reference, but its media-element drift tolerance is unsuitable as a claim of sample-accurate dialogue editing.

## Reusing the video editor

| Foundation in the checkout | Proposed reuse | Work still required |
| --- | --- | --- |
| `client/screens/editor-transport.tsx`, `lib/playback-engine.ts` | Transport conventions, seek, playhead, loop and keyboard behaviour. | Extract clock-neutral controls; introduce an audio scheduler without video-frame rounding. |
| `client/screens/editor-timeline.tsx`, `lib/timeline-drag.ts` | Lane layout, selection, gestures, zoom and edit affordances. | Separate picture/shot assumptions from reusable geometry; audio waveforms, sample windows and anchors remain explicit. |
| `client/screens/editor-library.tsx`; coordinator `productions/editor-import.ts` | Shelf browsing, import progress, world filing, measured media and revision-fenced placement. | Audio Studio destination carrying chapter and arrangement revision; audio filters and passage-aware placement. |
| `contracts/timeline.ts`; coordinator `productions/timeline.ts` | Validated command batches, authoritative acknowledgement and bounded undo/redo patterns. | Audio arrangement reducer and history in the chapter record. Do not send frame commands directly into passage timing. |
| `contracts/audiobook-timing.ts`; coordinator `productions/audiobook-timing.ts` and `audiobook-mix.ts` | Existing chapter clock, reactions, bed fades, speech ducking and mix caching. | Lossless migration, general clip placement, stereo mix plan and incremental preview. |
| `client/lib/plan-audio.ts`; contracts `render-plan.ts` | Audio source resolution and shared gain-plan concepts. | Reconcile video and audiobook plan semantics deliberately; no two independent soundtrack players. |
| `client/screens/chapter-timing.tsx`, `chapter-workspace.tsx` | Current chapter selection, Timing entry, take context and refusal UI. | Evolve this route into the studio; keep existing source/readiness ownership. |
| Production conversation and editor review workflows | Current/Suggested, stale-base checks, explicit Apply and one Undo. | Chapter arrangement proposal subject, readable diff and affected-cue preview. |
| `components/story-publish.tsx`; coordinator `publications/story.ts` | Existing edition capture, readiness and delivery lifecycle. | Capture the exact committed arrangement and mix; preserve explicit chapter scope. |

Paths in this table are relative to `packages/`. These are reuse candidates grounded in the current source, not already extracted reusable APIs. Start with the smallest shared control needed by both editors; retain separate screen composition and domain reducers. The video editor should gain shared audio controls over time without inheriting chapter semantics.

## Delivery sequence

1. **Prove the shared boundary.** Render one legacy chapter identically through the arrangement adapter. Demonstrate a real stereo fixture, precise overlap, seek/loop behaviour and the same gain envelope in preview and export. Validate safe passage identity and revision handling before broad UI extraction.
2. **Ship a complete chapter studio.** Include existing take assembly, import, narrator/cast tracks, passage/range/fixed placement, trim/split, overlaps and crossfades, music/SFX/ambience, levels, ducking, mute/solo, replacement review, durable undo and chapter export. Include migration and repair states. A generated-only workflow is insufficient; recorded and imported sources are part of this slice.
3. **Integrate book delivery and assistance.** Make the same arrangements available to Listen, captions, existing player/video exports and Publish before general release. Add Arke arrangement proposals and whole-book readiness review. Generation continues to use existing services and quotes.
4. **Extend production depth.** Add editable gain automation, pan automation, stems, verified word anchors, cross-chapter transitions and optional room effects. Defer plugin hosting, MIDI, musical scoring, surround and destructive waveform repair.

Slices 2 and 3 form the initial release boundary; a studio that exports a different mix from Listen or Publish is not ready. No delivery dates are implied.

## Acceptance scenarios

- An existing chapter opens without a disk write. Its first migration preserves the audible arrangement and survives close/reopen. Mixed migrated/unmigrated books play and publish in order.
- A cast exchange overlaps by 250 ms, a bed ducks under both voices, and a sound follows the end of a line. Preview, Listen and export preserve those positions within one project sample in the resolved plans; real playback receives separate latency/drift testing.
- A longer replacement moves linked material, retains fixed cues, invalidates old trims visibly and changes nothing until Apply. Apply is one history entry; Undo survives reopening.
- Paragraph insertion, repeated text, split/join, deletion, recasting and a grouped multi-speaker take all preserve identity or expose a repair state without guessed remapping.
- A stale import leaves successfully filed media available in Library and refuses obsolete placement. Reconnect, ownership loss, interrupted migration and missing media cannot produce an acknowledged partial arrangement.
- Manual edits and Arke suggestions use the same validation. A changed base cannot apply; Keep Current decisions survive proposal revisions.
- Stereo source channels survive, a music loop has an intentional seam, audible tails remain in duration, overlapping voices do not clip, and chapter mastering is applied once. Preview mute/solo are audition state; a persisted track mute is explicitly labelled and included in export readiness.
- This chapter exports only the named chapter. Book publication shows unresolved cues and acknowledged omissions and binds exact sources, mix settings and revision.
- Mouse, keyboard and touch can select clips and adjust timing without drag. At 320 px and 200% text zoom, controls remain reachable. Video editor gesture, import, transport and history regressions stay green after extraction.

## Design decisions and specification impact

The recommended decisions are: evolve Timing into Audio Studio; keep Audiobook as the production entry; edit per chapter; use passage-linked placement by default with an explicit fixed-time mode; preserve one arrangement authority; and share editor mechanics through an audio adapter.

SPEC-047 is marked proposed with built slices and later amendments. R-21 and D5 explicitly exclude a free timeline; R-80–R-89 describe the existing block timing/mix direction. This proposal deliberately changes that boundary, including the mono mix choice in R-85. SPEC-043 is accepted and supplies the independent video editing/import and track-role rules; reusing mechanics must preserve those rules. Publication integration must also be reconciled with SPEC-048. No new spec number is reserved here.

The approved design is committed as `087cfcdf5`. Implementation begins with the existing chapter timing authority inside the shared editor shell; [implementation scope](../docs/development/audio-studio.md) separates this first slice from the advanced arrangement work. The initial sandbox check could not inspect the private repository's Git metadata; a subsequent permitted check confirmed it is a clean Git repository. Live SPEC-047 R-185–R-190 and SPEC-043 are amended alongside implementation for the first slice and the remaining arrangement, migration, clock, review and delivery requirements. Prior design turns and their approval states remain unchanged.

## Review coverage

The review is a standalone fixture composed from the existing Cut drawing and shared tokens. It supports video/audio comparison, script and clip selection, Library search, Inspector / Arke, door attachment, level changes, longer-take comparison, Apply, Undo/Redo, zoom, loop and a silent transport. Import/export dialogs demonstrate placement only. Audio playback, gesture editing, media generation, filesystem persistence, exports and live application commands are not implemented. All story content and timing are illustrative.

Revision 2 is checked at the existing master drawing sizes: desktop 1360 × 900, Fold 984 × 900 and phone 390 × 844. Review checks cover the shared shell, selection, linked/fixed cue behaviour, Current/Suggested, Apply, Undo/Redo, compact Details and registration in the design master. Screenshots are inspected for desktop and compact layout. These checks validate the design fixture, not the application's audio pipeline.

Source references: [chapter timing contracts](../packages/contracts/src/audiobook-timing.ts), [chapter mixer](../packages/coordinator/src/productions/audiobook-mix.ts), [video timeline contracts](../packages/contracts/src/timeline.ts), [chapter workspace](../packages/client/src/screens/chapter-workspace.tsx), [production navigation](../packages/client/src/screens/production-shell.tsx), [module boundary guidance](../docs/development/production-module-boundaries.md), and [approved story entry design](story-journey-209.notes.md).

## Regeneration and preview

`audio-studio-226.mjs` captures HTML from the interactive fixture, preserving form values, using unique frame IDs and scoped styles. It updates only turn 226 and its review registrations. It requires an installed Playwright package; set `PLAYWRIGHT_MODULE` to its package directory when it is outside the repository. Set `CHROME` to a browser executable when needed; Windows otherwise uses installed Edge. The capture contains HTML and synthetic waveform bars, not screenshots.

```text
node design-system/audio-studio-226.mjs
node design-system/check-master.mjs --record
node design-system/build-review.mjs
node design-system/check-master.mjs --render
node design-system/build-review.mjs --check
```

To preview independently of a chat command session:

```text
node design-system/audio-studio-226.serve.mjs 8795
```

Keep that process running, then open `http://127.0.0.1:8795/design-system/Arke%20Studio.dc.html#t226` or the focused `audio-studio.review.html` on the same server. The server binds loopback and serves design assets and the referenced public client styles. On Windows, a hidden background launch can keep it available after the terminal command ends. This session uses that background launch; the preview is local and lasts until its process is stopped or the computer restarts.

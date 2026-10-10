# Turn 208 — audiobook motion and highlighted captions

**Approved by the owner on 2026-10-10 with turns 206–209. Implementation for #1672 is in progress in PR 1687.** The review page is an HTML copy of turn 208 in the design master, using the same tokens and existing public artwork. No private chapter text or images are included.

Open [the focused HTML review](audiobook-motion-208.review.html), or [the master](Arke%20Studio.dc.html#t208). The owner approved the complete turn before implementation. Extra UI surfaces still require a design approval.

## Approved scope

- **Motion:** one Animate action on an existing still, an editable motion prompt and a supported first-frame model, explicit resolution/time/price, a muted candidate review, and Use clip. Repeat is the approved default; Hold last frame is the alternative. Use still reverses the choice. The clip lasts on the picture's existing clock until the next picture, which can span several blocks.
- **Captions:** Phrases remains the default. Highlight current word appears only for burned-in captions, preserves short two-line cues and plain sidecars, and waits for validated timing. Preparation operates on the saved reading, with stale/unmatched block review and an explicit phrase-caption escape. No approximate timing is silently presented as word-accurate.

Review decisions are therefore bounded: the Animate entry and choice flow; Repeat versus Hold as the default; the retained source still; the new caption style and timing readiness states. Implementation may need a further design if evaluation shows an extra alignment setup or correction surface is needed.

## Findings that change the issue's assumptions

| Issue assumption | Current source | Consequence |
|---|---|---|
| `AudiobookPicture.file` can simply point at MP4 | `packages/contracts/src/audiobook-pictures.ts` is a strict still-oriented record; consumers validate images. `packages/contracts/src/audiobook-listening.ts` carries only a file, hold and focus. | Preserve `file` as the source still and add explicit optional motion with its own media identity. This is a proposed representation, not a schema amendment shipped in this PR. Old readers reject unknown strict fields, so first-write world-version handling is necessary. |
| A clip lasts for the block | `pictureHolds` continues until the next picture or chapter end; sparse illustrated blocks cover later unpictured blocks. | Use the same visual hold in player, package and MP4. Repeat or last-frame hold fills that duration; generation remains a short supported clip. |
| `timedWords` contains alignment timings | `packages/contracts/src/audiobook-video.ts:timedWords` distributes a sentence's time by character length. `blockSentences` also apportions grouped takes by text length. | This is estimated timing, unsuitable as evidence for a precise current-word highlight. |
| Grouped-read alignment already yields measured word times | `packages/coordinator/src/voice/word-times.ts:timeWords` finds speech stretches from pauses, transcribes each stretch, and spreads its words by length. `audiobook-run.ts:readGroup` keeps group cut offsets/durations but does not retain the word sequence. | Even retaining today's splitter output would not supply acoustic word boundaries. Caption implementation needs a validated aligner or provider word timestamps, authored-text mapping, confidence and explicit failure behavior. |
| Word highlighting is rendering only | Listening schemas currently expose sentences, not measured words. Timing/mix edits can trim or overlap blocks. Existing captions use `drawtext`; exported SRT/VTT remain plain. | Persist timings tied to exact take/audio/text, map them through the shared mix clock, define the caption lane for overlaps/reactions, and use the same cue plan in preview and render. ASS is one candidate implementation, not a confirmed bundled capability. No cumulative karaoke sweep is intended. |
| A model's `accepts.startFrame` tells whether to offer it | H3 deliberately has `accepts.startFrame: false` and a `first-frame` mode. `frameDispatchFor(model, 1)` is the shared query. H3's 480p route offers 4/5/6/7/8/10/15 seconds and always generates sound. The 768p row does not advertise the same first-frame route. | Offer capabilities dynamically through the existing manifest/route query. Mute all clip sound. The chosen frame and selected model determine supported shape/length/resolution; refuse an unavailable route before spend. |
| A 480p clip becomes 1080p through the export choice | Export fits media to an output frame; the separate SeedVR2 recipe is another operation. | Say “scaled to fill” and identify low-resolution clips. Do not promise more detail, run an upscale, download weights or add a purchase automatically. |

These conclusions are from current `origin/main` (`9caa8ad0`) and live SPEC-047 R-66–R-74, R-132–R-145 and R-147–R-152, plus master turns 194, 197 and 198. Spec requirements are not inferred from the issue's description. Turn 197 itself already states that saved takes keep no word times.

## Implementation slices

1. **Motion data and playback.** Add source-preserving media identity, compatibility/version guards, shared hold/seek behavior and thumbnail handling. Cover in-app playback, the packaged player and video export together. Missing media is visible; export refuses until the author chooses the still or restores the clip.
2. **Animate and review.** Reuse the queue, quote, first-frame dispatch, Library filing and explicit acceptance. Generation never attaches on completion. Bind results to the exact block/source; a late candidate cannot replace a changed picture. Keep source look/shot/focus and joins/splits behavior. Update render cache identity for motion and end behavior.
3. **Timing capability evaluation.** Evaluate real acoustic word boundaries on saved narration, including names, Pidgin, pauses, single-block reads and grouped takes. Establish a usable quality threshold and source binding. This is a separate prerequisite, not covered by a visual screenshot check. No GPU experiment, model download or provider spend was made for this turn.
4. **Caption style.** Persist verified timing where supported, prepare old takes on request, then map timings to the mix and render the highlighted word. Add preview parity, silence/no-highlight behavior, stale/uncertain states and cache invalidation. Sidecars remain plain. If the aligner is unavailable, Phrases continues and the highlight action says why it is unavailable.

Motion can ship independently of captions. Arbitrary imported video assignment, a motion timeline, bespoke upscaling controls and caption font/colour customization are outside this turn.

## Design validation

- `node design-system/check-master.mjs --record` and the static master check: pass; the pre-existing t195 warning remains unrelated.
- Focused HTML rendered in a dedicated headless Chromium instance, never the installed app or its CDP connection. All nine frames loaded their images and Geist font; no horizontal element overflow. The 390 px sheets use 44 px actions and an independently scrolling body above a persistent footer.
- Review screenshots are local artifacts; clip frames are deliberately static poster drawings, not a claim that generated video or accurate alignment was tested.
- No application tests or builds are appropriate to a design-only change. Actual focus trapping, keyboard behavior, playback synchronization, format compatibility and rendering correctness must be tested during an approved implementation.

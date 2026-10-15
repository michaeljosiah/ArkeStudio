# Audio Studio implementation

The approved [turn 226](../../design-system/Arke%20Studio.dc.html#t226) is the target design.
SPEC-047 R-185–R-194 defines the implementation contract; PR #1780 is still in progress.

## Chapter workspace

Audiobook opens Audio Studio for the listening chapter, or the first chapter. The chapter's
third view uses `view=audio-studio`; old Timing links retain the chapter and selected passage.
The existing production rail, wordmark, Cut layout, Inspector / Arke tabs and compact sheets
surround the script in the preview slot. The manuscript remains mounted while hidden so its
pending draft and autosave survive view changes.

`audio-studio-workspace.tsx` connects authoritative snapshots to the Library, timeline,
Inspector and repair controls. The timeline reuses video tool icons and `startClipGesture`,
with an adapter measuring audio samples rather than video frames. Typed fields provide
placement and source-window edits without dragging. Clip roles are independent of track names.
Cues added beside a selected passage retain that passage anchor and their playhead offset.
Crossfade overlaps consecutive clips without changing their source windows or attachment modes.
Looped beds retain sample phase across splits, including passage ranges. Source waveforms use
bounded stereo peak data from the exact pinned decode, loaded sequentially for visible clips.
Track mute is persisted and labelled “in mix”; solo is transient audition state. Muted passage
performances require explicit omission acknowledgement before final delivery.

Library imports use the existing desktop/browser filing pipeline. Filing precedes placement:
a stale chapter base leaves imported media available in Library and refuses the obsolete edit.
Sources are prepared against current catalogue scope, exact bytes and recording clearance.
Source replacement opens Current/Suggested with timing differences and trim-reset disclosure.
Apply commits one command batch; Keep Current writes no arrangement. The comparison names
fixed cues and track/master/omission changes and can display either version on the timeline.
The Audiobook Timing tab uses the same Inspector and commands after migration. Old timing
messages remain refused rather than creating a second writable authority.

## Persistence and rendering

The chapter record owns a versioned 48 kHz stereo arrangement with integer sample positions,
source hashes, conservative passage bindings and twenty durable undo steps. Opening a legacy
chapter derives the arrangement without writing. Its first edit atomically includes migration,
legacy recovery data and the command; schema floor 83 fences older builds. Stale bases,
unreadable records and ownership loss refuse writes.

The renderer streams the summed stereo mix through one master gain. The shared sample plan
owns placement, source windows, fades, looping seams, pan and speech ducking. Missing sources,
unresolved passages and unacknowledged omissions remain named draft issues and block final
rendering. Reused mix caches are verified against their digest; source bytes are checked even
when a rendered cache exists. Audition uses the single existing audio player with a physically
cropped sample-aligned excerpt, including looping, and request-scoped render cancellation.

Saved arrangements feed Listen, web-player and story video exports. Exact-source acoustic
word timings are transformed through their source windows; unsupported overlaps remain
explicitly unavailable for word captions. Private publication captures the exact arrangement,
revision, source bytes and compiler identity. Retry renders those frozen inputs. Mixed books
convert legacy mono chapters to the arranged book's 48 kHz stereo format without remastering
the arranged chapters. Create still revalidates the source against the preview.

## Arke review

The production conversation carries chapter, passage, clip, track and arrangement revision/base
context. `get_chapter` with `section: "audio-studio"` provides paged exact sources, tracks, clips,
passages and prior decisions. `production-audio-studio-propose` requires that complete read and
stages a bounded versioned command batch in the chapter record. Generic chat approval cannot
apply it. Audio Studio compares Current/Suggested and applies the exact latest version through
the same revision-fenced reducer, atomically recording the decision with one Undo entry.

Keep Current closes the proposal family durably; later revisions cannot reopen it. Undo of an
applied arrangement does not reopen its proposal either. Arke cannot release clip protection,
acknowledge omissions or declare a passage restored. Those decisions remain explicit editor
controls. Staging and declining do not migrate or change audio, and do not invalidate the audio
base. Proposal metadata is kept outside the arrangement undo history.

## Work remaining before release

Full browser interaction and real playback acceptance, video regressions and the final
cross-platform code gate are still being completed for PR #1780. Editable automation lanes,
stems and word-level attachment remain later design scope.

## Validation

Contracts: `test/audio-arrangement.test.ts` covers sample placement, conservative binding,
replacement ripple, fixed cues, protection, durable history and explicit omissions.
Coordinator: `test/productions/audio-studio.test.ts`, `audio-studio-mix.test.ts` and
`test/publications/story.test.ts` cover persistence, stale imports, source changes, stereo,
sample-aligned windows, phase-preserving loop splits, frozen retry and parity between Listen
and publication PCM. `test/world-chat/audio-studio-proposals.test.ts` verifies section-scoped
read receipts and the human-only apply boundary; `test/audio/waveform.test.ts` verifies stereo
peaks and transient retention.
Set `ARKE_STORY_CODEC_SMOKE=1` for real FFmpeg AAC publication with mixed arranged/legacy chapters.

From `packages/client`, run the edit preparation, player ownership and entry tests:

```text
node --import tsx --test test/audio-studio-edit.test.ts test/audio.test.ts test/chapter-timing.test.tsx
```

Run the broader chapter, Audiobook and Cut suites, then the repository lint, typecheck, build
and test gates. Inspect the actual React screen at desktop, Fold, phone, 320 px and enlarged
text; design fixture checks alone do not verify application layout.

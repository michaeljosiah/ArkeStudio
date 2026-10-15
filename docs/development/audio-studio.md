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
Track mute is persisted and labelled “in mix”; solo is transient audition state. Muted passage
performances require explicit omission acknowledgement before final delivery.

Library imports use the existing desktop/browser filing pipeline. Filing precedes placement:
a stale chapter base leaves imported media available in Library and refuses the obsolete edit.
Sources are prepared against current catalogue scope, exact bytes and recording clearance.
Source replacement opens Current/Suggested with timing differences and trim-reset disclosure.
Apply commits one command batch; Keep Current writes no arrangement.

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

## Work remaining before release

Legacy timing controls must route through the saved arrangement after migration; their current
guard prevents a second writable authority. Arke arrangement proposals, persistent review
decisions and selection context are still being integrated. Remaining acceptance work includes
repair edge cases, waveform presentation, crossfades, complete browser interactions, video
regressions and the final cross-platform code gate. These are release requirements, not deferred
features. Editable automation lanes, stems and word-level attachment remain later design scope.

## Validation

Contracts: `test/audio-arrangement.test.ts` covers sample placement, conservative binding,
replacement ripple, fixed cues, protection, durable history and explicit omissions.
Coordinator: `test/productions/audio-studio.test.ts`, `audio-studio-mix.test.ts` and
`test/publications/story.test.ts` cover persistence, stale imports, source changes, stereo,
sample-aligned windows, frozen retry and parity between Listen and publication PCM.
Set `ARKE_STORY_CODEC_SMOKE=1` for real FFmpeg AAC publication with mixed arranged/legacy chapters.

From `packages/client`, run the edit preparation, player ownership and entry tests:

```text
node --import tsx --test test/audio-studio-edit.test.ts test/audio.test.ts test/chapter-timing.test.tsx
```

Run the broader chapter, Audiobook and Cut suites, then the repository lint, typecheck, build
and test gates. Inspect the actual React screen at desktop, Fold, phone, 320 px and enlarged
text; design fixture checks alone do not verify application layout.

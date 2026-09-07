# Local H3 reference video

`comfyui-h3-reference-video` is **Local · H3 Reference Video**, a separate recipe from the
FL2VA text/first-frame recipes. Its `ref2va` checkpoint conditions on images, motion clips and
audio; it does not pin the first image to frame zero. Select it explicitly in the video model
picker. The existing automatic local-video preference order is unchanged.

## Setup and declared limits

Use ComfyUI 0.33.1 or later and the recipe's pinned weights. Settings derives the download and
readiness entry from the recipe catalogue. The encoder and both VAEs are shared with FL2VA;
only the reference checkpoint and its four-step LoRA are additional files. A matching existing
file is reused. No custom node installation is needed.

The first recipe exposes five-second, 480p output in landscape or portrait, with generated
stereo sound. It accepts up to nine images, three video clips and three standalone audio clips.
The authored limits are deliberately narrower than the upstream model's maximum: videos are
2–5 seconds each, audio at most five seconds each, and each kind has a fifteen-second aggregate
budget. Character voice samples share the three standalone audio slots. Per-file duration admits
0.2 seconds of frame/container rounding, including H3's 5.167-second output for a requested
five-second take. The aggregate budget still applies. Audio files are WAV or
MP3 and at most 15 MB each. Video input currently inherits the world reader's 48 MiB aggregate
byte ceiling. Longer and 768p output require separate measured recipe presets.

FFmpeg and ffprobe must be configured for multimedia references. Audio/video reference upload
is currently local-engine-only; selecting a remote ComfyUI URL does not authorize transferring
locally reviewed recordings. Images can use the existing remote-engine path.

## Reference meaning and ordering

The bench preserves the author's stable `@Image N`, `@Video N`, and `@Audio N` tokens. It resolves
them to dense transmitted order and renders H3's `<Picture N>`, `<Video N>`, and `<Audio N>`
syntax. Production prompt assembly uses the same translation. Voice guidance appears after
standalone audio and video soundtrack slots, so adding a motion clip cannot silently change
which voice an audio tag names.

Each video carries its soundtrack. Host preparation resamples frame timing to 24 fps and
resizes within 864×480 while preserving aspect. A silent source receives a silent soundtrack,
reserving one audio ordinal per video consistently before prompt review. Consequently, with two
video references, standalone audio starts at `<Audio 3>`. This is reference conditioning;
neither exact supplied soundtrack preservation nor performance synchronization is declared.
Native H3 internally snaps reference frames to its latent grid.

Standalone media selections journal their world-relative paths, hashes and measured durations.
Preparation rechecks these before using private temporary copies; sources are never overwritten.
Prepared bytes are ephemeral. Cancellation kills the bounded encoder before provider submission.
Existing character samples reuse QC evidence and hash checks; local guidance does not require a
cloud-upload acknowledgement. Cloud routes still require current cloud rights.

## Validation

On 2026-09-07, the mixed smoke completed on an RTX 3080 10 GB with 32 GB system RAM in
656.5 seconds. Two images, one two-second video with soundtrack and one two-second standalone
audio clip produced 124 frames of 864×480 H.264 at 24 fps, plus 32 kHz stereo AAC (5.167 seconds).
Inspected frames showed the requested red cube and blue sphere moving; audio was non-silent.
Free RAM started at 4133 MiB and bottomed at 407 MiB. The recipe therefore requires 4 GiB free
RAM at dispatch. This establishes mixed-input execution, not maximum-reference memory use,
speaker identity accuracy or verbatim dialogue. Automatic video recommendation is unchanged.

Run the focused provider tests from `packages/providers`:

```powershell
node --import tsx --test test/comfyui.test.ts test/h3-reference.test.ts
```

Run the coordinator boundaries from `packages/coordinator`:

```powershell
$env:ARKE_TEST_FFMPEG = (Get-Command ffmpeg).Source
$env:ARKE_TEST_FFPROBE = (Get-Command ffprobe).Source
node --import tsx --test test/media/reference-media.test.ts test/bench/bench.test.ts test/queue/dispatcher.test.ts test/audio/dispatch-gate.test.ts
```

The media test uses actual FFmpeg when both environment variables are present, checks a 30 fps
silent input becomes 24 fps with audio, and checks containment, changed sources and duration
refusals. Provider tests cover registration, graph slots, pruning, audio-only inputs, native tags,
remote refusal and rejection before uploads. Queue tests cover ephemeral bytes and cancellation.

For GPU validation, with the engine idle at `127.0.0.1:8188`, from the repository root:

```powershell
node --import tsx packages/providers/scripts/smoke-h3-reference.ts C:/path/to/ComfyUI .dev/h3-reference-smoke mixed
```

The script verifies every weight hash, creates synthetic test media, dispatches through the real
provider client, and records recipe identity, runtime, memory and ffprobe output. It supports
`images`, `video`, and `audio` as isolated checks too. It does not interrupt somebody else's
queue. Inspect generated picture and sound before recording a successful GPU validation; a
successful HTTP submission alone is not generation evidence.

Upstream sources: [ComfyUI R2V documentation](https://docs.comfy.org/tutorials/video/minimax/minimax-h3#minimax-h3-reference-to-video-r2v),
[pinned weights](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/a98869194787969724c7425d95d0ed73ce9202af).

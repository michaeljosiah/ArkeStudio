# Local H3 reference video

`comfyui-h3-reference-video` is **Local · H3 Reference Video**, a separate recipe from the
FL2VA text/first-frame recipes. Its `ref2va` checkpoint conditions on images, motion clips and
audio; it does not pin the first image to frame zero. Select it explicitly in the video model
picker. The existing automatic local-video preference order is unchanged.

## H3 Video's reference route (design turn 179)

There are two ways to give H3 a picture as a reference. This recipe (ref2va) is one. The other
is a second graph of **Local · H3 Video**: the same fl2va checkpoint, turbo LoRA, sampling and
adapter slot, with node 7 changed to `MiniMaxH3ReferenceToVideo` and the pictures fed into
`ref_images.ref_image_N` (nodes 20–22). The bench's **Reference** lane on H3 Video uses this
graph. The **Keyframe** lane still sends the picture as the first frame. One take cannot use both.

Prefer the H3 Video route when adapters are involved. On 2026-10-01 the Motion + anatomy
bundle was run on the same picture both ways. On ref2va it fused two bodies into one. On fl2va
the bodies stayed separate and the face held. The adapters were trained on fl2va, so their 480p
pairings apply to the route unchanged. This recipe still has no verified adapter pairing and no
bundle.

What the route does:

- Each picture has a **who**. A picture from a Cast character uses the character's name.
  Anything else uses a typed label, or `the person` when none is given. Arke puts one line
  per picture before the brief: `<Subject N> is {who}, shown in <Picture N>.` `@Image N` in the
  brief becomes `<Picture N>`. Nothing else in the brief changes.
- The take records the composed prompt, each picture's file and hash, and the route. The
  bench's *What was sent* shows them. A re-run uses that record. The client checks the bytes of
  each picture against the recorded hash before uploading. A changed file is refused.
- The route has its own recipe identity: the parent's id with `route: "reference"`, version 1
  and a different template digest. Jobs and takes made before the route are not affected.
- H3 Video 768p has no route yet. A picture stays in the tray and Generate is disabled with
  `H3 Video 768p takes no reference pictures yet`.

The route is measured with **one** picture: 15 s at 864×480 (362 frames), Motion + anatomy at
0.5 / 0.4 / 0.8, Fast, ComfyUI 0.38.1, RTX 3080 10 GB with 31.9 GB RAM. Two runs took 18.8 and
18.0 minutes, with peak card use of 9,525–9,563 MiB and a RAM low-water mark of 665–855 MB. The
graph has carriers for three pictures, but the manifest row offers one
(`referenceRoute.maxImages`) until two and three are measured. The node is in ComfyUI 0.33.1
and later.

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

FFmpeg and ffprobe must be configured for video and standalone audio preparation. Frozen character voice samples already carry reviewed technical evidence and need neither tool at dispatch. Audio/video reference upload
is currently local-engine-only; selecting a remote ComfyUI URL does not authorize transferring
locally reviewed recordings. Images can use the existing remote-engine path.

ComfyUI retains uploaded references in its `input` directory, including recordings and normalized
clips, after successful, failed and cancelled jobs. Arke removes its own preparation copies but
does not delete engine uploads. Native ComfyUI 0.33.1 has no public physical-file deletion API;
its asset-delete endpoint only hides database records. Clean engine inputs only while the engine
is idle and no queued job still needs them. Automatic per-job reclamation needs a separately
designed engine lifecycle contract; this preset does not promise ephemeral engine storage.

## Reference meaning and ordering

The bench preserves the author's stable `@Image N`, `@Video N`, and `@Audio N` tokens. It resolves
them to dense transmitted order and renders H3's `<Picture N>`, `<Video N>`, and `<Audio N>`
syntax. Bare authored prose is preserved; implicit image labels are translated only in generated bindings. Production prompt assembly uses the same translation. Voice guidance appears after
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
node --import tsx --test test/comfyui.test.ts test/h3-reference.test.ts test/h3-video-reference.test.ts
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

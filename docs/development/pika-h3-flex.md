# Local Pika H3 Flex

Pika H3 Flex is a separate video recipe family in Arke's normal local generation flow.
It uses Pika's distilled BF16 adapter on the matching MiniMax H3 INT8-convrot backbone,
the NVFP4 Qwen encoder, FP16 video VAE and FP32 audio VAE. Its sampler follows the Comfy
Pika template's six LCM steps, explicit sigma sequence and video/audio shifts of 12/3. The existing
H3 turbo recipes and automatic model preference order keep their identities.

| Picker name | Recipe id | Output | Requested seconds | Picture input |
|---|---|---|---|---|
| Local · Pika H3 Flex | `comfyui-pika-h3-flex` | 480p | 5, 10, 15 | Optional first frame |
| Local · Pika H3 Flex 768p | `comfyui-pika-h3-flex-768` | 768p | 5 | Optional first frame |
| Local · Pika H3 Flex Reference | `comfyui-pika-h3-flex-reference` | 480p | 5, 15 | One reference picture |
| Local · Pika H3 Flex Reference 768p | `comfyui-pika-h3-flex-reference-768` | 768p | 5 | One reference picture |

All four offer landscape and portrait. Native dimensions are 864×480 / 480×864 and
1344×768 / 768×1344. The requested lengths map to 124, 243 and 362 frames at 24 fps:
5.167, 10.125 and 15.083 seconds in the actual container. Output includes generated stereo
sound. Speech, voice identity and lip synchronization remain untested.

Choose the model in the normal video picker. With the first-frame presets, put a picture in
the Keyframe lane; Arke resizes and center-crops it to the selected canvas. Without a picture
these presets run from text. With the Reference presets, put one picture in Reference and
use `@Image 1` in the brief if desired. The shared H3 prompt handling translates it to native
picture syntax. A reference guides appearance rather than fixing frame zero. These presets
offer no video/audio inputs, last frame, extra adapter stacks or generic sampling controls.
The first-frame rows advertise zero appearance references and one frame task; the Reference
rows advertise one appearance reference and no frame task. The lanes cannot silently change
what the supplied picture means.

## Installation and provenance

Select a healthy ComfyUI 0.38.0 or later in Settings and map its models folder. Settings derives
the four optional weight installations and readiness checks from the recipes. Existing matching
H3 files are reused; Pika adds a different adapter for each backbone. No custom nodes are needed.
Do not replace H3's turbo adapters with these files.

These are downloadable weights under the
[MiniMax H3 Community License](https://huggingface.co/Pika-Labs/Pika-H3-Flex/blob/3ff166447d5edb1406107ab8370c42000ce173e4/LICENSE),
with its territory and use conditions; they are not an unrestricted open-source release.
The publisher's Comfy conversion note also distinguishes this workflow from Pika's original
inference implementation. The measured Comfy preset does not establish numerical equivalence
with that original runtime. License/NOTICE files must accompany redistributed adapters.

The complete five-file closure for each preset lives in
[`pika-h3-flex-recipe.ts`](../../packages/providers/src/comfyui/pika-h3-flex-recipe.ts).
Every file has an immutable download revision and SHA-256. On 2026-10-30 the publisher's LFS
pointers at those exact revisions were checked against the recipe digests:

- [Pika adapter repository](https://huggingface.co/Pika-Labs/Pika-H3-Flex/tree/3ff166447d5edb1406107ab8370c42000ce173e4/comfy/loras),
  revision `3ff166447d5edb1406107ab8370c42000ce173e4`.
- [Comfy H3 base files](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/a98869194787969724c7425d95d0ed73ce9202af),
  revision `a98869194787969724c7425d95d0ed73ce9202af`.

The FL2VA adapter is `loras/pika_h3_flex_fl2va_comfy_bf16.safetensors`, SHA-256
`68783e6447696ec365d13c0554941e070bee4cfea13c37da52498ec4f9a53f89`.
The Ref2VA adapter is `loras/pika_h3_flex_ref2va_comfy_bf16.safetensors`, SHA-256
`e4d058fbd027377b925a0ee607b514ddd9037873fee3afa05d73b302e6f7f8e1`.
Each is 1,956,172,176 bytes. Readiness hashes the actual local files before dispatch;
publisher pointers alone do not establish a local installation's integrity.

## Measured configuration envelope

The initial native matrix used Windows, an RTX 3080 with 10,240 MiB VRAM and approximately
32 GiB RAM, ComfyUI 0.38.0, Python 3.13.14 and PyTorch 2.14.0+cu130. The recipe floors are
10,000 MiB total VRAM and 30,720 MiB total RAM, representing this tested hardware class.
Lower hardware is unmeasured. Free-memory observations are diagnostic, not a new admission
threshold. These are offloaded models, not weights that fit wholly in 10 GiB VRAM.

The initial matrix used a synthetic toy-robot/ball fixture, seed 9123, one picture, the same
checkpoint/adapter closure and six-step schedule. It was an engine configuration study,
before the new recipe identities existed. It does not replace application qualification.
Later portrait/reference runs reserved 1.5 GiB with `--vram-headroom`; the initial landscape
runs used default allocation. Automatic VAE tiling could occur. These tests used the FP16
video VAE, not the INT8 VAE from the publisher's example workflow.

| Native input/configuration | Landscape elapsed | Portrait elapsed |
|---|---|---|
| First frame, 480p, 5 s | 15m 15s | 13m 46s |
| First frame, 480p, 10 s | 11m 41s | 12m 16s |
| First frame, 480p, 15 s | 19m 10s | 14m 40s |
| First frame, 768p, 5 s | 14m 56s | 13m 20s |
| First frame, 768p, 10 s | 39m 29s, over budget | Stopped at cutoff |
| First frame, 768p, 15 s | Stopped, no completed clip | Stopped at cutoff |
| Reference, 480p, 5 s | 11m 33s | Not in initial matrix |
| Reference, 480p, 15 s | 15m 00s | Not in initial matrix |
| Reference, 768p, 5 s | 14m 45s | Not in initial matrix |
| Reference, 768p, 15 s | Stopped at cutoff | Not in initial matrix |

Six sampled frames from each completed clip showed coherent toy/ball motion. Numeric audio
inspection established an audio stream, not semantic sound quality; the matrix audio was not
listened to. One reference clip was very quiet. A single fixture/seed is not a reliability or
quality benchmark for arbitrary people, dialogue or complicated motion.

The agreed test cutoff is **20 minutes per clip**. The earlier 39-minute result and stopped
768p attempts are excluded from the shipped duration choices. This is a qualification budget,
not an application-wide timeout promise. Reference 480p offers the measured 5/15-second spots;
its 10-second combination is not advertised pending a native measurement.

## Application qualification, 2026-10-30

The new recipe identities were exercised through the real Coordinator, runtime services,
provider client, durable Bench journal and built sandboxed Electron file page. Each run used
a private fixture world and an idle caller-owned ComfyUI 0.38.0, with default allocation
(no `--vram-headroom` override), no custom/API nodes and the exact verified weight pins.
Ollama 0.40.6 was an existing healthy service with no loaded models; no language-model call
was made. Native hardware measured 10,240 MiB VRAM and 32,676 MiB system RAM.

| Preset / input | Shape / requested length | Dispatch through saved take and playback |
|---|---|---|
| Pika H3 Flex, text only | 864×480, 5 s | 914.081 s; passed |

The text-only take retained recipe version 1, engine version 0.38.0 and seed 1120718763.
Its MP4 contains 124 H.264 frames at 24 fps, 5.166688 seconds and 32 kHz stereo AAC.
Authenticated desktop playback advanced past one second. Six sampled frames show a coherent
toy robot waving beside a red ball. Numeric audio mean/peak were −14.0/−0.6 dBFS; this is
technical audio evidence, not a listening or semantic-quality assessment. During this run,
the ten-second resource samples reached 9,499 MiB used VRAM and 703 MiB free RAM.

The native evidence directories retain the original MP4 in the fixture world's session,
the job/take record, dependency-readiness facts, playback measurements and frame contacts.
These application runs use fresh application-selected seeds rather than the matrix's fixed
9123, so timings are observations rather than a controlled quality comparison. This checks
the built app flow, not a packaged installer or a distribution release.

## Validation

Focused provider checks, from `packages/providers`:

```powershell
node --import tsx --test test/pika-h3-flex.test.ts test/comfyui.test.ts test/h3-reference.test.ts test/comfyui-sampling.test.ts
```

Application checks, from `packages/coordinator`:

```powershell
node --import tsx --test test/bench/pika-h3-flex.test.ts test/setup/catalogue-invariants.test.ts
```

For native qualification, build the client/preload, start an idle caller-owned ComfyUI with
the pinned models mapped and a healthy existing Ollama service, then from the repository root run:

```powershell
node --import tsx apps/desktop/scripts/smoke-pika-h3-flex.mjs http://127.0.0.1:8190 D:/models D:/new-pika-evidence comfyui-pika-h3-flex D:/reference.png 5 16:9
```

Use `-` for the picture to exercise text-only generation. The evidence directory must not
exist. The script copies the fixture world, starts the real coordinator and shared provider
client, measures hardware through the authenticated detect command, waits for verified readiness,
then presses Generate in the built sandboxed Electron
file page. A successful result must land as a durable Bench take and play through authenticated
media access. It retains screenshots, measured playback, readiness and the job/take records.
No credentials are put in renderer URLs or process arguments. This is a built-app smoke check;
run the packaged app before distribution as required by the recipe procedure.

Ollama defaults to `http://127.0.0.1:11434`; set `ARKE_PIKA_OLLAMA_URL` for another existing
loopback service. The host uses Arke's real runtime-readiness gate and makes no language-model
calls. Adjacent runs share identity-checked digest receipts, not fabricated integrity verdicts.

The caller owns the native worker and must stop it if the script reaches its 20-minute cutoff.
The script never interrupts an unrelated engine and never resubmits a stalled generation.

Implementation follows SPEC-021 R-2/R-3/R-9/R-10/R-18/R-19. Keep this note's application
qualification results separate from the earlier native matrix when changing recipe versions.

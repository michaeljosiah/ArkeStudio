# IndexTTS 2.5 integration status

General settings offers only eligible Text-to-Speech models. Model option labels contain
provider and model identity only; readiness and its reason remain separate. A saved TTS
default that becomes unavailable is retained as a hidden, disabled selected value with a
separate short warning. It is never silently replaced. Detailed reasons remain on
Settings → AI models → Voice clone and on the provider/engine diagnostics surfaces.

The previous General control appended `strandReason()` to each unavailable option. For
cloned voice that inserted the entire build diagnostic into a native select. The underlying
recipe had no checkpoints and a hardcoded unavailable reason: even an installed node could
not satisfy an unpublished dependency closure. A running ComfyUI process alone was insufficient.

## Verified pins

The artifact manifest and independent validation rules are in provider
`src/comfyui/indextts25-manifest.json` and `src/comfyui/indextts25.ts`. Recipe version 2 binds
this manifest's identity into the frozen dependency digest, alongside checkpoint and node pins.

| Input | Pin / evidence |
|---|---|
| TTS-Audio-Suite | Commit `dedd982ab999633d5296c3e5a152ef772941fb82`; 71,525,888-byte source ZIP; SHA-256 `6ff7b4855ca406d6874fac494e4596255d553ebe6087a4899803268b40773749`, downloaded and hashed on 2026-09-29 |
| IndexTTS 2.5 | `IndexTeam/IndexTTS-2.5` revision `ba2480d9f7f629eb18f6acaebb357679d9ba88a4`, matching the suite's own pin; all 19 inference/config/tokenizer files plus the licence |
| W2V-BERT | `facebook/w2v-bert-2.0` revision `da985ba0987f70aaeb84a80f2851cfac8c697a7b`; weights, config, preprocessor config |
| CAMPPlus | `funasr/campplus` revision `e4b6ede7ce16997aff4ae69fbca1f0175e2afede`; speaker-embedding checkpoint |
| BigVGAN | `nvidia/bigvgan_v2_22khz_80band_256x` revision `633ff708ed5b74903e86ff1298cf4a98e921c513`; checkpoint and config |
| Python candidate | Windows x64, CPython 3.13.11, uv 0.12.20; 193 version/hash-locked distributions; clean installation and offline inference-module import passed |

The 26 model assets total **8,290,508,298 bytes**. LFS hashes are the publisher's SHA-256
object IDs; smaller Git-backed files were downloaded at their pinned revision and hashed.
All 25 inference files already present on the reference machine matched those hashes. Its
model library lacked the separate licence file; verification reported that omission and
did not modify the library.

The [pinned suite downloader](https://github.com/diodiogod/TTS-Audio-Suite/blob/dedd982ab999633d5296c3e5a152ef772941fb82/engines/index_tts/index_tts_downloader.py)
declares the model file lists. Its
[2.5 inference code](https://github.com/diodiogod/TTS-Audio-Suite/blob/dedd982ab999633d5296c3e5a152ef772941fb82/engines/index_tts/indextts/infer_v2_5.py)
uses `codec.pth` rather than the separate legacy MaskGCT checkpoint. Qwen emotion files are
retained because the suite checks for them even when the graph does not request text emotion.

## Download, installation and readiness

`comfyUiWeightCatalogue()` in desktop derives download rows from the same recipe file paths,
URLs, sizes and hashes the coordinator verifies. Only a supported, nonempty recipe enters
the setup catalogue. The existing file installer provides disk checks, progress, partial-file
handling, hash verification before promotion and repair. It targets the selected engine's
mapped model folder. Completed setup invokes recipe re-verification.

Engine readiness/preflight already checks engine version, node classes, custom-node content
identity, mapped model files/digests and hardware/free-memory requirements. Managed launches
set `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE` and `HF_DATASETS_OFFLINE`. A catalogue refusal
precedes those checks and blocks dispatch regardless of an existing engine's health.

**The recipe is still `unsupported_in_build`.** There is no tested, hash-pinned, published
Python dependency bundle for managed setup, and offline graph inference has not been verified
with this lock. The managed source/dependency installer is also not integrated; changing the
manifest flags alone cannot enable it. The source lock includes distributions that build locally; it is not a
portable wheelhouse, does not lock their build toolchains and must not be treated as one.
The app therefore offers no partial IndexTTS download/install and sends no inference request.
The diagnostic now states these remaining blockers instead of claiming that the source and
model artifacts are missing.

Completion requires building the dependency bundle with a controlled Windows build environment,
retaining its package notices, integrating its atomic managed installation and dependency
verification, disabling every node download path, then running the actual graph offline through
audio retrieval. Only then can the manifest name that bundle and record successful inference.
Existing user-owned environments must remain verification-only. See SPEC-028 R-17 through R-20.

The reference machine's selected URL engine reported `--disable-all-custom-nodes`, which also
prevents the TTS node classes from loading. About 2 GB of GPU memory was free during this work,
below the existing 8 GB free-memory floor. Neither that server nor other GPU work was stopped.

## Repeatable checks

From the repository root:

```powershell
node --import tsx scripts/check-indextts25.mjs
node --import tsx scripts/check-indextts25.mjs --upstream
node --import tsx scripts/check-indextts25.mjs --source-archive <pinned-zip> --models-dir <models-folder>
node --import tsx scripts/check-indextts25.mjs --require-ready
```

The last command intentionally fails while release prerequisites remain incomplete. The other
commands check exactly the requested evidence and report build availability separately.
They never install packages, change engine settings, overwrite model files or download large
model weights. `--upstream` checks publisher metadata and downloads only small Git-backed files.

Regression coverage: provider `test/indextts25.test.ts` and `test/comfyui.test.ts`, client
`test/settings-general.test.tsx`, desktop `test/comfyui-setup.test.ts`, and coordinator
`test/comfyui/comfyui.test.ts` / `test/setup/comfyui-setup.test.ts`. The manifest tests remove
every required artifact individually and reject missing sections, mutable URLs, invalid hashes,
invalid sizes, unsafe paths, duplicates, absent locks and unverified build prerequisites.
Python candidate regeneration and installation are documented in
`vendor/comfyui/indextts25/README.md`.

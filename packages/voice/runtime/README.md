# Local speech runtime

Implements the batch local speech protocol for epic #2870, issue #2873.
This service receives no cloud credentials and opens no world. The coordinator
continues to own OpenCode sessions, tools and jobs. Live conversation, managed
installation and the production default are separate implementation issues.

The service uses the audition's local ONNX Kokoro adapter, its retained MIT
vocabulary notice, and Faster Whisper CPU int8 recognition. Pipecat's pinned
speech/transport dependency set prepares the same runtime for live sessions.
Model paths are supplied by the host; missing assets never trigger downloads.
Kokoro's model/style files are reused. Faster Whisper needs its own CTranslate2
model directory, including `model.bin`, `config.json` and `tokenizer.json`.
The existing GGML model is not that directory. espeak remains an executable.

## Protocol

All requests require the host's fresh 32-byte capability as a Bearer header.
The process reads its base64url encoding from `ARKE_SPEECH_CAPABILITY`, never an
argument or URL. It binds only `127.0.0.1` and refuses foreign Host/Origin headers.
The TypeScript client's optional capability callback also pins loopback and
forbids redirects; omitting it preserves the existing Voxa client behavior.
ChildSupervisor already supports private health headers for host integration.

| Route | Behavior |
|---|---|
| `GET /health` | Protocol 1, truthful independent Kokoro/Whisper readiness |
| `GET /voices` | Existing six preset IDs/attributes, filtered to installed styles |
| `POST /tts` | JSON voice/text/speed; returns 24 kHz mono PCM16 WAV |
| `POST /stt` | Audio body; returns JSON text; optional bounded `X-Voxa-Prompt` |
| `POST /stt/words` | Measured acoustic bounds from the isolated whisper.cpp DTW helper; no name hints |

Synthesis text is bounded to 4,000 characters and output to 16 MiB PCM.
Input audio is bounded to 64 MiB, ten decoded minutes and a 15-second body read.
Raw `audio/pcm`/octet-stream is 16 kHz mono PCM16 little-endian; `audio/L16`
uses network byte order. WAV and compressed browser recordings are decoded locally.
Recognition hints are base64 UTF-8, at most 200 bytes, without null characters.
The service keeps one CPU inference lane with at most four admitted requests.
Cancelled/disconnected observers discard delivery, but active native work keeps
the lane until it really exits. Queued cancelled work does not start. Shutdown
closes admission and drains the lane. Native model-call hard-stop ownership is
the host's responsibility; a cancelled HTTP observer does not prove native exit.
No raw audio is written to disk. Measured word timing is available only when the
independent alignment helper and its exact verified GGML model are supplied.

## Development checks

Use the locked environment, without installing into another engine's Python:

```powershell
python -m uv sync --project packages/voice/runtime --python 3.11 --locked
```

From this directory, run `python -m pytest -q test_service.py test_alignment.py`. The opt-in
`python smoke.py --kokoro <kokoro-root> --whisper <converted-model-dir> --espeak <executable> --decoder <ffmpeg.exe>`
requires already downloaded local models. It makes an authenticated HTTP
synthesis/recognition round trip with a synthetic phrase and saves no recording.
Add `--alignment <Arke.LocalAlignment.exe> --alignment-model <ggml-base.en.bin>`
to check measured intervals on that same real audio. It does not qualify physical
microphone permissions or speaker echo.

The desktop host selects a verified private runtime, passes private health/request
headers and supervises/drains it through the existing speech owner. It preserves
personal Voxa paths and arguments for explicit rollback. A missing backend setting
still selects Voxa; the default rollout remains #2879. Setup/repair choose the
converted recognizer separately from the GGML alignment model.
Windows x64 CPU is the initial target; ARM64 dependencies are not yet qualified.

## Measured word timing (#2878)

`alignment/` retains the qualified MIT acoustic DTW implementation, with its
source attribution, in a bounded stdin/stdout console helper. It references
Whisper.net 1.9.1 directly and no Voxa assemblies. The algorithm, strict interval
refusals and engine identity `whisper.cpp/dtw-word-boundaries-v1` are unchanged.
Faster Whisper recognition does not supply caption timestamps. The helper uses
only the exact SHA-256-qualified base.en GGML model; a missing/wrong model makes
word timing unavailable independently of ordinary dictation.

Build from the repository root:

```powershell
node apps/desktop/scripts/prepare-alignment.mjs --arch x64 --work D:/ArkeSpeechBuild/alignment
```

This makes a self-contained stage with locked NuGet dependencies, runtime notices,
source, verified VC runtime and a complete hash manifest. Existing staging is
replaced only after build, self-check and manifest verification succeed. Model
weights remain separately managed. Pass `--alignment` and `--alignment-model`
to `service.py`; the helper receives no capability/cloud environment or files
containing recordings. One process handles one bounded request and is killed on
timeout; the speech inference lane remains reserved until that process exits.

| Target | Evidence / current behavior |
|---|---|
| Windows x64 CPU | Self-contained helper built and executed; actual Kokoro WAV produced seven measured words; original interval/quiet-boundary checks passed |
| Windows ARM64 native | Not qualified: CTranslate2 Windows wheels are x64; preparation refuses ARM and existing Voxa remains available |
| Windows ARM64 x64 emulation | Not tested; not selected or advertised |
| Linux/macOS | Not a managed runtime target in this change |

The managed distribution omits PyAV. Compressed audio is decoded through bounded
pipes to Studio's separate FFmpeg executable. Faster Whisper's deterministic
adaptation accepts NumPy input and refuses its unused file-decoder entry point;
recognition source is otherwise unchanged. Development tests use PyAV only to
generate fixtures: set `ARKE_TEST_FFMPEG` to the separate FFmpeg executable before
pytest. That development environment is never copied into the installer.

## Managed Windows x64 distribution (#2874)

`npm run prepare:speech --workspace @arke-studio/desktop -- --work D:/ArkeSpeechBuild/managed --downloads D:/ArkeSpeechBuild/downloads`
prepares a private portable Python with hash-locked wheels and no developer Python
dependency. It requires .NET SDK 10, CMake and Visual Studio C++ build tools on the
build machine. Exact inputs are in desktop `speech-runtime-sources.json`.
It source-builds CPU-only CTranslate2 and minimal libsndfile, retains replaceable
LGPL files, complete native sources/build arguments, all package licence texts,
alignment source and manifests. No Intel/GPU redistributables or FFmpeg libraries
enter Python. Pipecat's small Silero/Smart Turn detector models remain bundled and
offline; Kokoro/Whisper user models are separate downloads.

The stage is verified before replacing a previous runtime. Both licence and
afterPack gates require it as loose `resources/speech` files. This qualifies the
portable Windows x64 runtime; the final installed-app and physical-device matrix
remains #2879. No public installer is published by preparation or local packaging.

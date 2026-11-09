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
No raw audio is written to disk. Measured word timing is explicitly unavailable
until #2878 qualifies an alignment path.

## Development checks

Use the locked environment, without installing into another engine's Python:

```powershell
python -m uv sync --project packages/voice/runtime --python 3.11 --locked
```

From this directory, run `python -m pytest -q test_service.py`. The opt-in
`python smoke.py --kokoro <kokoro-root> --whisper <converted-model-dir> --espeak <executable>`
requires already downloaded local models. It makes an authenticated HTTP
synthesis/recognition round trip with a synthetic phrase and saves no recording.
It does not qualify microphone permissions, speaker echo, packaging or timing.

The production host must install a verified private runtime and model tree,
pass private health/request headers, supervise/drain the process, and present
engine-specific setup/recovery status. Those integration gates remain #2874/2875.
Windows x64 CPU is the initial target; ARM64 dependencies are not yet qualified.

The installed Windows Python 3.11 PyAV 18.1.0 wheel's native avcodec reports
LGPL-3.0-or-later; this is distinct from Studio's separate GPL FFmpeg executable.
The exact wheel/native dependency tree still needs its own redistributable
notices, corresponding-source and replacement/relinking review in #2874/#2879.
The PyAV package's BSD licence alone does not cover those native libraries.

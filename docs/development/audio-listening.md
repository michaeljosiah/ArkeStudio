# Local audio listening

`listen_audio` gives shared leased conversation tools access to actual audio-model inference,
independently of the selected writing harness. It asks an optional local Qwen2-Audio worker for
music, perceived expressive tone and voice-delivery observations. This is separate from local
Voxa word recognition, script comparison and original-channel signal measurements.

## Status and boundaries

The host integration and offline worker are implemented. The installer includes the worker script,
not Python, Torch or model weights. Listening is unavailable until explicitly configured with a
compatible environment and complete local model. No downloads, cloud fallback, API keys, new paid
requests, media edits or selections occur. OpenCode's current [attachment documentation](https://opencode.ai/v2/docs/attachments)
excludes audio binaries; putting a WAV in its prompt would not prove audio reached the model.

The local worker receives only a canonical mono 16 kHz PCM16 WAV and enumerated review focuses,
over stdin. It receives no world path, source text, conversation history, script or credentials as
request fields. Source/container hashes, source/view range, selected stream, decoder versions,
derivative hash and a fingerprint of the local model/processor files stay in the durable receipt.
Audio bytes do not. The review text follows the selected writing harness's ordinary text policy.

Receipts declare `model-audio-listening` under world schema 81. They attest that the configured
local worker returned an interpretation of the supplied derivative, not that its interpretation
is correct. Emotion means perceived expression, not actual feelings or a diagnosis. Music review
can describe audible texture, instrumentation, rhythm and mood; voice review can describe audible
pacing, emphasis, breathiness, energy and articulation. Stereo/spatial detail and high-frequency
fidelity are unavailable from this derivative. There are no measured event/word timestamps,
objective quality scores, speaker identification, full-track coverage or audiovisual sync claims.
The exact selected interval must be cited; unsupplied intervals/focuses remain unreviewed.

## Configure an optional host

Use a dedicated Python 3.11 environment with a suitable PyTorch build for the machine. Install the
optional requirements from `packages/coordinator/src/media/audio-listener-requirements.txt` into
that environment. They target the documented [Transformers 4.51.3 Qwen2Audio API](https://huggingface.co/docs/transformers/v4.51.3/en/model_doc/qwen2_audio).
Maintain this environment independently of Voxa and other installed Python tools.

Prepare a complete local **Qwen2-Audio-7B-Instruct** snapshot, including config, processor,
tokenizer and safetensors shards. Use a fixed, immutable snapshot directory. Model acquisition is
an operator setup step; the worker uses `local_files_only=True`, offline environment flags,
`trust_remote_code=False` and safetensors-only loading. It does not fetch or run model repository
code. The model needs substantial memory; CPU/offload and GPU load time must be qualified on the
target machine. No realtime performance is promised. Model files are fingerprinted before each
one-shot read; each call loads the model and exits, releasing its process/GPU resources.

Set these absolute paths in the environment that starts Studio or the standalone Node host:

```powershell
$env:ARKE_AUDIO_LISTENER_PYTHON = 'C:\audio-listener\Scripts\python.exe'
$env:ARKE_AUDIO_LISTENER_MODEL = 'C:\models\Qwen2-Audio-7B-Instruct-snapshot'
```

The desktop development build copies the worker beside `main.cjs`; the installer carries it as
a loose `resources/audio-listener/local-audio-listener.py` file so Python can read it outside
Electron's asar archive. The packaging gate compares its hash with source. Node uses its source copy.
Other embeddings inject `AgentAudioListener` through the existing coordinator option. These are
host setup controls, not model-supplied executable paths. Missing/incomplete configuration refuses
without changing the world or consuming a call. A bounded readiness process checks model files,
actual runtime imports and local processor loading; inference additionally checks weight loading.
Readiness does not certify enough GPU memory or model accuracy. No new settings UI is introduced.

Ask the conversation to inspect an immutable artifact/Bench take/production take, then listen to
an explicit interval. `listen_audio` accepts `source`, `range`, optional `streamIndex`, and unique
`focuses` from `music`, `emotion`, `voice-delivery`. Ambiguous tracks require an explicit stream.
Limits are 30 seconds per excerpt, two listening calls inside the shared 16-call media budget,
180 seconds per inference, bounded process output and 8,000 characters of review text. Stop/world
close kills native work; expired leases, changed source identities/bytes and late results cannot
be delivered. There is no automatic acceptance or audio alteration.

## Verification

```powershell
node --import tsx --test packages/coordinator/test/media/agent-listening.test.ts packages/coordinator/test/media/local-audio-listener.test.ts packages/coordinator/test/world-chat/media-inspection.test.ts
python -I -B packages/coordinator/test/media/local_audio_listener_test.py
npm run typecheck
npm run smoke:main -w @arke-studio/desktop
```

The tests exercise waveform transport, offline model-loading arguments, bounded native execution,
Stop/deadline handling, source revocation, leased MCP, receipt replay and schema refusal. Python
protocol tests use fake inference dependencies and run on both CI platforms; they require no
weights or GPU. They do not establish live perceptual accuracy. Before advertising a ready
installed-model experience, run known music, speech and mixed excerpts with the real snapshot,
check that changed audible delivery changes the review, and compare with human listening. Also
verify Stop during actual model loading/inference and confirm offline execution on that machine.

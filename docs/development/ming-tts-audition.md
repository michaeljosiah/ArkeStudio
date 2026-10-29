# Ming local auditions

This is an offline qualification probe, not a shipped reader. It implements the probe-first
approach in SPEC-046 section 2.6. Existing Voxa speech and provider routing are unchanged.
The [0.5B run](../research/ming-tts-audition-2026-10-25.md) and
[original-weight tiny run](../research/ming-tiny-audition-2026-10-25.md) on 25 October 2026 record
the measured scope and listening gates.
The [Embers neutral narration comparison](../research/ming-embers-audition-2026-10-25.md)
records a separate 0.5B owner acceptance for voice similarity and artifact quality; that result
does not qualify directed character delivery.
The [online control audit](../research/ming-controls-audit-2026-10-25.md) and
[Dumah narrator audition](../research/ming-dumah-audition-2026-10-25.md) extend that qualification.
The [7.9B chunked narration retry](../research/ming-chunked-audition-2026-10-25.md) tests longer
reads and voice continuity separately from the whole-request seed path.
The [ComfyUI Python reuse check](../research/ming-comfy-runtime-2026-10-25.md) evaluates sharing
an existing GPU stack with separate Ming package overlays, without modifying ComfyUI's dependencies.
The subsequent [managed-bundle check](../research/ming-managed-runtime-2026-10-25.md) qualifies
the exact downloadable stack and records the additional adapters it requires. Application
runtime ownership and the Ming batch backend are covered in [Managed local runtimes](managed-local-runtimes.md).

`scripts/probe-ming-tts.py` runs a pinned upstream Ming checkout in a bounded child process,
records model/reference hashes and runtime versions, and writes PCM16 WAVs plus a flushed
JSONL journal. It distinguishes model loading from synthesis, records real-time factor
(synthesis seconds / audio seconds), peak PyTorch allocation/reservation, clipping and RMS.
The before/after `nvidia-smi` readings cover the whole machine, including other applications;
they cannot establish per-process VRAM use or an idle hardware floor.

## Local setup

Use a dedicated Python environment. Follow the pinned upstream
[requirements](https://github.com/inclusionAI/Ming-3.0-tts/blob/028c1eace193e7acdb256453da89b6e9207e052b/requirements.txt).
Keep source, environment, model weights, private reference recordings and generated audio in
gitignored `.dev/ming-audition/`, or another private scratch folder. Never install dependencies
into the user's existing ComfyUI environment. Record any dependency deviations in the results.
The initial Windows probe used Python 3.13, torch/torchaudio 2.6.0 with CUDA 12.4 and matching
torchvision 0.21.0. Optional Flash Attention was absent.
That first machine's venv inherited common system packages read-only while overriding the
pinned ML libraries locally; the commands below create a clean venv for a reproducibility run.
The journal records the actual package versions, rather than claiming all transitive
dependencies are pinned by upstream's requirements.

```powershell
git clone https://github.com/inclusionAI/Ming-3.0-tts.git .dev/ming-audition/upstream
git -C .dev/ming-audition/upstream checkout --detach 028c1eace193e7acdb256453da89b6e9207e052b
python -m venv .dev/ming-audition/venv
.dev/ming-audition/venv/Scripts/python.exe -m pip install torch==2.6.0 torchaudio==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
.dev/ming-audition/venv/Scripts/python.exe -m pip install -r .dev/ming-audition/upstream/requirements.txt
```

Download `inclusionAI/Ming-3.0-tts-0.5B` at an explicit checkpoint revision using
`huggingface_hub.snapshot_download`, with `local_dir=.dev/ming-audition/model`. Record that
revision beside the local model; the probe hashes the actual weights, config and speaker encoder.
Downloads are setup only: inference sets Hugging Face and Transformers to offline mode and
does not inherit provider credentials. Source is pinned and upstream tokenizers must be reviewed
before execution. The parent validates required checkpoint files before launching the child.

Create a private UTF-8 `suite.json`. Reference paths resolve relative to that file:

```json
{
  "cases": [
    {
      "id": "speaker-neutral",
      "seed": 1895,
      "request": {
        "task": "TTS",
        "language_id": "English",
        "text": "I kept the letter because I thought you would come back.",
        "prompt_wav_path": "references/speaker.wav",
        "prompt_text": "The exact words in the reference recording.",
        "use_spk_emb": true
      }
    }
  ]
}
```

Use copies of permitted recordings. Preserve their source hashes, excerpt ranges and transcript
origin in a private provenance record. ASR-derived transcripts remain drafts until checked by
listening; they are not invented or silently treated as exact. The probe disables prompt caching
so repeated seeded cases do not change their random draw sequence merely because a prompt was
previously encoded. It still cannot promise bit-identical results across runtimes or devices.

## Run and inspect

```powershell
$mingPython = '.dev/ming-audition/venv/Scripts/python.exe'
& $mingPython scripts/probe-ming-tts.py --upstream .dev/ming-audition/upstream --model .dev/ming-audition/model --suite .dev/ming-audition/suite.json --out .dev/ming-audition/run-01 --check
& $mingPython scripts/probe-ming-tts.py --upstream .dev/ming-audition/upstream --model .dev/ming-audition/model --suite .dev/ming-audition/suite.json --out .dev/ming-audition/run-01 --timeout 1800
```

Use `--case 'neutral$'` for a subset and a fresh output directory on every run. The parent refuses
to overwrite an existing run. `--cancel-after 2` terminates only its own inference child two
seconds after the first case starts. A cancelled run is recorded as cancellation, never a
successful take. The watchdog also kills the child at the whole-run `--timeout` deadline.
This measures process termination/release, not cancellation through Studio's queue or Voxa.

Text normalization is **off by default** because the optional pynini dependency has no ordinary
Windows wheel. This is a named configuration difference, not an equivalent fallback: number/date
pronunciation in these runs does not qualify upstream FST normalization. Add
`--text-normalization` only in an environment with pynini installed. Normalized and unnormalized
cases need separate results. Default upstream text splitting still applies.

Qualify at least two distinct speakers, repeated neutral reads, the six Studio deliveries,
isolated and multiple vocal events, invented/Nigerian names, numbers/version strings, and long
paragraphs. Test FREEFORM without a reference separately from experimental reference-conditioned
FREEFORM. Emotion, basic attributes and cloning are different task modes, not composable manifest
promises. Voice design needs its own persistence/identity audition.

Keep three decisions separate: technical generation, words fidelity and human listening. A
successful WAV does not prove a complete read, speaker identity, accent or delivery. An ASR edit
distance is a screening aid, especially unreliable for names and vocal events. Reference repeats
compare the same words against saved source audio without making new paid provider requests;
fresh same-text cloud comparisons require a separately budgeted app operation.

Offline harness checks:

```powershell
python -B scripts/test-probe-ming-tts.py
```

No application gate is implied by these checks. Shipping requires owner listening acceptance,
repeatable hardware evidence, reviewed asset licences and a deliberate runtime/provider design.

## Original-weight tiny trial

The owner rejected the 0.5B audition's onset/mid-read artifacts and loss of Nigerian accent under
direction, and requested an actual attempt of the 7.9B-backbone variant with its original weights.
Use `--variant tiny` with a separate checkpoint directory and environment. This selects the
upstream `MingTinyTTS.from_pretrained` API without changing its BF16 loading, MoE backend,
recurrent-state policy or device placement. It does not quantize or add CPU offload.

The tiny checkpoint uses `model.safetensors.index.json` and 30 weight shards, rather than one
weight file. The runner requires every shard, hashes each file, and records initialization
failure separately from a generated case. The same suite keeps the reference audio, exact
target text and seed. Its mapped `executionRequest` records tiny's task names and input fields;
it uses the native default decode ceiling unless the corpus explicitly supplies one.
Tiny's target-language line is mapped only for seed, paralinguistic and multilingual tasks;
its basic, emotion and freeform tasks reject that line even when 0.5B accepts `language_id`.
The native resolver and probe regression checks cover this distinction. The first
tiny neutral smoke used its default 250-step ceiling and stopped normally at step 61. Subsequent
long-read comparison retains the corpus's explicit 1,000-step ceiling through the public API,
so the default 20-second ceiling cannot silently decide a longer passage's result. The journal
records stop evidence, step count and latent shape; a generated WAV alone is not wording proof.

The reference `requirements-tiny.txt` targets Python 3.10 and Linux Triton. The Windows attempt
uses a separate Python 3.13 venv, PyTorch 2.7.1+cu118, transformers 4.46.3, fla-core 0.4.2 and
`triton-windows==3.3.1.post21`. The Windows Triton fork is a runtime substitution; this is not
the exact published reference environment. NumPy remains 2.3.5 because the reference 1.26.4
has no Python 3.13 wheel. Record actual versions and any observed failure rather than inferring
failure from the nominal GPU size. A small real KDA CUDA kernel completed with finite output
in this environment before the whole-model attempt; that alone is not model qualification.

```powershell
.dev/ming-audition/tiny/venv/Scripts/python.exe -B scripts/probe-ming-tts.py --variant tiny --upstream .dev/ming-audition/upstream --model .dev/ming-audition/tiny/model --suite .dev/ming-audition/suite.json --out .dev/ming-audition/tiny/smoke-01 --case '^ife-neutral$' --timeout 600
```

Start with one short line. If it completes, compare the whispered and long reads against the
0.5B outputs, preserving the unprocessed waveforms so onset and internal artifacts can be heard.

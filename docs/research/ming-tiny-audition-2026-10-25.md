# Ming tiny original-weight trial · 25 October 2026

Decision: do not proceed with Ming integration for directed character performances on the evidence
of these auditions. The owner
confirmed that the Nigerian accent still does not hold in the 7.9B whispered clip. This tested
configuration fails the accent-preserving delivery requirement; increasing model size did not
resolve it. This is a decision about the tested workflow, not every possible Ming configuration.
The subsequent [Embers narrator audition](ming-embers-audition-2026-10-25.md) separately tests
neutral cloning for simpler narration needs.

The original BF16 model loaded on this PC's RTX 3080 10 GiB and produced neutral, whispered
and long-read speech WAVs. All three decoders stopped normally.
No quantization, explicit CPU offload, model-code patch, replacement checkpoint or alternate
inference backend was applied. This is an observed execution result, not a hardware-capacity
prediction. Acoustic quality remains a separate listening decision.

The owner requested this trial after hearing onset/internal artifacts and accent drift under
direction in the [0.5B audition](ming-tts-audition-2026-10-25.md). The new trial reuses the same
9.25-second Nigerian-English synthetic voice reference, source words and seed 1895.

## Inputs and environment

- Source: `inclusionAI/Ming-3.0-tts`, unchanged commit
  `028c1eace193e7acdb256453da89b6e9207e052b`.
- Checkpoint: `inclusionAI/Ming-3.0-tts-tiny`, revision
  `7bd9446a8d47e462362261a0150258da6d458318`.
- Original checkpoint: 30 weight shards, 17,962,089,128 bytes. Metadata counts 8,981,004,468
  elements; the constructed model reports 8,980,997,932 parameters. The 7.9B name describes
  the backbone, not the complete speech checkpoint.
- Windows 11, RTX 3080 10 GiB, NVIDIA driver 610.88. Other desktop processes remained active.
- Separate Python 3.13.11 venv; torch/torchaudio 2.7.1+cu118; transformers 4.46.3;
  tokenizers 0.20.3; accelerate 1.14.0; fla-core 0.4.2; x-transformers 2.7.4;
  triton-windows 3.3.1.post21; safetensors 0.8.0; onnxruntime 1.23.2; soundfile 0.14.0;
  scipy 1.15.3; numpy 2.3.5. Common system packages were inherited read-only.
- The Windows Triton fork, Python version and NumPy version differ from the published Linux
  reference environment. They are recorded runtime deviations; the model and weights are
  unchanged. This is not an exact-reference-environment parity claim.

A real KDA CUDA kernel returned finite output, including under the inference child's restricted
environment. Meta-device architecture construction also completed. These checks preceded the
whole-model attempt and were not counted as successful model inference.

## First neutral result

| Observation | Measured result |
|---|---|
| Original API | `MingTinyTTS.from_pretrained(..., device="cuda:0")` then `generate(task="seed", ...)` |
| Loading | 102.24 seconds after imports |
| Output | 4.88 seconds, mono 44.1 kHz PCM16 WAV |
| Synthesis | 198.56 seconds; RTF 40.69 |
| Whole worker | 313.05 seconds, excluding the preceding provenance hash scan |
| Decoder | Stopped normally after 61 steps; last stop probability 0.99995 |
| Initial ceiling | Native 250-step default; not reached |
| PyTorch allocation after load | 18,363,766,272 bytes |
| Peak PyTorch allocation | 17.54 GiB |
| Runtime contract | BF16, portable MoE loop, stable FP32 recurrent state; original trained prompt/decode protocol |
| Local ASR screen | Zero normalized word edits against the requested neutral sentence |

The allocator reported more bytes than physical GPU VRAM. These counters do not establish
physical residency or a supported hardware floor. The empirical result is that the original
checkpoint loaded on `cuda:0` and generated audio here. This run alone does not establish why
the performance has this shape or how it compares with an otherwise idle machine.

Local ASR used faster-whisper small, CPU int8, snapshot
`536b0662742c02347bc0e980a01041f333bce120`. It recovered the neutral words but cannot judge
accent, voice identity, delivery or the audible artifact reported on 0.5B.

## Targeted comparison

The matching whispered and 97-word long cases used a separate worker, loading in 76.77 seconds.
Both use the original weights. The whispered request uses native FREEFORM with speaker-reference input;
the long request retains the corpus's explicit 1,000-step ceiling through the upstream API
so its default 20-second ceiling cannot decide the result. No waveform is trimmed, denoised
or normalized by the probe.

| Case | Audio | Synthesis | RTF | Normal stop | Local ASR screen |
|---|---|---|---|---|---|
| Neutral | 4.88 s | 198.56 s | 40.69 | Step 61 | Zero normalized edits |
| Whispered | 6.08 s | 152.09 s | 25.02 | Step 76 | Zero normalized edits |
| Long, 97 words | 31.68 s | 515.10 s | 16.26 | Step 396 | One substitution: Maren → Marin |

The long screen recovered the passage through its final sentence. The name spelling difference
is not adjudicated as a speech error. ASR does not determine whether the Nigerian accent held
under whispering or whether the onset/internal artifact remains. The owner listened to the
larger-model whispered clip and reported: "No still does not hold", confirming failed accent
retention. That reply did not establish whether the onset artifact remains; its status is
unresolved. Human assessment of the other larger-model clips is not recorded.

The raw neutral waveform had two samples above full scale (peak 1.164); the long waveform had
35 (peak 1.096). These saturate when written as PCM16. The whispered waveform had none. Sparse
clipping is an observed defect to review, not a demonstrated cause of the artifact reported
on 0.5B. The local comparison page preserves the original levels and onset, with paired 0.5B
and tiny clips and the reference recording. Copied WAV hashes match their generation journals.

This establishes that original-weight inference runs here. The measured synthesis takes
16–41 times the audio duration on this occupied desktop, so these results do not qualify an
interactive Studio reader. The failed accent-retention listening result independently prevents
acceptance of this configuration. Keep the audition evidence and probe available; do not add a
Ming reader on the basis of these results.

## Validation

All three outputs are mono, 44.1 kHz, 16-bit PCM WAVs. Both workers exited successfully, with
decoder stop evidence rather than exhausted ceilings. The standalone probe's six standard-library
tests pass; source syntax, documentation links, the private-document path guard and whitespace
checks pass. Application packages were unchanged, so the full npm application gate was not run.

Private journals retain every weight-file hash, reference hash, exact execution request,
runtime versions, decoder termination evidence and output hash. They and the audio remain
local, outside tracked repository content. No live world or app reader configuration changed.

See [probe setup and boundaries](../development/ming-tts-audition.md). Sources:
[pinned upstream](https://github.com/inclusionAI/Ming-3.0-tts/tree/028c1eace193e7acdb256453da89b6e9207e052b),
[checkpoint](https://huggingface.co/inclusionAI/Ming-3.0-tts-tiny/tree/7bd9446a8d47e462362261a0150258da6d458318).

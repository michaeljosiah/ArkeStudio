# Ming 0.5B local audition · 25 October 2026

Decision: platform feasibility passed this bounded run, but the owner's subsequent listening
rejected this 0.5B configuration for inclusion. No Ming provider, model row,
Voxa protocol extension or user-facing reader was added.

The subsequent [7.9B original-weight trial](ming-tiny-audition-2026-10-25.md) ran successfully
but also failed the owner's whispered accent-retention check. The recommendation is to defer
Ming inclusion for the tested accent-preserving performance workflow.

Later voice-specific neutral tests qualified a narrower use: the owner accepted the
[Embers clone](ming-embers-audition-2026-10-25.md) and
[Dumah clone](ming-dumah-audition-2026-10-25.md) for narration. Those results do not reverse
the directed accent-retention failure. The [control audit](ming-controls-audit-2026-10-25.md)
records delivery limitations, request verification and the larger-model stress comparison.

The probe follows SPEC-046 section 2.6's listen-before-integration approach. SPEC-046 R-38's
retired local reader remains retired; historical SPEC-022/028 plans are not evidence of a
current execution path. [Setup and rerun instructions](../development/ming-tts-audition.md).

## Reproducibility and scope

- Source: inclusionAI/Ming-3.0-tts at `028c1eace193e7acdb256453da89b6e9207e052b`.
- Checkpoint: `inclusionAI/Ming-3.0-tts-0.5B`, revision
  `8d66b70a00f05ad183fa8a863b4ce609fc83cbc0`.
- Weights SHA-256: `45c4d78d8ad6b1d942e3da86ba035fece02de569f7b2ca7e9d121dfaf18d674c`.
- Windows 11, RTX 3080 10 GiB, NVIDIA driver 610.88. Other desktop applications remained active;
  roughly 3–4 GiB of GPU memory was free before/after the isolated workers.
- Python 3.13.11; torch/torchaudio 2.6.0+cu124; transformers 4.46.3; tokenizers 0.20.3;
  accelerate 1.3.0; diffusers 0.33.0; x-transformers 2.9.2; onnxruntime 1.28.0;
  numpy 2.3.5; soundfile 0.12.1. Matching torchvision 0.21.0 was installed locally.
- Dedicated venv with locally installed pinned ML libraries and read-only inherited common
  system packages. Existing ComfyUI/global packages were not modified. A clean environment and
  additional supported Windows/driver combinations remain separate qualification.
- No Flash Attention, text normalization disabled, upstream default splitting/silence trimming,
  seed 1895 and prompt cache disabled. This does not qualify the optional pynini/FST pipeline.

Two existing, synthetic character/narrator samples were copied from local worlds: a
Nigerian-English female voice and a coastal British female narrator. Reference excerpts were
9.25 and 5.97 seconds. Source hashes, excerpt ranges and reference hashes are retained locally.
Their transcripts came from local ASR and await human verification. No live world was modified,
no recording was uploaded, and no new paid cloud synthesis was requested.

The 28 cases cover same-text reference repeats, neutral/repeated neutral, whispered, breaking,
urgent, warm, cold, sad emotion mode, inline vocal events, names, numbers/version/date strings,
and a 97-word passage through both voices, plus reference-free FREEFORM and voice design.
Reference-conditioned FREEFORM was deliberately experimental: upstream recommends its
reference-free form. Task availability does not prove identity preservation under direction.

## Measured technical results

| Observation | Result |
|---|---|
| Generated cases | 28/28; all container/duration/hash readbacks verified |
| Output | Mono 44.1 kHz PCM16 WAV |
| Total generated duration | 234.3 seconds |
| Total measured synthesis time | 585.36 seconds |
| Whole worker elapsed | 598.29 seconds |
| Median real-time factor | 2.494; range 2.449–2.632 |
| Model construction/load | 3.15 seconds after Python/library imports, with warm OS file cache |
| Peak PyTorch allocated memory | 2,938.93 MiB / 2.87 GiB |
| Peak PyTorch reserved memory | 3,086 MiB / 3.01 GiB |
| Repeated neutral reads | Identical WAV hashes for each speaker under the fixed seed |
| Output level exception | Four samples above full scale in one long read; raw peak 1.056 |
| Cancellation | Worker killed about two seconds into synthesis; process exit observed |
| Restart after cancellation | Fresh worker succeeded; WAV hash matched the main run |
| Deadline | Deliberate one-second worker deadline terminated the child and recorded timeout |

Memory figures describe PyTorch's allocator, not total process/driver memory or a supported
minimum GPU capacity. Machine-wide free-memory readings returned after worker exit but include
unrelated applications. The restart/cancellation tests are process tests, not Studio queue or
Voxa cancellation tests. Synthesis timing excludes WAV encoding/writing and includes prompt
encoding, generation and waveform transfer; whole-worker timing includes imports and loading.

The longer passage produced 35.8 seconds through the first voice and was generated in 88.62
seconds. This is a paragraph test, not a chapter-length or 300/600/1,200-word stress test.
The first voice's same-text reference repeat ran 5.5 seconds versus a 9.25-second reference:
voice cloning must not be assumed to retain the source's pace or performance.

## Words screening and listening

Local faster-whisper small, CPU int8, snapshot
`536b0662742c02347bc0e980a01041f333bce120`, screened every generated WAV after the main run.
22/28 had zero normalized word edits against the requested speech. The six nonzero cases were
both name lines, both number lines and both long passages. The number transcripts preserved
the displayed amount/version/date but rendered the time differently; the long passages differed
on a proper name's spelling. These edit rates are screening evidence, not adjudicated TTS errors.
ASR cannot establish correct names, identity, accent, vocal events or delivery.

Owner listening feedback, 25 October 2026: a strange artifact was audible at the beginning;
the long read also contained the artifact within the passage. The Nigerian accent held in
neutral delivery but shifted to American under direction such as whispering. This rejects the
auditioned configuration's acoustic cleanliness and directed accent retention. These are the
owner's listening observations; their cause has not been diagnosed. The owner requested a
separate trial of the 7.9B-backbone variant with its original weights.

A local listening bundle preserves the reference
excerpts, all 28 generated WAVs, requested text/direction, ASR screens and exportable review notes.
It compares saved Google samples with Ming on the same reference-repeat words; it does not
constitute a fresh paid A/B across the existing reader catalogue. Private recordings, world
paths, raw journals, model weights and the listening bundle are not repository content.

## Inclusion gates

1. Verify the two reference transcripts and judge speaker identity/accent under neutral and
   directed reads. Stop the inclusion work if the listen fails.
2. Qualify a clean distributable Windows runtime, output-level handling and realistic long-read
   bounds. Repeat on the actual minimum supported hardware; this single run sets no VRAM floor.
3. Qualify normalization separately, plus persistence/reuse of a newly designed voice. This run
   generated a design sample but did not test a saved designed identity across later reads.
4. Review bundled asset/dependency licences, then design a distinct local reader using existing
   voice ownership/reference/queue/cadence contracts. The source and checkpoint cards declare
   MIT; that is not a completed distribution inventory.

The reusable probe's four offline boundary/environment tests passed; syntax, new documentation
links, private-document placement and `git diff --check` passed. Application lint/typecheck/build
and workspace tests were not run: this change adds standalone qualification tooling/documentation
and does not change application execution. It is not release validation.

Sources: [pinned source and cookbook](https://github.com/inclusionAI/Ming-3.0-tts/tree/028c1eace193e7acdb256453da89b6e9207e052b),
[checkpoint](https://huggingface.co/inclusionAI/Ming-3.0-tts-0.5B/tree/8d66b70a00f05ad183fa8a863b4ce609fc83cbc0),
[source licence](https://github.com/inclusionAI/Ming-3.0-tts/blob/028c1eace193e7acdb256453da89b6e9207e052b/LICENSE).

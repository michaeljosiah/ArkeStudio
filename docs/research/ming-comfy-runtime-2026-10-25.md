# Ming with an existing ComfyUI Python · 25 October 2026

The owner requested a compatibility check that leaves ComfyUI's dependencies unchanged.
This is a standalone local probe, with no provider registration, application runtime change,
world write, custom-node installation or server startup. It follows SPEC-046 section 2.6's
probe-first boundary. It does not restore the retired reader in SPEC-046 R-38.

## Environment and protection

The existing repository install identifies itself as ComfyUI 0.38.1. Its launcher activates
its own Python 3.13.11 venv, with system site-packages disabled. This is an existing user
installation, not Arke's downloadable portable archive. Its relevant installed packages are:

| Package | Existing ComfyUI environment |
|---|---|
| torch | 2.12.1+cu130 |
| torchaudio | 2.11.0+cu130 |
| torchvision | 0.27.1+cu130 |
| transformers | 5.12.1 |
| tokenizers | 0.22.2 |
| diffusers | 0.38.0 |
| x-transformers | 2.25.5 |
| accelerate | 1.14.0 |
| numpy | 2.2.6 |
| onnxruntime | 1.29.0 |

Before inference, a private snapshot recorded all 97,311 venv files by path, byte size and
nanosecond modification time; 1,794 package-metadata, path-configuration and interpreter files
also received SHA-256 hashes. Imports disable bytecode writes. Worker environments omit
provider credentials, disable Hub network access, and direct model, compiler and temporary
caches into the audition scratch directory. Nothing is installed into ComfyUI's environment.

The source and original checkpoints are unchanged from the earlier auditions. Each attempt
uses one 11-word English sentence, the original Embers reference, its transcript, seed 1895
and a 1,000-step ceiling. Each worker has a bounded lifetime. Audio and detailed journals
remain in ignored private scratch storage.

## Direct reuse

Both public APIs import successfully. That is insufficient to establish model compatibility:

- 0.5B loads its checkpoint, then fails when the newer torchaudio loader attempts to decode
  the reference through TorchCodec. The requested `soundfile` backend is ignored. The local
  TorchCodec loader reports missing/unloadable FFmpeg libraries; this probe does not diagnose
  all possible ABI causes or repair the existing audio stack.
- 7.9B refuses model loading because its native API explicitly requires Transformers 4.46.3.

## Separate overlays

Small dependencies are copied from the previously auditioned environments into independent
Ming-only package directories. Their exact versions and file hashes are recorded privately.
Neither overlay contains torch, torchaudio or CUDA libraries. The worker prepends its overlay
only to its own module search path; ComfyUI retains its original package resolution.

The dense overlay contains Transformers 4.46.3, tokenizers 0.20.3, huggingface-hub 0.36.2,
x-transformers 2.9.2, diffusers 0.33.0 and accelerate 1.3.0: 71,142,333 bytes without bytecode.
The tiny overlay uses x-transformers 2.7.4 and accelerate 1.14.0, omits diffusers and adds
fla-core 0.4.2 and triton-windows 3.3.1.post21: 174,993,505 bytes without bytecode.

A process-local adapter replaces only Ming's reference-file loading call with an explicit
SoundFile float32, channel-first read. Ming retains its own resampling, speaker encoder,
padding and synthesis. The torchaudio package and its global loader remain unchanged. This
adapter is a named departure from invoking upstream without adaptations.

0.5B generated a 2.40-second mono 44.1 kHz PCM16 clone in 7.77 seconds after loading. The raw
waveform peak was 0.3704 with no full-scale samples. Local Whisper-small CPU-int8 screening
recovered the complete sentence with zero normalized word edits. No owner listening verdict
has been collected for this runtime change.

The first tiny overlay attempt failed to locate its bundled C compiler: Triton looks under
the interpreter's site-packages rather than the external overlay. An explicit worker-only
`CC` path resolves that setup issue. The next attempt reached PyTorch's compiler imports,
which require a username even with compiler caches redirected; the stripped environment
omitted it. The following worker uses a fixed scratch-cache username. These are recorded
probe setup failures, not successful model runs or proof of a torch incompatibility.

With those launch settings, tiny loaded in 73.73 seconds and generated a finite 1.36-second
PCM16 waveform in 319.67 seconds, stopping normally at step 17 of 1,000. Peak amplitude was
0.4384 with no full-scale samples. Its advisory transcript was only "I kept the letter because
I thought", omitting the final four words (normalized edit rate 0.364). This is a successful
execution but an incomplete reading. A cold scratch compiler cache was used; no warm-run
speed or cause of the delay is established. A matched request in the previously auditioned
dedicated environment was then run to distinguish an existing request/model issue from a
shared-environment difference.

The dedicated control (torch 2.7.1+cu118, torchaudio 2.7.1+cu118, Transformers 4.46.3)
also generated 1.36 seconds, stopped at step 17 and transcribed as exactly the same incomplete
sentence, with edit rate 0.364. Suite, original weight-shard and speaker-encoder hashes match
between the two attempts. The control loaded in 74.29 seconds and synthesized in 237.28
seconds. It reused the scratch compiler-cache directory; these single runs do not isolate
individual dependency effects or provide a controlled speed comparison. The omission is
reproduced outside ComfyUI's environment; it cannot be assigned to sharing from this evidence.
The waveforms have different hashes, so this is not bit-identical numerical parity.

## Final checks and scope

After all ComfyUI-runtime attempts, the venv inventory still contained the same 97,311 files,
with zero additions, removals or changed byte sizes/modification times. All 1,794 hashed
metadata/configuration/interpreter files also matched. This is an inventory and selected-hash
comparison, not a full content hash of every installed binary. ComfyUI's original Transformers
5.12.1 and torch 2.12.1+cu130 resolved from its own environment afterwards; imports of
`comfy.model_management`, `comfy.sd` and `comfy.sample` and a finite CUDA matrix operation
passed. No image/video workflow was rendered as part of this check.

The 0.5B result establishes one successful short clone with the shared GPU stack, not universal
compatibility with other ComfyUI installations, long-read fidelity, delivery parity or a
distributable installer. Tiny executed against the shared stack, with the same omission as the
dedicated control; neither incomplete output passes word-fidelity acceptance. No owner verdict
on voice or delivery parity has been collected for either shared-runtime output.
Overlay sizes exclude model weights, caches and installation staging space. Application code
is unchanged, so the full npm gate is not run for this standalone research check.

## Decision

Reusing this existing Python/PyTorch/CUDA installation is technically viable through separate
Ming workers, without altering ComfyUI's dependencies. The demonstrated additions are about
71 MB for the dense overlay or 175 MB for tiny, plus model weights, worker code and writable
caches. They replace the need to duplicate the large GPU libraries for this tested stack.
This is not direct reuse of every ComfyUI package: Ming needs its older dependencies isolated
and an explicit audio-loading adapter. Other ComfyUI/Python/GPU combinations need their own
compatibility checks and a standalone fallback. The native task contracts and the existing
long-read, accent and direction limitations remain unchanged.

All inference workers exited. Scratch-script syntax, copied overlay hashes, generated WAV
headers/hashes, matched-control provenance, touched-document links, the private-document path
guard and whitespace checks pass. Detailed attempts, setup failures, ASR screens and before/after
inventories remain local under the ignored audition directory. No application setting changed.

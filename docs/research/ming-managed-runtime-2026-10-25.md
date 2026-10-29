# Ming against Arke's managed ComfyUI runtime · 25 October 2026

Both Ming variants execute using the Python/PyTorch/CUDA installation in Arke's pinned
ComfyUI portable archive. Ming needs isolated smaller packages and two process-local adapters;
it cannot use the bundle's packages unchanged. This qualifies this specific Windows/NVIDIA
stack, not arbitrary existing installations or narration fidelity.

## Verified artifacts and environment

The tested archive is the setup catalogue's ComfyUI **0.38.0** NVIDIA Windows portable
[release artifact](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.38.0),
1,994,326,521 bytes, SHA-256
`8f137eac345707fd7e42bcf8e29377415243011ca15522a86aed6c77331fbd56`.
It contains Python 3.13.14, torch 2.14.0+cu130, torchaudio 2.11.0+cu130,
torchvision 0.29.0+cu130, Transformers 5.17.0 and NumPy 2.5.3.
The test machine is an RTX 3080 with 10 GB VRAM and driver 610.88.

The Ming source remains pinned at `028c1eace193e7acdb256453da89b6e9207e052b`.
Original checkpoint weights, reference audio/transcript, target sentence, seed 1895 and the
1,000-step ceiling match the previous existing-runtime control. No quantization is introduced.

## Isolated additions

Ming's older Transformers and other missing/incompatible packages are copied into a separate
dependency overlay. PyTorch, CUDA, torchaudio, torchvision, NumPy, SciPy and compatible shared
utilities continue to resolve from the managed bundle. No pip operation targets that bundle.
The copied closure occupies 124,232,233 bytes for 0.5B and 231,110,238 bytes for 7.9B, excluding
weights, caches and installation staging. These copies demonstrate compatibility; they are
not a distributable wheel lock or installer.

Two adaptations are required inside the worker:

- Ming's reference loader uses SoundFile to produce float32, channel-first audio. The native
  torchaudio transforms remain shared; neither torchaudio files nor its global module change.
- The vocoder constructs complex64 explicitly after the original BF16 exponential/trigonometric
  operations. The unadapted expression fails with an unsupported `BComplex32` CUDA multiply
  in this managed PyTorch build. Only the worker's Ming `ISTFTHead.forward` changes.

Tiny's Triton compiler additionally requires matching Python headers/import libraries absent
from the embedded distribution. Only those files and the licence are extracted from the
official [Python 3.13 NuGet distribution](https://docs.python.org/3.13/using/windows.html#the-nuget-org-packages):
2,440,125 bytes, outside the shared runtime. The Python 3.13.14 NuGet archive's SHA-256 is
`9ac15cfa6cab1115c83d48f2af55c554efa4d1bb044bbc4ab1c9d17ad426e16c`;
its bytes also match NuGet's published SHA-512. The worker redirects Triton's compiler lookup
to this SDK and uses its isolated TCC. No system SDK is assumed.

## Results and limits

| Variant | Audio | Synthesis | Advisory local transcript screen |
|---|---:|---:|---|
| 0.5B | 2.40 s | 6.80 s | Complete sentence; zero normalized edits |
| 7.9B | 1.36 s | 191.55 s | Stops at step 17; omits final four words |

The larger variant repeats the same 1.36-second truncation seen in its dedicated-runtime
control. Successful execution is not a word-fidelity pass. These are single short probes,
not a performance benchmark or a new listening verdict.

Before/after inventories contain the same **57,017** embedded-runtime files, with no changes
to names, sizes or modification times. All **892** selected metadata/configuration/interpreter
hashes match. This is not a complete hash of every binary. Afterwards, original ComfyUI core
imports (`model_management`, `sd`, `sample`) and a finite CUDA matrix operation pass.
No image/video workflow was rendered.

A further native check uses the implemented `MingProcess` and three-engine `LocalGpu` lane:
Arke-owned portable Ollama 0.40.11 starts on a private port with an empty dedicated model
store, yields to a real 0.5B batch, and is admitted again only after Ming exits. That batch
generates 2.40 seconds in 7.34 seconds, with peak PyTorch allocation 3,100,709,376 bytes.
Ollama's downloaded archive matches its catalogue SHA-256. This checks process ownership
and handover, not loaded Ollama model eviction or a simultaneous ComfyUI image job.
A separate native check confirms that Ollama creates its identity key in the Arke-owned
runtime home, reads an empty dedicated model store, and confirms process exit on disposal.

All tested workers exit. Detailed provenance, package inventories, audio and source passages
remain under ignored local scratch. The application-side integration and its remaining
reader-packaging boundary are described in [Managed local runtimes](../development/managed-local-runtimes.md).

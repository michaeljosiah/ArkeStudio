# H3 adapter acceptance — 25 September 2026

The catalogue owner reviewed the ten completed neutral geometry videos, accepted their outputs,
and explicitly approved all fourteen pinned adapters while waiving further GPU runs. This is
recorded as **owner-approved**, not as fourteen passed GPU tests. The approval applies only to
`comfyui-h3-video` (864×480, 24 fps) at adapter strength **1**. Other recipe pairings remain
unverified; combinations and other strengths are not approved.

The [machine-readable evidence](h3-adapter-validation.json) records exact release/weight hashes,
generated-output hashes, timings and available memory samples. Tests used seed 9123 and requested
five seconds of a red cube and blue sphere moving on a tabletop. No further generations or
no-adapter speed comparison were run after the owner's stop instruction.

| Outcome | Adapters |
|---|---|
| Generated; outputs accepted by owner | HMBreastsV2; HMBreasts_085e0750_e40; HMCumshot_V1.0; HMCumshot_V2; HMInnie_v1_e50; HMMisDogV2; HMNSFW_AIO_V2; HMPenis_v2_e35; Vagina_minimax-h3_epoch20; hmmasturbation_v2 |
| Blocked before generation by free-VRAM admission | HMNSFW-AIO-V2.5; HMSquirtV0.1 |
| Not run | hmpussy_v6_epoch30; vagassist_e40 |

The engine was ComfyUI 0.33.1 at commit `72865f4f27eaf5396f8f36370e0a2be3a9a090ee`,
with custom nodes disabled, PyTorch 2.12.1+cu130, an RTX 3080 10 GB and 32 GB system RAM.
All fourteen weight downloads matched the pinned sizes and SHA-256 hashes. Direct CUDA component
patch probes passed against both base headers. Separate optional bypass probes produced non-finite
outputs for the two LoKR artifacts (HMCumshot_V2 and hmpussy_v6_epoch30); that is not the default
weight-patching path, and HMCumshot_V2 subsequently completed a full generation.

The first video was recovered after its runner stopped recording; its continuous memory samples
are unavailable. The final video was collected after stopping the batch launcher, so its memory
samples are incomplete. Other memory minima are periodically sampled, not instantaneous peaks.
This record does not establish cancellation coverage, a usable strength range, higher-resolution
performance, reference-video compatibility or superiority over base H3. Owner acceptance waives
further testing for the stated catalogue scope; it does not fabricate those measurements.

Owner-approved pairings retain the base recipe's hardware and engine guards. Adult-mode
acknowledgements, exact-byte checks, installation state, compliance decisions and revocation
remain independent. The default host still has no connected compliance agent, so catalogue
approval alone does not make installation or dispatch available.

The local review gallery is `.dev/h3-adapter-validation/review/index.html`; its media and raw
reports are local artifacts, not repository contents. The checked-in hashes identify the outputs
the owner accepted without publishing the videos or local machine paths.

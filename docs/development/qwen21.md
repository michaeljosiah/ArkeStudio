# Qwen Image 2.1 local recipe

`comfyui-qwen21-image` implements SPEC-021 R-2, R-13 and R-16 as a separate research recipe.
It offers 1024 × 1024 PNG images and one optional reference. Krea and SDXL keep their
existing identities and defaults. The [Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE)
permits noncommercial research and evaluation; commercial use requires separate terms. The
model row says **Research** for that reason.

The graph uses the native Qwen 2.1 encoder, INT8 ConvRot transformer and encoder weights, BF16
VAE, forty Euler/simple steps, CFG 1, disabled prefix caching, and tiled decoding (512/64).
The immutable publisher revision and three SHA-256 hashes live in
`packages/providers/src/comfyui/qwen21-recipe.ts`. Existing matching weights can be reused.

References are center-cropped to a square, then scaled to 1024 before encoding. Subjects near
the edges can be cropped: prepare square references when framing matters. Alpha is rejoined
after loading and preserved in PNG output. Editing uses the encoder's first-reference latent;
text-only generation uses the declared empty canvas. Arke translates `@Image 1` to the native
`<image1>` marker before prompt review and submission.
Precise relative scale is not assured. 2K output is not offered in this version.

## Runtime setup

The reference machine is Windows, RTX 3080 10 GB and 32 GB RAM. ComfyUI 0.37.0, Torch
2.12.1+cu130, comfy-kitchen 0.2.35 and comfy-aimdo 0.5.5 were exercised. Earlier default and
partially modified configurations stalled. This recipe requires a conservative engine launch,
including standard Torch kernels instead of Comfy Kitchen's optimized CUDA/Triton backends.

Install the pinned runtime guard into an engine containing `main.py`:

```powershell
node scripts/install-comfyui-qwen21.mjs C:/path/to/ComfyUI
```

The offline installer verifies source and installed content, refuses differing files, and writes
the existing `.arke-content-id` marker. It does not install weights, upgrade packages, patch
ComfyUI core or change a running engine. Install the engine's requirements in its environment.
From the ComfyUI directory, using that environment's Python:

```powershell
python main.py --listen 127.0.0.1 --port 8189 --disable-api-nodes --disable-dynamic-vram --disable-pinned-memory --disable-async-offload --disable-cuda-malloc --reserve-vram 4.5
```

Point Arke's ComfyUI URL at `http://127.0.0.1:8189`, map the models directory, and re-verify.
For a URL engine, the runtime guard must also be visible in `custom_nodes/ArkeQwen21Runtime`
beside the mapped models directory, under the same existing rule as Krea's node.
If using `--disable-all-custom-nodes`, add `--whitelist-custom-nodes ArkeQwen21Runtime`.

On ordinary launches the guard changes nothing and does not register its required node, so
the recipe remains unavailable. Under the explicit profile it selects eager kernels before
generation; validation and execution recheck the flags and backend. A missing-node readiness
result means to check this setup as well as the installed file. Arke's managed/default-path
launcher does not silently adopt these engine-wide flags: use the URL setup. Other recipes in
that process share its kernel and memory settings. Use a dedicated Qwen engine profile;
switch back to the ordinary engine URL for other recipes. Compatibility with other recipes
under this profile is not established.

Admission requires a 10 GB CUDA card and 30 GiB visible RAM, plus conservative free-memory floors
of 6500 MiB VRAM and 10000 MiB RAM (rounded up from about 9972 MiB before the measured edit).
The provider requests idle model unloading before refusing
a busy machine. These are admission policies, not a guarantee every prompt or reference fits.

## Evidence and limits

On 2026-09-22 the isolated conservative profile completed four consecutive API jobs: a four-step
diagnostic (62 s), two different-seed forty-step text images (148 s each), and a 25-step edit
(168 s). Text peaked near 8007 MiB whole-GPU use; editing reached 9261 MiB. Available RAM briefly
fell to 753 MiB during edit loading. Timings include loading and polling, exclude engine startup,
and describe a multitasking desktop. Small samples do not establish broad reliability.

The combined settings are a workaround, not a proven root cause. Relevant upstream reports:
[Ampere repeated-run freezes](https://github.com/Comfy-Org/ComfyUI/issues/14719),
[Qwen prefix-cache abort](https://github.com/Comfy-Org/ComfyUI/issues/16443), and
[proposed prefix-cache fix](https://github.com/Comfy-Org/ComfyUI/pull/16450).
The proposed fix is not included: cache-disabled failures also occurred. Earlier multi-reference
evaluation retained recognizable designs but missed scale and duplicated an object.

The shipped graph's text-only provider smoke check completed in 141 seconds, and its forty-step
one-reference edit completed in 231 seconds. Both produced inspected 1024-square PNGs through
Arke; the edit retained the reference teapot's shape and glaze while changing the setting.
A two-reference
candidate stalled before its first sampling step with a stack in weight transfer, so v1 accepts
one reference and refuses a second before upload. The managed download pin is raised to the
publisher's digest-verified 0.37.0 release (SPEC-021 R-21); its normal launcher still needs the
explicit URL/profile setup above for Qwen. This does not update an existing user installation.

A Krea compatibility check under this Qwen profile completed all sixteen sampling steps at 2K,
but stopped progressing during VAE decoding. Two stack samples remained in the same VAE
normalization call; the owned test engine was stopped after about four minutes without decode
completion. This was a multitasking run, not a controlled performance comparison. It does not
establish a Krea regression on its ordinary profile, but rules out claiming shared-profile
compatibility from this evaluation.

## Checks

```powershell
npm test --workspace @arke-studio/providers
npm run typecheck --workspace @arke-studio/providers
node --test scripts/test/install-comfyui-qwen21.test.mjs
python scripts/test/qwen21-runtime.test.py
node --import tsx packages/providers/scripts/smoke-qwen21.ts C:/path/to/ComfyUI C:/path/to/models http://127.0.0.1:8189 .dev/qwen-text
node --import tsx packages/providers/scripts/smoke-qwen21.ts C:/path/to/ComfyUI C:/path/to/models http://127.0.0.1:8189 .dev/qwen-edit .dev/qwen-text/output-1.png
```

Create the destination's parent first; every run requires a new destination. The smoke check
verifies weight and runtime-source hashes, loaded classes and engine version, then submits
through Arke's provider client and saves the exact graph, output and report. A second reference
is refused in v1. `ARKE_SMOKE_PROMPT` and `ARKE_SMOKE_SEED` vary the test without
changing the recipe. Inspect images: success alone does not establish useful quality.

Unit coverage includes absent-reference pruning, ordered uploads, alpha wiring, bounded canvas,
immutable graph identity, runtime/profile refusal and preservation of existing install files.

# Krea 2 local images

Arke's `comfyui-krea2-image` runs Krea 2 Turbo locally, with up to four ordered image-edit
references. `comfyui-draft-image` remains SDXL for existing jobs. The graph, weights, node pin,
hardware floors and output sizes belong to `packages/providers/src/comfyui/krea2-recipe.ts`.

## Quality baseline

Checked against primary sources on 2026-09-07:

- [Krea's inference guidance](https://github.com/krea-ai/krea-2): use Turbo for inference,
  eight steps, disabled CFG and fixed timestep shift `mu = 1.15`. Raw is intended for training
  and post-training, not a higher-quality inference preset.
- [ComfyUI's Krea tutorial](https://docs.comfy.org/tutorials/image/krea/krea-2): the Turbo FP8
  model and FP8 Qwen3VL encoder are the recommended local baseline. The recipe uses the
  installed FP8 files, Euler/simple, and `cfg: 1` (ComfyUI's no-guidance value). ComfyUI 0.33.1
  sets the Krea model's shift to 1.15 itself; it needs no extra sampler patch.
- [Krea's prompting guide](https://github.com/krea-ai/krea-2/blob/main/docs/prompting.md): use
  natural-language descriptions with explicit materials, composition, lighting and style;
  quote words that should appear in the image. Its example images use native 2K output.

The shipped quality preset uses **sixteen steps**: on the reference RTX 3080, the publisher's
eight-step baseline produced strong residual noise at 2048 × 2048. Tiled VAE decoding did not
remove it. A matched sixteen-step run with the same prompt, seed, weights and native resolution
produced a clean image; the eight-step 1024 × 1024 control was also clean. This is local evidence
for the 2K preset, not a claim that sixteen steps are universally optimal or the author's default.

The recipe offers a 2K tier, with 2048 on the longest side and 2048 × 2048 for square images.
This is native synthesis, not an upscale. Text-only runs use the native text encoder and do
not apply hidden style LoRAs or the custom edit node's conditioning adjustments. Arke's existing
prompt-enhancement workflow remains the place to expand a prompt; the provider preserves it.

With references, the installed image-edit workflow's conditioning settings apply: refocus 0.8,
guidance 0.5, split conditioning enabled, and 512-pixel reference encoding with preserved aspect
ratio. These are the pinned workflow's settings, not a claim that Krea endorses the community
editing method or that they are universally optimal. More sampler steps or stronger conditioning
are not automatically better. Exact identity retention and artistic preference need evaluation
on the user's images; successful execution alone does not establish either.

## Setup

Use ComfyUI 0.33.1 or later and a mapped local models directory. Install the vendored node:

```powershell
node scripts/install-comfyui-krea2.mjs C:/Users/mjosi/source/repos/ComfyUI
```

The argument names the directory containing `main.py`, not the models directory or the parent
of the checkout. The installer uses no network, verifies each source and destination hash,
refuses differing files and writes `.arke-content-id` only after verification. It can verify an
identical existing checkout. Restart ComfyUI if the node was not loaded, then use Re-verify in
Arke. Installer regressions run with `node --test scripts/test/install-comfyui-krea2.test.mjs`.

Settings can fetch the three weights from the [pinned Comfy-Org release](https://huggingface.co/Comfy-Org/Krea-2/tree/e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96).
Their names and SHA-256 hashes are in the recipe. Existing identical files satisfy verification.
For a URL engine, Arke locates `custom_nodes` beside its mapped `models` directory. A shared
model library must also expose the verified node there, or the recipe correctly remains disabled.
Neither model detection nor a node merely appearing in `/object_info` substitutes for verification.

The custom-node installer is a developer setup command in this integration. The desktop's weight
download action does not install Python extensions. Engines without the node remain unavailable.

## Validation

On 2026-09-07, native 2048 × 2048 text generation and a subsequent one-reference edit were
visually checked on an RTX 3080 10 GB with 32 GB system RAM. The sixteen-step reference edit
completed through Arke's provider client in 369 seconds, retaining the blue ceramic teapot
while changing its surroundings to a rainy window scene. GPU usage reached approximately
9.7 GB. Four-reference dispatch is covered by unit tests; its quality and memory use have not
been measured on this card.

From the repository root:

```powershell
npm test --workspace @arke-studio/providers
npm run typecheck --workspace @arke-studio/providers
node --import tsx packages/providers/scripts/smoke-krea2.ts C:/Users/mjosi/source/repos/ComfyUI .dev/krea2-quality/text
node --import tsx packages/providers/scripts/smoke-krea2.ts C:/Users/mjosi/source/repos/ComfyUI .dev/krea2-quality/reference .dev/krea2-quality/text/output-1.png
```

The GPU check requires an idle engine on port 8188 and verifies local weight hashes and the node
marker before dispatch. It runs through Arke's provider client, saves the returned PNG and a
report with recipe identity, runtime and initial system memory. The second run uses the first
image as an editing reference. Outputs stay under gitignored `.dev/`; inspect both visually.
Unit tests cover zero, one and four references, order, safe upload names, absent carrier removal,
preflight refusal, incomplete upload refusal and template immutability without using the GPU.

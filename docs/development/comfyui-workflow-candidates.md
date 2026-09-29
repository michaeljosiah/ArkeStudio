# ComfyUI workflow candidates for Arke

Reviewed 2026-09-22 against the official Comfy documentation and template catalogue. These
are candidates for evaluation, not installed recipes or claims of compatibility with a 10 GB
card. The priority order is an Arke product judgment: useful transformations of existing
production assets come before another general image generator.

| Priority | Workflow and primary source | Proposed Arke use | What needs proving |
|---|---|---|---|
| 1 | [BiRefNet background removal](https://docs.comfy.org/tutorials/utility/remove-background-birefnet) · [official JSON](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/utility_birefnet_remove_background.json) | Produce transparent character/prop cutouts and masks from existing reference art. Native Comfy support; the documentation identifies MIT-licensed weights. | Fine hair, horns, translucent edges, difficult backgrounds, alpha round-trips, pinned model digest and measured memory. |
| 2 | [SeedVR2 3B INT8 image upscale](https://docs.comfy.org/tutorials/utility/seedvr2) · [official JSON](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/utility_seedvr2_3b_int8_upscale_image.json) | Evaluate 1K-to-2K finishing for Qwen output without asking its generator to sample/decode at 2K. The native template also has a video variant; the documented models use Apache 2.0. | Identity and texture changes, alpha handling, tiled decoding, actual 10 GB fit, output bounds and the full dependency closure. Upscaling is not additional ground-truth detail. |
| 3 | [Qwen-Image-Layered](https://docs.comfy.org/tutorials/image/qwen/qwen-image-layered) · [official JSON](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_layered.json) | Decompose scene art into separate RGBA layers for compositing and parallax experiments. | A multi-layer artifact/selection contract rather than silently keeping one PNG, ordering and recomposition fidelity, weight licence and VRAM. This is a larger integration than a catalogue row. |
| 4 | [FLUX.1 Fill inpainting/outpainting](https://docs.comfy.org/tutorials/flux/flux-1-fill-dev) · [inpaint JSON](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/flux_fill_inpaint_example.json) · [outpaint JSON](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/flux_fill_outpaint_example.json) | Repair a selected part of a shot or extend a background while preserving the surrounding frame. | Explicit mask inputs and preview, unaffected-region fidelity, hardware fit and applicable model-use terms. |

The official [Qwen 2.1 editing template](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_image_edit.json)
remains the upstream reference for the implemented recipe. Its broader reference support is
not a reason to remove Arke's measured one-reference limit. Wan 2.2 TI2V 5B already underpins
Arke's draft-video recipe, so it is not a new catalogue candidate.

Start with BiRefNet and SeedVR2 image upscaling. Each needs the same authored-graph, immutable
dependency, fresh-install and real-GPU checks described in [recipe authoring](comfyui-recipes.md).
The downloadable editor JSON is source material for an authored API graph, not something Arke
should accept from a user or execute without inspecting and pinning its dependencies.

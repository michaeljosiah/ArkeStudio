# Adding or changing a ComfyUI recipe

Follow this order for a shipped recipe. The [code map](code-map.md) locates the owners;
[SPEC-021 §2.3](../specifications/021.local-image-and-video-generation.md) defines the recipe contract. Existing
examples are [Krea 2](krea2.md) and [H3 reference video](h3-reference-video.md). A graph that
submits successfully is not yet a verified recipe.

1. **Author the API-format graph in the provider package.** Start with a ComfyUI API export:
   a record of node IDs with `class_type` and `inputs`, whose links are `[nodeId, outputIndex]`.
   The editable UI export with node positions and widgets is not a dispatch graph. Add a focused
   `*-recipe.ts` beside [krea2-recipe.ts](../../packages/providers/src/comfyui/krea2-recipe.ts)
   and [h3-reference-recipe.ts](../../packages/providers/src/comfyui/h3-reference-recipe.ts),
   using `ComfyUiRecipe` from [recipes.ts](../../packages/providers/src/comfyui/recipes.ts).
   Give it a stable ID, an initial `recipeVersion`, the measured engine range and one declared
   `outputNode`. Register it in `COMFYUI_RECIPES`. Keep graphs out of client state and manifests.

2. **Declare the bounded parameters and every binding.** Use the existing `RecipeParamSpec`
   kinds, ranges, enums and string limits. For a replacement, make a worksheet before changing
   the graph:

   | Application value | Old node / input | New node / input | Type or range change |
   |---|---|---|---|
   | Prompt | `6 / text` | `7 / prompt` | Record the new character cap |
   | Seed | `3 / seed` | `9 / seed` | Record the accepted integer range |

   Every `bind` must name an existing leaf input. `bind: []` means a value feeds the client's
   derivation, such as aspect or duration; it is not an unused graph parameter. Derived width,
   height, frame count and uploaded reference names are `internal` and cannot be supplied by
   callers. Check the existing `VIDEO_DERIVATIONS` and
   [ComfyUiClient](../../packages/providers/src/clients/comfyui.ts) before adding derivation
   logic. Declare optional reference carriers and all their consumer slots in the recipe so
   pruning an absent reference cannot leave a dangling link. Preserve the text-only path where
   supported. Existing graph substitution, polling, cancellation and artifact fetching should
   need no new job-runner mechanism.

3. **Pin and verify the complete dependency set.** Each checkpoint declares its models-relative
   filename, size, immutable download revision and SHA-256. For Hugging Face weights, obtain the
   publisher's LFS pointer at that exact repository revision: its `oid sha256:<digest>` is the
   digest of the served weight bytes. The Git commit ID, Git blob ID and hash of the pointer
   text are different values. For example, download the Krea pointer without downloading 12 GB:

   ```powershell
   New-Item -ItemType Directory -Force .dev/recipe-pins | Out-Null
   curl.exe --fail --location --output .dev/recipe-pins/krea2.lfs https://huggingface.co/Comfy-Org/Krea-2/raw/e5ea8b4dd7f38f348b138eb0fe29f92c0e367e96/diffusion_models/krea2_turbo_fp8_scaled.safetensors
   Get-Content .dev/recipe-pins/krea2.lfs
   (Get-FileHash -Algorithm SHA256 -LiteralPath C:/path/to/ComfyUI/models/diffusion_models/krea2_turbo_fp8_scaled.safetensors).Hash.ToLowerInvariant()
   ```

   Compare the local digest with both the pointer OID and recipe `sha256`; record the source
   URL, revision and verification date in the setup note. Repeat for encoders, VAEs and LoRAs.
   Pin custom-node revisions and use the existing content verification/install pattern from
   [Krea's installer](../../scripts/install-comfyui-krea2.mjs). A loaded class in `/object_info`
   does not prove its provenance. If the complete dependency closure is unknown, declare
   `requires.unavailableReason` rather than offering an unverified graph as ready.

4. **Add the manifest projection alongside the recipe.** Follow `COMFYUI_MANIFEST_MODELS` in
   [recipes.ts](../../packages/providers/src/comfyui/recipes.ts), or `H3_REFERENCE_MODEL`.
   Keep `accepts`, reference syntax/counts/durations, frame-input support, aspects, output sizes,
   prompt limits and hardware requirements aligned with what the authored graph actually runs.
   Capability copy, picker eligibility, estimates and scene pass packing consume this projection;
   declaring an upstream maximum that this preset cannot run makes all four wrong. Record a
   measured `typicalRunSec` where available; unmetered pricing says nothing about speed.

5. **Measure the readiness floors independently on real hardware.** `hardware.minVramMb`
   answers whether the whole card is large enough. `minFreeVramMb` answers whether enough of it
   is free at admission and dispatch. `minFreeMemMb` answers whether enough system RAM is free
   for offload; `minMemMb` describes total system RAM. Record total/free memory, loading peaks,
   sampling and decoding behavior, output settings, reference mix and offload configuration.
   Put the evidence and limitations in `floorSource` and the recipe's setup note. Never copy a
   neighboring recipe's floor as if measured. If a guard is conservative or a reference maximum
   is unmeasured, say so explicitly; an absent optional free-RAM floor is not proof of zero RAM
   use. Readiness and pre-dispatch room checks must agree with this recipe's evidence.

6. **Run focused contract checks during implementation.** From `packages/providers`:

   ```powershell
   node --import tsx --test test/comfyui.test.ts test/h3-reference.test.ts
   npm run typecheck
   ```

   Use the relevant cases for catalogue projection, bounded substitution, identity, optional
   carrier removal, preflight refusal and output-node selection. Add a focused regression for
   new behavior rather than duplicating the shared client suite. For new media preparation or
   readiness behavior, follow the relevant coordinator checks in [testing](testing.md) and
   [the H3 setup note](h3-reference-video.md#validation); configure FFmpeg/ffprobe when exercising
   real media. These tests prove the contract, not GPU execution. After related implementation
   is complete, run the full `npm run lint`, `npm run typecheck`, `npm run build` and `npm test`
   gate once from the repository root, and verify both platform CI results.

7. **Run and inspect a real GPU job before claiming the preset works.** Use an idle engine and
   the pinned, hash-verified weights/nodes. Follow
   [smoke-krea2.ts](../../packages/providers/scripts/smoke-krea2.ts) or
   [smoke-h3-reference.ts](../../packages/providers/scripts/smoke-h3-reference.ts): submit through
   Arke's provider client, poll to completion, fetch the declared output, and inspect picture
   and sound. Exercise the new preset's meaningful input paths; do not interrupt another queue.
   Keep raw outputs under gitignored `.dev/` and commit a setup/validation note recording date,
   recipe identity, engine/node/weight revisions, GPU and total RAM, free VRAM/RAM before and
   during the run, parameters/reference mix, elapsed time, media dimensions/frame rate/duration/
   audio, and what visual inspection established. State what remains unmeasured. H3's recorded
   656.5-second run, 4133 MiB initial free RAM and 407 MiB low point are the pattern: evidence
   tied to one mixed-input run, not a promise about maximum-reference memory use. After building,
   exercise the recipe from the packaged app too before distribution, so discovery and packaged
   assets are part of the proof.

8. **Version changes rather than rewriting history.** Any graph, pinned value or binding change
   requires a new `recipeVersion`. Check `comfyUiRecipeIdentity` and its template digest against
   the new shape; jobs retain the identity they were priced and dispatched against. A materially
   different model/preset can need a distinct recipe ID, as Krea 2 and H3 reference video do.
   Update the setup note and [code map](code-map.md) with the new entry points and evidence.
   Retain earlier measurements as dated history; do not relabel them as runs of the new version.

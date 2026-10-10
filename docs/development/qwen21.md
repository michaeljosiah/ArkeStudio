# Qwen Image 2.1 local recipe

`comfyui-qwen21-image` implements SPEC-021 R-2, R-13 and R-16 as a local image recipe beside
Krea 2. It holds a character's likeness from a reference picture well. On the reference machine
it kept Ife's face from *Na love or Juju* in new settings and lighting where Krea 2, given the
same picture and prompt, drew a different woman. Use it where a face must stay recognisable.

The [Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/790c92633540aa0cb11d9abf19eb46d861714758/LICENSE)
is what Qwen publishes with the weights, and the model's name keeps **Research** and its card
links that licence beside the download controls. Check the terms that apply to your use.

## Version 2 (2026-10-10)

Version 1 ran only in a separate ComfyUI worker started with a conservative profile, guarded by
a bundled custom node, and offered one 1024² canvas and one centre-cropped reference. That was
the workaround for stalls measured on ComfyUI 0.37.0. On 0.38.1 the ordinary engine ran every
job below without them, so version 2:

- runs on the ordinary engine, with Krea 2 and the other recipes; no worker, no guard node, no
  launch flags and no setup step for a URL engine;
- offers two size tiers in five shapes. **2K**, the default, is the publisher's recommended
  native canvases: 1:1 2048², 16:9 2752×1536, 9:16 1536×2752, 4:3 2400×1792, 3:4 1792×2400.
  **1K** is Qwen-Image's canvases near 1.5 megapixels (1328², 1664×928, 928×1664, 1472×1104,
  1104×1472), about 2.5 times quicker. The ComfyUI client picks the tier's table from the
  output's resolution word (`IMAGE_TIER_DIMENSIONS`); no tier means the row's first, 2K;
- takes up to three references in order, each keeping its own shape. The encoder scales each to
  about 1024² at multiples of 32, so nothing is cropped away. The canvas always comes from the
  chosen aspect: a reference says who or what is in the picture, not how it is framed;
- samples 40 Euler/simple steps at CFG 1, the publisher's default, with the prefix cache on
  `auto`, and decodes tiled (512/64).

4K is not offered. The publisher states native 2K only, and community testing reports texture
artifacts at 4096² while sizes up to about 3072² hold.

### Why these settings

Sources agree on CFG 1 and Euler/simple. The publisher's default is 40 steps; ComfyUI's template
samples 25, and community guides call 25 normal and 40–50 best. Nobody published measured
identity settings, so they were measured here on one prompt and seed with Ife's identity photo:

| Run | Time | Face width | What changed |
| --- | --- | --- | --- |
| 1K, 25 steps | ~60 s warm | 232 px | Clearly her; softer |
| 1K, 40 steps | 79 s | 232 px | Slightly crisper |
| 2K, 25 steps | 132 s | 385 px | Finer skin and lashes; face a little rounder and darker |
| 2K, 40 steps | 204 s | 385 px | Brows, lips and cheekbones closest to the reference |
| 2K, 25 steps, references at 1536 | 206 s | 385 px | No visible gain over 1024 for the time |

So the shipped default is 2K at 40 steps with references encoded at 1024, the publisher's default
and the node's. Likeness held at every setting; resolution and steps buy detail.

The engine floor is 0.38.0, the managed pin (R-21); the runs were on 0.38.1. A version bump keeps
every v1 take's provenance meaning what it meant (R-13). Arke translates `@Image N` to the native
`<imageN>` marker before review and submission. Alpha is rejoined after loading so a transparent
picture's hidden background never becomes reference content. Precise relative scale between
references is not assured.

## Setup

Download the recipe's three files in Settings › Models (17.3 GB: the INT8 ConvRot transformer
and Qwen3-VL 8B encoder, and the BF16 VAE). They are pinned to publisher revision `ace0edeb` and
verified by SHA-256; matching files already in the models folder are reused. A URL engine needs
its models folder mapped, as for every recipe. Nothing else is installed.

## Evidence

Reference machine: Windows, RTX 3080 10 GB, 32 GB RAM, ComfyUI 0.38.1 started with no special
flags, the desktop busy with Arke, a browser and Electron apps. Times include loading and
polling; GPU figures are the whole card's peak.

**The shipped default, 2K at 40 steps, one reference (Ife's identity photo):**

| Canvas | Time | GPU peak |
| --- | --- | --- |
| 16:9 2752×1536 | 204 s | 9654 MiB |
| 1:1 2048² | 237 s | 9584 MiB |
| 9:16 1536×2752 | 199 s | 9462 MiB |
| 4:3 2400×1792 | 205 s | 9648 MiB |
| 3:4 1792×2400 | 205 s | 9626 MiB |

Through Arke's provider client (`smoke-qwen21.ts`, the shipped graph, weights hash-verified),
three references (Ife, Ade and the house sheet) at 2K 16:9 completed in 402 s. Both people kept
their faces. The house sheet shows the exterior, and it pulled a staircase the prompt put inside
out onto the front steps: a place reference brings its own framing, so choose the view that
matches the shot.

**Stability on the ordinary engine.** A first matrix at 1K and 25 steps ran seven jobs back to
back: text only, one reference at three shapes, two references and three (a woman, a man and the
house sheet), and repeats, in 105–165 s at a 9.4–9.6 GB peak. None stalled. 1K at 40 steps took
79 s. Two references at 2K and 25 steps took 217 s.

**Likeness.** Each person kept their own face with two and three references, and the house sheet
supplied the staircase and balustrade. With four (a woman, two men and the house) the second
man's face replaced the first's: two copies of one man. The recipe offers three.

**Memory.** Free system memory is the tight resource, not the card: available RAM fell to between
tens of MiB and a few GiB while the 9.4 GB encoder and 7.3 GB transformer moved through it, lowest
when something else was busy at the same time. Every job still completed. The admission floors
(10 GB card, 30 GiB RAM, 6500 MiB free VRAM and 10000 MiB free RAM before dispatch) are kept from
v1; they are admission policies, not a guarantee every prompt or reference set fits.

## Checks

```powershell
npm test --workspace @arke-studio/providers
npm run typecheck --workspace @arke-studio/providers
node --import tsx packages/providers/scripts/smoke-qwen21.ts C:/path/to/models http://127.0.0.1:8188 .dev/qwen-text
node --import tsx packages/providers/scripts/smoke-qwen21.ts C:/path/to/models http://127.0.0.1:8188 .dev/qwen-two ife.png ade.png
```

Create the destination's parent first; every run needs a new destination. The smoke check
verifies the weights' hashes, the loaded node classes and the engine version, then submits
through Arke's provider client and saves the exact graph, output and report. It takes up to three
reference PNGs. `ARKE_SMOKE_PROMPT`, `ARKE_SMOKE_SEED`, `ARKE_SMOKE_ASPECT` (default `16:9`)
and `ARKE_SMOKE_RESOLUTION` (`1664` for 1K; absent is 2K) vary a run without changing the recipe. Inspect the images: success alone does not establish
useful likeness.

Unit coverage includes absent-reference pruning, ordered uploads of up to three pictures, alpha
wiring, each tier's canvas, immutable graph identity and refusal of a fourth or unverified
reference before upload.

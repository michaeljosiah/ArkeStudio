# Arke Studio, image prompts

The UI chrome is monochrome, so the imagery carries all the colour. To keep the set coherent, every prompt below ends with the same **style suffix**:

> …painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

Character portraits share an extra clause so the roster reads as one cast:

> …consistent character-sheet style, three-quarter view, plain dark neutral backdrop, chest-up framing

## Website motion artifacts

The refreshed website is media-led. It renders a poster image while an artifact is unavailable, so each video can be produced independently without blocking the page. Deliver final files to `assets/site-video/` under the filenames below.

### Delivery contract

- Desktop master: 1920×1080 unless a slot below says otherwise; 30 fps; H.264 MP4 and VP9 WebM.
- No baked-in words, controls, logos or subtitles. The website supplies all text.
- Every background loop is muted, 8–16 seconds, and must return to a nearly identical first frame without a visible cut.
- Product demonstrations use the real prototype UI. Do not ask an image or video model to generate interface text.
- Generated world footage must use the named image as its first-frame and identity reference.
- Keep action inside the centre 80% so the same master can crop to desktop and mobile.
- Also export the first frame as a 1920px-wide WebP poster when it improves on the existing fallback.
- Check every loop with sound off and at `prefers-reduced-motion`; its poster must communicate the same claim.

| Artifact | Files | Poster already in page | Slot |
|---|---|---|---|
| Undersong hero | `hero-undersong.mp4`, `.webm` | `world-undersong.png` | Hero, 16:9 |
| Accept gate | `accept-gate.mp4`, `.webm` | `site-loop2.png` | Mechanic card, 4:3 crop |
| Canon refusal | `canon-refusal.mp4`, `.webm` | `site-canon.png` | Mechanic card, 4:3 crop |
| Identity travels | `identity-travels.mp4`, `.webm` | `maren-sheet-pitchboard.png` | Mechanic card, 4:3 crop |
| Studio loop | `studio-loop.mp4`, `.webm` | `site-loop1.png` | Product stage, 16:9 |
| Voice mode | `voice-mode.mp4`, `.webm` | `drowned-quarter.png` | Feature stage, portrait-safe 4:3 |
| One world, many works | `one-world-many-works.mp4`, `.webm` | `saltlight-shot15.png` | Manifesto, 16:9 |

### 1. Undersong hero

**Intent:** still, assured and inhabited. This is a world waiting to be authored, not an effects reel.

**Image-to-video prompt**

> Use the supplied image of The Undersong as the exact first frame. A locked cinematic wide shot of the drowned harbour at blue hour, viewed low over the water. Half-submerged bell towers and a distant lighthouse remain fixed beneath heavy coastal fog. A narrow ribbon of pale bioluminescent light moves slowly below the water toward the city. One amber lantern glows on a weathered pier. The camera makes an extremely slow, stable push forward with no pan, roll or reframing. Water moves gently, fog drifts laterally, the lighthouse beam crosses once, and the underwater light pulses subtly. Quiet, ominous, premium historical fantasy. Preserve architecture, horizon, palette and composition exactly. Fourteen seconds, seamless loop; first and final frames must match closely.

**Negative prompt:** cuts, people entering, dialogue, text, logos, camera shake, aerial movement, fast water, lightning, explosions, morphing architecture, moving horizon, new boats, day-to-night transition, exaggerated glow.

**Acceptance:** lighthouse and buildings do not deform; there is only one warm accent; the loop point is invisible; overlaid white text stays legible on the left.

### 2. Accept gate

**Source:** record the real prototype at 1360×850. Use the proposed scene or canon draft surface.

**Capture brief**

1. Begin on a conversation with a complete proposal already staged.
2. Move focus to the proposal; changed fields resolve one after another, 120 ms apart.
3. Reveal the computed ripple count and affected productions.
4. Hold on the Accept button without pressing for one second.
5. Press Accept; the proposal settles and the version advances once.
6. Return to the staged first state with a short crossfade for the loop.

**Motion:** 8 seconds, one focus at a time, cursor absent, no decorative zoom. Interface material moves quickly and precisely: 180–260 ms ease-out entrances, exits 30% faster.

**Acceptance:** the sequence visibly proves `proposal → ripple → accept`; no live record changes before the click; all UI text is sharp and real.

### 3. Canon refusal

**Source:** record the real Canon Q&A refusal state in the prototype.

**Capture brief**

1. The question appears: “Who collects rent in the Drowned Quarter?”
2. Search count advances to all 42 entries.
3. Closest entries appear with `CANON-021` cited.
4. The sentence “The canon doesn't answer this, and it won't guess” becomes the focus.
5. The `Open as thread` action appears, but is not committed.

**Motion:** 8 seconds. Text should reveal by block, not with a typewriter effect. Hold the refusal for at least 2.5 seconds.

**Acceptance:** no answer is fabricated; the closest entry is explicitly a non-answer; refusal is readable in the card crop.

### 4. Identity travels

**Intent:** show structural consistency, not a magical transformation.

**Hybrid composition brief**

1. Begin with Maren's accepted main photo, full frame.
2. Pull back to reveal it seated in the Character Kit UI.
3. The accepted character sheet joins beside it.
4. A thin reference line travels from both records to three finished frames: close portrait, medium deck shot, wide pier shot.
5. The three frames settle as a production strip; Maren's face, braids, oilskin and proportions remain consistent.

Use `char-maren.png`, `maren-sheet-pitchboard.png`, `scene4-shot12.png`, `scene4-shot14b.png` and `scene4-shot15.png`. Composite in motion graphics; do not regenerate these frames.

**Motion:** 9 seconds, 30 fps. Clean 2D camera and mask transitions only. No simulated 3D cards, bouncing, elastic easing or particle effects.

**Acceptance:** both source images remain identifiable; every destination frame is visibly the same Maren; the sequence reads without labels.

### 5. Studio loop

**Source:** record the real prototype. This is the principal product film on the page.

**Capture brief**

1. World hub: The Undersong, cast and canon visible.
2. Character: Maren's main photo and character sheet.
3. Scene: shot cards for Scene 4.
4. Take: generated shot 15 awaiting review.
5. Cut: accepted shots assembled with two remaining gaps.

Use editorial cuts motivated by the selected object: click Maren to enter the sheet, select Saltlight to enter the scene, select the take to enter review. Each surface holds long enough to understand. The final cut view dissolves back to the hub.

**Motion:** 20–22 seconds, 30 fps. Browser capture at 1360×850, delivered inside a 1920×1080 master. No cursor trail, fake text, speed ramps or soundtrack baked into the loop.

**Acceptance:** every transition follows a plausible user action; the same world and character are recognisable throughout; the cut contains only accepted takes.

### 6. Voice mode

**Source:** record the real voice composer surface, then composite over the existing Drowned Quarter poster only if the prototype needs environmental framing.

**Capture brief**

1. Resting state reads `Hold to speak`.
2. Held state reads `Listening`; a partial transcript appears: “The bells in the Drowned Quarter only ring…”
3. Correct one misheard proper noun in place.
4. Release to send; state changes to `Thinking`.
5. Written reply lands first, then state changes to `Speaking`.
6. A proposed canon entry appears beside the reply; Accept remains a separate untouched control.

**Motion:** 10 seconds. Waveform motion must be secondary to the written state labels. Do not rely on colour. Preserve a readable still for reduced motion.

**Acceptance:** listening, thinking and speaking are each named; audio does not accept anything; the transcript remains visible as the record.

### 7. One world, many works

**Intent:** one source becoming several works without changing identity or visual language.

**Composition prompt**

> Build a cinematic triptych from the supplied Undersong assets. Begin on the single accepted portrait of Maren Kest. The composition widens into three adjacent authored outcomes drawn from the same world: on the left, a manuscript page and restrained story layout; in the centre, the Saltlight pier shot playing as a cinematic frame; on the right, a finished still on a dark contact sheet. Maren's identity, oilskin costume and teal-slate world look remain consistent wherever she appears. Transitions are clean editorial masks following the geometry of the panels, not generative morphs. The background remains dark and atmospheric with one amber practical light. Twelve seconds, seamless loop.

Use `char-maren.png`, `banner-story.png`, `saltlight-shot15.png`, `scene4-shot12.png` and `maren-sheet-pitchboard.png`. Composite these sources; do not generate words into the manuscript.

**Negative prompt:** identity drift, costume change, collage clutter, floating cards, illegible generated text, particles, lens flares, fast zooms, new characters, changing art style.

**Acceptance:** three production types are distinct at a glance; all feel like The Undersong; crop leaves the lower-left clear for website copy.

### Optional 8. Art-direction transition reel

This is not wired as a required video because the four stills work without motion. Produce it if the treatment transition can preserve identity exactly.

> Use the exact same Maren Kest composition, pose, framing, costume and environment across four treatments: painterly world look, live-action cinematic, editorial illustration and feature animation. Transition only the rendering treatment. Identity, silhouette, camera, crop, lighting direction and background geometry remain fixed. Each treatment holds for two seconds; transitions take one second and feel like material resolving across the frame, never a crossfade or character morph. Twelve seconds, seamless loop, 30 fps. No text, labels, added objects, facial changes or camera movement.

Use the four `art-direction-*.png` images as hard keyframes. Reject the result if facial landmarks or hand position move between treatments.

---

## Status

| Image | Slot(s) | Asset | Status |
|---|---|---|---|
| The Undersong key art | `a-w1` | `assets/world-undersong.png` | ✅ Generated |
| Meridian Dust key art | `a-w2` | `assets/world-meridian-dust.png` | ✅ Generated |
| Copper Saints key art | `a-w3` | `assets/world-copper-saints.png` | ✅ Generated |
| Maren Kest portrait | `b/c/d/e-c1` | `assets/char-maren.png` | ✅ Generated |
| Ilo Venn portrait | `b/c/d/e-c2` | `assets/char-ilo.png` | ✅ Generated |
| Sereth Anwe portrait | `b/c/d/e-c3` | `assets/char-sereth.png` | ✅ Generated |
| Bray Half-Hitch portrait | `b/c/d/e-c4` | `assets/char-bray.png` | ✅ Generated |
| Odile Marrow portrait | `b/c/d/e-c5` | `assets/char-odile.png` | ✅ Generated |
| The Chorister portrait | `d/e-c6` | `assets/char-chorister.png` | ✅ Generated |
| Saltlight shot 15 still | `b-cta`, `c-cta1` | `assets/saltlight-shot15.png` | ✅ Generated |
| The Drowned Quarter | `c-cta2` | `assets/drowned-quarter.png` | ✅ Generated |
| Story format banner | `np-story` | `assets/banner-story.png` | ✅ Generated |
| Video format banner | `np-video` | `assets/banner-video.png` | ✅ Generated |
| Game format banner | `np-game` | `assets/banner-game.png` | ✅ Generated |
| Board A, shots 12–14 | `sc4-boardA` | `assets/board-scene4-a.png` | ✅ Generated |
| Maren pitch-board sheet v5 | sheet preview | `assets/maren-sheet-pitchboard.png` | ✅ Generated |
| Maren composite model sheet | reference kit | `assets/maren-model-sheet.png` | ✅ Generated |
| Shot 13, the water answers | shot card | `assets/scene4-shot13.png` | ✅ Generated |
| Shot 15, the pier hold | shot card | `assets/scene4-shot15.png` | ✅ Generated |
| Scene 4 board sheet, labelled | Board tab | `assets/scene4-board-sheet.png` | ✅ Generated |
| Scene 4 master board 3×2 | cut into frames | `assets/board-source.png` | ✅ Generated |
| Watch hero | `ms-watch` | `assets/ms-watch.png` | ✅ Generated |
| Choose hero | `ms-choose` | `assets/ms-choose.png` | ✅ Generated |
| Interact hero | `ms-interact` | `assets/ms-interact.png` | ✅ Generated |
| New-character image example | `nc-image` | — | ◻ Not generated (optional; any portrait works for the demo) |
| Art direction: World look | `art-style-world` | `assets/art-direction-world.png` | ✅ Generated |
| Art direction: Cinematic | `art-style-cinematic` | `assets/art-direction-cinematic.png` | ✅ Generated |
| Art direction: Illustrated | `art-style-illustrated` | `assets/art-direction-illustrated.png` | ✅ Generated |
| Art direction: Animated | `art-style-animated` | `assets/art-direction-animated.png` | ✅ Generated |

Statuses: **✅ Generated** (asset in place) · **⟳ Regenerate** (prompt changed since the asset was made) · **◻ Not generated**. If you rewrite a prompt below, flip its row to ⟳.

---

## World key art, home screen cards (1a)
Portrait-ish crop, ~1:1. Slots: `a-w1`, `a-w2`, `a-w3`.

**The Undersong** (`a-w1`)
A drowned stone harbour city at dusk seen from the water, tide pulling in ribbons of pale light toward a lighthouse, half-submerged bell towers, deep teal and slate sea, single warm lantern glow, painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

**Meridian Dust** (`a-w2`)
A lone freight train crossing a vast salt-white desert that was once an ocean floor, fossilised whale bones rising like arches, rust-orange dust haze, pale bleached sky, painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

**Copper Saints** (`a-w3`)
A rain-slicked brick city at night from a rooftop, copper-green domes and fire escapes, four silhouetted figures overlooking neon-tinged streets, amber sodium lamps, painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

---

## Cast portraits, Undersong characters
Portrait 4:5. Used across 1b (`b-c1…c5`), 1c (`c-c1…c5`), 1d (`d-c1…c6`), 1e (`e-c1…c6`), generate once per character, drop the same image everywhere they appear.

**Maren Kest, tide-caller, lead**
A weathered young woman in oilskin coat with salt-crusted braids, pale grey eyes reflecting moving water, faint bioluminescent thread woven at her collar, resolute expression, consistent character-sheet style, three-quarter view, plain dark neutral backdrop, chest-up framing, painterly cinematic concept art, muted palette with one warm accent, filmic lighting, high detail, no text, no watermark

**Ilo Venn, cartographer of the Drowned Quarter**
A wiry middle-aged man with ink-stained fingers and brass survey goggles pushed into curly hair, satchel of rolled wet charts, curious half-smile, consistent character-sheet style, three-quarter view, plain dark neutral backdrop, chest-up framing, painterly cinematic concept art, muted palette with one warm accent, filmic lighting, high detail, no text, no watermark

**Sereth Anwe, warden of the Vigil, lead**
A tall austere woman in a lighthouse keeper's storm coat with a high collar, lantern-light catching one side of her face, streak of white in dark hair, guarded and tired, consistent character-sheet style, three-quarter view, plain dark neutral backdrop, chest-up framing, painterly cinematic concept art, muted palette with one warm accent, filmic lighting, high detail, no text, no watermark

**Bray Half-Hitch, salvage diver**
A broad grinning man with a rope scar across one cheek, patched brass-fitted dive suit open at the collar, wet hair, a recovered coin on a cord around his neck, consistent character-sheet style, three-quarter view, plain dark neutral backdrop, chest-up framing, painterly cinematic concept art, muted palette with one warm accent, filmic lighting, high detail, no text, no watermark

**Odile Marrow, voice of the Ebb Council**
An elegant older woman in formal grey-green council robes with a tide-clock pendant, silver hair pinned severely, appraising politician's gaze, consistent character-sheet style, three-quarter view, plain dark neutral backdrop, chest-up framing, painterly cinematic concept art, muted palette with one warm accent, filmic lighting, high detail, no text, no watermark

**The Chorister, antagonist**
An ambiguous robed figure whose hood holds only darkness and a faint choir of pale lights, barnacle-crusted vestments trailing seawater, unsettling stillness, consistent character-sheet style, three-quarter view, plain dark neutral backdrop, chest-up framing, painterly cinematic concept art, muted palette with one warm accent, filmic lighting, high detail, no text, no watermark

---

## Production / CTA imagery

**Saltlight, shot 15 storyboard frame** (`b-cta`, wide ~2.5:1; `c-cta1`, small)
A cinematic film still: a woman stands at the end of a flooded pier at blue hour facing a distant lighthouse beam, wide anamorphic framing, storyboard final-frame quality, painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

**The Drowned Quarter** (`c-cta2`, small wide)
A submerged city district seen from a rowboat: doorways and shop signs continuing below clear green water, laundry lines strung between sunken chimneys, painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

---

## Format banners, "New production" picker
Wide crop ~2.2:1 (the slots are 235×104). Slots: `np-story`, `np-video`, `np-game`. These represent the *medium*, staged inside the Undersong world so the picker still feels like one universe.

**Story** (`np-story`)
A writing desk against a rain-streaked window overlooking the drowned harbour at dusk, manuscript pages weighted by a brass tide-clock, ink pen resting mid-sentence, warm lamplight, painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

**Video** (`np-video`)
A vintage film camera on a tripod at the end of a flooded pier at blue hour, aimed at a distant lighthouse beam, storyboard cards clipped to its side fluttering in wind, painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

**Game** (`np-game`)
A miniature diorama of a drowned city street seen from above at an isometric angle, tiny glowing waypoint lanterns marking a path between sunken rooftops, one figurine of a hooded ferryman on a game-board tile, painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

---

## Storyboard sheet, example board (scene 4, board A)
One wide image, ~2.9:1 (the slot is ~640×212). Slot: `sc4-boardA`.

**Board A, shots 12–14** (`sc4-boardA`)
A cinematic storyboard sheet: three equal panels side by side in one wide image, separated by thin white gutters. Panel one: a weathered young woman with salt-crusted braids in an oilskin coat grips a ship's rail at night, listening, harbour fog behind. Panel two: wide shot, the dark sea lifting into a single ribbon of pale light beneath storm clouds. Panel three: close-up of a brass lantern flame guttering in the same night wind. Same character, costume, palette and lighting across all three panels, painterly cinematic concept art, muted teal-slate palette with one warm lantern accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

---

## Model sheet, Maren Kest v2 (pitch-board style, after the Mind Revolution template)
One landscape sheet, ~16:9 or 3:2. Replaces the even-grid composite; GPT Image 2 class models handle the annotations.

Create a cinematic, film-production-grade character design sheet for a director, casting team, and costume department. Character name: Maren Kest. Must feel like a high-budget animated film pitch board, not a generic model sheet.

CORE DIRECTIVE (NON-NEGOTIABLE): No generic layouts. No evenly spaced grids. No symmetry for symmetry's sake. Composition must feel art-directed, intentional, slightly asymmetrical, a dominant cinematic portrait anchoring one side, turnaround and studies placed around it. Every section must feel placed, not auto-generated.

CHARACTER IDENTITY: Name: Maren Kest | Role: Tide-caller, lead | Age: late 20s | Height: 1.68m | Build: lean, wiry, weathered; carries weight low and steady like someone used to standing on moving decks | Design Language: painterly cinematic realism, grounded North-Atlantic maritime culture.

FACE DESIGN: Structure: angular but soft-eyed, wind-worn | Skin: pale, salt-chapped, faint freckling, always slightly damp | Eyes: pale grey, watchful, heavy-lidded from listening | Hair: dark salt-crusted braids, flyaways stiff with brine | Distinct Features: head habitually tilted, favouring her left ear, she hears the verse under the water.

PSYCHOLOGICAL PROFILE: Core Traits: quiet resolve, vigilance, buried grief, dry tenderness | Internal Conflict: wants to answer the song; knows what answering costs | Behavior Patterns: goes still before speaking; thumbs the frayed thread at her collar; stands where she can see the water | Emotional Baseline: calm surface, fast-rising dread.

PERFORMANCE DIRECTION: Must feel like a real actor caught mid-moment, NOT posing. Micro-expressions required, lip tension, eye flicker, brow shift. Transitional emotion: the instant of hearing something others can't. Body Language: braced, economical movement; idle behavior: hand drifting to the collar thread.

WARDROBE: Garment 1: long oilskin coat, cracked wax, salt-bloom at the seams, ochre lining showing at cuffs | Garment 2: rough-knit jumper beneath, darned at the elbows | Layering logic: built for wet wind, nothing decorative | Footwear: sea boots, heel-worn | Accessories: a frayed collar thread that glows faint teal, the only unnatural thing on her | Props: none; her hands are the tell.

MATERIAL ACCURACY: Fabrics must show stretch, stitching, wrinkles, wear. No plastic look. Skin must have soft light interaction. Include imperfections: salt crust, dirt, smudges, usage marks.

TURNAROUND (STRICT): Full-body front, 3/4, side, back, 3/4 back views. Identical proportions and design fidelity. No drift in face or costume across any angle.

HEAD STUDY: Front (neutral) | 3/4 (listening, her primary state) | Profile (structure, the tilted ear) | Looking Down | Dynamic Angle (the moment the water answers). All expressions mid-thought, not posed.

CINEMATIC PORTRAIT: Environment: the rail of a ship in a drowned harbour at night, fog, distant lighthouse | Lighting: one warm lantern practical against cold blue-grey dark | Color Tone: muted teal-slate with a single warm accent | Expression: she has just heard it | Camera: 85mm, shallow depth of field, cinematic realism.

LAYOUT: Clean, art-directed sheet on a flat pale warm-grey board. Include: height scale, small annotation callouts in plain dark uppercase lettering, wardrobe breakdown, production notes. Must feel like a premium studio board. Header text: "MAREN KEST · THE UNDERSONG · SHEET v5".

STYLE: Painterly cinematic concept art, muted teal-slate palette with one warm lantern accent, soft volumetric fog in the portrait only, high emotional readability.

CONSISTENCY RULE (STRICT): Face, proportions, costume, and details must remain IDENTICAL across all views. No reinterpretation between angles. Ever.

OUTPUT: Extremely high detail. Sharp focus. Production-ready fidelity. No watermark, no border.

---

## Model sheet, Maren Kest composite (reference kit card + artifact)
One landscape image, ~4:3. Slot: the model-sheet preview compiles from tiles in the product, but for the mockup drop one generated composite.

**Maren Kest, production model sheet**
A professional animation-production character model sheet on a single flat pale warm-grey background, laid out as one clean composite: across the top row, four full-figure turnaround views of the same woman, front, left three-quarter, right three-quarter and back, standing in a neutral A-pose, evenly spaced with consistent scale and a faint ground line; along the bottom row, three smaller vignettes, a chest-up expression study with eyes shut listening, a mid-shot of her calling with one arm extended toward unseen water, and a detail study of her collar showing a frayed faintly glowing thread. The character in every view: a weathered young woman in a long oilskin coat, salt-crusted braids, pale grey eyes, quiet resolute face, head tilted slightly favouring her left ear. Identical costume, proportions, palette and lighting in all seven drawings, flat even studio light, no cast shadows between figures, generous margins like a printed studio reference page, painterly cinematic concept art rendering within each figure, muted teal-slate palette with one warm lantern accent at the collar thread, high detail, no text, no watermark, no border

---

## Scene 4, missing shot frames + board sheet

**Shot 13, the water answers, wide** (16:9, shot card frame)
A cinematic film still, extreme wide shot from the cliff above a drowned harbour at night: the dark sea below going unnaturally still, then lifting into a single ribbon of pale light that runs from the horizon toward a distant lighthouse, high horizon line, storm clouds holding their breath, no people in frame, painterly cinematic concept art, muted teal-slate palette with one warm lantern accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

**Shot 15, the pier, blue hour, hold** (16:9, shot card frame)
A cinematic film still, locked-off wide shot: an empty flooded pier at blue hour, planks half a hand under glassy water, a weathered young woman in a long oilskin coat with salt-crusted braids entering frame at the far end, small against a distant lighthouse whose beam has just passed, her back to camera, head tilted slightly to the left as if listening, painterly cinematic concept art, muted teal-slate palette with one warm lantern accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

**Scene 4 board sheet, all four shots, labelled** (one page, ~4:3, for the Board tab)
A professional film storyboard page: four cinematic panels arranged in a 2×2 grid on a flat pale warm-grey page with thin white gutters and generous margins, each panel with a small plain label strip beneath it in dark uppercase lettering. Panel one, labelled "SHOT 12, 4.0s": medium close-up of a weathered young woman with salt-crusted braids in an oilskin coat gripping a ship's rail at night, head tilted, listening, harbour fog behind. Panel two, labelled "SHOT 13, 5.0s": extreme wide of the dark sea going still and lifting into a single ribbon of pale light beneath storm clouds, high horizon. Panel three, labelled "SHOT 14, 4.5s": close-up of a brass lantern flame guttering sideways, a tall austere woman in a storm coat behind it, rack-focus feel. Panel four, labelled "SHOT 15, 6.0s": locked wide of an empty flooded pier at blue hour, the braided woman small at its far end, back to camera, distant lighthouse beam just passed. Same characters, costumes, palette and lighting across all four panels, painterly cinematic concept art within each panel, muted teal-slate palette with one warm lantern accent, soft volumetric fog, filmic lighting, high detail, no watermark, no border, no text other than the four label strips

---

## Scene 4, 3×2 storyboard master (for cutting into shot frames)
One image, 3 columns × 2 rows, generous flat gutters so panels crop cleanly. No labels, Arke overlays its own.

**Scene 4 master board** (~16:10)
A film storyboard sheet of six cinematic panels in a strict 3-column, 2-row grid, every panel exactly the same size, separated by wide flat pale warm-grey gutters, no labels, no text anywhere. Panel 1: medium close-up of a weathered young woman with salt-crusted braids in an oilskin coat gripping a ship's rail at night, head tilted, listening, harbour fog behind. Panel 2: extreme wide from a cliff at night, the dark sea going still and lifting into a single ribbon of pale light running toward a distant lighthouse, high horizon. Panel 3: close-up of a brass lantern flame guttering sideways in wind, a tall austere woman in a storm coat with a white streak in her dark hair behind it. Panel 4: insert close-up of the braided woman's collar, a frayed woven thread beginning to glow faint blue-green against wet oilskin. Panel 5: night two-shot on a ship's deck, the austere lantern-bearing woman and the braided young woman exchanging a look, fog moving between them. Panel 6: locked wide of an empty flooded pier at blue hour, the braided woman small at its far end, back to camera, distant lighthouse beam just passed. Same characters, costumes, palette and lighting across all six panels, painterly cinematic concept art within each panel, muted teal-slate palette with one warm lantern accent, soft volumetric fog, filmic lighting, high detail, no text, no watermark, no border

---

## Art-direction picker, matched style studies

Landscape 3:2. Generate each prompt independently and save it under the listed asset name.

The subject and composition are deliberately locked across the set. The only meaningful difference should be rendering treatment. This lets the picker answer "how should it look?" rather than accidentally comparing four different scenes.

**Shared composition**

Maren Kest stands at the rail of a weathered harbour boat at blue hour, shown waist-up in left-facing three-quarter profile. She is a lean, wind-worn woman in her late twenties with dark salt-crusted braids, pale grey eyes, a long cracked oilskin coat and a faint teal thread glowing at the collar. Her left hand grips the wet rail while her head tilts as if hearing something beneath the water. Behind her: a drowned stone harbour, one distant lighthouse beam, low fog, slate sea and a single amber deck lantern. Medium shot, eye-level camera, 50mm-equivalent framing, Maren on the left third, open harbour on the right, no text, no lettering, no logo, no watermark, no border, no collage.

Keep Maren's face, pose, costume, camera, crop, objects, weather and time of day identical in all four outputs.

**World look** (`assets/art-direction-world.png`)

Maren Kest stands at the rail of a weathered harbour boat at blue hour, shown waist-up in left-facing three-quarter profile. She is a lean, wind-worn woman in her late twenties with dark salt-crusted braids, pale grey eyes, a long cracked oilskin coat and a faint teal thread glowing at the collar. Her left hand grips the wet rail while her head tilts as if hearing something beneath the water. Behind her: a drowned stone harbour, one distant lighthouse beam, low fog, slate sea and a single amber deck lantern. Medium shot, eye-level camera, 50mm-equivalent framing, Maren on the left third, open harbour on the right. Painterly cinematic concept art with visible but controlled brushwork, grounded anatomy, tactile weathered materials, layered atmospheric depth, muted teal and slate palette, one restrained amber practical light, soft volumetric fog, emotionally quiet dark-fantasy production design, polished feature-film concept-art finish. No text, no lettering, no logo, no watermark, no border, no collage.

**Cinematic** (`assets/art-direction-cinematic.png`)

Maren Kest stands at the rail of a weathered harbour boat at blue hour, shown waist-up in left-facing three-quarter profile. She is a lean, wind-worn woman in her late twenties with dark salt-crusted braids, pale grey eyes, a long cracked oilskin coat and a faint teal thread glowing at the collar. Her left hand grips the wet rail while her head tilts as if hearing something beneath the water. Behind her: a drowned stone harbour, one distant lighthouse beam, low fog, slate sea and a single amber deck lantern. Medium shot, eye-level camera, 50mm cinema lens, Maren on the left third, open harbour on the right. Photoreal live-action film still, natural skin and wet fabric texture, subtle anamorphic softness without visible black bars, shallow depth of field, cool available blue-hour light balanced by one warm lantern practical, restrained film grain, gentle highlight halation, realistic fog and water, premium historical-fantasy cinematography, physically plausible materials and lighting. No text, no lettering, no logo, no watermark, no border, no collage.

**Illustrated** (`assets/art-direction-illustrated.png`)

Maren Kest stands at the rail of a weathered harbour boat at blue hour, shown waist-up in left-facing three-quarter profile. She is a lean, wind-worn woman in her late twenties with dark salt-crusted braids, pale grey eyes, a long cracked oilskin coat and a faint teal thread glowing at the collar. Her left hand grips the wet rail while her head tilts as if hearing something beneath the water. Behind her: a drowned stone harbour, one distant lighthouse beam, low fog, slate sea and a single amber deck lantern. Medium shot, eye-level camera, 50mm-equivalent framing, Maren on the left third, open harbour on the right. Sophisticated editorial illustration on toothy off-white paper, layered gouache and dry-brush pigment, selective charcoal contour, simplified but accurate anatomy, broad graphic shadow shapes, visible paper grain, restrained teal-slate colour blocks and one amber accent, expressive mark-making in fog and water, elegant contemporary book-jacket finish, tactile and handmade rather than photoreal. No text, no lettering, no logo, no watermark, no border, no collage.

**Animated** (`assets/art-direction-animated.png`)

Maren Kest stands at the rail of a weathered harbour boat at blue hour, shown waist-up in left-facing three-quarter profile. She is a lean, wind-worn woman in her late twenties with dark salt-crusted braids, pale grey eyes, a long cracked oilskin coat and a faint teal thread glowing at the collar. Her left hand grips the wet rail while her head tilts as if hearing something beneath the water. Behind her: a drowned stone harbour, one distant lighthouse beam, low fog, slate sea and a single amber deck lantern. Medium shot, eye-level camera, 50mm-equivalent framing, Maren on the left third, open harbour on the right. High-end 2D feature-animation keyframe, strong readable silhouette, designed angular shapes softened by expressive eyes, clean confident linework, graphic cel-shaded planes with painterly texture in the background, controlled proportions suitable for repeatable character animation, muted teal-slate palette with one amber practical light, atmospheric depth built from layered shapes, emotionally expressive and cinematic without becoming photoreal or childish. No text, no lettering, no logo, no watermark, no border, no collage.

The **Describe your own** card intentionally has no generated thumbnail: its empty, text-led treatment communicates that the user defines the visual language.

---

## Tips
- Generate square or 4:5 masters; the slots crop with `cover`, and double-clicking a filled slot lets you reframe.
- Reuse each character's single portrait across every screen, that *is* the product's pitch (one canon, many surfaces).
- Keep one warm accent colour (lantern amber) across the whole set so the monochrome UI + imagery reads as one system.
---

## Movie subtype heroes, "How should the audience experience it?" (35a)
Landscape ~3:1 crop shown at 240×110. Each image shows the AUDIENCE'S mode of experience, staged inside the drowned-harbour world. Slots: `ms-watch`, `ms-choose`, `ms-interact`.

**Watch** (`ms-watch`) — passive viewing
A dark screening room seen from behind a lone viewer's silhouette, the bright screen showing a lantern-lit drowned harbour at blue hour with a small clean subtitle reading "The tide is lower than it has ever been.", projector beam cutting through haze overhead, painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no watermark, no border

**Choose** (`ms-choose`) — deciding the story
A paused film frame of a drowned canal city with two large glowing choice buttons floating over the image side by side, the left button lit warm amber reading "Wake her", the right button pale teal reading "Let her sleep", a subtle timer ring between them, the scene held mid-moment behind, clean minimal sans-serif UI type, painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no watermark, no border

**Interact** (`ms-interact`) — reaching into the film
A fingertip touching the surface of a glowing film frame from outside it, ripples spreading across the image where it touches, three faint circular target rings over bronze bells inside the scene, a small clean UI caption reading "Quiet the bells" with a thin 8-second timer bar, minimal sans-serif UI type, painterly cinematic concept art, muted palette with one warm accent, soft volumetric fog, filmic lighting, high detail, no watermark, no border

# Arke Kids, image & video prompt sheet

Every visual asset for **Arke Kids**: the family app (`Arke Kids App.dc.html`) and the marketing site (`Arke Kids Studio.dc.html`). The grown-up product's prompts live separately in `image-prompts.md`.

## Status key

| | Meaning |
|:--:|---|
| 🟢 | **Done.** File exists in `assets/` and is wired into the product. |
| 🟡 | **Redo.** Exists, but something about it does not work. Reason given in the row. |
| ⚪ | **To do.** Not made yet. |

**Contents**

| Part | Section | 🟢 | 🟡 | ⚪ |
|---|---|:--:|:--:|:--:|
| [1](#1--style-contract) | Style contract | | | |
| [2](#2--character-locks) | Character locks | | | |
| [3](#3--the-helpers) | The helpers | 7 | 1 | 12 |
| [4](#4--voice) | Voice | 4 | 1 | 1 |
| [5](#5--the-childs-own-drawing) | The child's own drawing | 6 | 0 | 5 |
| [6](#6--child-mode) | Child mode | 0 | 0 | 10 |
| [7](#7--making--review) | Making and review | 0 | 0 | 10 |
| [8](#8--worlds-cast--wizards) | Worlds, cast and wizards | 0 | 0 | 33 |
| [9](#9--print--post) | Print and post | 0 | 0 | 13 |
| [10](#10--marketing-site) | Marketing site | 6 | 0 | 18 |
| [11](#11--parent-onboarding-videos) | Parent onboarding videos | 7 | 0 | 12 |
| [12](#12--what-to-make-next) | What to make next | | | |

**Totals: 🟢 30 done · 🟡 2 to redo · ⚪ 114 to make.**

### The two redos, and one copy fix

| | Asset | Problem | Fix |
|:--:|---|---|---|
| 🟡 | `pip-answering.png` | Sits on an **orange background** while `pip-listening` and `pip-thinking` are cut out, so the three cannot cross-fade in place. The voice state change currently jumps. | Regenerate on cream or transparent, same crop and scale as the other two. |
| 🟡 | `helpers-group.png` | Composed with the cast in the **lower band** and headline space above. Any banner under ~200px tall decapitates Trill and Nan. Currently forced to `height:clamp(200px,26vh,260px)` with `object-position:center 72%`. | A second crop with the cast centred would free the layout. Low priority, the current workaround holds. |
| 📝 | Pip's scarf, in app copy | The supplied art gives Pip a **yellow** scarf; the app's character sheet and wizard copy still say **blue**. Art is canon. | Change the copy, not the art. |

---

## 1 · Style contract

Three families. Never mix two inside one screen.

| Family | Suffix to paste | Used for |
|---|---|---|
| **ART** | *warm contemporary picture-book illustration, gouache texture, friendly rounded shapes, soft rich colour, gentle light, high charm, no text, no watermark, no border* | Story artwork, characters, child mode |
| **HELPER** | ART, plus *chest-up, three-quarter view, plain warm off-white background* | The six helper agents only |
| **PHOTO** | *warm editorial lifestyle photography, soft natural window light, shallow depth of field, candid and unposed, cozy domestic interior, no logos, no text, no watermark* | Real-world product, print, families |

**Never**, anywhere: primary-colour "kids TV" styling, alphabet bunting, foam letters, balloons, emoji, or anything that looks like a brand's idea of childhood.

**Three rules that matter more than any single prompt**

1. **One character, one image, reused everywhere.** Consistency across surfaces *is* the product's argument.
2. **Generate square or 4:3 masters.** Slots crop with `cover`.
3. **Leave room for type** where a prompt says so.

---

## 2 · Character locks

Keep these exact, in every prompt the character appears in.

| Character | Lock |
|---|---|
| **Pip** | small orange fox, one white ear, too-big **yellow** knitted scarf, worried eyebrows |
| **The gull** | a stout, kind-eyed harbour seagull, grey and white, one crooked wing, often a paper boat under it |
| **Volt** | a boxy robot dog with antenna ears and a lightning-bolt collar, as a ten-year-old would draw it |
| **Pockets** | a russet red squirrel in a many-pocketed canvas waistcoat, cheeks full, one ear notched |
| **Quill** | a small brown hedgehog in round wire spectacles, ink-stained paws, one quill behind the ear |
| **Inko** | a soft violet octopus, each arm holding a different brush, a smudge of paint on the brow |
| **Trill** | a plump yellow-and-grey songbird, striped scarf, open beak mid-note |
| **Barnaby** | a broad tan beaver in a paper apron, carpenter's pencil behind the ear, flat tail |
| **Nan** | a soft grey owl, enormous calm eyes, half-moon glasses, a small crescent brooch |
| **The host** *(video)* | a friendly mixed-race woman, early thirties, warm brown skin, dark curls loose to the shoulder, minimal make-up, small gold studs, oatmeal knitted jumper, sleeves pushed up, no lanyard, no headset |

---

## 3 · The helpers

Six agents, one animal each. The child meets helpers, not features.

| | Slot | Aspect | Prompt | Job |
|:--:|---|---|---|---|
| 🟢 | `helper-pockets` | square | Pockets the squirrel, a russet red squirrel in a many-pocketed canvas waistcoat, cheeks full, one ear notched, leaning in with an ear cupped, listening hard, a scrap of paper poking from every pocket. HELPER style. | Listens, keeps every idea |
| 🟢 | `helper-quill` | square | Quill the hedgehog, a small brown hedgehog in round wire spectacles, ink-stained paws, one quill behind the ear, mid-sentence, writing on a strip of paper that curls away. HELPER style. | Writes the words |
| 🟢 | `helper-inko` | square | Inko the octopus, a soft violet octopus with each arm holding a different brush and a smudge of paint on the brow, painting three things at once, delighted. HELPER style. | Draws, and keeps a child's own lines |
| 🟢 | `helper-trill` | square | Trill the songbird, a plump yellow-and-grey songbird in a striped scarf, perched on a thin brass microphone stand, eyes shut, beak open mid-note, singing. HELPER style. | Voices and music |
| 🟢 | `helper-barnaby` | square | Barnaby the beaver, a broad tan beaver in a paper apron with a carpenter's pencil behind the ear, holding a freshly bound little hardcover book, proud, string and brown paper on the bench behind. HELPER style. | Binds the book, posts it |
| 🟢 | `helper-nan` | square | Nan the owl, a soft grey owl with enormous calm eyes, half-moon glasses and a small crescent brooch, one wing raised gently in a "let's check first" gesture, kind not stern. HELPER style. | Pauses anything needing a grown-up |
| 🟡 | `helpers-group` | wide landscape | All six at a long workbench seen side-on: Pockets listening, Quill writing, Inko painting, Trill singing, Barnaby binding, Nan watching over the lot, warm lamplight, papers and brushes everywhere, generous empty space above them for a headline. HELPER style. | **Redo optional:** cast sits low, crops badly under 200px |

### Helper loops

Silent, seamless, square. **Each must match its portrait exactly** — the notched ear, the quill, the paint smudge, the striped scarf, the pencil, the crescent brooch.

| | Slot | Length | Prompt |
|:--:|---|---|---|
| ⚪ | `loop-pockets` | 2–3s | The squirrel's ear twitches toward the viewer, a new scrap of paper appears in a pocket. Seamless loop, cream background, ART style, no text. |
| ⚪ | `loop-quill` | 2–3s | The hedgehog writes, the paper strip growing and curling off the bottom of frame. Seamless loop, cream background, ART style, no text. |
| ⚪ | `loop-inko` | 2–3s | The octopus's arms paint in rotation, a picture filling in behind. Seamless loop, cream background, ART style, no text. |
| ⚪ | `loop-trill` | 2–3s | The songbird's chest puffs, three little notes rise and fade. Seamless loop, cream background, ART style, no text. |
| ⚪ | `loop-barnaby` | 2–3s | The beaver stitches a spine, then pats the finished book. Seamless loop, cream background, ART style, no text. |
| ⚪ | `loop-nan` | 2s | The owl blinks slowly, once. Seamless loop, cream background, ART style, no text. |
| ⚪ | `loop-*-still` | still ×6 | First frame of each loop at the identical crop, for reduced-motion and slow connections. |

---

## 4 · Voice

The interface is a conversation, so the art has to make *listening* visible.

| | Slot | Aspect | Prompt | Where |
|:--:|---|---|---|---|
| 🟢 | `voice-pip-listening` | square | Pip mid-listen, head tilted, one ear forward, eyes up and expectant, completely still. ART style, plain or transparent background. | Face of the microphone, parent and child |
| 🟢 | `voice-pip-thinking` | square, matching crop | The same Pip, eyes rolled up and to the side, one paw on his chin, thinking. ART style. | Voice state strip |
| 🟡 | `voice-pip-answering` | square, matching crop | The same Pip, mouth open mid-word, paws spread. ART style. | **Redo:** orange background, will not cross-fade with the other two |
| 🟢 | `voice-hero` | landscape | A four-year-old sitting on the floor talking at a propped-up tablet, mouth mid-word, both hands up in the air describing something big, parent out of focus behind, smiling. PHOTO style. | Site voice band, voice onboarding |
| 🟢 | `kid-pip-avatar` | square | Reuses `pip-listening`. | Child-mode home |
| ⚪ | `loop-listening-ring` | 2s loop, square, alpha | Abstract, no character: a soft hand-painted watercolour ring breathing in and out, gouache edges, no hard vector geometry. | The "I am hearing you" halo |

> The three Pip states must share **crop, scale, lighting and background** so they cross-fade in place: listening → thinking → answering.

---

## 5 · The child's own drawing

The most important images in the product. They prove the output is the family's, not generated.

> **🟢 The real drawing is supplied: `assets/ivy-fox-crayon.png`.** It fills every "her original" slot. **Everything derived from it must preserve these details**, or the comparison screens stop proving anything:
>
> two huge triangular ears, right much bigger than left, plus a small third ear-shaped mark between them · a long low body scribbled in one direction, tail merging into the body on the right · two black dot eyes set high and close, one black dot nose · **three whiskers left, four right**, black, straight · four straight stick legs, evenly spaced · **all four feet purple**, scribbled outside the leg · orange fill skipping over the paper grain, edges overshooting · blue-ruled paper, red margin line, one torn corner top right

| | Slot | Aspect | Prompt | Note |
|:--:|---|---|---|---|
| 🟢 | `draw-original` | 4:3 | *Supplied.* Kept in case a second child drawing is needed: A drawing made by a four-year-old, a fox, in wax crayon, on lined school paper. Very crude and babyish: a lopsided potato body, two triangle ears of different sizes, four stick legs coming straight out of the body, a long tail wider than the head, dot eyes set too far apart, three whiskers on one side and four on the other, feet coloured purple because the orange ran out. Heavy uneven pressure so the wax skips over the paper grain, scribbled fill going well outside the outline, one small tear at the corner. Photographed flat on a wooden kitchen table in daylight, slight shadow at one edge, paper not quite straight. PHOTO style. | **If it looks like an illustrator's "child-like style", it is wrong** |
| 🟢 | `cmp-original` | 4:3 | Reuses `draw-original`. | Left panel of the comparison |
| 🟢 | `kidcmp-original` | 4:3 | Reuses `draw-original`. | Child's own compare screen |
| 🟢 | `home-drawing-thumb` | small square | A tight crop of `draw-original`, just the head and one ear. | Home alert |
| 🟢 | `kid-photo-frame` | landscape | The crayon fox on lined paper seen through a tablet camera at a slight angle, held up in a child's hand at the bottom of frame, kitchen behind thrown out of focus. PHOTO style. | Camera route |
| 🟢 | `kid-drawing-kept` | square | `draw-original` reproduced as a printed page inside a finished book, crayon lines untouched, in a clean printed frame with an empty caption area beneath. PHOTO style. | Also `hand-doodle-kept` |
| ⚪ | `draw-tidied` | square, same crop | The exact same crayon drawing with the paper, table, shadow and warm colour cast removed: the child's crayon marks alone on clean white, colours trued for print, every line and wobble identical. PHOTO style, flat product lighting. | Must read as the **same object**, not a redraw |
| ⚪ | `cmp-tidied` | square | Reuses `draw-tidied`. | Right panel, tidy path |
| 🟢 | `cmp-painted` | square, same crop | The same fox as a finished picture-book character, painted in the world's gouache watercolour, deliberately keeping every odd choice from the crayon original: the lopsided ears, the over-long tail, the too-wide eyes, the purple feet, three whiskers one side and four the other. Standing three-quarter view, charming and properly drawn, but unmistakably *that* child's fox. ART style. | If a viewer cannot match it to the crayon detail for detail, it has failed |
| 🟢 | `kidcmp-painted` | square | Reuses `cmp-painted`. | Child's compare screen |
| ⚪ | `kid-canvas` | landscape | A finger-drawn picture in progress on a tablet: thick soft digital crayon strokes, a half-finished animal, one colour scribbled over another, plenty of empty white. Seen straight on, screen only, no hands, no UI, no paper texture. Flat digital. | **Not** photographed paper, and **not** a finished drawing |
| ⚪ | `hand-endpaper` | landscape | The book's inside endpaper printed with a collage of the child's own scribbles and a handwritten dedication. PHOTO style. | Print upsell |

---

## 6 · Child mode

Bigger, softer, readable at arm's length by someone who cannot read.

| | Slot | Aspect | Prompt |
|:--:|---|---|---|
| ⚪ | `kid-tile-story` | landscape tile | Pip sitting inside an open book as if it were a boat, big and central, plain warm background, nothing small or fiddly. ART style. |
| ⚪ | `kid-tile-draw` | landscape tile | Pip holding up a wax crayon nearly as big as he is, a bold scribble behind him. ART style. |
| ⚪ | `kid-tile-watch` | landscape tile | Pip and the gull on a harbour wall watching something bright off-frame, their backs to us. ART style. |
| ⚪ | `kid-tile-shelf` | landscape tile | A short shelf of five chunky picture books with Pip peeking over the top. ART style. |
| ⚪ | `kid-wait` | landscape | Pip and all six helpers in a huddle, backs mostly to us, working on something we cannot quite see, one small light in the middle. ART style. |
| ⚪ | `kid-done` | landscape | Pip holding a finished book above his head with both paws, scarf flying, confetti of paper scraps. ART style. |
| ⚪ | `kid-ask-grownup` | square, min 100px | Nan the owl alone, wing raised gently, warm and unembarrassing. HELPER style. |
| ⚪ | `kidread-page` | landscape 4:3 | A single picture-book page: a gull landing on a harbour wall beside a small orange fox, close enough to touch, evening light. Clear empty space in the bottom third for text. ART style. |
| ⚪ | `loop-kid-idle` | 5–8s loop, landscape | Pip on screen doing nothing much: breathing, blinking, scarf moving, occasionally looking straight at camera. Must loop invisibly. |
| ⚪ | `kid-handoff` | 3s, landscape | A tablet passed from adult hands to small hands across a table. PHOTO style. |

---

## 7 · Making & review

| | Slot | Aspect | Prompt |
|:--:|---|---|---|
| ⚪ | `app-making` | landscape | A rough pencil-and-light-watercolour **sketch**, deliberately unfinished, construction lines visible, only partly coloured: Pip huddled at the base of a lighthouse as a storm rolls in. Loose and half-done, generous white paper margins. ART style. Must read as "still being drawn". |
| ⚪ | `app-rev-p4` | landscape | A finished picture-book page: inside the lighthouse at night, Pip holding the gull's wing while the storm flashes past the little window, warm lamplight inside against cold blue outside, calm not scary, open sky and wall areas for text. ART style. |
| ⚪ | `app-rev-g1` | landscape | Page 1: the calm harbour, too quiet. ART style, calm area for text. |
| ⚪ | `app-rev-g2` | landscape | Page 2: Pip hears the storm before anyone. |
| ⚪ | `app-rev-g3` | landscape | Page 3: the gull will not leave the pier. |
| ⚪ | `app-rev-g4` | landscape | Page 4: inside the lighthouse, holding wings. *Same as `app-rev-p4`.* |
| ⚪ | `app-rev-g5` | landscape | Page 5: the window flashes white. |
| ⚪ | `app-rev-g6` | landscape | Page 6: Pip sings back at the wind, tiny but brave. |
| ⚪ | `app-rev-g7` | landscape | Page 7: the storm exhales, the sea flattens. |
| ⚪ | `app-rev-g8` | landscape | Page 8: dawn, Pip asleep under the lamp, the gull keeping watch. |

---

## 8 · Worlds, cast & wizards

### Pip's character page

Square-ish tiles, 96×110 crop. Same fox every time, soft paper-white background, no scenery, watercolour storybook.

| | Slot | Prompt |
|:--:|---|---|
| ⚪ | `pip-view-34` | Pip standing, three-quarter view facing left, tail relaxed, gentle expression. Clean character study. |
| ⚪ | `pip-view-side` | Full side profile facing left, standing straight, scarf hanging still. |
| ⚪ | `pip-view-back` | From behind, tail up, head turned slightly so one white ear shows. |
| ⚪ | `pip-feel-happy` | Beaming, eyes closed with joy, ears perked, head-and-shoulders. |
| ⚪ | `pip-feel-worried` | Ears flattened, wide worried eyes, paw near mouth, head-and-shoulders. |
| ⚪ | `pip-feel-brave` | Chin up, chest out, scarf streaming in the wind, determined little smile. |
| ⚪ | `pip-model-sheet` | *(wide ~3:1)* One composite watercolour character sheet on paper-white: a large portrait at left, a full-body turnaround (front, three-quarter, side, back) across the middle, a row of small head expressions at right, tiny handwritten-style labels. Same fox throughout. |

### A look for a new character

`look-sketch-1/2/3` — three squares at **identical crop, scale, eye height and lighting**. Alternatives of one character, not three species. Chest-up, three-quarter view, plain warm background, ART style.

| | Character | 1 | 2 | 3 |
|:--:|---|---|---|---|
| ⚪ | The gull | grey and white, one crooked wing | softer, rounder, a bit scruffy | sharper, bright yellow beak |
| ⚪ | Pip | one white ear, the yellow scarf, as he is now | fluffier, rounder, a little younger | longer nose, taller ears, a bit braver |
| ⚪ | Volt | boxy and bright, as Ethan drew him | sleeker, one glowing eye | heavier, more dented, well used |

### Style grid, the Style phase

Eight tiles, ~150px tall. **The same subject in every tile** — a small friendly fox child — so only the rendering differs.

| | Slot | Prompt |
|:--:|---|---|
| ⚪ | `wiz-style-watercolour` | Soft watercolour washes with loose pencil linework, storybook, gentle palette. *(Pip's default look.)* |
| ⚪ | `wiz-style-cartoon` | Bold ink outlines, bright flat fills, whimsical rhyming-storybook cartoon. |
| ⚪ | `wiz-style-felt` | Cut-felt and paper-collage textures, handmade craft look, warm; the fox child made of felt. |
| ⚪ | `wiz-style-scribble` | Energetic crayon and coloured pen, vivid saturated colour, childlike. |
| ⚪ | `wiz-style-pixar` | Glossy 3D animated film render, round forms, soft studio lighting. |
| ⚪ | `wiz-style-anime` | Hand-painted anime, lush sky and wind, painterly, on a cliff. |
| ⚪ | `wiz-style-classic` | Classic golden-age painted storybook plate, timeless, rich. |
| ⚪ | `wiz-style-bold` | Bold modern picture book, big flat shapes, thick lines, high contrast. |
| ⚪ | `style-3d` | Pip himself as a 3D animated film character: glossy fur, big expressive eyes, soft studio lighting, warm harbour bokeh. |
| ⚪ | `style-anime` | Pip himself in hand-painted anime: towering clouds, wind in the grass on a harbour cliff, looking out to sea, golden light. |

### Cast portraits

| | Slot | Prompt |
|:--:|---|---|
| 🟢 | `wiz-cast-pip` | Pip portrait, watercolour, paper-white background. *Reuse his model-sheet portrait.* |
| ⚪ | `wiz-cast-gull` | The harbour gull, soft watercolour, paper-white background, gentle expression, matching Pip's world. |
| ⚪ | `app-gull` | *(small landscape)* The same gull with a paper boat tucked under one wing, standing on a mooring post. ART style. |

### Video wizard, storyboard frames

Watercolour storybook, cinematic 16:9, soft night-and-dawn harbour palette. A rough storyboard feel is correct.

| | Slot | Prompt |
|:--:|---|---|
| ⚪ | `wiz-board-1` | Wide establishing: Pip small on the harbour wall at night, boats knocking, lamplight on the water. |
| ⚪ | `wiz-board-2` | Pip leaning back from a glass bottle bobbing in dark water, ears down, uneasy. |
| ⚪ | `wiz-board-3` | Two-shot: the gull landed beside Pip at the water's edge, offering a wing. |
| ⚪ | `wiz-board-4` | Low angle on Pip's paw stepping into the pale dawn shallows, brave. |
| ⚪ | `vid-s1` | Pip on the dock pointing at one blue fishing boat. ART style. |
| ⚪ | `vid-s2` | Pip conducting three boats like an orchestra, gulls joining. |
| ⚪ | `vid-s3` | Pip asleep against a bollard as lantern-lit boats glide home. |

### The world page

| | Slot | Aspect | Prompt |
|:--:|---|---|---|
| ⚪ | `app-loc-harbour` | ~220×120 | The stone harbour wall at dusk, little fishing boats knocking softly, lamplight on calm water. Watercolour, **no characters**. |
| ⚪ | `app-loc-lighthouse` | ~220×120 | A small white lighthouse on rocks at night, warm glow, stars. Watercolour, no characters. |
| ⚪ | `app-loc-water` | ~220×120 | Dark choppy open water just past the harbour mouth, faintly foreboding but gentle, dawn light. Watercolour, no characters. |
| ⚪ | `app-art-look` | ~150×96 | A watercolour style swatch card: loose washes and pencil strokes in Pip's Harbour colours (warm tan, soft blue, cream), abstract, no character. |
| ⚪ | `app-art-colour` | ~150×96 | A printable black-and-white colouring page: clean line art of Pip on the harbour wall, thick friendly outlines, white background. |

### Ethan's notebook

Must look like real objects a ten-year-old made.

| | Slot | Prompt |
|:--:|---|---|
| ⚪ | `nb-scan-1` | A photo of a real kid's notebook spread: lined paper, messy ten-year-old pencil handwriting, a doodled rocket ship and lightning bolts in the margin, a few words underlined hard. Shot slightly angled on a desk in warm lamplight. |
| ⚪ | `nb-drawing-1` | A ten-year-old's marker drawing on white paper: a boxy robot dog with antenna ears and a lightning-bolt collar, "VOLT!!" above in big wobbly capitals. Bold marker colours, slightly crumpled paper, photographed flat. |

### Templates and covers *(optional)*

| | Slot | Prompt |
|:--:|---|---|
| ⚪ | `tpl-*` ×6 | Six small landscape tiles in a softer, more iconic ART style on plain warm backgrounds: a lamp with an open book and a sleeping fox curled on it; musical notes rising from a little boat; five paper boats in a row, one sailing off; a small fox facing a big friendly wave; a cake with one candle and two party hats; halftone comic panels with a caped silhouette leaping. |
| ⚪ | `shelf-3` | *(portrait-ish cover)* Pip and the gull on the lighthouse gallery after the storm, sky clearing, empty title space top left. ART style. |

---

## 9 · Print & post

The payoff. Must feel like a real object arriving, so it leans **PHOTO** much harder than the rest of the app.

### Format choice

All four **shot identically** — same surface, light and angle — so switching in the picker changes only the object.

| | Slot | Aspect | Prompt |
|:--:|---|---|---|
| 🟢 | `print-hardcover` | square | A landscape hardcover picture book, ~25cm wide, closed, three-quarter view on a plain warm surface, cloth spine, cover art showing an orange fox with one white ear. PHOTO style, clean product lighting, plain background. |
| ⚪ | `print-board` | square, matching | The same book as a chunky board book, thick pages clearly visible at the edge. |
| ⚪ | `print-softcover` | square, matching | The same book as a softcover, one cover corner slightly bent to show it flexes. |
| 🟢 | `print-comic` | square, matching | A stapled square-bound kids' comic, ~21cm, cover showing a caped silhouette leaping, held slightly open. |

### Proof

| | Slot | Aspect | Prompt |
|:--:|---|---|---|
| 🟢 | `proof-spread` | wide landscape | An open double-page spread lying flat, gutter visible, one page mostly illustration and one mostly text (text may be greeked), a faint printer's registration mark just outside the trim. PHOTO style. |
| ⚪ | `proof-cover-flat` | wide landscape | The full cover printed flat and unfolded, back cover, spine and front cover in one strip on a light table, trim and fold lines faintly visible. PHOTO style. |
| ⚪ | `proof-detail` | square, macro | Extreme close-up of one printed page, visible paper tooth and ink, so the family can judge quality. PHOTO style. |

### Delivery

| | Slot | Aspect | Prompt |
|:--:|---|---|---|
| ⚪ | `print-packing` | landscape | The finished book wrapped in brown paper and string on a workbench, hands only, no faces. PHOTO style. |
| ⚪ | `print-doorstep` | landscape | A small brown-paper parcel on a doorstep in morning light, one child's slipper just entering frame. PHOTO style. |
| 🟢 | `print-arrived` | landscape | A child on the floor tearing brown paper off the book, mid-motion, genuine surprise. PHOTO style. |
| ⚪ | `print-gift` | square | Two identical books, one wrapped with a handwritten gift tag facing away from camera. PHOTO style. |

### Print video

| | Slot | Length | Prompt |
|:--:|---|---|---|
| ⚪ | `vid-print-tour` | 20–30s | The making of one book: pages printing, sheets folded, spine glued, cover wrapped, book boxed, parcel posted. Silent with captions. *Reassurance: this is a real book, made properly.* |
| ⚪ | `vid-unboxing` | 10s | A family opening the parcel at a kitchen table. *"What to expect" on the order confirmation.* |

---

## 10 · Marketing site

For `Arke Kids Studio.dc.html`.

| | Slot | Aspect | Prompt |
|:--:|---|---|---|
| ⚪ | `kids-hero` | landscape | A parent and a four-year-old at a kitchen table in the evening, heads close together, laughing, drawing a little orange fox with crayons scattered around, a tablet propped nearby showing the same fox. PHOTO style. |
| ⚪ | `kids-hero-char` | portrait | Pip sitting on a harbour post looking doubtfully at the water, boats behind. ART style. |
| ⚪ | `kids-hero-book` | landscape | A child's hands holding a hardcover picture book, cover showing the orange fox, warm lamplight. PHOTO style. |
| ⚪ | `kids-print` | landscape, dark | A child tucked in bed reading the same hardcover by a bedside lamp, room mostly in shadow, a parent's silhouette at the door. PHOTO style, **deliberately darker** so white text reads over the lower third. |
| ⚪ | `kids-char1` | square | Pip, chest-up, plain soft-colour background. ART style. |
| ⚪ | `kids-char2` | square | **Juno**, a plump baby whale made of cumulus cloud, drifting above a bedroom, trailing drizzle. |
| ⚪ | `kids-char3` | square | **Sir Wobble**, a translucent wobbly jelly knight in a tin colander helmet, proud pose. |
| ⚪ | `kids-char4` | square | **Mabel**, a powdery grey moth in a tutu mid-pirouette, moonlit. |
| ⚪ | `kids-char5` | square | **Rex**, a thumb-sized T-rex standing in a coat pocket, roaring adorably. |
| ⚪ | `kids-char6` | square | **Zia**, a round owl in a knitted hat counting stars on an abacus. |
| ⚪ | `kids-spread` | wide landscape | An open picture-book double spread with a slight centre gutter: left page, Pip at the harbour edge refusing to look at the water; right page, the gull offering him a paper boat; large empty sky areas for text. ART style. |
| ⚪ | `kids-video1` | landscape | Pip on a dock counting fishing boats, numbers implied by lanterns, bouncy and bright. ART style. |
| ⚪ | `kids-video2` | landscape | Pip and a small green dragon in a birthday hat sharing cake on the harbour wall, confetti. ART style. |
| ⚪ | `kids-age4` | landscape | A single picture-book page, one huge illustration of Pip hiding from a wave, room for eight big words. ART style. |
| ⚪ | `kids-age5` | landscape | A bright video frame of Pip singing on a boat prow. ART style. |
| ⚪ | `kids-age7` | landscape | A chapter-book page: a small ink-and-wash vignette of Pip mid-swim at the top, dense greeked type below. ART style. |
| ⚪ | `kids-safety` | landscape | A parent and child on a sofa looking at a tablet together, the parent's finger hovering over the screen, the child pointing and grinning. PHOTO style. |
| 🟢 | `site-helper-*` ×6 | square | Reuses the six supplied helper portraits. |
| 🟢 | `voice-hero` | landscape | Reused on the site's voice-first band. |
| ⚪ | `site-print-band` | landscape | Optional: reuse `print-arrived`. |

---

## 11 · Parent onboarding videos

Three layers, one shoot. The **host** carries trust (bookends only, no instructions, no UI, so a redesign never invalidates her). **Real family footage** carries the teaching. **The helpers** carry anything a parent might see while the child is watching.

### Shared shoot constants

| Block | Paste this |
|---|---|
| **HOST LOCK** | *a friendly mixed-race woman in her early thirties, warm brown skin, dark natural curls worn loose to the shoulder, minimal make-up, small gold stud earrings, an oatmeal knitted jumper with the sleeves pushed up, no lanyard, no headset, no branding, no clipboard* |
| **ROOM LOCK** | *a bright lived-in family room: pale warm-white walls, a low bookshelf of real picture books, four children's crayon drawings taped up slightly crooked, a soft oatmeal rug, one trailing plant, a pale linen armchair at frame right; warm afternoon window light from camera left, no visible lamps or fill* |
| **LOOK LOCK** | *warm editorial lifestyle photography, natural window light, 50mm, shallow depth of field, muted warm palette, gentle film grain, candid and unposed, no logos, no on-screen text, no watermark* |

> Not a studio. Never a kids-TV set, foam letters, bunting, balloons, a desk, a backdrop or a headset.

### Host clips and stills

| | Slot | Aspect | Prompt |
|:--:|---|---|---|
| 🟢 | `host-welcome-frame` | still 16:9 | **Supplied.** Chest-up, seated, straight to camera, hands lightly open in her lap, the crayon drawings and bookshelf soft behind her. The first frame of `host-welcome` — shoot the video to match it exactly. |
| ⚪ | `host-welcome` | video 25s, 16:9 | HOST LOCK sits in a pale linen armchair in ROOM LOCK and speaks warmly and directly to camera. Medium shot from the chest up, she leans slightly forward, hands relaxed in her lap and occasionally opening in one small unhurried gesture, smiling between sentences rather than continuously, eye-line straight to the lens. Behind her, softly out of focus, the bookshelf and the taped-up crayon drawings. The camera is locked off and completely still. LOOK LOCK. |
| 🟢 | `host-wide` | still 16:9 | **Supplied.** Full-body wide: seated in the armchair at frame right, legs crossed, the whole room readable — three crayon drawings, the bookshelf of picture books, wicker basket, trailing plant, rug. The establishing frame, and the widest crop available. |
| ⚪ | `host-signoff` | video 20s, 16:9 | The same woman, same jumper, same armchair and room, same session, identical hair, make-up and light. Medium shot matching the previous framing exactly. Posture a little more relaxed, one hand resting on the arm of the chair, finishing with a genuine closed-mouth smile and one small nod to camera. Camera locked off. LOOK LOCK. |
| 🟢 | `host-still-open` | still 16:9 | Medium shot, seated, caught mid-sentence with both palms open in a small explaining gesture, warm engaged expression, straight to camera. Room softly out of focus. LOOK LOCK. |
| 🟢 | `host-still-listening` | still 16:9 | Same seat and wardrobe, head tilted slightly, listening rather than speaking, mouth closed, eyes attentive and kind, hands still in her lap. LOOK LOCK. |
| 🟢 | `host-still-aside` | still 16:9 | Turned three-quarters, looking off-camera right at something we cannot see, small interested smile. **She sits in the left third; the right half is calm empty wall for a caption.** LOOK LOCK. |
| 🟢 | `host-still-warm` | still square | Head-and-shoulders, quiet closed-mouth smile, straight to camera, warm and unguarded, background reduced to soft warm blur. 85mm. LOOK LOCK. |
| 🟢 | `host-title-plate` | still 16:9 | ROOM LOCK **with nobody in it**: the armchair empty at frame right, bookshelf and crayon drawings at frame left, soft rug, trailing plant. The upper two-thirds is calm empty pale wall. 35mm. LOOK LOCK. *One plate, reused for every chapter title, with the product's own type set over the wall. No lower-third bar.* |

**🟢 All five host stills are supplied and wired.** The host lock is now set by the photographs, not the prose: *warm brown skin, dark curly shoulder-length hair, oatmeal knit jumper, blue jeans, pale linen armchair, children's crayon drawings taped to a pale wall, low bookshelf, trailing plant, wicker basket, soft rug.* Match this room and wardrobe exactly when the two **video** clips are shot.

| In the app | Uses |
|---|---|
| First-run welcome card | `host-wide` as the video poster |
| Getting started, main player | `host-welcome-frame` in a 16:9 box |
| Getting started, "Your OK, always" clip | `host-still-aside` |
| Getting started, clip-list header | `host-title-plate` |
| Not yet placed | `host-still-open`, `host-still-listening` and `host-still-warm` — the warm crop is an 85mm avatar, so keep it for a small circular slot, never a full-width poster |

**Scripts**

| Clip | Words |
|---|---|
| `host-welcome` | "Arke Kids is for the two of you, together. Your child does the imagining, out loud, and the helpers do the making. You stay in the middle of it. Nothing they make reaches them until you have seen it and said yes. That is the whole idea, and everything else is just making things you will want to keep." |
| `host-signoff` | "That is everything you need. Start with one character, tonight, and let them tell you who it is. If it turns into something you love, we will print it and put it in the post. Have fun with it." |

### Real-family clips

**Cast the same parent and child in all six**, and neither may be the host. No faces addressing camera. Handheld but steady. The tablet must be legible.

| | Slot | Length | Prompt |
|:--:|---|---|---|
| ⚪ | `guide-talk` | 15s | A four-year-old girl and her parent sit cross-legged on a rug in a warm family living room, a tablet propped upright on a low table. The child talks at the tablet with both hands lifted in the air describing something enormous, mid-word, delighted; the parent sits just behind her, out of focus, smiling and not intervening. Filmed from slightly behind and to one side so the screen is visible but the child's face leads. 35mm, handheld but steady. LOOK LOCK. |
| ⚪ | `guide-handover` | 10s | Close shot across a low wooden table: a tablet passed from adult hands to a small child's hands, the child's fingers wrapping the edges as the adult lets go. Only hands and forearms, no faces. Slow, unhurried. 50mm. LOOK LOCK. |
| ⚪ | `guide-approve` | 15s | A parent alone on a sofa late in the evening, one lamp on, the rest of the room dark and quiet, thumbing slowly through pages on a tablet in their lap. Calm, a small approving nod. From the side at sofa height, the lamp warm against the dark. 50mm. LOOK LOCK. |
| ⚪ | `guide-drawing` | 15s | Directly overhead: a child's wax-crayon fox on lined paper on a wooden kitchen table, a parent's hands holding a tablet above it, photographing it, the tablet screen showing the same drawing in the camera view. A child's hand enters at the edge of frame, pointing. No faces. 35mm. LOOK LOCK. |
| ⚪ | `guide-readaloud` | 15s | A parent and a four-year-old lying in bed under a duvet at bedtime, a tablet propped between them showing a picture-book page, a warm bedside lamp on. The child points at the screen, the parent is mid-word. From the side at pillow height, faces partly turned away. 50mm. LOOK LOCK. |
| ⚪ | `guide-parcel` | 10s | A brown-paper parcel with string on a doormat in morning light just inside a front door. Two small hands tear the paper open to reveal the cover of a hardcover picture book showing an orange fox. Low camera at doormat height, no faces. 35mm. LOOK LOCK. |

### Helper tips *(in-app, safe for a child to see)*

| | Slot | Length | Prompt |
|:--:|---|---|---|
| ⚪ | `tip-nan-approval` | 4s square | Nan blinks slowly once and raises one wing gently in a "let's check first" gesture, then settles. Seamless loop, cream background, ART style, no text. |
| ⚪ | `tip-barnaby-print` | 4s square | Barnaby pats the cover of the little hardcover he is holding twice, pleased. Seamless loop, cream background, ART style, no text. |
| ⚪ | `tip-pockets-listening` | 4s square | Pockets cups one ear toward the viewer and twitches it, and a new scrap of paper appears in a chest pocket. Seamless loop, cream background, ART style, no text. |

### Cut order

| # | Clip | Length | Carries |
|---|---|---|---|
| 1 | `host-welcome` | 25s | why, and the approval promise |
| 2 | `guide-talk` | 15s | your child can drive it without typing |
| 3 | `guide-handover` | 10s | you can safely hand the screen over |
| 4 | `guide-approve` | 15s | nothing reaches them without your yes |
| 5 | `guide-drawing` | 15s | their own drawing goes in, unretouched |
| 6 | `guide-readaloud` | 15s | it reads itself aloud, in your voice |
| 7 | `guide-parcel` | 10s | it ends as a real book in the post |
| 8 | `host-signoff` | 20s | permission to start |

**Total 2:05.** No middle clip depends on the one before it, so each doubles as a standalone tip inside the app.

---

## 12 · What to make next

| Order | What | Why now |
|:--:|---|---|
| 1 | `draw-tidied` and `cmp-painted` | The comparison screens are built and showing empty slots. Without these the product's strongest claim cannot be seen. |
| 2 | `pip-answering` **redo** | One regeneration fixes the voice state change, which currently jumps. |
| 3 | `print-hardcover`, `proof-spread`, `print-arrived` | The print flow reads as vapour without a real object. |
| 4 | `host-welcome`, `host-signoff` and the six `guide-*` clips | Onboarding has no video at all yet. |
| 5 | The six helper loops | The cast exists as stills; the loops make the Making screen live. |
| 6 | `kid-tile-*`, `kid-wait`, `kid-done` | The weakest-looking surface, and the one a child actually sees. |
| 7 | Everything else | |

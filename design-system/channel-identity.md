# Arke Worlds, channel identity

Arke Worlds is the parent brand; Arke Studio is the product inside it. The YouTube channel
belongs to Arke Worlds and is **mostly a devblog** — building Arke Studio in the open — with
craft teaching as a secondary strand. Its audience is creatives who intend to make something:
novelists, screenwriters, directors, people building interactive stories.

Everything here inherits the visual language in [`image-prompts.md`](image-prompts.md): muted
teal-slate, one warm amber accent, painterly cinematic, dark and quiet. Type is Geist and Geist
Mono, per [`_ds/…/tokens/fonts.css`](_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens/fonts.css).

All prompts here target **GPT Image 2**, which renders lettering reliably enough to bake the
wordmark into the image rather than typesetting it afterwards. They are written in the sectioned,
all-caps-heading style the Maren pitch-board prompt uses, because that is what the model responds
to best.

## Status

| Asset | File | Status |
|---|---|---|
| Channel banner, 16:9 with baked wordmark | `assets/channel-banner.png` | ✅ Generated |
| Channel avatar, monogram | `assets/channel-avatar.png` | ⟳ Regenerate — needs the scale and line-weight fix pass |
| Title-card plate, horizon | `assets/title-card-horizon.png` | ✅ Generated — rejected as avatar, reassigned |
| Banner, tagline-contrast fix | — | ◻ Not applied, optional |
| Banner, warm-side correction | — | ◻ Not applied, optional |

Statuses: **✅ Generated** (asset in place) · **⟳ Regenerate** (prompt changed since the asset was
made) · **◻ Not generated**. If you rewrite a prompt below, flip its row to ⟳.

---

## The canvas

YouTube crops the banner brutally and differently per device. Composition is driven by this table,
not by what the full frame looks like.

| | Banner | Avatar |
|---|---|---|
| Upload | 2560 × 1440, 16:9, under 6 MB | 800 × 800 PNG, under 4 MB |
| Visible on every device | centre 1546 × 423 — the middle **60% width × 29% height** | the inscribed circle; corners are discarded |
| Desktop | full-width strip 2560 × 423 — again the middle 29% of height | rendered at 98 × 98 |
| Smallest real render | — | ~24 px in comments and search |
| Full frame seen only on | TV | never |

**Everything that matters lives in the central band.** The top and bottom thirds of the banner are
seen by almost nobody. 98 × 98 is the avatar's *display* size, not its upload size.

---

## Banner

### Concept

One continuous horizon, three worlds. The Undersong at the left edge, Meridian Dust and Copper
Saints at the right, and a deliberately empty middle that holds the wordmark. Plural in the name,
plural in the image.

Two constraints shape it beyond the brief:

- **The horizon sits below centre, around 60%**, so the type beds on clean fog rather than across
  the value break.
- **The outer worlds reach inward past the safe-box edges.** Pinned to the far edges they vanish on
  mobile, which only sees the middle 60% — a phone viewer would get fog and a wordmark and no
  worlds at all. The innermost bell tower and the first whale-bone arch must stand *inside* the
  central 60% of the width so silhouettes frame the type at every crop.

### Delivery contract

- One continuous image. Not a triptych, not a montage, no gutters or seams.
- The centre is the darkest, most tonally even region of the frame — that is what carries white type.
- Exactly three small warm amber accents, all distant and low.
- Ask for the widest landscape size the endpoint offers. If that is 3:2 rather than 16:9, nothing is
  lost: every constraint pins content into the central band, so cropping 3:2 to 16:9 trims only
  empty sky and water.
- Upscale to 2560 × 1440 and export under 6 MB.
- Judge re-rolls on three things in this order: is the lettering spelled and kerned cleanly; does the
  horizon stay level and unbroken; does the centre stay dark enough for white type.

### Prompt

```
Create a wide cinematic YouTube channel banner for a worldbuilding studio called
ARKE WORLDS. Premium, restrained, film-poster quality. Not a collage, not a
montage, not a poster with panels.

CANVAS: One single continuous ultra-wide 16:9 landscape image. All essential
content — the horizon, both typographic lines, and every recognisable silhouette
— must sit within the central 60% of the width and the middle 30% of the height.
The outer left and right edges, the top third and the bottom third are
atmospheric only and may be almost empty.

SCENE: Three distinct worlds meeting along one single unbroken horizon, reading
left to right as one continuous landscape with no seams, gutters or divisions.
LEFT: a drowned stone harbour at dusk — half-submerged bell towers and
copper-green domes standing in deep teal-slate water, a distant lighthouse,
ribbons of pale bioluminescent light drawn through the tide, one small warm amber
lantern on a weathered pier. The innermost bell tower reaches inward far enough
to stand just inside the central 60% of the width.
CENTRE: the harbour dissolves into vast quiet emptiness — flat calm dark water
meeting a low wall of soft volumetric fog. Almost no detail. This is the darkest,
most tonally even region of the entire image.
RIGHT: the water thins to a salt-white desert floor that was once an ocean,
fossilised whale-bone arches rising through rust-orange dust haze, and far beyond
them the faint silhouette of a rain-slicked brick city at night with amber sodium
lamps. The innermost whale-bone arch reaches inward far enough to stand just
inside the central 60% of the width.
The three regions hand off to one another through fog, dust and rain, never
through hard edges. The frame must read as one place.

CAMERA AND LIGHT: Locked-off eye-level camera, extremely wide anamorphic framing,
deep atmospheric perspective. The horizon runs perfectly level and unbroken, set
slightly below the vertical centre at roughly 60% of the way down the frame. Cool
blue-hour ambient light. Exactly three small warm amber accents in the whole
image, all of them distant and low. The area directly above the horizon in the
centre of the frame stays dark, even and uncluttered.

TYPOGRAPHY — the only text anywhere in the image:
Line 1, the wordmark, horizontally centred and sitting in the fog directly above
the horizon: ARKE WORLDS
Spelled exactly, letter for letter: A-R-K-E space W-O-R-L-D-S. Capitals only. A
clean contemporary geometric sans-serif with even stroke weight, generous
x-height and flat terminals, in the manner of Geist, Inter or Helvetica Neue
Light. Light weight, not bold. Wide, even, confident letter-spacing. Pure white,
crisply rendered, evenly kerned, sitting flat on the image with no bevel, glow,
outline, drop shadow or 3D extrusion. Cap height approximately 9% of the total
image height.
Line 2, the tagline, horizontally centred directly beneath the wordmark, separated
by a gap of roughly half the wordmark's cap height: THE WORLD IS THE ASSET
Spelled exactly, capitals only, in a technical monospaced typeface in the manner
of Geist Mono or JetBrains Mono, with very wide letter-spacing. Cap height
approximately one quarter of the wordmark's. Soft neutral grey, clearly quieter
than the white wordmark.
Both lines form one tight centred stack, optically centred as a block within the
middle 30% of the frame height. The scene behind them stays dark enough that both
lines read at a glance.

STYLE: Painterly cinematic concept art. Muted teal and slate palette with one
warm amber accent. Soft volumetric fog, filmic lighting, high detail, quiet and
assured rather than spectacular. Emotionally still.

STRICT RULES: No text of any kind other than the two specified lines — no
subtitles, captions, credits, URLs, dates, taglines, invented words, letters
hidden in the architecture, or signage. No logo, symbol, icon or watermark. No
borders, frames, panel gutters, seams or triptych divisions. No people in the
foreground and no faces. No lens flare, sun glare or particles. No tilted or
broken horizon. No saturated colour. No bright or high-contrast centre. No
fantasy clichés — no dragons, spaceships or floating islands. No HDR look.
```

**Tagline alternates.** `THE WORLD IS THE ASSET` is correct for a devblog-led channel, whose viewer
is interested in the product thesis. Were the channel led by craft teaching instead,
`ONE WORLD · EVERY FORMAT` or `AUTHOR ONCE · PRODUCE EVERYWHERE` would serve better. Swap the one
string; nothing else changes.

### Extend to 16:9

If the master comes back wider than 16:9, extend it rather than cropping the sides. Cropping costs
roughly 16% off each edge — the far-left lighthouse and amber pier lantern, the copper city and skull
on the right — and it makes the desktop strip show *less* of the scene, not more (43% of scene height
when extended, against 29% when cropped to fill).

```
Extend this image vertically only, to a 16:9 aspect ratio. Do not crop, scale,
shift or alter any existing content — the horizon, both lines of text, the harbour,
the whale bones and the far city stay exactly where and as they are, at exactly
the same width.
Add more sky above: the same dark storm-heavy overcast continuing upward, growing
slightly deeper and emptier toward the top edge, with the same soft volumetric
haze and no new light sources, cloud shapes, stars, birds or structures.
Add more water below: the same flat calm dark reflective surface continuing
downward toward the bottom edge, with the same faint reflected glow, no new
objects, no shoreline, no foreground detail and no ripples.
Match the existing grain, colour temperature, contrast and atmosphere exactly. The
new areas must be indistinguishable in style from the original and must contain no
text, lettering or watermark of any kind.
```

**Known drift.** The extend adds more sky than water, which pushes the scene down — in the current
asset the horizon lands near 63%, at the *bottom* edge of the desktop strip. Desktop then shows sky,
the wordmark and the tops of both cities, while the pier lantern and bioluminescent tide fall below
the visible band. To recover them, trim ~6% off the top of the canvas and add the same to the bottom
before export. The sky-heavy version is arguably more on-brand; this is a judgement call, not a bug.

### Fix passes

Both optional. Neither has been applied to the current asset.

**Tagline contrast.** The tagline sits on the brightest part of the fog band. It survives at full
size; YouTube compresses banners hard, so it may soften at channel scale.

```
Keep everything in this image identical. Darken only the band of fog and haze
immediately behind and around the smaller line of text, lowering its brightness so
the grey lettering reads clearly against it. Do not move, resize, restyle or
respell either line of text. Do not change the horizon, the sky, the water or any
structure. The darkening must be a soft, gradual, invisible falloff with no visible
edge, shape, box or vignette.
```

**The warm side runs hot.** House rule across the asset set is a muted palette with *one* warm
accent. The generated right third is broadly orange-lit, which pushes the frame toward a blue/orange
split. Append to a re-roll or edit:

> reduce the overall warm ambient light on the right side by half, keeping the amber city lamps as
> small isolated points against a cooler dust haze, so the whole image reads as cool with only a few
> warm accents

### Acceptance

The horizon is level and unbroken; both lines are correctly spelled and evenly kerned; the centre is
dark enough that white type reads at a glance; the inner bell tower and inner whale-bone arch both
fall inside the central 60% of the width; no lettering appears anywhere else in the frame. Check the
desktop strip and the mobile safe box as crops — never judge the banner by the full frame.

---

## Avatar

### Delivery contract

- Upload 800 × 800 PNG, under 4 MB.
- Cropped to a circle. Everything essential inside the inscribed circle, ideally the central 80%.
- **Never near-black.** YouTube's dark theme sits on roughly `#0F0F0F`; a near-black avatar becomes
  an invisible hole in the page. The base value must lift to a deep teal-slate that holds against
  both themes. The banner can be as dark as it likes; the avatar cannot.
- Judge it by shrinking to 24 px and squinting, not by admiring it at full size, and check it on both
  a white and a `#0F0F0F` ground before committing.

### The mark: monogram

Chosen. A letter is a shape, and shapes survive downscaling. The A's crossbar extends edge to edge as
a horizon with a single amber point on it, which ties the avatar to the banner and makes the mark a
fragment of the same world rather than a separate logo — it matters because the avatar sits directly
beneath the banner on the channel page.

```
A square brand mark: a single capital letter A, centred, in a clean contemporary
geometric sans-serif with even stroke weight and flat terminals, in the manner of
Geist or Inter. Light-to-regular weight, wide and open, sized to fill roughly 58%
of the square's width and 52% of its height. Pure white, perfectly formed,
symmetrical and correctly proportioned.

The letter's horizontal crossbar extends out past both sides of the letter as one
perfectly level line running the full width of the square, edge to edge, so it
reads simultaneously as a horizon. Its thickness is roughly 1.5% of the image
width — clearly visible as a distinct line at small sizes, thinner than the
letter's diagonal strokes, but never a hairline. A single small warm amber point of
light sits on that line to the right of the letter, glowing softly into the air
around it.

BACKGROUND: A smooth deep teal-slate field with soft atmospheric fog, marginally
lighter behind the letter and darkening toward the corners, never approaching pure
black, so the mark holds against both a white and a near-black page background.

CONTENTS: Nothing else. No other letters, no words, no numbers, no symbols, no
border, no frame, no watermark. The letter is flat and clean — no bevel, glow,
outline, drop shadow or 3D extrusion. Must remain legible reduced to a 24-pixel
circle. All content well inside the central circle, as the corners will be cropped.
```

**Fix pass for the existing asset.** The first generation came back with the A filling about a third
of the frame width instead of 58%, and with the horizon as a hairline that will go sub-pixel at
98 px — which deletes the clever part of the mark and leaves the A reading as a bare Λ.

```
Keep this image's concept, palette, atmosphere, fog, lighting and composition
exactly as they are. Change only scale and line weight.

Enlarge the capital letter A so it fills roughly 58% of the image width and 52% of
the image height, keeping it centred, keeping its current letterform, weight,
proportions and pure white colour exactly as they are. Do not restyle or redraw the
letter — only scale it up.

Thicken the horizontal horizon line substantially, to roughly 1.5% of the image
width — clearly visible as a distinct line at small sizes, still thinner than the
letter's diagonal strokes, but never a hairline. It stays perfectly level and runs
the full width of the image, edge to edge, and continues to serve as the letter's
crossbar.

Enlarge the warm amber point of light on the line by about half again, keeping it to
the right of the letter and keeping its soft glow gentle and contained.

Everything else is unchanged: the deep teal-slate fogged background, the corner
falloff, the absence of any other letters, words, symbols, borders or watermarks,
and the flat clean rendering of the letter with no bevel, glow, outline or shadow.
```

### Rejected: the horizon mark

Kept on record because the prompt produces a genuinely good image — it is simply not a mark. Its read
depends on one small softly-bloomed amber point against low-contrast teal; at feed size the point
becomes a single faint pixel, the bloom smears into the horizon band, and what remains is an
anonymous teal blob. Beautiful plate, no silhouette.

Reassigned to `assets/title-card-horizon.png` for video title cards, end screens, section
backgrounds and playlist art, where it renders large enough to work.

```
A square brand mark for a worldbuilding studio, painted as an extremely simplified
fragment of a single world.

COMPOSITION: One perfectly level, unbroken horizon running straight across the
exact middle of the square, edge to edge. Above it, a deep teal-slate atmosphere of
soft luminous fog, darkening gradually toward the top edge. Below it, the same
tone slightly deeper, flat and calm as still water. Exactly one small warm amber
light sits on the horizon, slightly left of centre, glowing softly into the fog
around it and reflecting straight down into the water beneath it as one narrow
amber streak.

CONTENTS: Nothing else whatsoever. No buildings, no land, no boats, no figures, no
clouds, no stars, no moon, no text, no letters, no symbols, no border, no frame.

VALUE: Base tone is a deep teal-slate clearly lighter than black — the value of a
dark slate blue-green. The image must never approach pure black anywhere, so the
mark stays visible against both a white page and a near-black page. Keep the
overall contrast gentle and the tonal transitions smooth.

LEGIBILITY: The image must still read when reduced to a 24-pixel circle, as three
elements only — dark above, dark below, one warm point between them. All essential
content sits well inside the central circle of the square, because the corners will
be cropped away.

STYLE: Painterly cinematic concept art, muted teal-slate palette with a single warm
amber accent, soft volumetric fog, filmic lighting, high tonal subtlety. No grain,
no vignette, no watermark, no text.
```

### Acceptance

Legible as a distinct mark at 24 px; visible against both a white and a `#0F0F0F` ground; the horizon
line survives at 98 px; nothing essential outside the inscribed circle.

---

## Channel description

Roughly 975 of YouTube's 1,000 characters. Paste as-is; YouTube descriptions are plain text, and line
breaks are the only formatting available.

```
Building Arke Studio in the open — one tool for turning a world into novels, films, dramas and interactive stories.

Most creative tools are organised around projects. You finish a film, and the film is what you own; the world it was set in still lives in your head and a folder of notes. We're building the opposite, and doing it where you can watch.

Mostly this is the devblog: what we're making next and why, the design decisions in full, what we get wrong, and features as they land. Along the way we teach the craft it's built on — how to decide what's true in a world and keep it true, how to direct image and video models so a character stays the same person across a hundred frames, how to get from a premise to a shot to a finished cut.

Arke Studio is early, free and open source, runs on your own machine, and your worlds stay on your disk.

The world is the asset. Author once, produce everywhere. If you've a world in your head and a folder of notes to show for it, this is for you.
```

### Why it reads this way

**The first line must work alone.** YouTube indexes channel descriptions and truncates them in search
results at roughly 100–150 characters. That opening carries the brand name, the category and the
formats, and signals devblog immediately.

**Paragraph two is lifted from the README.** "The world it was set in exists only in your head and
across a folder of notes" is the sharpest sentence the project has, and it is the line that makes a
novelist or a director recognise themselves. It does more work than a pitch would.

**The ratio is stated out loud.** "Mostly this is the devblog" costs nine words and buys an audience
that stays, because nobody subscribes expecting a tutorial series and leaves disappointed.

**AI is named as a skill, not an identity.** "How to direct image and video models" sits inside the
teaching list rather than in the opening line. Creatives searching for worldbuilding and screenwriting
find the channel, the method stays honest and visible, and the channel is not branded as an AI
channel — that audience churns and is not the one being courted.

**"What we get wrong" is load-bearing.** It is the whole difference between a devblog and a marketing
feed, and it is already true of how the project is built: the specs say plainly what is designed and
not yet written.

**"Early" is deliberate.** A devblog audience forgives rough edges when told in advance and turns on
you when it discovers them itself.

If *devblog* reads too software-flavoured for novelists and directors, `build diary` swaps in cleanly
— but devblog is the term people search, so keep it in the description and use *build diary* in video
titles, where warmth matters more than discovery.

### Keywords

Settings → Channel → Basic info. A separate field from the description, and worth populating.

```
worldbuilding, devblog, build in public, worldbuilding tutorial, creative tools, narrative design, screenwriting, novel writing, character design, filmmaking, storyboarding, concept art, interactive fiction, AI filmmaking, AI video, indie software
```

### Links

YouTube has a dedicated Links section that renders on the channel page. Keep URLs out of the
description body — a link buried in paragraph five does nothing.

| Label | URL |
|---|---|
| Arke Studio on GitHub | `github.com/michaeljosiah/ArkeStudio` |
| Download for Windows | `github.com/michaeljosiah/ArkeStudio/releases/latest` |

### Playlists

Split the two strands: `Devblog` in release order, `Craft` standalone. Feature the devblog playlist
as the channel's default section so a new visitor lands in sequence rather than on whatever is
newest. A devblog is the one format where episode order genuinely matters.

---

## Decision log

| Decision | Reasoning |
|---|---|
| Wordmark baked into the image rather than typeset afterwards | GPT Image 2 renders lettering reliably enough, and one asset is simpler to regenerate than a layered file. Expect several re-rolls for clean kerning. |
| Three worlds, empty centre | The centre is the only region visible on every device, and it has to hold white type. Making it the darkest and emptiest part of the frame serves both the crop and the type. |
| Worlds reach inward past the safe-box edges | Pinned to the far edges they disappear on mobile, leaving a wordmark on fog with nothing to say it is about worlds. |
| Horizon below centre rather than dead centre | Keeps the value break away from the type. |
| Extend to 16:9 rather than crop to fill | Preserves full width, fills the TV view without bars, and shows 43% of scene height in the desktop strip against 29% when cropped. |
| Monogram over the atmospheric mark for the avatar | A letter survives downscaling to 24 px; a soft amber point on low-contrast teal does not. |
| Avatar base lifted off black | YouTube's dark theme is roughly `#0F0F0F`; a near-black avatar reads as a hole in the page. |
| Description leads with devblog, not craft | The channel is mostly a devblog. Stating the ratio sets expectations and retains subscribers. |
| `THE WORLD IS THE ASSET` kept as the banner tagline | Correct for a devblog-led channel, whose viewer is interested in the product thesis. A craft-led channel would want a viewer-facing line instead. |

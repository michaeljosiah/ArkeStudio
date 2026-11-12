# Turn 277 · Text in the Cut

Drawn 12 November 2026 and approved by the owner the same day; not built when drawn. The design
turn SPEC-065 owes (issue 2990) before the Cut's controls for text clips are written.

## Asked

Issue 2990: a title typed on the timeline, drawn by the app, in place of a picture made elsewhere
and uploaded. SPEC-065 sets what a text clip is and leaves four things to this turn: the Add
action, the Inspector's rows, the clip on its track and the typeface menu, on desktop and phone.
It also leaves four questions open for the owner, answered below as proposals.

## Why

- The Juju promo's names were made as pictures outside the app and placed as stills. Changing a
  word meant making the picture again.
- A title is words and a look. Both belong in the Inspector beside the fades and the blend a still
  picture already has, so nothing new has to be learnt to time one.

## What is drawn

| Frame | Screen |
|---|---|
| 277a | Add pressed: a four-second text clip at the playhead on a new picture track, selected, its words selected |
| 277b | A text clip selected: Words, Type and Place; Size shows the size Fit draws |
| 277c | The typeface menu open over a title of two lines, each name in its own face |
| 277d | Further down: Fill, Edge, Shadow, Rule, Backing; the colours run down each line, the rule sits under the last |
| 277e | The end: the four timing rows, Motion, and Appearance with its protection, as a still picture shows them |
| 277f | Words the typeface cannot draw: `Jost has no ẹ` under the field, nothing saved; a title moved by hand reads Custom |
| 277g | Three text clips selected: the look without the words, `Mixed` where they differ |
| 277h | Phone, nothing selected: Text in the foot |
| 277i | Phone, a text clip selected: the selection line and Edit |
| 277j | Phone, the sheet open under the Viewer |
| 277k | Phone, the typeface list inside the sheet |

## The sample

Harbour lights (16:9, 72 s, 24 fps), the film turn 220's Cut shell draws, with three titles on a
picture track of their own: `Harbour lights`, `The coast / at first light` on two lines, and
`Evening`. The shell is 220's own script; this turn swaps its Overlay lane, its Viewer canvas and
its Inspector body, and adds one button to the timeline's header. The shell letterboxes its still;
here the Viewer draws it as the film's 16:9 frame, so every per cent in the Inspector can be
checked against the frame. The look is the promo's: Jost in capitals with wide tracking, four golds
top to bottom of each line, a dark edge, a halo, a faded rule and a shade behind. The title in the
Viewer is an SVG drawn to the same numbers, standing in for the painter.

## The open questions, as proposed

- **Which typefaces, and how many.** Six: Geist, Jost, Comic Neue and Bangers, which are installed
  with the app, plus EB Garamond and Cinzel. The last two are named and not drawn: their files are
  not in the repository, and fetching them is the owner's to allow. The painter's own files for the
  four are new pinned files in the coordinator; the client loads only some of their weights today.
  Checked with fontkit: none of the four has ẹ, ọ and ṣ together (Bangers lacks only ṣ), so the
  serif picked must.
- **Where Add lives.** Beside the transport with the T key; in the shipped strip, after Add audio
  track. A gutter belongs to one track and R-29 may need a new one.
- **Named places and a guide.** Five named places and Custom; no guide for the areas phone apps
  cover, which SPEC-065 leaves out along with dragging in the Viewer.
- **Seeding from a character's name.** Not in the Cut. A request to Arke.

## Calls the owner may strike

- **The Play button gives way** to a selected text clip while the film is paused (rule 4).
- **The Viewer drops the fades while the Words field has focus** (rule 5). A new clip starts at the
  playhead with a half-second fade, so its first frame is faint; without this the words typed into
  a new clip would not be seen until the playhead moved.
- **Timing follows the look**, where a picture's Inspector puts it straight after the header
  (rule 7, R-31).
- **Opacity**, where a picture's slider reads Picture opacity, and **no hint under Appearance**:
  the picture's speaks of sound (rule 7).
- **Tracking falls between characters**, none after a line's last, so a tracked line stays centred
  on its letters (rule 9). R-8 as written adds it after every character; proposed as an amendment.
- **Middle** for the place at the centre of the frame, so Centre is only an alignment (rule 11).
- **Edit** as the phone's name for the sheet's button over a text clip, where a picture's says Trim.
- **The sheet starts under the Viewer** on a phone, 42px lower than the shell's, so a lower-third
  title is not covered while it is changed.

## Not drawn

Trim, split, move and crossfade of a text clip (the existing gestures); the colour picker; the
mixed states 277g's titles do not differ in; the phone's keyboard; the refusal before an export;
Arke's cards. Rule 16 says where each belongs.

## Changed after the first draft

The frames the owner approved were the first draft. A review against the shipped Cut then made
them truer to it, without changing what was approved: the Viewer draws the 16:9 frame; 277c and
277d show a two-line title; 277e draws the timing rows and Appearance's protection as shipped and
no longer scrolls; 277f shows Custom; 277g's Mixed values are true of the three titles; the
selected clip is outlined as a picture clip is; Place's Centre became Middle; the tip reads
Add text · T.

## Checks

`node design-system/cut-text-277.mjs`, then `check-master.mjs --record` and `build-review.mjs`.
`cut-text-277.shoot.mjs` shoots every frame light and dark and reports anything that leaves its
frame: none does; the Inspector scrolls in 277j by design.

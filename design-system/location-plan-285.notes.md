# Turn 285 · the Plan

Drawn 20 November 2026 for the owner's approval. Nothing here is built. It answers issue 2302's
comment of the same day: the film's second scene needed a floor plan, named camera positions and a
rule of sides, and all three were drawn outside Arke. It extends turns 229 (the Stage, uplifted)
and 231 (the Stage in the page), which are built.

## What is drawn

| Frame | Screen |
|---|---|
| 285a | The scene page with a fourth view, Plan: the set from above, the cast on marks, two walks, ten numbered positions; the inspector lists positions and sides |
| 285b | Position 5, The wide, selected: its form, its grey view and its picture, Redraw picture |
| 285c | Shot 23 tried from the bar's side: position 11 in the warning colour, one crossing, one clause |
| 285d | A location's sheet with a third tab, Plan: the set with no cast, every position as a card |
| 285e | The Stage in the page on shot 3: the camera's position row, the set named for its place, Start from with The place |
| 285f | The scene page on a phone with the Plan view |

## Where each screen came from

Every screen the Plan stands in is the app's own, not a drawing of it. `location-plan-285.capture.mjs`
builds the real client from this tree, mounts the real `App` on a synthetic world (the sample below),
and for each screen writes its markup and the client rules that style it:

| Frame | Taken from | What the turn changed in it |
|---|---|---|
| 285a–c | `/w/…/p/the-film/scenes/sc_02`, 1360 × 850, on Flow | Flow's tab is off and a Plan tab is on; `Export plan` before Flow's Full screen; the Flow canvas is replaced by the Plan |
| 285d | `/w/…/locations/the-club/reference`, 1360 × 850 | Reference's tab is off and a Plan tab is on; the line under the name; the views are replaced by the Plan. Its cards are Reference's own card |
| 285e | `/w/…/scenes/sc_02/shots/sh_03?view=stage`, camera selected | a `position` row heads the camera form; the set group names the place; the Start from menu is drawn open. The viewport is the app's own canvas, kept as a JPEG |
| 285f | `/w/…/p/the-film/scenes/sc_02`, 390 × 844, phone emulation | a Plan tab between Storyboard and Preview; the storyboard is replaced by the Plan |

The markup is in `location-plan-285.app.mjs` and the rules in `location-plan-285.app.css`, scoped to
`.app285` and `.app285p` so they reach nothing else in the master. Each `@media` is settled for the
size the screen was taken at, and a rule that won by naming `#root` keeps that weight. Both files
are written by the capture; do not edit them.

Held against the app's own screenshots on the review page, pixel for pixel, outside what the turn
changed: the scene page's head, rail and dock differ in 246 of 740,832 pixels; the Stage's head,
list and timeline in 113 of 369,040; all of it antialiasing. The Stage's viewport is a JPEG of the
canvas, so it differs by its compression. On the phone every box sits where the app puts it; its
type is smoothed a little differently, because the app was taken under Chrome's phone emulation
and the frame is shot from a desktop page. In the master every box is in the same place too, and
the type is smoothed in grey rather than per sub-pixel, as all of the master's cards are.

The Plan's inspector is built from the Stage inspector's own classes, so it takes the Stage's
rules: the same lines, rows, chips and selects.

## The sample

`location-plan-285.plan.mjs`: Gold on Gold, scene 2 of Na Love or Juju: The Film, from its paper
plan. The room is the by-hand drawing's 1480 × 790 px box at 100 px to the metre. 72 shots, 57 of
them in the club, at ten positions; the fifteen on the way home have no position in this room.

Three things differ from the paper plan, each on purpose:

- **Position 10 stands south of Ade's chair.** The paper drawing put it north of her table. There
  it is on the other side of the line between Tunde and Ade from position 5, so under rule 8 as
  written shot 24 would cross. The paper's own sentence says table cameras stand on the south side.
  If a glance back should never count, rule 8 needs a clause for it.
- **Positions 2 and 3 stand in the aisle**, 0.25 m further out than drawn. As drawn, each looked
  through the bench's back.
- **Position 5 is a 10 mm lens.** From the south wall nothing longer sees the booth and her table
  in one frame.

Position 9 looks straight down on her table, so it draws its frame and not a wedge.

## The pictures

- **The plan and the grey views** are three.js renders from `location-plan-285.render.mjs`, built
  from `stage-229.render.mjs`. The set is expanded by the app's own kit code
  (`packages/contracts/src/stage-kit.ts`), not a copy: Room, Counter, three of Booth, Table and
  chairs, and boxes for the low table, the DJ and the dance floor. Greybox as the app draws it; the
  ground is the clear colour of the app's own filed stills, `#e6e3dd`.
- **The six pictures** (positions 1, 4, 5, 6, 7, 8) are Lit renders of the same set standing in for
  drawn location pictures, as 229's plate was a stand-in. A drawn picture replaces each with no
  other change. Nothing was generated and nothing was spent.
- **The Stage's viewport in 285e** is the app's own Stage drawing the sample's set.

## What is built today, and what is not

Built, and seen running in the capture: the Stage in the page, the kit, Greybox, Lit and Plate,
jointed figures, the camera in words, Start from, Quick layout, Build with Arke, Arke's notes, the
plate picker, boards with their line check, Export playblast and Render with this (229 and 231;
epic 1826 and issue 1865 are closed). The storyboard row and the Flow card already carry a
`180° line` mark. The viewport already renders an orthographic overview from above
(`stage-viewport.ts`, `overview()`), but only for Build with Arke's inspection and as a still
filed with a playblast; no screen shows it.

Not found in the client: 229g's `Flip` on a board's crossing.

Not built: a set, a position or a picture that belongs to a place. Today a set and a camera are a
shot's, or the scene's shared blocking.

Seen while capturing, not part of this turn: the Stage's list wrote two kit tables as
`table and chairss`. The sample's low table is a plain box, which is also truer to it.

## To regenerate

    node design-system/location-plan-285.renders.mjs   # the plan, grey views and pictures, after a change to the sample or the kit
    node design-system/location-plan-285.capture.mjs   # the app's screens, after a change to the client
    node design-system/location-plan-285.mjs           # review page, master turn, build-review entries
    node design-system/check-master.mjs --record && node design-system/build-review.mjs
    node design-system/location-plan-285.shoot.mjs --master <folder>

`--preview` on the third writes only the review page. The capture builds the client with esbuild
from the main checkout's `node_modules`; on 20 November 2026 that had no `pdfjs-dist`,
`@fontsource/comic-neue` or `@fontsource/bangers`, none of which reaches these screens, so each
was built as an empty module and nothing was installed.

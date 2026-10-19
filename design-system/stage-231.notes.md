# Turn 231 · the Stage in the page, and after Build

Proposed on 19 October 2026. It completes turn 229 for #1865: 229 drew the Stage at full screen
and Build while it runs, and left the Stage inside the normal page and the Stage after Build
undrawn. Round 92 measured the page-mode viewport at 668 × 180 in a 1360 × 900 window.

## The owner's calls, settled before drawing

1. **The Stage is its own workspace in the page.** The head folds to one line, the filmstrip and
   the production dock step away while Stage is open, and Export and Render sit at the inspector's
   foot, as 231a draws. Keep sits in the draft bar while a draft waits (231b).
2. **Quick layout waits for Keep, like Build.** Nothing from Arke or a preset lands until kept.
3. **The Bench sends the plate and the cast's pictures**, not the greybox opening still.
4. **The plate picker lists location pictures first**, with Show all pictures for the rest.

## What is drawn

| Frame | Screen |
|---|---|
| 231a | The Stage in the page: viewport 1004 × 580 in a 1360 × 850 page |
| 231b | After Build: the draft bar with counted chips, + and ~ in the stage list, Export and Render waiting for Keep |
| 231c | Arke's notes opened over the viewport, apart from the summary |
| 231d | Quick layout as a draft, in Greybox |
| 231e | Start from on an empty stage: only Nothing can be chosen |
| 231f | The plate picker: three locations, Generate and Upload, Show all pictures off |

## Carried proposals, drawn here for the owner to rule on

- The draft bar's chips are built from the draft's own diff; no sentence in it comes from the
  model. Its chips add up to the stage list's change count.
- The preserve select is renamed Start from: Nothing · This shot · The scene. The save button is
  Keep everywhere; "Keep blocking" is retired.
- Lights and set pieces can be added while a draft waits and are kept or discarded with it.
- Mesh is deferred until it is decided whether it means importing a model.

## The pictures

The viewport images are turn 229's renders (`stage-229.renders.mjs`); this turn adds none. The
plate picker's three locations are the lobby plate and two existing world pictures standing in
for location sheets.

To regenerate:

    node design-system/stage-231.mjs             # review page, master turn, build-review entries
    node design-system/check-master.mjs --record && node design-system/build-review.mjs

`--preview` writes only the review page.

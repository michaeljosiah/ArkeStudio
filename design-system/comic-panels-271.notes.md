# Turn 271 — Panels and Words, the shorter path

Drawn for the owner's approval, 6 November 2026. Samples are synthetic. Nothing here is built.

From round 95 on 0.5.99, using a real four-panel page on Panel by panel.

## What changes, and why

| Found | Drawn |
| --- | --- |
| Findings below the model picker, off screen, cut off with no way to read them | 271a: under the page, joined to the verdict, in full |
| Accept anyway stayed on the same panel; three flagged panels meant three hunts | 271b: moves to the next fault |
| A panel accepted anyway stayed red, so the page looked unfinished | 271b: amber |
| Place with Arke greyed with no reason beside it | 271c: says how many panels and goes to them |
| Two different Undo buttons | 271d: one, stepping back the last change |
| "Arke placed" row pushed Accept page off screen | 271d: the lines scroll, the foot stays |
| Orange sound words and cream captions on a black-and-white Noir page | 271d, 271e: colours from the style |
| A tail on a face, a caption across a gutter | Rule: inside the panel, clear of faces |

The 269 rules still stand. This moves things and adds no steps. Whole page is not redrawn, but it uses
the same findings row, so it gets the wrapping and placement too.

## Choices for the owner

1. **Which styles print black and white.** Drawn as Noir, Ink wash, Manga and Clean line. Vintage and
   Webtoon stay colour. Say if any belong on the other side.
2. **No `Accept all`.** Stepping through faults takes one press each and a person still reads them, so a
   bulk accept of flagged panels is left out. It is easy to add if stepping feels slow.
3. **No reversed balloon yet.** The test script asked for white-on-black balloons and the shapes have none.
   That is a new shape for the placer and the export, so it waits.

## For the build

- `fy-comic__finds` moves in `comic-panels.tsx` and loses `white-space: nowrap` for this row. Page review's
  `gn253-what` ellipsis was drawn on purpose in 253 and goes here only.
- `comic-ink.ts` and `comic-ink.css` hold one palette, used by both the stage and the flatten. Keep them one
  function per palette, so what is placed is what ships.
- Changing a book's colours changes what a finished page prints. Treat it the way a typeface change is
  treated: it asks for Accept page again and redraws nothing.
- The continuity miss in round 95 (a wall bell in panel 2, a desk bell in panel 3) is a review across panels,
  which is neither drawn nor promised here. The sample finding in 271b only shows the row's layout.

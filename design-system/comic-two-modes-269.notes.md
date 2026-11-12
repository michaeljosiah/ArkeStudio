# Turn 269 — Two ways to make a page

Drawn for the owner's approval, 5 November 2026. Samples are synthetic. Nothing here is built.

Owner, after the cell-by-cell trial on Legend of Dumah chapter 1: "I think we should have two modes
for this. One where the entire sheet is generated as a single image by the AI and another which is
completely manual. Meaning the AI generated the individual cells but the placement of the text is
manual (which the AI can also drive) i.e. not generated with the image. This gives the user maximum
flexibility or go all in on a very simple mode."

This lifts the "no editable text overlays in this version" decision of 28 October 2026 for the
second mode only. Whole page keeps that rule. It reopens SPEC-064 R-36 – R-39 and R-48, which were
written and never built; `mode`, `lettering` and `LetteringPlacement` are already in the contracts.

## What the trial showed

Drawing panels alone gave about twice the detail per panel, exact layout, and one-panel redraws.
It did **not** remove anatomy faults: 5 of 25 panels were flagged on the first pass, against 4 of 25
on whole pages, and one hand failed every take. So this mode makes faults cheaper to fix rather than
rarer, and the picture review stays. A person still reads the book.

## Choices for the owner

1. **Names.** `Whole page` and `Panel by panel`.
2. **A book has one mode.** Mixing per page was left out to keep the screen simple. Pages already
   made stay as they are, so a book can still hold both after a change.
3. **Existing books stay Whole page.** A new book is asked at setup.
4. **Finished pages are images everywhere.** The Player, CBZ, PDF and EPUB get one flattened image,
   with the words as alt text. R-48's selectable text in PDF and EPUB waits, as a later amendment.
5. **Arke places words but does not spend.** Arke cannot press Make today (`make-comic-page` is
   human only) and this keeps that.

## Left out, on purpose

Custom tails beyond one aim point, per-line type, panel gutters and free panel shapes, and reframing
a panel inside its box. All can follow if the first version needs them.

## For the build

- A panel is asked for at its exact shape where the model allows it (the ChatGPT route returned
  within 0.2%) and centre-cropped otherwise.
- One accepted panel rides as a **style reference only**. The trial told cells to match it, and the
  statue in the anchor then appeared in nearly every panel.
- The app and the export draw balloons from one shared function, so what is placed is what ships.
- Picture review prompt: the trial's hand-by-hand steps. One read is not reliable (GPT disagreed with
  itself on 7 of 34 panels), so whether to take more than one read per panel is measured when built.

# Turn 270 — Arke makes the book

Drawn for the owner's approval, 6 November 2026. Samples and prices are synthetic. Nothing here is built.

Owner, asking for round 95: look for "advanced features hidden away but made available for Arke agent
to perform on behalf of the user". After its report: "Design turns first please".

## What round 95 found (0.5.99, real services)

- Panel by panel works by hand from start to finish. Arke cannot see or drive any of it.
- Arke said a page "hasn't been checked" while the review had flagged three panels, and took "panel by
  panel" for a reader setting. Nothing Arke reads names `panelTakes` or `mode`.
- `make-comic-page`, `place-comic-lettering`, `accept-comic-take`, `export-comic` and
  `set-comic-settings` are `humanOnly`, while video takes and exports have priced cards.
- `Change with Arke` sent "change panel 4:" with nothing after it.
- Approving one of two cards stopped the other with "Story context changed" and raw ids.

## Choices for the owner

1. **Arke may spend, on a priced card. Decided by the owner, 6 November 2026: yes, on approval.** This
   reverses 269's "Arke places words but does not spend". Approve is still the author's press, at a stated
   limit.
2. **Redraws are limited for the card, not per panel.** One hand failed every take in the cell trial, so
   a per-panel allowance could pay for three bad takes on one panel. 13 panels at $0.22 plus up to 6
   redraws is the $4.18 drawn.
3. **Arke never accepts a page.** The owner's own "a person still reads the book" holds. `Accept 2 pages`
   is one press, offered once nothing on those pages is left to decide.
4. **The card places the words too.** Separately pressing Place with Arke per page was the longest part of
   the round.

## Left out, on purpose

Whole books in one card (a chapter is the largest, so a bad style or sheet costs one chapter), publishing to
Arke Player (the publishing recipe's owner question stands), Arke choosing the model, and Whole page runs,
which can follow once this has been used.

## For the build

- The page's final image is flattened in the client (`flattenComicPage`), so `Accept 2 pages` runs in the
  window and is not a coordinator action. It needs a window open, and it cannot run from a remote command.
- The review and placing calls are not image spend. Say that in the quote rather than folding them in.
- Check the five P2s left on PR 2582 before building on this path. Two touch it directly: a panel's take saved
  with `admission.hash` when it is edited mid-run, and the page-wide take cap checked only after spending.
- A plain fix, no drawing needed: `plan.knows[].how` over 40 characters refused a whole Arke turn. Repair or
  loosen it. The Studio assistant's failures are a separate bug on the owner's install.
- SPEC-064 and the Arke authority lines in `entry-context.ts` are amended with the code, not before.

## Not in this turn

New book's first steps (Dashboard, Mode at setup), Chapters and Develop for a comic, Export's file path with no
way to open it, and the floating world tabs. These are not drawn yet and need a turn of their own.

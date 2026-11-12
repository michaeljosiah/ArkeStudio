# Turn 272 — A new book's first steps

Drawn for the owner's approval, 6 November 2026. The book and its lines are synthetic. Nothing here is built.

Owner, after turns 270 and 271: "Draw next turn".

## What is wrong today

- Round 95: "Create and open day one" lands on an almost blank Dashboard with no next step.
- An original book never meets Arke. Only an adapted book reaches setup, so only it sees the usual card and
  its Mode row. An original book starts Whole page without being asked.
- The code agrees. `createProduction` writes no chapter for a graphic novel, so the Dashboard reads
  `0 chapters · 0 pages planned · 0 made` with no Next, and Pages says `No chapters yet`.
- Setup cannot plan an original book at all: `ComicPlanChapter.from` is a required source chapter number.
- Next says `Open in Pages` for every stage, so the step takes a second press on another screen.
- Picking a style seeds its words above the door's foot, which moves `Create` (a click missed it in the round).

## Choices for the owner

1. **A new book is Panel by panel unless changed.** Today's default is Whole page. Recommended because 270's
   Make card only runs Panel by panel, one bad panel redraws alone, and a model that cannot letter a page cannot
   make Whole page at all. Against: the cell trial found faults no rarer (5 of 25 panels, 4 of 25 pages), and
   the words are a second step. Books that exist do not change.
2. **Original books go through setup.** `Plan with Arke` is the main press. `Start empty` stays for an author
   who wants to write the script by hand.
3. **`Start empty` writes one chapter and opens Pages**, skipping the Dashboard. There is then always somewhere
   to put a page.
4. **The plan only names who has no picture.** It makes no sheets. 270 already names them again on the priced
   card and offers to make them. Making them in setup would need a world write before the book exists.

## For the build

- `ComicPlanChapter`: `from` becomes optional, with a required `about` line when there is no source. It rides in
  setup drafts, so it needs a world schema raise, and older builds refuse it as unreadable.
- `graphicNovelSection` in `setup-brief.ts` tells Arke to read the source first. It needs a branch for no source.
  `assertSourceReadForPlan` already returns early without one.
- `about` must reach chapter planning, since `Plan with Arke` has no prose to read. The spec lists an outline into
  pages as not built, so this is the real work of the turn. Decide where the line is stored in the build, and
  check the cold read's citations, which expect a passage.
- 272b's question can be drawn by the page with no model call. Today's door seeds a first message and spends a turn.
- The door's seed carries the style, as the adapted path does. No name means Arke's proposal fills `title`.
- `nextStep` returns a press as well as words. `Make with Arke` asks in chat as Plan and Draft do, and the
  existing `autoSend` carries it.
- A plain fix, no drawing: prompts sent "should feel playful" (the world's tone) alongside "Crime noir". A chosen
  style should override the tone.
- SPEC-064 R-4 and R-36a are amended with the code, not before.

## Not in this turn

Chapters and Develop for a comic, Export's file path with no way to open it, book cards showing the style sample
instead of the book's own pages, and the floating world tabs. Each still needs a turn of its own.

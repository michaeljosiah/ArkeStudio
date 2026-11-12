# Turn 245 · Export → Arke Player for an interactive story

Drawn on 28 October 2026 and approved by the owner the same day (“Approve, merge both”), with Player P18 (ArkePlayer PR #21). Nothing is built.

## Asked

The owner asked whether the interface for interactive stories on Arke Player had been designed. It
had, in Player P4, but P4 was never built and could not be: the Studio exports a story only as a
web folder, and SPEC-063 left an Arke Player format out of scope. The owner said "Draw it", and
Player P18 brought P4 up to date. The owner approved P18 the same day ("Approve"), with four calls:

- **21:** a story reaches the Player as a production package of its own, holding one story
  document compiled from the Studio's routing.
- **22:** the Player plays it natively, held to the Studio's rules by shared route fixtures.
- **23:** a closed choice shows only with the author's reason, and a listener never sees the facts.
- **24:** Export → Arke Player for a story is a Studio turn of its own.

This is that turn. The owner then said "Yes, go ahead": merge P18, amend the specs, and draw it.

## What it draws

- **245a:** the Export sheet on an interactive movie, Low Water, with Web package and Arke Player
  as its two kinds and Arke Player chosen. The rows are World, Story, Closed choices, Clips, Shape,
  Format and Edition, priced in size and time.
- **245b:** the same sheet on a visual novel, The Lantern Road. Pictures counts wide and tall, with
  Make tall for the beats that have only a wide picture. Size is 235d's, and Voices counts the
  voiced lines.
- **245c:** not made. It shows a scene with no clip, a dead end that one remembered value causes,
  and a picture that disagrees with a fact. Each has the press that clears it. A closed choice
  with no reason is hidden, never a blocker.
- **245d:** made. The package has its size and SHA-256, a read-back line (`37 of 37 routes ·
  2 endings`), and the world's releases in order: the edition, the album, and the story.

## Calls for the owner

1. A story is exported as its own production package beside the world's edition, never inside it
   (Player call 21).
2. The export compiles routing to one story document with the evaluator the web package already
   uses (SPEC-063 R-23), and replays every route through it before the file is kept.
3. A closed choice without a reason never blocks an export. It is hidden.
4. The web package stays beside Arke Player in the same sheet.

## Rests on

- 233, the Export sheet, Activity and read-back.
- 235, picture shapes and Size.
- 236, the releases list.
- 238, the production package.
- 240, Story facts and their findings.
- 156 and 174h, the web package.
- SPEC-058 revision 12, R-79 – R-90, and SPEC-063 revision 13, R-27.
- Player P18.

## The samples

Low Water and The Lantern Road are The Undersong's, as P18 shows them on a phone. Their counts,
sizes, facts and findings are samples. The key art is `world-undersong.png`. No new picture was
made.

## To regenerate

    node design-system/story-export-245.mjs
    node design-system/check-master.mjs --record
    node design-system/build-review.mjs
    node design-system/check-master.mjs

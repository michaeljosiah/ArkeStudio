# Turn 234 · A world's Guide

Drawn 22 October 2026 and approved as drawn by the owner the same day. Built in ArkeStudio PRs #2156 and #2157, merged the same day; turn 236 added teasers. Its other half is Arke Player's
turn P11 (in the ArkePlayer repository's design master): the Worlds tab, a world's characters,
places and lore, and Reveal. To be specified in SPEC-059.

## Asked

A Worlds section in Arke Player where people explore worlds and their productions, and read about
the characters and some of the lore — starting with the worlds Arke makes available, more to come.

## Why a Guide

- A world package (SPEC-058) carries a world's name, logline, key art and productions, nothing
  about the world itself. The Player never opens a world's source, so what a reader may see has to
  be chosen and published.
- A sheet mixes what a reader may see with what they must not: Maren's Essence is a fine public
  bio, but it carries a Room note, and Bray's Relationships give away the Quiet Ward and the
  arrears. Choosing goes section by section, and a section can wait for a chapter.
- Canon holds the lore, but an open thread (CANON-044, CANON-048) is the author's question, not
  the world's, so only settled entries can be public.

## What is drawn

| Frame | Screen |
|---|---|
| 234a | World → Guide: characters, places and settled lore, each public or not, from the start or after a chapter |
| 234b | A character's entry: Public, Shows, sections each with its own chapter, a voice line, and the Player's page beside it |
| 234c | Export → Arke Player gains Guide: what is public, counted, with Edit |
| 234d | From a phone: the Guide in one column; an entry as its own page |

The sample is The Undersong as the fixture world holds it: five characters, six places, sixteen
canon entries; chapters are counted in The Ledger of Nights. The voice line is a sample.

## Calls for the owner

1. **Guide is a world page, not part of Export.** The guide is the world's, reused by every export;
   the Export sheet only counts it and links to it.
2. **Nothing is public until turned on.** A world's Guide starts empty, so nothing reaches a phone
   by default.
3. **Section by section, each with its own chapter.** A character can be public from the start
   while their relationships wait for chapter 6.
4. **Only settled canon.** Open threads and proposed entries cannot be made public.
5. **A voice line is chosen from takes**, never generated: nothing is spent.
6. **Curated worlds, not a directory.** Worlds in the Player are Arke's own list (Player P9 rule 1);
   a directory anyone publishes to waits for the Arke cloud.

## To regenerate

    node design-system/world-guide-234.mjs           # the review page, the master, build-review
    node design-system/check-master.mjs --record
    node design-system/build-review.mjs

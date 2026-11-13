# Turn 233 · Export → Arke Player

Drawn 21 October 2026 and approved as drawn by the owner the same day, with the calls below;
nothing is built. Specified in SPEC-058 (the private
specification set; R-1 – R-8 and R-29 are this turn) and tracked in #2037.

## Asked

An export of a world from Arke that a person adds by hand in Arke Player, and above all being able
to listen to the audiobook while watching its pictures.

## Why a new export

- `Audiobook player` (186e, R-72) carries its own player page. A phone never runs a package's page
  (SPEC-048 R-14), and Arke Player's MVP hosts no web view.
- Story Publish (224, SPEC-048 §2.11) makes an EPUB and an M4B, which the Player plays, but an M4B
  carries one cover: the pictures, Slow push and Text are lost.
- The data `player.html` carries, the chapter's audio, pictures with their times, holds, focus and
  motion, and the phrases with their words, is already a complete description of what to show and
  when. Arke Player shipped as a package of that data is drawn natively there (Player P5a–P5c).

## What is drawn

| Frame | Screen |
|---|---|
| 233a | The Export sheet with Arke Player chosen: World, Book, Narration, Pictures, Text, Motion, Edition; ~228 MB · ~3 min |
| 233b | Making it, in Activity: Fitting pictures · 54 of 131, 41%, Cancel |
| 233c | The package made: its file, 228 MB, Show in folder, Make again, its SHA-256 in full with Copy |
| 233d | Not made: a loop that will not play (Use still) and a picture outside the world (Show), one clause each |
| 233e | Publications · Other exports: the package with Copy SHA-256 and Show in folder |
| 233f | From a phone: made on the desktop; Download and Share hand the package to Arke Player |

The sample is The Undersong's *The Ledger of Nights*: 16 chapters written, 12 read whole, as
published on 20 October 2026. The sizes, picture counts and SHA-256 are samples.

## Calls for the owner

1. **Export, not Publish.** The package is made from the audiobook's Export sheet beside the player
   it replaces for phones, because it carries what that player shows. Publish (224) stays the place
   for private editions in standard formats.
2. **The book goes in whole; the narration only where read whole.** Read opens every chapter;
   Listen plays only chapters read whole (R-72's rule). The counts say both.
3. **Pictures fitted to 2048 px JPEG.** A phone package should be tens of megabytes of pictures,
   not hundreds; the originals' hashes are kept in the package's provenance.
4. **Share from a phone.** A paired phone can make the package on the desktop and hand it straight
   to Arke Player through the share sheet, so a world goes from the Studio to the Player on one
   phone.

## Owed

- The Player's side is drawn (P2c–P2f, P5a–P5c, P9); `Replace`, for a second edition of a world
  already in the Player's library, is a Player turn of its own (P10).
- Several productions in one package is a later turn.

## To regenerate

    node design-system/arke-player-export-233.mjs           # the review page, the master, build-review
    node design-system/check-master.mjs --record
    node design-system/build-review.mjs

# Arke Player · design master notes

Drawn 20 October 2026, proposed and awaiting the owner's review. Asked: a new mobile application,
Arke Player, where people play productions from worlds shared in Arke and upload packaged Arke
worlds to play, reusing the player designs already in the Studio master, drawn as a new file in
the design-system folder.

`Arke Player.dc.html` is that file: a second design master beside `Arke Studio.dc.html`, with the
same document chrome (read from the Studio master when it is written) and its own turns. Turns are
P1, P2… and frames P1a… so an issue or commit citing one never collides with a Studio turn number.

## The shape, in one paragraph

The Player plays **publications** — frozen editions with their own manifest (SPEC-048) — and never
a world's source. Things arrive two ways: a **share** through an Arke account, which streams until
downloaded, or a **package** added from a file, which is checked file by file before it plays. Four
tabs: Home (Continue, New, Worlds), Library (every world, Shared and Added), Downloads, You. A
world's page groups its productions by what a person does — Watch, Play, Listen, Read. A
production's page is Studio 199's show page on a phone. The players are the Studio's own modules
(156 interactive, 174 visual novel, 186/211/212 audiobook), so a package plays the same in a
browser and in the Player; the Player adds its close and the phone's media session around them.

## What is drawn

| Frame | Screen |
|---|---|
| P1a | First open: the wordmark over a world's picture, Sign in with Arke ↗, Add a package |
| P1b | Home: Continue, New, Worlds |
| P1c | Library: All · Shared · Added, a card per world, + |
| P1d | A world: the hero, its logline, Watch and Play; the dock playing an audiobook |
| P1e | A production: an audiobook with its book — Continue, Read, the download, Chapters |
| P1f | A production: a micro drama — Continue · Episode 13, Episodes as 9:16 thumbnails |
| P2a | A share link opened while signed out |
| P2b | Waiting for the browser |
| P2c | Add a package: Choose a file, Paste a link |
| P2d | Checking a package: 212 of 418 files |
| P2e | A package, ready: what is inside, the space, Add to library |
| P2f | A package, refused: 3 files do not match |
| P2g | A share that ended: No longer shared, Remove |
| P3a | A film held upright |
| P3b | A film turned (844 × 390) |
| P3c | A micro drama as a feed |
| P3d | Episodes: numbered tiles, 1–20 · 21–40 |
| P3e | Captions: the publication's text tracks, Size |
| P4a | An interactive movie: the choice (156i in the Player) |
| P4b | The route |
| P4c | An ending |
| P4d | A visual novel: a line (174g in the Player) |
| P4e | The log |
| P5a | An audiobook: picture, Slow push, two-line Text, the transport |
| P5b | Chapters |
| P5c | Speed and sleep |
| P5d | An audio drama with its transcript |
| P5e | A book, with Listen |
| P6a | Downloads |
| P6b | You |
| P6c | Adult content, off |
| P6d | Offline |
| P6e | Home on a Fold7 (984 × 1092), the tabs as a rail |
| P6f | An audiobook on a Fold7 |

## Calls for the owner

1. **When a share ends, its downloads go too.** Drawn so (P2g). The alternative — keeping
   downloaded copies — contradicts the owner having stopped sharing; a package added from a file
   is the person's and is never removed.
2. **The Player runs the Studio's web player modules inside a native shell.** Drawn so (P3). It
   keeps 156's one-player rule — what is previewed is what is played — at the price of a web view
   inside the app; the shell supplies the lock screen, background audio, picture in picture and
   casting.
3. **A world package is the file people add**: a ZIP of a world's name, logline and key art and
   its publications, each with its own `publication.json`. Its extension (the frames say
   `.arke`) and schema are owed to SPEC-048 before it is built.
4. **The Studio's Share sheet** — who a world is shared with, and which productions — is a turn of
   its own in the Studio master.

## What this rests on

- Publications, `publication.json` and the verify-before-play rule: `packages/contracts/src/publication.ts`,
  `packages/coordinator/src/publications/`.
- The account and its browser handoff: Studio turn 151 and `AccountService` (`NoArkeCloud` today:
  `Arke cloud is not available yet`). Shares and streaming need the Arke cloud, which does not
  exist yet; the first build can ship packages, the players and downloads.
- The players: Studio 156 (interactive), 174 (visual novel), 186 (audiobook), 211 (Slow push),
  212 (two-line Text), 199 (show page), 224 (story editions), 230 (audio drama transcripts),
  154 (adult content), 149 (row grammar), 137 (no captions under controls).

## The pictures

Every picture is already in `design-system/assets`; nothing was generated. The sample is The
Undersong (shared by Helen Marsh, 151's sample identity, with Jonah Pike), Copper Saints (shared by
Ama Mensah) and Meridian Dust (added from a file).

## To regenerate

    node design-system/arke-player.mjs        # writes Arke Player.dc.html and arke-player.review.html
    node design-system/check-master.mjs       # checks both masters; --record after adding a turn
    node design-system/build-review.mjs       # the review index lists both pages

`arke-player.mjs` checks every frame before writing: balanced `<div>` and `<span>`, type through
the tokens only, every picture present, unique ids, every anchor resolving. `check-master.mjs`
section 7 checks the written master on every lint, with `arke-player.turns.json` as its ledger,
and `--render` proves it paints in Geist through the dc runtime.

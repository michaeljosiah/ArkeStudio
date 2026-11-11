# Turn 276 · Publish

Drawn 11 November 2026 and approved as drawn by the owner the same day ("Approve as drawn"), the
plates and calls 1–5 as drawn; not built. The design turn that epic 2771 asks for
before slices 33, 34 and 51: issues 2804 (one Arke Player sheet), 2805 (one Publish page per
production) and 2823 (the app absorbs the mechanical Arke Player steps).

## Asked

The owner: "Lets begin the design turn for publishing to arke".

## What is wrong today

From findings UP-01, UP-02 and UP-10 of the 7 November simplification review, checked against the
code on 11 November:

- **No one place to publish.** Export sits on seven screens under five labels: Publish (Chapters,
  Audiobook), Publish… (audio drama), Export (Pages, Tracks, Branch Map), Export… (a chapter's
  Audiobook view) and Export film (the Cut). The Publish sheet's Other exports opens Export
  manuscript from Chapters and Export audiobook from the Audiobook page.
- **A book's Arke Player package is four presses deep**, and only from Audiobook: Audiobook,
  Publish, Other exports, Arke Player.
- **Four sheets make the same package from one coordinator function**, and they differ. Only the
  book's offers Submit to Arke Player. The comic's dialog has no SHA-256, no Make again and no Submit.
  The album's has no Make again, Download, Share or Submit. The story's has no Share or Submit.
  From a finished comic, album or story, Submit is five to seven presses away, through Home and
  Publications.
- **Made files are listed in five places**, none of them the whole of one production's: the
  Publish sheet's editions, Export manuscript's and Export film's Delivered rows, the audio drama's
  Editions, and Publications' Web packages (not filtered by production). A comic's CBZ, PDF and EPUB
  are listed nowhere once the dialog closes.
- **A guide alone has no path in the app.** `exportGuideAlone` exists in the coordinator; only the
  export script calls it.
- **Publishing to Arke's list is about eleven hand steps across two repositories**, done by a
  session each time: export from a copy, check, upload under a new name, pin, paste the pin under the
  right key, raise the serial, commit, upload the list, read it back. Its traps have bitten: a list
  published over a higher serial (30 October), an asset uploaded under a temporary name (31 October
  and 9 November).

## What is drawn

| Frame | Screen |
|---|---|
| 276a | Publish for a book: four outputs with readiness, and everything the book has made |
| 276b | Publish for a graphic novel not ready: Blocked · 3, the first blocker and Go to; nothing made |
| 276c | The one Arke Player sheet, made: the block every kind shows |
| 276d | The same block on a graphic novel, which gains SHA-256, Make again and Submit |
| 276e | Add to Arke's list: what goes public, before the one press |
| 276f | On Arke's list: published and read back |
| 276g | The Guide page's Export: the sheet for the guide alone |
| 276h | Publish on a phone |

Every card carries its output's plate (below).

The title bar, rail, phone switch and strip, Guide page and the sheet's chrome and rows are drawn
from the shipped client: `publish-arke-player.capture.mjs` renders the real App with a synthetic
world in headless Chrome, and the frames were checked against those captures. The sample is The
Undersong: The Ledger of Nights (16 chapters, an edition on 21 October and a part on 7 November)
and Neap Tide (turn 272's graphic novel). Sizes, counts, dates and hashes are samples.

## Calls, approved as drawn

1. **Publish is a page, and the rail's last item for every kind.** Below the divider: after
   Artifacts, or after Cut where a production has one. The alternative, the last item above the
   divider, puts it in a different place for a film than for a book.
2. **One word, one place.** Every header button that opens a publishing sheet from a production's
   main screen becomes Publish and opens the page. The Cut's Export film, the Branch Map's Export and
   a chapter's Export… stay, because each exports that screen's own work. The alternative keeps every
   button as a shortcut to its own sheet, and the word Publish keeps two meanings.
3. **Made replaces the sheets' own lists.** One list per production, on the page. Publications
   keeps every world's editions and opening a ZIP.
4. **Add to Arke's list in the app, on your host only.** The app performs the upload, the pin, the
   serial and the list, after one press on a sheet that says exactly what goes public. It never
   replaces a file, marks a release Latest, makes a release or adds a world the list does not have.
   The lighter alternative, the review's, is a Copy pin details button, with uploading and the list
   left to a session as today.
5. **The hosted list becomes the one list.** Arke Player's bundled catalogue.json is refreshed from
   it before each build (an Arke Player issue of its own), so a list published from the app is never
   undercut by an older serial.

## The plates

The owner asked, on seeing the first drawing, whether the page could do with pictures for the
publish types, made on the Bench. Each output card now opens on a plate in the look of the
production doors (`public/doors`, `public/video-kinds`): a dusk harbour still life with lamplight,
the object of the output at its centre, no people and no text. Nine were made on the dev build's
Bench in one session of The Undersong fixture world, through Codex Image on the ChatGPT plan: two
takes each for Edition, Audiobook, Arke Player, Manuscript and Comic files, one each for Web
package, Film, the audio drama's Edition and Playable edition. The best take of each is in
`assets/t276-<output>.jpg`; the build ships them as `public/publish/<output>.webp` at 640 × 360.

## Not in this turn

- An Arke Player package for an audio drama, a film or a series: a product question for SPEC-057
  and SPEC-058.
- A first listing of a world from the app: its names, descriptions, genres, age and pictures stay a
  hand edit in Arke Player.
- Pictures with the list (key art, wide and tall covers): still uploaded and pinned by hand.

## To amend before building

SPEC-058 R-7 (made files are listed on Publish), R-29 and R-36 (Add to Arke's list), SPEC-059 R-10
(the guide alone from the Guide page), SPEC-060 R-18 (an album's publishing steps), SPEC-064 R-50
(the comic's package from the one sheet).

## To regenerate

    node design-system/publish-arke-player-276.mjs           # the review page, the master, build-review
    node design-system/check-master.mjs --record
    node design-system/build-review.mjs
    node design-system/publish-arke-player-276.shoot.mjs     # light and dark PNGs under output/

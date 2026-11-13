# Turn 278 · Clean up

Drawn 13 November 2026 and approved by the owner the same day; not built. The design turn SPEC-066 §2.7 owes
("a Clean up sheet from Studio Storage; a design turn is owed before any client code") for
issue 3044.

## Asked

The owner asked for "a mechanism to clean up worlds. Where we can remove duplicate or unused
images, multiple unused takes, cache etc." SPEC-066 answers with Clean up: a plan the owning
modules compute, the person reads and confirms, and the coordinator runs with a ledger it can
recover from. §2.7 lists what the turn must draw: the way in and how it shows a blocked class or
an unsettled run; the classes with their counts, two totals and hold dates; a class opened,
artifacts grouped by production, the problems with Put back on shelf; the confirm, the run with
its progress and a way to stop, and the result; held plans with Restore and Empty now, its second
confirm, and an ended hold; the world export's note on held files; and a paired browser's view
that shows and does not run. The owner took every recommended default on 12 November 2026 (§3.4).

## Why

- Nothing in the Studio makes a world smaller. Juju held 20.6 GB (19.2 GiB as Studio Storage
  counts) on 12 November, and most of what can go is second copies and remakeable mixes, not
  "unused" pictures.
- Clean-up removes the person's work only after they read and tick it, so the screen is the
  safeguard: what each class does, what it leaves, when a hold ends, and what is a problem rather
  than a candidate.

## What is drawn

| Frame | Screen |
|---|---|
| 278a | Studio Storage as it ships, in the Studio assistant's storage reply, with Held in Files in Arke folders and Clean up world beside the card |
| 278b | The sheet with its plan: Now and After hold, eight classes with items and sizes, ticked by the spec's defaults, problems below |
| 278c | Old exports opened, each labelled with the newer unit that covers it; two ticked, so After hold reads 4.3 GiB, Until 20 Nov |
| 278d | Unused artifacts opened, grouped by production then World; Change log only, With its Bench take, and a protected source with Include |
| 278e | Problems opened on the 137 Bench pictures whose artifact is gone: Put back on shelf, and Put back on each; the 9 chapter mixes kept back beside the narration problems |
| 278f | The confirm: Link, Clear, Hold, each with count, size and when; Back and Clean up |
| 278g | The run: cleared so far, a bar, each class in turn; Stop |
| 278h | The result: Cleared and Held, the drive before and after and what it gained, done and skipped per class with the reason |
| 278i | Held, opened in the Studio on 21 Nov: an ended plan that goes after a day, and an open plan whose items each have Restore; Name taken |
| 278j | Empty now's second confirm: the plan, its size, Can't be undone |
| 278k | Refused: Read-only world, with an unsettled run reported |
| 278l | Refused: Outside edits · Adopt first, with Review edits |
| 278m | Refused to run: an export running; the three classes that read Publish drafts stopped because one will not read |
| 278n | Phone, a paired browser: the plan with ticks off, Bench copies opened, Studio only |
| 278o | Phone, a paired browser: held plans, Studio only |
| 278p | The run stopped by outside edits: what was done stays done, the rest Not run; Review edits and Done |

278p is drawn after the phone frames so that 278a–o keep the letters the first review used.

The desk frames are 1360 by 900 over the master's 227a writing room (Na Love or Juju, chapter 1);
the phone frames are 390 by 844 over 227m. Both pages and the Studio assistant's shell are turn
239's captured references. The storage reply is the shipped markup of `StudioMessage` and
`StudioStorageReadingsView`, drawn with the shipped `studio-assistant.css`; the only changes in it
are the Held row and the Clean up world button, which takes the shipped `fy-studio-button` look
of Review installed models. Files in Arke folders is drawn opened, as a person who opened it sees
it. The sheet is a PageSheet, centred as Spend's is; the confirm and Empty now are pages inside it
with Back, because a second PageSheet would put the first away.

The frames carry state in classes and aria, not in boolean attributes: the design master's
runtime rebuilds each frame from a template and drops `open`, `disabled` and `checked`. Before
this, the master drew 278a's card shut (hiding Held), and 278m's Clean up… and 278i's Restore live.

## The sample

Juju, from SPEC-066 Appendix A (12 November 2026), labelled as Studio Storage labels sizes:

| Class | Items | Now | After hold | Source |
|---|---:|---:|---:|---|
| Bench copies | 1,111 | 2.4 GiB | 2.4 GiB | Appendix A, 2,609,690,507 B |
| Reference copies | 214 | 473.8 MiB | 473.8 MiB | 12 session takes + 202 groups, 496,801,165 B |
| Old chapter mixes | 11 | 830.7 MiB | 830.7 MiB | illustrative split of the 26 renders, 2,058,868,264 B |
| Current mixes | 8 | 820.2 MiB | 820.2 MiB | 6 current chapter renders + 2 Audio Studio mixes (384,891,057 B) |
| Old exports | 15 | — | 1.9 GiB | Appendix A's 9 + 2 + 4 units, 2,008,003,476 B; each unit's size illustrative |
| Unkept Bench takes | 208 | — | 870.3 MiB | Appendix A, 912,565,470 B |
| Unused artifacts | 31 | — | 46.9 MiB | 22 change-log-only + 9 Bench-kept; the 12 on timeline undo and 1 in a Publish draft are protected |
| Unkept narration | 317 | — | 222.7 MiB | Appendix A's upper figure; R-40's shelf rule was not applied |

Now with the defaults is 3.7 GiB and so is After hold, since nothing held is ticked; with two old
exports ticked (278c) After hold is 4.3 GiB. Problems: 137 Bench pictures (366.5 MiB), 216
narration takes before joins with no audio, 7 empty WAVs in chapter 1, 139 artifacts with no
file; 1,178 retired sidecars with no file on a line apart. No render and no export is kept back:
the 216 sit under keys "Group by beats" folded away, so no current block needs them, and the 7
were filed empty (SPEC-066 revision 2, R-34 and R-42).

On 2026-11-13 the 216 were found to have been deleted by a hand cleanup on 2026-10-30/31; all of
them survive byte for byte in copies on D:, and the owner decided to leave them gone. The first
draft of this turn listed the 11 October book package as a last copy and kept 9 chapter mixes
back, because revision 1 of the spec read those takes as lost narration. Revision 2 corrects
that.

Illustrative, not measured: the stale, current and kept-back split of the mixes (9 kept back is
R-34 applied to Appendix A's chapters, not a count); the inventory's split by category (the world
total is measured); the drive (476.3 GiB, 7.8 GiB available, below the 9.5 GiB warning floor, and
11.4 GiB after, or 10.4 GiB after the stopped run); $3.40 to read the narration again; the run's
two skips; the pictures and their names; and the second held plan of 18 November in 278i and 278o.

## Open for the owner

- **The world export's note on held files (R-46): not drawn, a gap against §2.7.** §2.7 asks for
  it. No client control starts a world export; it is World Chat's `world-chat-world-export` card,
  and R-2 bars any conversation action from carrying Restore, while R-46 says the export offers
  Restore first. Proposed: the card says Held · 2 plans · 739.8 MiB · Until 25 Nov and offers
  Open Held, which opens Clean up's Held tab in the Studio, so Restore stays a person's act in the
  sheet. The World Chat card is not drawn in the master, so drawing it is new work on another
  surface. Waive it here, or ask for it as its own frame?
- **A paired browser's way in.** The Studio assistant runs disconnected on a paired browser
  (`studio-assistant.tsx` sets `connected` false under `isRemoteSession()`), so Studio Storage and
  Clean up world are not reached there today. 278n and 278o draw what the sheet shows once it is.
  The System panel's Storage section does reach a paired browser ("Connected desktop"): an entry
  there, or no phone view until the assistant runs remotely?
- **Restore, Empty now and Put back on a paired browser.** R-2 makes running Studio-only and these
  human-only, but does not say Studio-only for them. Drawn as Studio-only, as SPEC-062's reviewed
  clean-up refuses paired browsers.
- **A link's consequence.** R-16 asks a link class to say: same files, one copy; folder sizes
  other programs show do not drop; a copy made outside Arke may hold two again. Drawn as Same
  files · one copy · Explorer sizes stay. The third clause is left off the screen to keep it a
  label; add it to the consequence if wanted.
- **R-42's last copy and R-34's mixes kept back.** Settled by SPEC-066 revision 2: only media a
  current block needs makes an export a last copy or keeps a render back. Takes before joins
  and audio filed empty are listed and hold nothing back.
- **"Shared files may be counted more than once."** The shipped note under Files in Arke folders
  becomes untrue for the open world once R-45 counts each file once. Drawn as shipped; proposed:
  drop that sentence when R-45 ships.
- **Frees.** The task named the totals "frees now" and "frees after hold". SPEC-066's decision log
  rejects "frees" (SPEC-062 R-2 forbids promising a saving), so they read Now and After hold, and
  the drive's gain appears only in the result, measured.
- **The problem count** counts problem items (500), not kinds (5), and not the 9 mixes kept back
  beside them.
- **Amber text.** No warning text token reads 4.5:1 on the light sheet, so the warning colour
  marks a reason's glyph and a tag's fill, and the words stay in the text colour. A darker amber
  text token would let the words carry it.

## Calls the owner may strike

- **Clean up world** as the label, in one row with Review installed models.
- **The entry is never disabled**; the sheet says why a plan cannot run (rules 2, 19).
- **The totals and column heads stay put** while the list scrolls (rule 5).
- **Stop**, where §2.7 says Cancel: what is done stays done, and Cancel reads as undo (rule 14).
- **The confirm is a page in the sheet** with Back, not a dialog over it (rule 13).
- **Put back on shelf needs no confirm**: it removes nothing (rule 12).
- **Held sits before Other or unmeasured** in the inventory (rule 3).
- **A class whose phase has not shipped reads Later** (rule 21); leaving it out instead departs
  from R-14 and the plan's schema.
- **A paired browser shows the ticks off** rather than hiding them (rule 20).
- **A paired browser's opening does not count** as the one that lists a hold ended (rule 17).

## Not drawn

Made's held and removed rows (R-36); the world export's note (R-46), open above; the Studio
assistant's anonymous totals (R-2); Plan again, Held elsewhere, Not on this drive, Proves
readiness, a Later class, Opened elsewhere and an unsettled plan's Held card; the Studio in a
phone-width window. Rule 23 says where each belongs.

## Checks

`node design-system/world-cleanup-278.mjs`, then `check-master.mjs --record`, `check-master.mjs`,
`build-review.mjs` and `build-review.mjs --check`. `world-cleanup-278.shoot.mjs` shoots every frame
light and dark from the review page and reports anything outside its frame or its sheet, and any
label cut short: none is. The sheet's body and the assistant's transcript scroll by design. 278a,
278i and 278m were also shot from the design master, where the frames' states now hold.

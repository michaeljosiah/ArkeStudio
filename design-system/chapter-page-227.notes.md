# The chapter page, full width — turn 227

Status: **revision 1, drawn for review, 15 October 2026.** Nothing is built.

The owner asked for the chapter page to be full width like the other story tabs, less cluttered,
and visual where the subject offers it — the characters especially. Today the Manuscript view
caps its head and body at `--content-max-chapter: 940px` and centres them
(`packages/client/src/screens/chapter-responsive.css`, the `min-width: 1100px` rule), and a
250 px side column carries The book, After this chapter, Voices (with a textarea per character),
Style, Implies, Draws on and Earlier versions.

## The idea

People in the left margin, pictures in the right, the prose at a fixed measure between them.

- **Hero.** The chapter's picture fades into the page behind the title. A *book strip* — one
  segment a chapter, sized by its words — replaces "CHAPTER 01 OF 18" and the The book card,
  and is the previous/next navigation.
- **Cast.** The Voices column becomes a row of faces in their speaker colours. A face opens its
  voice card (popover on desktop, sheet on a phone) with the sample, Change, Direction and the
  book override. "Effective character direction" leaves the surface.
- **Margins.** Spoken paragraphs carry their speaker's face in the left margin; passage pictures
  from the audiobook sit beside their passage in the right. Two toggles hide either margin.
- **Notes.** Everything else from the side column is one Notes column, pushed in beside the
  prose on desktop and docked open at 2000 px and wider.

## Data the drawing relies on

| Drawn | Source today | New? |
|---|---|---|
| Faces | `mainPhotoFor(kit)` / `characterPortraitPath` | no |
| Speaker colours | `--voice-1…6`, per book (SPEC-047 R-33) | no |
| Who speaks each paragraph | the chapter's cast lines (`voicesRecord`) | no |
| Passage pictures | `ChapterAudiobook.pictures` via `useChapterPictures` | no |
| Book strip | `production.chapters[].words` / `order` | no |
| Hero picture | first passage picture in reading order | **chosen chapter picture is a new field** |
| Listen duration | the chapter's audiobook timing | no |

## Frames

| Frame | What it shows |
|---|---|
| 227a | Desktop 1360, Arke put away: hero, cast, view row, margins |
| 227b | A face opened: the voice card; that speaker's line tinted |
| 227c | Scrolled: compact bar, Notes open beside the prose, pictures inline |
| 227d | Ultrawide 2560 with Arke open: larger hero and measure, Notes docked |
| 227e | Fold 984: faces without names, pictures inside the column |
| 227f | Phone: full-bleed picture, round faces, Listen held at the foot |
| 227g | Phone: a face's voice as a sheet |
| 227h | A planned chapter: no picture, no cast, Draft with Arke |

Light theme: `227a-light`, `227f-light` in `docs/issues/assets/227-chapter-page/`.

The prose in the drawings is written for them, not taken from the book. Rebuild with
`node design-system/chapter-page-227.mjs`, then `check-master.mjs --record` and `build-review.mjs`.

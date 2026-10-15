# The chapter — a writing room, working with Arke, and a Chapter view · turn 227

Status: **revision 4, drawn for review, 15 October 2026.** Nothing is built.

## Revision 4

The owner approved revision 3 and asked for two more things:
- what a new chapter looks like
- the full chat, drawn with the existing design: voice, upload and the other controls

**Chat is turn 225's global Chat.** The chat panel and composer come straight from turn 225's own drawing:
- the composer from `global-chat-224.composer.mjs`
- the model chip from turn 225's `ModelChip` specimens
- the styles from turn 225's own section of the master

None of it is redrawn. Chat opens from the titlebar's chat mark as a 400px panel, or a sheet on a phone. The folded Arke column beside the page is gone.

**The composer** has:
- attach, with file chips showing File in world and ×
- the mic for dictation, with "Listening — click mic to stop"
- the model chip
- Read replies; when it's on, the answer being read carries Reading aloud with Stop
- send

| Frame | What |
|---|---|
| 227u | A new chapter. The title, then its brief as fields (synopsis, point of view, when, goal), then Start writing. Chat opens on "Let's write Chapter 26" with Draft from the synopsis, Draft the opening and Plan the beats. |
| 227v | Arke's draft waits in the page as grey text, with Draft · words · Discard · Keep. The chat answer names it and offers Show in page. The sent message carries its attached notes. |
| 227w | Voice and upload. A picture attached in the composer, dictation listening, and Read replies on with the answer being read aloud. |
| 227x | The Chapter view of a new chapter: a bare hero with Write, and four steps not started. |
| 227y | Phone: a new chapter with Chat as a sheet. |

Turn 225's section of the master carries more styles than `global-chat-224.css`, including the model chip. The review page borrows that section's styles when it is built, so it shows the approved drawing.

## Revision 3

The owner approved revision 2's Manuscript. They asked for two changes:
- the Chapter view's cast as the world overview's cards, with less use of colour borders
- the AI-assisted editing menu, and what collaborating with Arke in the manuscript looks like

**Cast.** It now uses the `.fy-polaroid` card: picture, name, one line. No face or card anywhere
carries a colour ring. Speaker colour survives only as the underline on linked names.

**Working with Arke.** This builds on what exists today:
- the passage menu (`passage-actions.ts`), which hands each request to the dock
- the passage-revision proposal, which waits in the page with keep/refuse per edit
- the chapter review's quoted findings and their stored offsets

| Frame | What |
|---|---|
| 227p | Selection: a format bar with Ask Arke. Its menu has an ask field, then Tighten, Expand, Simplify, Make it vivid and Change tone ›. Check against style and Critique reply rather than edit. Last is Open in Arke. |
| 227q | Change tone's second level |
| 227e | Up to three versions of an edit (1 of 3), then Accept N of M |
| 227r | Review findings beside the words they quote: Fix, Intentional, Dismiss |
| 227s | Continue: grey text after the caret; Keep (Tab), Discard, 1 of 3 |
| 227t | The dock about a passage: the passage quoted; the reply points to the edit waiting in the page |

**New behaviour:**
- the menu's own ask field (today it only fills the dock)
- versions of an edit
- Continue from the caret
- review notes drawn at their offsets

**Retired.** The unused `SelectionTray` and bible-helper path.

## Why revision 2

Revision 1 made the chapter page full width with a hero picture, cast faces and pictures in the
margins. The owner's review: impractical for writing. On a 900 px screen the first line of prose
sat around 520 px down. They asked for a chapter overview separate from the manuscript, and for a
manuscript editor "superior in nature to Obsidian".

Their choices (15 October 2026):
- Opening a chapter lands on **Manuscript**.
- Revision 2 draws **linked names**, **focus writing** and **Arke inline**.
- The scene outline rail and command palette wait for a later turn.

## The shape

The chapter has four views: **Chapter · Manuscript · Audiobook · Audio Studio**.

- **Manuscript** is the writing room.
  - Above the page, only one 56 px bar: Brief, previous and next chapter, the four views, the
    chapter goal, Focus, Compare and ⋯.
  - The chapter's number and title are the top of the document.
- **Chapter** is revision 1's visual page, as the production home of the chapter:
  - hero and book strip
  - cast faces and their voice cards
  - progress in four steps: Written, Cast, Read, Mixed
  - pictures, continuity and versions

## Better than Obsidian

Obsidian is a general notes tool. This editor knows the world it is writing about.

| Capability | Frame | What it does |
|---|---|---|
| Linked names | 227a, 227b | People and places recognised from sheets, underlined in speaker colour; hover card with face, voice, appearances. Decoration only — the Markdown stays plain. |
| @ names | 227c | The world at the caret: this chapter's people first, then everyone, then places. |
| / commands | 227d | Arke first (Continue, Describe…, Dialogue for…), then formatting. |
| Arke edits in the page | 227e | Tracked edits in the prose, each kept or refused; the set held at the foot. |
| Compare versions | 227f | Side by side, with Restore. |
| Focus | 227g | Window is the page; the caret's paragraph lit, the rest dimmed; typewriter scrolling; goal track. |
| Type steps | 227h | Larger type on wider screens, never longer lines; the Brief docked at 2000 px and wider. |

## Frames

| Frame | What it shows |
|---|---|
| 227a | Manuscript, the landing view, at 1360 |
| 227b | A linked name hovered |
| 227c | @ inserts a name |
| 227d | / commands |
| 227e | Arke's edits in the page |
| 227f | Two versions side by side |
| 227g | Focus |
| 227h | Ultrawide 2560: type steps up, Brief docked, Arke open |
| 227i | Chapter view: hero, cast, progress, pictures |
| 227j | Chapter view: a face opens its voice card |
| 227k | Fold 984, the writing room |
| 227l | Phone, writing, format bar above the keyboard |
| 227m | Phone, Chapter view, Write and Listen at the foot |
| 227n | Phone, a face's voice as a sheet |
| 227o | A chapter with no words yet |

Light theme: `227a-light`, `227i-light`, `227m-light` in `docs/issues/assets/227-chapter-page/`.

## New data

- A per-chapter goal.
- A chosen chapter picture. The fallback is the first passage picture.

Everything else is already in the read model:
- faces: `mainPhotoFor`
- speaker colours: `--voice-1…6`
- cast lines: `voicesRecord`
- passage pictures: `useChapterPictures`
- chapter words and order
- continuity and versions

Tracked Arke edits reuse the existing proposal path. The current editor is Tiptap
(`packages/client/src/components/editor/`), with a slash menu and the selection tray.

The prose in the drawings is written for them, not taken from the book. To rebuild:

1. `node design-system/chapter-page-227.mjs`
2. `node design-system/check-master.mjs --record`
3. `node design-system/build-review.mjs`

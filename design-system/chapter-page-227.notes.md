# The chapter — a writing room and a Chapter view · turn 227

Status: **revision 2, drawn for review, 15 October 2026.** Nothing is built.

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

# Turn 252 · Opening and closing credits

Proposed 31 October 2026. Approved by the owner the same day ("Approve as drawn"), calls 1 – 7 as drawn. SPEC-047 R-210 – R-218, SPEC-058 R-94.

## Why this turn

The Na Love or Juju chapter files went out at 192 kbps on 31 October. The owner then asked about credits: Audible asks for them, and they would suit the story's audiobook everywhere it goes.

ACX's submission rules, checked on 31 October 2026 at help.acx.com:

- **Opening credits** state the audiobook's title, author(s) and narrator(s). They must match the title's metadata and cover art.
- **Closing credits** must indicate finality. The page recommends "You have been listening to…", the same names, and "The End".
- **Separate files:** opening and closing credits should be separate files. Each file carries its section header. No file may run over 120 minutes.
- **Human narration:** "Your submitted audiobook must be narrated by a human unless otherwise authorized." Credits alone do not make an AI-read book eligible for Audible. The book still benefits from them on every other outlet, in Arke Player and in its own M4B.

The Studio already speaks each chapter's heading (the chapter's `title` block). Its Chapter files export already meets the 192 kbps CBR and level rules (SPEC-047 R-22 – R-28). Nothing makes credits yet; the export's report says "verify credits… separately".

## What it reuses

- **Turn 199's audiobook page** (199a, 199e), in its own markup, as it ships now: Publish where 199a drew Export. Chapter rows are 199a's row; the Credits sheet is 199e's Reading sheet.
- **Turn 235d's Export sheet grammar**, for Chapters and Arke Player.
- **The chapter title block's reading path,** with its take record, flags and Hear.
- **The retail mastering and report** (R-23), and the listening plan's phrases.
- **The author Publish last named.**

## The frames

| Frame | What it decides |
|---|---|
| 252a | Opening credits is the first row of Chapters: the cover, its length, its words. |
| 252b | Closing credits is the last row. The Credits sheet holds four details and each credit's words, with Read for what is not read. |
| 252c | Narrated by: an AI voice, the voice by name, or your words. A credit that drops the narrator warns in one clause. |
| 252d | Chapters exports the credits as `00-OpeningCredits.mp3` and `27-ClosingCredits.mp3`. |
| 252e | Arke Player plays them inside Chapter 1 and the last chapter, over the cover, with no Player change. |

## Calls for the owner

1. Credits are two rows at the ends of Chapters, opening a Credits sheet.
2. The words are drafted from four details (Title, Written by, Narrated by, Copyright) and stay editable. A credit that drops the title, author or narrator warns.
3. Narrated by defaults to "an AI voice".
4. They are read in the narrator's voice, checked like any block.
5. Chapter files: two files of their own.
6. Arke Player: inside the first and last chapters, over the cover, with no Player change.
7. No music under the credits for now.

## Not drawn

- **Phone layouts.** The rows and the sheet follow 199f's phone page.
- **Publish's M4B,** which takes the credits as its first and last chapters.
- **The video's credit card.**
- **Music under the credits:** a later turn, if wanted.

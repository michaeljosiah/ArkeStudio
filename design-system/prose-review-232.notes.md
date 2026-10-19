# AI tells in the chapter review · turn 232

Status: **revision 2, drawn 19 October 2026 for the owner's review.** Nothing is built.

- Issues: #1744 (prose findings) and #1782 (evidence-based chapter review).
- Extends turn 227's review notes (227r) and the chapter review now shipped.
- The definition of a tell is [docs/research/ai-tells.md](../docs/research/ai-tells.md). This
  note holds the decisions made on top of it.

## The owner's calls, settled before drawing

1. **One chapter at a time.** #1744's whole-book Prose view and cross-chapter habits are not in
   this turn.
2. **Rewrite with Arke, checked before it is shown.** Revision 1 left the note without a
   rewrite: an AI rewrite of an AI tell tends to trade one tell for another. The owner then asked
   for the option. Revision 2 adds it with that risk designed in:
   - the AI tells check reads Arke's words before the writer sees them
   - the result shows as before → after counts
   - any tell Arke added is underlined
   - a rewrite still over the line says so

   The note's actions are Rewrite, Intentional and Dismiss, at the same weight; What counts moves
   to its head.
3. **The line is provisional.** It is set at 8 for drawing. Before release it is calibrated
   against chapters the author wrote unaided (see below).

## The rule

The research note's central finding is that a tell is ordinary craft and density is the signal.
The check follows from that:

| | Rule |
|---|---|
| Instance | One device, tagged by the model with its kind and an exact quotation. Different kinds may overlap; the same kind overlapping is one instance. |
| Verification | The coordinator drops any quotation that is not in the saved chapter, exactly as `verifiedReviewAnswer` does today. |
| Stretch | About 450 words, starting at a paragraph, sliding one paragraph at a time. A crowded run cannot hide by straddling two stretches. |
| Crowded | 8 or more tells in a stretch, or 4 or more of one kind. |
| Passage | Overlapping crowded stretches merge into one passage. Its note reports its densest 450 words. |
| Below the line | Nothing is marked, anywhere. A single tell is never a note. |
| Chapter figure | Tells per 1,000 words, in the report only. It is never a pass or fail. |

**The model tags; the app counts.** The model never states a density, a score or a verdict. All
the arithmetic is a pure function in contracts, beside `chapter-review.ts`:

- stretches
- counts by kind
- the line
- passages

That keeps the numbers deterministic and testable, and matches how the review already treats
citations: an exact quotation proves where a claim points, not that the claim is right. On
screen the counts are "the model's reading, checked against your words". They are never called
a detector or a score.

**Why 450 words.** The source's samples were that long, so counts compare directly with the
source's numbers. It is also about a page, the span in which a reader forms an impression.

**Why a kind line.** The source's word for the tell is *stacking*: the same device again and
again. In the thriller sample that was eight metaphors in 451 words. Four of one kind in a
stretch catches that even when the total stays under 8.

## Rewrite with Arke (revision 2)

**What Arke is asked.** Arke receives:

- the saved passage (the whole crowded stretch)
- its tagged tells, each a kind and a quotation
- the kind chosen, if the writer chose one
- the story's prose style (`prose-style.json`: point of view, tense, voice and samples)

The brief:

- Remove or plainly restate the tagged devices.
- Keep the events and their order, point of view, tense and every linked name.
- Leave dialogue word for word.
- Add no new figures, triads, lists, contrasts or summed-up feelings.
- Add no information the passage did not have.

**What the writer sees, in order:**

1. Rewriting the passage, then Checking Arke's words, with Stop (232l).
2. The rewrite waiting as tracked edits, with AI tells 14 → 4 in the held bar and before → after
   per kind in the note (232m).
3. Or, when it is still over the line, an amber Still crowded with Refuse all, Try again and
   Accept, none of them primary (232n).

**Rules that keep the counts honest:**

| Case | What happens |
|---|---|
| Accept every edit | Exactly the checked words are kept, so the note becomes Cleared at once with no further model call (232o). |
| Accept some edits | Words nobody has checked are kept, so the note becomes Changed with Check again. |
| The check fails | The rewrite still shows, marked Not checked, and is never shown as cleared. |
| A tell Arke added | Underlined in its proposed words even under the line. "New" is decided mechanically: a tell whose quotation falls inside inserted text. |
| Try again | Another version, up to three as in turn 227. Each version is two model calls. |
| Passage changed since the check | Rewrite waits for Check again; it never runs against a stale count. |

**Provenance.** A kept rewrite saves a version labelled *Arke rewrite*, so Compare versions
(227f) shows Arke's words against the writer's. That answers the question the source says a
copyright examiner may ask, which sentences are the author's, without a new record.

## Calibration, before release

The source gives two AI data points and no human one. In the source's samples:

- the ChatGPT thriller held about 16 tells in 451 words
- the Claude romance held 21

The provisional line of 8 is roughly half of either, chosen only so the drawing has a number.

1. **Human baseline.** Run the check on chapters the author wrote without AI help, including
   *Na Love or Juju* chapters from before any AI pass where they exist. Record the count for
   every stretch.
2. **AI drafts.** Run it on Arke's own unedited drafts of comparable chapters.
3. **Set the lines.** Put the total line above where the author's own stretches sit; the 95th
   percentile is a starting point the author can move. Set the kind line the same way, per kind.
   Then check that the AI drafts trip it.
4. **Check the reader.** Run the same chapter twice to measure how much the model's count
   varies. Have the author mark a sample of tagged instances right or wrong to measure precision
   per kind. Pivot sentence is the kind most likely to need a tighter definition.
5. **Dialogue.** Revision 1 counts dialogue and narration alike. Each instance records whether
   it sits in dialogue, so calibration can test leaving dialogue out. A character who talks in
   triads is characterisation.

Until the line is calibrated, every screen that shows it also shows its number.

## Frames

| Frame | What it shows |
|---|---|
| 232a | Review chapter lists its checks: AI tells (new, on by default), Clarity and continuity, Pictures, Narration records. Notes only. The chapter doesn't change. |
| 232b | A crowded passage. An amber bar in the gutter numbered to its note, a wavy underline under each tell, and the note with the count, kinds and pips. The strip sits under Review in the margin. |
| 232c | A tell hovered: its kind, *fine on its own*, and its place in the passage's count |
| 232d | A kind chosen in the note: its five metaphors lit, the other tells quietened |
| 232e | What counts: the six kinds with one line and an example from this passage, and the line in words |
| 232f | The writer rewrote the passage: underlines lift, the bar dashes, the note says Changed with the old count struck, and Check again |
| 232g | Checked again: under the line, the note is Cleared (5 in 450 words, was 14), and the strip's bar drops |
| 232h | The report read whole: checks down the left; AI tells with the chapter's figures, the strip large, By kind, and the crowded passages as Cleared, Open and Kept |
| 232i | A chapter with its tells spread out: the strip under the line, AI tells · None crowded, and the prose unmarked even where single tells sit |
| 232j | Phone: the bar at the page edge, and the note as a half sheet with the strip and Rewrite |
| 232k | Rewrite: the whole passage from the note, or only the chosen kind (Rewrite only these 5) |
| 232l | Rewriting, then checking Arke's words, with Stop. Nothing changes yet. |
| 232m | The rewrite waiting as tracked edits: 8 edits, AI tells 14 → 4, before → after per kind, its one new tell underlined |
| 232n | Still crowded: 14 → 9, with Arke's five new tells underlined. Refuse all, Try again and Accept, none primary. |
| 232o | Kept: Cleared (4 in 450 words, was 14, rewritten with Arke), saved as v5 · Arke rewrite |

The prose in the drawings is written for them and deliberately crowded. It is not the book's.

## Implementation boundary

**New:**

- A prose specialist: a read-only session with a shipped, versioned skill
  (`chapter-prose-review.md`) built from the research note's definitions. It sits beside the
  script and visual reviewers.
- A passage finding. It carries its instances, its stretch and its kind counts, where today's
  findings carry one quote.
- The counting function in contracts.
- Per-check selection on Review chapter.
- A per-passage Check again, which re-reads only that stretch: one small model call that never
  runs on its own.
- The strip, the gutter bar, the underlines, the note and the report section in the client.
- The rewrite brief, and a passage revision that spans several paragraphs. Today's passage path
  stops at one paragraph and 1,200 characters; a crowded passage is about 450 words.
- Checking the proposed words before the proposal is shown, and marking tells that fall inside
  inserted text as new.

**Reused:**

- `ChapterReviewService` and its sidecar under `.reviews/`
- the request-ID identity and replay
- exact-quotation verification
- staleness on changed prose
- the Intentional and Dismiss decisions with their notes
- the 60,000-character source budget
- the proposal path for tracked edits, versions of an edit, and Compare versions

**Kept apart on purpose.** The script reviewer's skill says to prefer a few important findings
to stylistic policing. That is right for continuity and the opposite of what a density count
needs. AI tells is its own task, so neither brief weakens the other.

**Spec.** This needs SPEC-056 (the chapter page) and the SPEC-012 §2.4 prose-findings amendment
that #1744 asks for. Both are in the private set, which this session could not read, so the
spec work is still to do there.

## Not in this turn

- The whole book: #1744's Prose view, and habits repeated across chapters.
- #1744's mechanical layer for repeated phrases and known habits. It could later feed the same
  strip.
- Emotional flatlining, and drama in every paragraph. The source names both but defines and
  counts neither.
- Checking while Arke drafts, before the words reach the page.

## To regenerate

    node design-system/prose-review-232.mjs             # review page, master turn, build-review entries
    node design-system/check-master.mjs --record && node design-system/build-review.mjs

`--preview` writes only the review page. Turn 227's frames module exports the writing-room
helpers this turn draws with; its own drawings are unchanged.

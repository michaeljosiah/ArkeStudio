# Story to audiobook — approved turn 209

Status: **owner approved turns 206–209 on 2026-10-10; implementation in progress**.
This change records the approved design; it contains no application implementation.

The owner liked the three destination designs but asked how an end user reaches them from
Story. This proposal connects Activity (turn 206, #1684), saved Looks (207, #1680) and motion /
highlighted captions (208, #1672) without introducing a new dashboard or compulsory wizard.

Open [the clickable review](story-journey-209.review.html). Start at Story and press Chapters,
The harbour, then the chapter's Audiobook tab. The review navigator also exposes alternate
states. Companion proposals remain in draft PRs #1685, #1686 and #1687.

## Approved changes

- Keep the existing Story rail and chapter view switch. Label **Direct and illustrate** on
  desktop; show Direct, Illustrate and Looks together with their states. Add one quiet
  **Export…** action. A phone uses **Chapter actions** and keeps Read / Listen at the foot.
- Draw the missing chapter Looks overview: one character row, one named chosen outfit and a
  small preview. Open turn 207's collection from that row; explicitly Use a look, then return.
- Select a pictured passage to reach **Picture → Animate**. Keep the quote, generation,
  review and explicit Use clip steps of turn 208. Return to the same passage.
- Export from a chapter with **This chapter** selected. Export from the existing book door
  with **Whole book** selected. The user may change scope, and changing format preserves it.
- Keep every sheet's originating view, chapter, selected passage, scroll, focus and draft.
  An Illustrate → Looks detour returns to Illustrate; browsing saved looks from New look
  returns to that unsaved draft. Background jobs never change the chapter being edited.

## Important implementation boundary

Before this turn, `AudiobookExportSheet` had no chapter-selection input. Its `Files` control chooses
file partitioning, **not chapter inclusion**. The approved change requires explicit selection in
the shared listening/export plan and coordinator path for both video and player packages,
including caches and receipts. A client-only filter is insufficient.

An incomplete current chapter blocks export and offers a quote for its missing blocks. It
cannot silently export other chapters. Whole book lists incomplete chapters it will omit
before confirmation. Missing measured word timings disables only highlighted words; plain
subtitles remain available. Turn 208 owns the actual alignment prerequisites and quote.

The live private SPEC-047 was read, including R-66/R-71/R-72, R-112/R-114/R-118/R-146,
R-123/R-126/R-129 and R-132–R-145. Turn 209 deliberately proposes an extension to toolbar and
export scope rules. PR 1690 implements the chapter navigation and explicit scope through both
coordinator export paths, saved manifests, delivery listings, cache reuse and recovery. Its
private companion amends SPEC-047 R-179. The original design-only PR changed no world data or
generation service; the HTML review remains a separate fixture from the application.

## Review coverage and limitations

31 HTML frames cover entry, the new navigation and Looks overview, supporting destinations,
scope and recovery states, and 390px phone layouts. Public Undersong assets are illustrative;
all prices, durations and job progress are fixtures. The prototype demonstrates navigation,
look selection and export scope. Media controls and existing detailed editors are static.
The prior 206–208 proposals remain the authority for their detailed controls. Schematic book,
direction and illustration destinations do not replace their existing approved designs.

Rendered every frame in headless Chromium: Geist Sans loaded, no broken image, no horizontal
overflow in checked layout containers, and no visible action below 44px. Main entry, selected
look return, animation acceptance/revert and phone return links were exercised. These are
design checks; native modal focus, keyboard menu behavior, 320px, 200% text zoom and actual
job/plan persistence remain implementation acceptance checks. Existing t195 missing-turn
warning remains unrelated and tracked by #1576.

To regenerate the design after an approved revision:

```text
node design-system/story-journey-209.mjs
node design-system/check-master.mjs --record
node design-system/build-review.mjs
node design-system/check-master.mjs --render
node design-system/build-review.mjs --check
```

The generator replaces only turn 209 and its review registrations. It must not overwrite
206–208 when those branches land; each keeps its own turn. The standalone HTML uses local
styles and public assets. Its script has no app bridge, network requests or persistence.

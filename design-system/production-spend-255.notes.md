# Lifetime production spend · turn 255

Proposed on 1 November 2026 for issue #250. Owner review pending. No application UI changes.

Rebuild with `node design-system/production-spend-255.mjs`, then `node design-system/check-master.mjs --record` and `node design-system/build-review.mjs`. The same drawings are registered in the master and mirrored into the prototype. `production-spend-255.review.html` is the standalone clickable review. Type, colours and light/dark come from the existing design tokens.

## Decisions to review

1. A compact lifetime summary below the existing production, scene and shot heading. The existing conversation remains first on day one.
2. One shared Spend details sheet, scoped to where it was opened, with a receipt for each contributing job.
3. Generated and selected counts; no hit-rate percentage. Selected means current shot selections, not lifetime acceptance or a timeline audit.
4. Local runs and allowance-covered work beside billed spend. Unknown allowance use stays unknown.
5. Partial, unavailable and empty are visibly distinct. Re-reading history spends nothing.

## Frames

| Frame | What is drawn |
|---|---|
| 255a | Production dashboard, summary and scene rows. |
| 255b | Scene workspace, summary and per-shot values. |
| 255c | Shot page, summary beside its existing editing fields. |
| 255d | Production receipt sheet, with expandable allocation and outcome details. |
| 255e | Partial evidence: $13.00 known, including $2.40 not allocated to a shot. |
| 255f | Failed spend-history read; known candidate counts remain visible. |
| 255g | Empty work: $0.00, 0 generated, 0 selected. |
| 255h | Phone sheet, one shot and its board share; fixed header/footer, scrolling body. |

The review's scope selector links to the corresponding drawing, rather than pretending to be the application. Receipt details expand in place. Retry controls are drawings; they perform no I/O. Production implementation must use native PageSheet focus containment, Escape/Close and focus return, and retain the originating scope. A successful refresh clears the degraded state only after its evidence can be read. Initial loading says Reading history; missing candidate records say Counts partial independently of accounting coverage.

## One inspectable fixture

`production-spend-255.fixture.mjs` is synthetic. It is not a pricing recommendation, a record of live generations or a claim that every provider can currently make these exact requests. Shared calculations feed every complete-state drawing and assert reconciliation.

| Work | Billed spend | Shot allocation | Video candidates |
|---|---:|---|---:|
| Board A | $5.00 | Shot 12 $2.00; shot 13 $3.00 (4 s : 6 s) | 2 |
| Shot 12 solo take | $1.80 | Shot 12 | 1 |
| Shot 12 failed attempt | $1.20 | Shot 12 | 0 |
| Shot 13 solo take | $2.00 | Shot 13 | 1 |
| Shot 14 video | $2.40 | Shot 14 | 1 |
| Shot 14 frame | $0.60 | Shot 14 | 0 |
| Local Board A | Unmetered | Shots 12 and 13 | 2 |
| Shot 13 plan-covered frame | Account allowance; use unknown | Shot 13 | 0 |

- Production: $13.00, 7 generated, 2 selected (shots 12 and 14).
- Scene 1, The tide: $10.00, 6 generated, 1 selected.
- Scene 2, The bell: $3.00, 1 generated, 1 selected.
- Shot 12: $5.00, 3 generated, 1 selected.
- Shot 13: $5.00, 3 generated, 0 selected.
- Shot 14: $3.00, 1 generated, 1 selected.
- Cost sources: $11.00 provider-reported, $2.00 manifest-derived, one local job, one plan-covered image attempt. The local board is one run at production level, represented in each member shot's detail; local run counts are not summed across member shots.

255e removes shot allocation evidence for the $2.40 video without removing its known production charge or its retained candidate evidence: assigned shot subtotals $5.00 + $5.00 + $0.60, plus $2.40 unassigned = $13.00. Partial does not promise this is the entire lifetime spend.

The failed-read variant 255f retains all candidate evidence and withholds money totals. A moved world with no matching local ledger instead says Historical spend unavailable. Missing candidate evidence must independently mark its counts partial; no inference from filenames or neighbouring timestamps.

## Implementation boundary

The revised issue #250 supplies the scope. Existing requirements are SPEC-008 R-14–R-19/R-29–R-30, SPEC-013 R-3–R-5/R-8–R-9, SPEC-032 R-21 and SPEC-036's frame-slot/Bench workflow. Their current statuses and amendments were read. A proposed amendment in the private specification set records this design; it does not claim approval or implementation.

New UI: the compact summary, scoped read-only sheet and accounting evidence copy. Existing UI: production navigation, scene/shot editors, take review, PageSheet and Activity. No new generator, review grammar, batch contract, reference-kit accounting or world-folder summary writes.

Before implementation, settle the five decisions above. Implementation validation will include actual component layout at desktop/phone, long source labels, 200% zoom, keyboard/focus and receipt scrolling. This design-only review can verify drawings and links; it does not qualify application behavior.

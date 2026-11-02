# Manuscript review

Issue #2198, approved design turn 267 and SPEC-012's manuscript-review amendment add **Review
manuscript** to the production's Chapters screen. Chapter review remains independent. Reports
contain an overview, causal synopsis including the ending, ordered chapter readings, candid
editorial review, continuity/intent findings, a prioritised revision plan, and method/limitations.

The optional author brief carries genre, audience/intensity, concerns and protected passages.
The coordinator pins every non-retired saved chapter in order, its hash and exact body, saved
production/chapter planning, and settled canon explicitly referenced by those chapters. Other
world canon, character sheets, pictures and audio are not inspected. Missing, unsettled or retired
canon references are named in the pinned context. Empty chapters and oversized sources are
refused before model work; nothing is silently truncated.

Full text is supplied in consecutive stages of at most 24,000 UTF-16 characters, keeping surrogate
pairs together. Limits are 1,000 chapters, 1,000 reading stages, 24 million manuscript characters,
64,000 context characters and a 6,000-character author brief. Each reading output is bounded to
16,000 characters. If ordered readings exceed 60,000 characters, bounded groups are synthesised
until the final input fits. The final synthesis uses those derived readings, not an assertion
that the whole book fit a single context window. Model/capability failures retain completed work.
Supplying all text does not establish that a model understood every detail.

The existing isolated JSON runner provides configured harness sessions, read-only agent scope,
ownership checks, cancellation, model/session receipts and one JSON-format correction after a
completed malformed reply. No general-purpose authoring tool or paid automatic replay is added.
Provider identity is shown only when the harness reports it; otherwise the report says it was
not separately reported. Calls may incur charges through the configured provider.

Derived files live at `productions/<id>/.reviews/manuscript/`: a source snapshot, authoritative
report checkpoints and a lightweight history index. A request ID has one retained report.
Interrupted/failed calls are never resubmitted by replay or continuation. **Continue unstarted
stages** explicitly continues the original snapshot's pending work; unresolved reading gaps
prevent a complete synthesis. **Start a new review** is a new, potentially paid request. Reports
and completed readings survive restart; history is capped at 1,000 reports without deleting any.

Final finding citations must match unique exact quotations in the pinned chapter. Invalid or
ambiguous citations are counted and omitted from the actionable findings. This establishes
linkage, not model correctness. Historical quotations remain available at their chapter even
when current text changes. Changed evidence blocks new decisions. A repeated finding carries
the author's decision only when its full finding, source versions, brief and context match.
Earlier findings absent from a later report are **not raised again**, never automatically resolved.

**Discuss with Arke** opens the existing production conversation scoped to the supporting
passage. It sends no message automatically. Any edit uses existing proposals and acceptance,
which retain the current chapter/media dependency checks. Review decisions do not edit prose.

**Export PDF** renders the selected retained report with Unicode text, chapter references,
coverage, limitations, provenance and page numbers, then downloads it privately. It never
publishes or shares material, and does not modify manuscript, canon or media files.

Focused checks: contracts `test/manuscript-review.test.ts`, coordinator
`test/productions/manuscript-review.test.ts`, client `test/manuscript-review.test.tsx`, plus the
existing chapter review, harness review, roster and command registry tests. Fixture models test
orchestration/evidence boundaries; they do not qualify a real model's editorial detection quality.

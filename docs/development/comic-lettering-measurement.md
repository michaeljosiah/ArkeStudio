# Comic lettering measurement

Issue #2219 proposes 85% first-take and 95% within three attempts for pages with one to eight
lettering items before treating a model as qualified. The development tool below records what
existing page-check receipts establish. It makes no model calls, opens no world store and writes
nothing. Keep its output private: page, take and artifact identifiers refer to the author's world.

```powershell
node --import tsx scripts/measure-comic-lettering.mts codex-image en "C:/path/to/world/productions/book-drawn" > output/comic-lettering.json
```

Supply more production folders to include them in one report. The tool pins hashes of the comic
settings, scripts and page records and refuses changes while reading. Missing records remain in
the denominator. Only takes for the current script, requested model/language and baked mode are
counted, in retained order. Unavailable checks and author overrides never convert a failure into
a pass. Empty samples have no rate. Pages outside the proposed lettering range are reported as
excluded, and reader versions/comparison rules accompany the results.

The rates are **first retained take** and **within three retained takes**. Failed or removed
generations may be absent, a later read can replace a check, and model aliases can change. This
does not verify present image bytes, reader accuracy, speaker attribution or visual quality.
Consequently `qualification` remains `not-established`, even if the observed rates meet the
proposed targets. The report never changes model eligibility, defaults or acceptance policy.

A prospective qualification still needs a frozen corpus and pinned generation/reader identities,
every attempted generation including failures, independent checks of the images, and a retained
result for each attempt. Do not select only accepted pages or count an override as quality proof.

## Observed receipts, 1 November 2026

A read-only inspection of three existing private productions found 31 current pages, 15 within
the proposed lettering range. For the `codex-image` route in English, 8/15 (53.3%) passed on their
first retained take and 10/15 (66.7%) within three. The recorded reader was
`harness-vision/1:github-copilot/claude-opus-5.5`. These observations do not meet either proposed
target and do not establish that reader's accuracy. Source material and individual receipts remain
private; no unpublished words or images are included here.

The separate page-review stage already checks balloon speakers and treats speaker findings as
blocking (`graphic-novel-reviewer.ts`, `REVIEW_BLOCKING`). The lettering reader's `not-checked`
speaker field alone does not mean that stage is absent. SPEC-064 was unavailable in the live
private set; this measurement follows the issue and implemented comparison rules, without
reconstructing the missing design.

Validation: coordinator `test/productions/comic-lettering-measurement.test.ts` tests missing and
unavailable data, overrides, stale scripts/model/language, attempt order, empty samples and
read-only portable records. Fixtures establish report behavior, not generation quality.

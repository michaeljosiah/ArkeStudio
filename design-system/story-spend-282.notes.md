# Turn 282 — Story and audiobook spend (#2820)

Proposed for owner approval, 13 November 2026. This is the narrow spend extension selected
in the issue audit, not the original confirmation-policy rewrite.

## Scope and UI

Add the existing compact spend summary below the current chapter overview content. Label it
**Audio & picture spend** and state that it covers recorded narration and illustration jobs
on this device, excluding writing costs. Reuse the existing read-only PageSheet and receipt
expansions; omit video candidate counts and scene/shot selectors for chapter productions.
Show chapter labels when the frozen job history supports them, otherwise unassigned work.
Model names and amounts in the drawings are illustrative. Surrounding overview content is
context only; existing navigation, chapter cards, writing controls and spacing remain.

Keep known billed money, local runs and plan-covered attempts distinct. Known amounts plus
missing charges produce a partial total. An unreadable ledger or missing historical money
never becomes zero. Retained narration/illustration media establishes past work even when
its device-local ledger is absent. A readable genuinely empty history can show zero and
No audio or picture work yet. The existing Read history again control remains read-only.

## Accounting and boundaries

Use the ledger for money and the retained job journal for production/chapter ownership;
never total take.cost or count cached/reused narration twice. Include charged failed/cancelled
attempts and historical jobs hidden from Activity. Do not include unrelated voice previews,
reference work, arbitrary Bench work or authoring calls. Orphan ledger money with a known
production identity stays visible as unassigned with partial coverage.

Do not change confirmation sheets, one-press limits, voice-upload consent, provider dispatch
or stored world records. Other production kinds and confirmation-policy unification stay
deferred. SPEC-008's lifetime-spend amendment and SPEC-032 R-21 guide accounting uncertainty.
The existing video spend design (turn 255) is retained.

## Validation after approval

Exercise narration and illustration attribution, deduplication, failed charges, local/plan
sources, removed chapters, retained media without ledger, empty and unreadable history.
Test existing video totals unchanged. Render actual components at phone, Fold and desktop
sizes in both themes; verify receipt scrolling, refresh, Escape and focus return. Then run
focused tests, lint, typecheck and build before the requested immediate PR merge.

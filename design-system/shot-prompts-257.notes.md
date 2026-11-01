# Shot prompts · turn 257

Proposed 1 November 2026. The owner approved narrowing issue #252 to prompt history, restore
and request inspection. This approves the scope, not these screens. Application implementation
and the accepted prototype mirror follow owner design review.

The latest reviewed main is `2064be208d24491aa607a28e7d20c778c7a30248`. Manual prompt
editing/reset, conversational scene commands, whole-scene history, shot pages and production
Bench are already present. The former proposal's new shot list, Patch/Rebuild harness purpose,
per-shot failure modes, extra status ladder and #250 dependency are removed.

## Proposed behavior

1. Two local actions: History and Inspect request. Keep the existing Frame prompt editor,
   View full prompt and Rebuild. A frame entry stays image; the video generator stays video.
2. History projects retained scene versions for the stable shot ID. Collapse unrelated versions,
   keep source pins/capability, and disclose gaps. No second journal or prompt authority.
3. Review one historical prompt, then restore it as one new scene version. Keep older source
   evidence and stale-sheet warnings. Nothing else in the scene is restored.
4. Inspection names its saved/draft/frozen source, chosen route and controls, then shows the
   actual compiler's prompt and reference fields. It never submits, uploads or saves work.
5. Phone uses the same native PageSheet, fixed header/footer and scrolling body. History and
   inspection remain separate tasks rather than a permanent multipanel workspace.

## Frames

| Frame | Review |
|---|---|
| 257a | Entry on the dedicated shot page, preserving the existing editor. |
| 257b | Retained versions, readable comparison and source detail. |
| 257c | The full body to restore and an older-source notice; save as new v22. |
| 257d | Current video generator draft, compiled prompt and carried/omitted references. |
| 257e | Reference inputs keep their own numbering, source identity and omission reasons. |
| 257f | Stale restore refuses; the historical text remains readable. |
| 257g | Phone history with an unreadable version and earlier-history gap. |
| 257h | Phone request inspector, one scrolling column. |
| 257i | Unavailable model/route; no fabricated request or order. |
| 257j | A known current prompt without recorded older versions. |
| 257k | A saved frame prompt opens the image inspector, never the video draft. |

The fixture is synthetic. Version numbers, words, source hashes and route capabilities describe
the drawings, not a live model, generation or author world. No historical actor/action/date is
claimed from an ordinary scene snapshot. Both prompt contexts deliberately use different bodies.

## Implementation constraints to preserve

- SPEC-012 R-14–R-16: `promptOverride`/`promptFor` owns the current body and source staleness.
  The document is draft overall; current code and amendments establish the shipped boundaries.
- SPEC-029 R-36–R-38 (implemented): semantic version fences and whole-document scene history.
  History is projected from it; this proposal does not amend R-38 into a parallel journal.
- SPEC-019 (implemented, with authored-prompt amendment): actual compiler composition and
  bound-reference order. No new constraints layer or dispatch text reordering.
- SPEC-036 R-41/R-42 and later amendments (implemented): the dedicated shot page, single writer,
  frame/video override protection and production Bench. History cannot trigger a blur save that
  accidentally replaces a hidden video override. Existing refusal and draft rules remain.

Some detail needs implementation investigation, not a UI promise: retained version gaps and
trusted historical provenance must be resolved on the coordinator; compiler routes that do not
expose exact layers show the full prompt instead; frozen requests are inspected from their own
record without current recompilation. Renderer contracts are bounded display facts rather than
raw provider objects. A no-override historical snapshot offers today's assembled reset, clearly
labelled, because old world/sheet assembly text was not necessarily recorded.

## Validation and rebuild

Run `node design-system/shot-prompts-257.mjs`, then
`node design-system/check-master.mjs --record` and `node design-system/build-review.mjs`.
The standalone review is `shot-prompts-257.review.html`.

`node design-system/shot-prompts-257.capture.mjs` renders every frame in both themes in an owned
headless browser. It checks internal destinations, fonts, horizontal fit, fixed sheet chrome,
source disclosure, context labels and phone scrolling. Output is under `output/shot-prompts-257/`.
These are drawing checks; native application focus, persistence and request parity are future
implementation gates. No application code has changed.

Checked 1 November 2026: all 22 light/dark renders pass, along with master anchors/rule counts,
consolidated review freshness, script syntax and repository lint (8 existing warnings). The
private SPEC-012 proposal names PR #2292 and keeps design approval explicitly pending.

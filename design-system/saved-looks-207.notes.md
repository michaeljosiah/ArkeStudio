# Saved looks — approved turn 207

The owner approved turns 206–209 on 2026-10-10 before implementation. PR #1686 implements
turn 207 and turn 209’s nested return paths. The owner approved turn 210 on 2026-10-10 to retain existing chapter editing in the compact
209 overview. The explicit audit differences below remain documented. SPEC-017
R-29 and SPEC-047 R-180 record the behavior in the private specification set.

A look has an optional short name separate from its generation prompt. The shared collection
shows thumbnails, names and chapter usage; selection previews locally until **Use for Chapter**.
The full prompt and face lineage remain in Details. Legacy looks have stable date labels,
including an ID suffix when timestamps collide. Missing media remains visibly unavailable.

Renaming changes only the name, checks the expected previous name, and preserves the look ID,
images, prompt, acceptance timestamp, source take/job, attachment scopes and face lineage.
The first named reference-kit write atomically raises the world to schema 72. Older writers
refuse that world instead of dropping the field. Clearing a name does not lower the boundary.

The chapter overview has one chosen-outfit control per character. New look keeps its clothing,
optional name and candidates while the saved collection is open. Closing a nested sheet returns
to its originating control. The existing Illustration sheet keeps **Review chapter looks**
available on a phone, and the detour returns to the same Illustration sheet.

## Validation on 2026-10-10

- Contracts, client and coordinator typechecks passed.
- 36 contract, 86 client and 17 coordinator focused tests passed (139 total). The 86 client tests
  were repeated after the final layout/return refinements. Coverage includes reopen persistence,
  schema refusal, stale edits, snapshot-before-ack, explicit choice, search, missing/removed looks,
  connection loss, and retained New look drafts/candidates.
- The production client build passed. Repository lint passed with four existing warnings.
- A local fixture rendered the actual components with the application stylesheet cascade and
  bundled Geist at 1360×900, 390×844 and 320×844. Twenty-two screenshots cover the overview,
  collection, rename, legacy/missing previews, New look, and text enlarged to 200%.
- Real browser pointer and keyboard input verified preview-only arrow navigation, Enter to save
  a name, Escape return to the chosen outfit, New look draft/candidate preservation, the original
  chapter opener, and Illustration → Looks → Illustration. Each step has one active dialog;
  measured layouts have no horizontal overflow and at least 44px action/list targets.

Browser fixtures use public Undersong sample assets and an in-memory command bridge. They do
not mutate an installed app or a real world. Native persistence is covered separately by the
coordinator tests. Screenshots are session review artifacts; no private manuscript or character
reference files were published.

## Literal master audit

The owner subsequently requested a literal side-by-side completeness audit. Eighteen matched
approved/actual pairs cover 207a–g, Looks-related 209d/e/n/t/v and approved 210a–f. Source screenshots are rendered
directly from the approved master; actual screenshots render application components and CSS
with bundled Geist and fictional sample data. The fixture background differs from the chapter
workspace and is labeled explicitly. Earlier responsive tests are not a claim of visual parity.

The audit found corrections in subtitle, row usage, provenance, candidate-card dimensions,
quote position, phone actions and rename layout. Those approved-207 corrections are implemented and recaptured. The detailed requirements retain full Name and
Face facts under Details even where an illustrative frame omits those rows; the comparison
matrix identifies this rather than calling it an exact drawing match.

209 explicitly defers destination details to 206–208. Its chooser and New look drawings are
navigation schematics; detailed 207 controls remain authoritative. The 209 overview previously
exposed legacy Place, Mood, clothing, Add a character and Derive controls. The owner explicitly approved turn
210, and those existing fields/actions now remain in a folded Chapter details disclosure. Approved 207/209 source frames are unchanged.

The current native phone PageSheet fills the viewport; the illustrative 209/210 phone frame
retains 53px chapter chrome and 28px status (207 phone drawings retain a 40px shell bar). This is a real platform presentation difference,
not solely fixture background, and is explicitly recorded rather than claimed as whole-frame
1:1. Issue #1692 tracks the remaining phone shell reconciliation. Desktop frame positioning likewise follows the native overlay over the available viewport.

Final affected client/contracts typechecks and 88 client behavior tests passed. The actual
browser smoke now captures 31 states, adding expanded details and bottom scroll states at
1360, 390 and 320 pixels and 200% text. It verifies the disclosure remains open through nested
browsing, the phone chooser-to-New look path, retained candidates and exact origin focus.

The final pointer-flow regression found that blurring a newly added character could insert its
compact row between pointer down and click, moving Derive again before the click reached it.
The action now retains field focus until click, then focuses the button so the field write is
sent before the explicit derivation request. Real browser input verified that ordering, one
derive request, Add, Done, and the empty phone collection → New look → Saved looks → Back path.

After that correction, 36 contract tests and 50 directly affected client tests were repeated
and passed. Final client/contracts typechecks, the production client build and repository lint
also passed (four existing lint warnings; the existing bundle-size warning remains). All 18
paired captures and 31 responsive captures were refreshed. The 17 coordinator persistence and
compatibility tests and broader 88-client suite passed earlier in this session; coordinator
source was unchanged by the final visual/interaction corrections. No whole-frame 1:1 claim is
made: retained binding Name/Face facts, shared checkbox rendering and the phone chrome gap
are identified in the paired review.

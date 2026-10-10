# Saved looks — approved turn 207

The owner approved turns 206–209 on 2026-10-10 before implementation. PR #1686 implements
turn 207 and turn 209’s nested return paths. The literal audit below found that the compact
209 overview still needs a separately approved preservation design before it can match. SPEC-017
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

## Literal master audit, still in progress

The owner subsequently requested a literal side-by-side completeness audit. Twelve matched
approved/actual pairs cover 207a–g and Looks-related 209d/e/n/t/v. Source screenshots are rendered
directly from the approved master; actual screenshots render application components and CSS
with bundled Geist and fictional sample data. The fixture background differs from the chapter
workspace and is labeled explicitly. Earlier responsive tests are not a claim of visual parity.

The audit found corrections in subtitle, row usage, provenance, candidate-card dimensions,
quote position, phone actions and rename layout. Those approved-207 corrections are in progress
and must be recaptured before this PR is ready. The detailed requirements retain full Name and
Face facts under Details even where an illustrative frame omits those rows; the comparison
matrix identifies this rather than calling it an exact drawing match.

209 explicitly defers destination details to 206–208. Its chooser and New look drawings are
navigation schematics; detailed 207 controls remain authoritative. The actual 209 overview
still exposes legacy Place, Mood, clothing, Add a character and Derive controls. Proposed turn
210 would preserve these in a secondary Chapter details disclosure. It awaits owner approval;
no 210 application implementation has been made. Approved 207/209 source frames are unchanged.

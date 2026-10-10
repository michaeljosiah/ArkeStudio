# Saved looks — approved turn 207

The owner approved turns 206–209 on 2026-10-10 before implementation. PR #1686 implements
turn 207 and turn 209’s compact chapter Looks overview and nested return paths. SPEC-017
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

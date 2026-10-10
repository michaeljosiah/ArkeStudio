# Compact chapter Looks — approved turn 210

The owner explicitly approved turn 210 on 2026-10-10 before implementation. Approved turns
207 and 209 remain unchanged. Implementation is complete; matched-state validation and phone field/return checks are recorded in saved-looks-207.notes.md.

The literal master audit found that the compact 209 overview omitted existing Place, Mood,
per-character clothing, Add a character and Derive again controls. Deleting those controls would
remove useful editing. Turn 210 keeps the compact overview and puts those existing fields in a
secondary **Chapter details** disclosure below the new-picture hint.

- 210a/c: desktop and phone overview, details folded.
- 210b/d: details expanded at the top, beginning with Place and Mood.
- 210e/f: the same expanded state scrolled to the bottom, showing all remaining clothing fields,
  Add a character, Derive again, saved status and the held Done action.

On a phone, each chosen-outfit or Main photo row opens the shared 207 chooser, even with zero
saved looks. That chooser retains **New look**. The overview omits only its duplicate button.

The existing save contract remains: edits save when leaving a field; Done closes the sheet and
returns to the originating chapter or Illustration control. Derive again submits the existing
chapter derivation request. It is separate from saving and closing. The disclosure does not
create a new generation or auto-derive step. Missing/older-face warnings remain in the compact
character summary, and existing close-view/lineage details and actions remain available inside
the expanded details.

The design uses public Undersong samples. The standalone review has no app connection and
cannot change a world or incur generation cost. The owner’s approval authorizes this disclosure and its existing return paths.

The native phone PageSheet fills the viewport. The approved phone illustrations retain 53px
of chapter chrome and 28px of status; this known whole-frame difference remains open in
issue #1692. The approved master was not rewritten to conceal this difference.

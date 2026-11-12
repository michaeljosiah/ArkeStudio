# Turn 268 — File problems: a notice, not a banner

Drawn for the owner's approval. Samples are synthetic. The notice and the Inbox rows draw the shipped
`.fy-note` and `.fy-ap` at token sizes; the screen behind them is left out because nothing about it
changes except that the band is gone.

Owner, on the band over a world's screens: "We should just get a notification that something was
wrong with the files and not keep it constantly there. It just makes the app feel broken."

- **The band goes** from every world screen: `file(s) could not be read` and `record(s) say the same word`.
- **The notice** is the queue notification (turn 79), warning tone. `View` opens the Inbox; `×` closes it.
- **Once.** The paths are remembered per world in app settings beside the Inbox's seen stamp
  (SPEC-014 R-25), so every window agrees and a restart does not raise it again. Only a path not in
  that list raises it again.
- **Past versions** (`.history/`) raise no notice and no dot. The live record is whole and in use.
- **The details** stay at the foot of the Inbox for as long as the problem exists (SPEC-002 R-2).
- **The outside-edit band stays**: the world's writes wait on it and it holds Adopt.

# Turn 281 — Manual sketches and production navigation

13 November 2026. Approved by the owner in chat before UI implementation. Work order:
#2811, then #2806, one minimal PR each. The owner requests merging without CI or code-review
waits. #2808 and #2809 are retired; #2807 stays deferred.

## #2811 — Manual sketch and one default writing model

When writing AI is unavailable, the existing sentence form says Create as sketch and explains:
“Create a sketch from your own words. No AI drafting is needed. Review it before adding it to
your world.” This explicit choice carries manual intent to the coordinator, so a readiness
change cannot turn it into an AI request. The existing attended proposal opens from its list
card/row and uses the ordinary Accept/Discard controls. Accept still checks current world state,
ownership and validation. Keep the author's sentence as submitted; no AI text or provider cost.

When the author asks for AI drafting, preserve #1916: failed/unavailable drafting remains a saved
brief requiring drafting or authored edits. Never silently convert a failed AI request into an
acceptable manual sketch. Beginning a world retains its own existing settlement behavior.

Use the existing Story writer model selector and Same as Story writer options. Setup configures
the writer once; ordinary writing roles inherit through the current shared routing rule. Keep
explicit custom models and specialized/operational role routing. Do not guess which old model
overrides were intentional or clear them in bulk. The settings note explains inheritance and
that changes apply to the next session. Model names in the drawing are examples.

Keep completed setup in the existing model settings, as SPEC-016's PR #2339 amendment requires.
Reopening the setup wizard, changing founding arrival and redesigning phone pairing are outside
this narrow fix. Relevant live requirements: SPEC-007 R-10, SPEC-016 R-1–R-5 and its completed-setup
amendment; the original specs are draft design records, not proof of implementation.

## #2806 — Reach existing pages from both navigation surfaces

For episodic video, add Story structure after Episodes and Cast after Story structure to the
desktop rail (including its Fold drawer). Both already appear on the phone page strip. Keep
episode expansion, scene rows, counts and active-state behavior. The desktop drawing omits
expanded episode rows solely to show the added destinations.

For an audio drama with a source story, insert Adaptation after Episodes on the existing phone
strip, matching the desktop conditional entry. Original audio dramas without a source get no
Adaptation item. Keep the existing horizontal scroll behavior and route. The drawing's page body
is contextual scaffolding; do not redesign the Adaptation screen or add sample status controls.

Share the static destination definitions with explicit device differences where they already
exist. Preserve desktop Takes/Generate lenses, page names, route aliases and retired-address
redirects. Do not introduce new pages or a canonical-URL migration. SPEC-001 R-7 requires existing
screens to be reachable; design turns 88, 91, 99 and 166 remain the surrounding layout baseline.

## Checks after approval

- Manual intent vs failed AI drafting; ready/unready adapter transitions; acceptance and reopening.
- Writer inheritance for new setup; explicit and specialized model choices retained.
- Episodic rail/phone parity; sourced vs original audio drama; Fold drawer, selected page and routes.
- Actual components at phone, Fold and desktop sizes, light/dark; focused tests, lint, typecheck,
  build. Drawings show only the changed areas and retain the existing neutral design tokens.

# Turn 280 — First run, episode decisions and earlier saved replies

13 November 2026. Approved by the owner in chat before UI implementation. The owner has already
authorised retiring #2789's unused client flow. One minimal PR per issue; no CI or code-review
waits, as explicitly requested. These detail drawings retain the surrounding layouts and use
the existing neutral tokens. Example download figures and proposal contents are fixtures.

## #2790 — One clear way into the studio

Launch keeps its existing artwork, layout and Continue intent. Until onboarding is complete,
the greeting is **Welcome**; afterwards it is **Welcome back**. The one working card is
**Your studio**, with **Continue locally** on the local host. Hide the inactive Cloud card and
account footer. Remote pairing, hostname, reconnect and refusal states retain their controls.

On setup review, **Set up and start** is the only primary. Queue exactly the selected downloads
through the existing setup owner, then finish onboarding after the request is acknowledged.
Downloads continue in the background. **Skip downloads** is secondary and finishes without
starting the selection. With no missing downloads, use **Start using Arke** and omit Skip.
Back and Check again remain secondary. A refused save or queue keeps the review visible and
shows the existing reason; failed downloads remain available in Settings for recovery.
Neither choice bypasses the workspace-ready requirement.

Move the existing environment warnings to onboarding's storage section and empty Home, before
Create a world. Preserve the actual environment detail; the drawing's search warning is an
example of a non-blocking problem. Display a failed startup check as needing attention, never
with a passed checkmark. Unknown is still checking. Optional tools cannot block manual writing.
Retire the obsolete FirstRunScreen and redirect its route through the current entry flow.

This is the narrowed review recommendation: no new-world layout rewrite, download UI unification
or new transfer calculations. Authority: issue #2790 and SPEC-016 R-1–R-5, SPEC-033 R-82.

## #2791 — Decide beside the episode

Each attended staged episode offers **Review episode 03** (using its actual order). It opens a
local sheet containing the existing StagedDecision and its real changes, checks, conflicts,
Accept, Send back and Discard controls. The illustration abbreviates the existing panel body;
it does not introduce a new acceptance implementation. Multiple episodes/proposals remain
separate and a shared proposal is not accepted twice. An unresolved conflict still blocks
Accept. Closing keeps the proposal. Successful acceptance updates the current board.

Replace the dead instruction “accept them in Proposals” with the in-place review control and
**Awaiting decision** where needed. For the Watch door, change only its description to
**Short film or micro-drama**. Those are the selectable creation kinds; this does not restrict
the artistic style or story discussion. Other door layout and art remain unchanged.

The publishing ambiguity is already fixed by #2804/#2805. No publishing changes, blanket
banned-word test or application-wide vocabulary rewrite. Authority: narrowed issue #2791
and existing staged-episode decision behaviour from turn 92.

## #2802 — A saved answer is visible while its actions finish

Keep complete-turn validation and action preparation before the durable turn.completed append.
After that append succeeds, publish the saved reply and preparation intents immediately, before
binding the action cards and refreshing the wider conversation list. The same reply stays in
place as cards become ready; never duplicate it or mark an unbound action accepted/executed.
The drawing uses a Preparing placeholder for a persisted intent. Reuse existing card status
presentation where available. Controls appear only when the action is bound and eligible.
Preparation/binding failures and reconnect use their durable existing recovery state.

This is earlier publication of a complete validated answer, not token streaming, which remains
#2819. Do not publish failed or uncommitted turns or weaken the existing all-or-nothing checks.
Publishing the view must not turn a successfully saved turn into a duplicate retry if the
notification fails. Test ordering and recovery with a paused binding step.

Give the thread's prioritised action kinds full entries when they fit the guide budget. Keep
every other allowed kind visible with its name, short purpose and refusal where applicable;
describe_action supplies its full requirements on demand. Preserve shared policy, required-read
guidance and world/production scoping. Compact further within the existing budget when needed.
No new setting and no loss of an action kind. Measure guide size; do not promise unmeasured
model latency savings. Authority: issue #2802, SPEC-050 R-3/R-5 and whole-turn validation.

## #2789 — Retire the unreachable timing proposal

The owner chose removal. Delete only orphaned client components, proposal hook/store helpers,
constant-null proposal locks and their dead tests/styles. Keep Audio Studio, manual timing,
saved records, command contracts and coordinator services. Correct the code map and amend
SPEC-047's client entry-point assumptions. There is no replacement button or screen.

## Evidence and delivery

Render desktop/narrow details in light and dark, check fonts and overflow, then show the narrow
drawings inline in chat. The three UI designs above are approved. Update
#2771's completed children now and the remaining checklist entries when their work is merged.

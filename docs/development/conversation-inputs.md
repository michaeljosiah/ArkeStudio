# Conversation input persistence

This is the first implementation slice of [issue #1138](https://github.com/michaeljosiah/ArkeStudio/issues/1138), checked on 13 September 2026. It provides input contracts, a durable journal, replay and startup recovery. The composer and command handlers do not yet admit additional messages, the runner does not yet drain this queue, and no adapter advertises native steering. The full capability remains incomplete.

## Entry points

| Area | Source |
|---|---|
| Input identity, bounds, state transitions and sanitized projection | [contracts/world-chat-input.ts](../../packages/contracts/src/world-chat-input.ts) |
| Optional native input controls | [contracts/adapter.ts](../../packages/contracts/src/adapter.ts) |
| Owned, flushed admission and control operations | [input-journal.ts](../../packages/coordinator/src/world-chat/input-journal.ts) |
| Replay, FIFO and native-attempt checks | [input-fold.ts](../../packages/coordinator/src/world-chat/input-fold.ts) |
| Startup pause and lost-offer recovery | [input-recovery.ts](../../packages/coordinator/src/world-chat/input-recovery.ts), called by the existing conversation recovery pass |
| Transcript, checkpoint and deletion projection | [fold.ts](../../packages/coordinator/src/world-chat/fold.ts) |
| Regression cases | [input-journal.test.ts](../../packages/coordinator/test/world-chat/input-journal.test.ts) and [v2-input-protocol.test.ts](../../packages/adapter-opencode/test/v2-input-protocol.test.ts) |

## What the journal guarantees

`WorldChatInputJournal` requires the owning world's write and compatibility operations. It checks admission under ownership before raising world schema 27, so an already invalid command does not upgrade the world. It repeats validation under `ownedWrite` after the boundary and before writing the input event. These operations remain separate because the boundary commit and owned write use the same world queue. A closed or unwritable world cannot admit new input.

Admission retains the original submission identity, text, requested delivery/run, resolved constraints, routing and attachment hashes. Explicit model, subject and reply-only selections must match their capture. Inputs start without a turn id. Repeated submission content returns the original durable receipt; changed content under that identity is refused. Each conversation accepts at most ten unresolved inputs, with the existing 16,000-character and twenty-attachment limits.

The conversation append queue and expected log sequence arbitrate concurrent journal instances. Each transition validates the latest state; a sequence conflict repeats preflight. A disk error does not automatically repeat a write. Duplicate receipts flush the existing log again because a readable event may survive an earlier failed `fsync`. Torn-tail replacement is also flushed before rename. These are the existing local-filesystem crash guarantees, not a new claim about directory persistence or network filesystems.

Promotion appends one `input.promoted` event containing the original message, constraints and new primary run. It refuses a changed route, changed attachment hash, another active run, a reused turn/run identity, a paused queue or a later FIFO input. The prepared run must also name the latest overall conversation sequence; an intervening non-input event requires rebuilding context. Continue explicitly records the reviewed route for inputs already present, without mutating their original capture. Remove retains history and only applies to never-offered queued input.

Native offer records name the Arke run, turn, native session, execution, input identity and attempt ordinal. Acceptance remains separate from inclusion. An uncertain result pauses the queue; only an exact correlated disposition can resolve it. Startup turns unfinished offers into uncertainty and pauses waiting input without calling a harness. Archive and failed-run events also project a durable pause. A new admission never clears a pause.

Queued, accepted and uncertain inputs are excluded from transcript evidence. Confirmed inclusion adds the original user message once; promotion binds it to its primary turn. Summaries retain included corrections and promoted messages, including a correction reconciled after completion or an earlier summary. Corrections precede their target reply and carry its message identity into summary input; reconciliation does not move the summary boundary past a newer unfinished turn. Snapshots omit native session/execution identities and retain all unresolved inputs plus at most ten rows selected by their settlement sequence; the journal retains the complete history.

Unresolved inputs block conversation deletion and wrap-up. Both lifecycle intents commit against the sequence read during preflight, and input admission refuses a durable deletion intent or an unfinished wrap-up intent. This closes both sides of the race before a receipt, proposal staging or directory removal can occur.

The transcript places confirmed direction at its original native-offer sequence, which is within the targeted run. Late reconciliation therefore appears before that run's reply, and paging before the reply still includes its corrections. Checkpoints retain that same ordering. Retry refuses damaged history before reading model or constraint metadata from it.

The journal has no dispatch loop and holds no lock across a native call. Wiring normal sends, completion, Stop, readiness/ownership changes and automatic advancement through one scheduler remains necessary before exposing the feature. Final run/input provenance and approval fencing, repair/retry integration, transport receipts and shared composer behavior also remain on #1138. Passing the journal tests does not satisfy the end-to-end native-engine requirement.

## Native protocol evidence

The opt-in test ran against the shipped Windows x64 OpenCode binary, reporting `0.0.0-next-17444`. Its installed manifest records executable SHA-256 `4F7C5140DEBF2436D1AF9A4EED573B24D7E3A4CF9DDAFDA2F8994870797BE10D`. The test launches its own hidden child with an isolated profile and no provider credentials. Every prompt uses `resume: false`; it makes no model call.

| Observation | Measured result | What it establishes |
|---|---|---|
| Same input id and payload, repeated | HTTP 200; one inbox row | Native admission deduplication |
| Same id, changed text | HTTP 409 | Native content-conflict refusal |
| Pending input cancellation | HTTP 204; inbox becomes empty | Cancellation while still pending |
| Nonexistent `expectedExecutionID` on an idle session | HTTP 200; input admitted | That supplied precondition is not enforced |
| Interrupt on an idle session | HTTP 204 | Success alone cannot identify a stopped execution |

Source was separately inspected at upstream commit `d4f10fa9bed3c19d3e28fb90f20dc208226eeee7`, the commit cited by the runtime's license metadata. This is not asserted to be the nightly binary's exact build revision. The [session protocol](https://github.com/anomalyco/opencode/blob/d4f10fa9bed3c19d3e28fb90f20dc208226eeee7/packages/protocol/src/groups/session.ts) exposes admission and execution controls. The [inbox implementation](https://github.com/anomalyco/opencode/blob/d4f10fa9bed3c19d3e28fb90f20dc208226eeee7/packages/core/src/session/inbox.ts) promotes input into visible messages. The [model loop](https://github.com/anomalyco/opencode/blob/d4f10fa9bed3c19d3e28fb90f20dc208226eeee7/packages/core/src/session/runner/llm.ts) then loads/prepares context, may compact it and resets its internal step allowance after promotion.

Admission-only input and isolated native sessions may supply part of an equivalent targeting mechanism. These observations do not prove model-input inclusion, completion races, unchanged execution budgets or interrupted/lost-receipt reconciliation. The adapter therefore leaves `nativeInput` absent. The Claude adapter also leaves it absent; its ordinary SDK input stream is not treated as a verified steering contract. The Codex adapter landed with [#1129](https://github.com/michaeljosiah/ArkeStudio/pull/1129) while this slice was being verified. It provides ordinary turn dispatch and correlated interruption, but does not expose `nativeInput`; steering and inclusion reconciliation still require their own qualification.

Run the native measurement from `packages/adapter-opencode`, with the executable path explicitly selected:

```powershell
$env:ARKE_TEST_OPENCODE2 = 'C:\path\to\opencode2.exe'
node --import tsx --test test/v2-input-protocol.test.ts
```

Without the variable, the native test skips. A different version requires repeating and updating the measurement; a passing scripted adapter test is not a substitute.

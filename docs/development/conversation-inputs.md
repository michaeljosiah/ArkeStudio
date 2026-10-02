# Conversation input persistence

The foundation slice of [issue #1138](https://github.com/michaeljosiah/ArkeStudio/issues/1138) (SPEC-045, partial T-1 to T-3). It provides input contracts, a durable journal, replay, startup recovery and a runner entry point for executing a queued primary input. The composer and command handlers do not yet admit additional messages, nothing yet schedules the queue, and no adapter advertises native steering. The capability is not available in the app.

## Entry points

| Area | Source |
|---|---|
| Input identity, bounds, state transitions and sanitized projection | [contracts/world-chat-input.ts](../../packages/contracts/src/world-chat-input.ts) |
| Optional native input controls (`nativeInput`, absent on every adapter) | [contracts/adapter.ts](../../packages/contracts/src/adapter.ts) |
| Owned, flushed admission and control operations | [input-journal.ts](../../packages/coordinator/src/world-chat/input-journal.ts) |
| Replay, FIFO and native-attempt checks | [input-fold.ts](../../packages/coordinator/src/world-chat/input-fold.ts) |
| Startup pause and lost-offer recovery | [input-recovery.ts](../../packages/coordinator/src/world-chat/input-recovery.ts), called by the existing conversation recovery pass |
| Transcript, checkpoint, deletion and summary projection | [fold.ts](../../packages/coordinator/src/world-chat/fold.ts), [summarisation.ts](../../packages/coordinator/src/world-chat/summarisation.ts) |
| Queued primary turn | `WorldChatRunner.sendQueued` in [run.ts](../../packages/coordinator/src/world-chat/run.ts) |
| Regression cases | coordinator `test/world-chat/input-journal.test.ts`, `run.test.ts`, `store.test.ts`, `wrapup.test.ts` |

## What the journal guarantees

The journal is the conversation's existing event log, written through `WorldChatStore`. It inherits that store's per-directory write queue and its flush order (write, sync, close, then acknowledge); there is no second inbox file.

`WorldChatInputJournal` requires the owning world's write and compatibility operations. It checks admission under ownership before raising world schema 44, so an already invalid command does not upgrade the world, and repeats the check under `ownedWrite` after the boundary and before writing. A closed or unwritable world admits nothing.

Admission keeps the original submission identity, text, requested delivery and run, constraints, routing and attachment hashes. Explicit model, subject and reply-only selections must match their capture. Inputs start without a turn id. Repeating a submission returns the original durable receipt; changed content under that identity is refused. Each conversation accepts at most ten unresolved inputs, with the existing 16,000-character and twenty-attachment limits.

The append queue and expected log sequence arbitrate concurrent journal instances. A sequence conflict repeats preflight; a disk error is never repeated, because its outcome is uncertain. A duplicate receipt flushes the log again, since a readable line may survive an earlier failed `fsync`, and the store checks for foreign writes before returning one. A torn-tail replacement is synced before it is renamed into place. These are the existing local-filesystem crash guarantees, not a new claim about directory persistence or network filesystems.

Promotion appends one `input.promoted` event carrying the original message, constraints and new primary run. It refuses a changed route, a changed attachment hash or changed attachment bytes, another active run, a reused turn or run identity, a paused queue or a later FIFO input. The prepared run must also name the latest conversation sequence: any intervening event means the context has to be rebuilt. Continue records the reviewed route for inputs already present without changing their original capture. Remove keeps history and applies only to never-offered queued input.

Native offer records name the Arke run, turn, native session, execution, input identity and attempt ordinal. Acceptance is separate from inclusion. An uncertain result pauses the queue, and only an exact correlated disposition resolves it. Startup turns unfinished offers into uncertainty and pauses waiting input without calling a harness; it leaves a conversation alone while this process has a live turn on it, and writes nothing to input history it cannot read. Archive and failed-run events also project a durable pause. A new admission never clears a pause.

Queued, accepted and uncertain inputs are not transcript and so are not evidence. Confirmed inclusion adds the original user message once, placed at its offer's position inside the targeted run, so late reconciliation still appears before that run's reply and pages with it. Promotion binds the message to its primary turn. Summaries keep included corrections and promoted messages, including a correction reconciled after its turn or after that turn's summary, without moving the summary boundary past a later unfinished turn. Snapshots omit native session and execution identities and carry every unresolved input plus at most ten settled rows, chosen by when they settled.

Unresolved inputs block conversation deletion and wrap-up. Both lifecycle intents commit against the sequence their preflight read, and admission refuses a durable deletion intent or an unfinished wrap-up intent, which closes the race from both sides. Retry refuses a conversation whose input history is damaged before reading model or constraint metadata from it.

## Running a queued primary turn

`WorldChatRunner.sendQueued` is the execution boundary for a scheduler-selected queue row. It reserves the same conversation slot as ordinary Send before its first read, rebuilds context, and asks the journal to promote the original message, constraints and new run atomically. A refused or failed promotion never reaches session preparation or model dispatch. A promoted turn that fails uses ordinary Retry with its captured constraints, never a second promotion.

This is an internal entry point. It adds no automatic advancement, input wire commands or editable busy composer. The admission scheduler must still serialize Stop and Continue, pause durably before interruption, validate the current subject and routing, and wait for native settlement before selecting the next row.

## Native protocol evidence

Both probes are opt-in and skip without their environment variables. Neither uses credentials or makes a paid model call. Passing them does not qualify an adapter, and no adapter sets `nativeInput`.

### Codex app-server (2 October 2026)

`adapter-codex/test/steering-protocol.test.ts` runs a real app-server against a scripted localhost Responses provider, with an isolated profile that receives only model catalogue metadata. It can therefore inspect the actual model request after a steering call.

| Build | SHA-256 | Result |
|---|---|---|
| `codex-cli 0.154.0` (the adapter's supported floor) | `be96b992178b1e467c225800da0d65f2c86d5eba1ef0b14632f65db381cbdfde` | Passed, 2 October 2026 |
| `codex-cli 0.154.0-alpha.6.2` (prerelease) | `081e4de4be8e38fac6ed4d95e3b1a0b9f6d31c090ddc36e1696b349fe406f575` | Passed, 16 September 2026 |

What passed:

- `turn/steer` targets the original execution through `expectedTurnId`; a wrong id is refused.
- `clientUserMessageId` comes back as the correlated completed user item's `clientId`.
- The correction appears in a later actual model request on the same turn. The acceptance response alone is not taken as inclusion.
- Abandoning a steering receipt after the request was written still yields one correlated input and one inclusion, with no resend. This observes the late receipt; it does not prove reconnect recovery.
- `turn/interrupt` produces an interrupted terminal event for the target turn.
- Steering after completion or interruption is refused rather than starting a successor.

Still needed before release qualification: consumption ordering during compaction, repair and cancellation races; bounded reconciliation after transport loss; and wiring the verified capability to runner finalization, input provenance and approval checks.

```powershell
$env:ARKE_CODEX_STEERING_COMMAND = "C:\path\to\codex.exe"
$env:ARKE_CODEX_SMOKE_CATALOG = "$HOME\.codex\models_cache.json"   # any file with a top-level "models" array
cd packages/adapter-codex; node --import tsx --test test/steering-protocol.test.ts
```

### OpenCode v2 inbox

`adapter-opencode/test/v2-input-protocol.test.ts` launches its own hidden `opencode2` child with an isolated profile and no provider credentials. Every prompt uses `resume: false`, so no model is called. Measured against `0.0.0-next-17444`, SHA-256 `4f7c5140debf2436d1af9a4eed573b24d7e3a4cf9ddafda2f8994870797be10d` (last run 2 October 2026):

| Observation | Measured result | What it establishes |
|---|---|---|
| Same input id and payload, repeated | HTTP 200; one inbox row | Native admission deduplication |
| Same id, changed text | HTTP 409 | Native content-conflict refusal |
| Pending input cancellation | HTTP 204; inbox becomes empty | Cancellation while still pending |
| Nonexistent `expectedExecutionID` on an idle session | HTTP 200; input admitted | That precondition is not enforced |
| Interrupt on an idle session | HTTP 204 | Success alone cannot identify a stopped execution |

These do not prove model-input inclusion, completion races, unchanged execution budgets or lost-receipt reconciliation, so OpenCode keeps the queue fallback. The Claude adapter's ordinary SDK input stream is not treated as a steering contract either.

```powershell
$env:ARKE_TEST_OPENCODE2 = 'C:\path\to\opencode2.exe'
cd packages/adapter-opencode; node --import tsx --test test/v2-input-protocol.test.ts
```

A different build needs the measurement repeated; the OpenCode probe asserts the version it was measured against.

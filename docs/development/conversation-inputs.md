# Conversation input persistence

The queue-only slice of [issue #1138](https://github.com/michaeljosiah/ArkeStudio/issues/1138) (SPEC-045). World Chat and existing production conversations keep their composer editable during a reply. **Send next** saves a separate message for the next reply; **Remove** withdraws waiting input; **Continue** resumes a paused queue after reviewing the current writing destination. Production setup retains its existing turn lifecycle. No adapter advertises native steering, so nothing changes the reply already in progress.

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
| Serialized admission, Stop, Continue and FIFO advancement | [application/conversation-inputs.ts](../../packages/coordinator/src/application/conversation-inputs.ts), composed once per open world by coordinator |
| Editable busy composer, durable-receipt recovery and queue controls | client [components/conversation-inputs.tsx](../../packages/client/src/components/conversation-inputs.tsx), shared by World Chat and production conversation |
| Regression cases | coordinator `test/world-chat/input-journal.test.ts`, `run.test.ts`, `store.test.ts`, `wrapup.test.ts` |

## What the journal guarantees

The journal is the conversation's existing event log, written through `WorldChatStore`. It inherits that store's per-directory write queue and its flush order (write, sync, close, then acknowledge); there is no second inbox file.

`WorldChatInputJournal` requires the owning world's write and compatibility operations. It checks admission under ownership before raising world schema 121 (initial foundation: 44), so an already invalid command does not upgrade the world, and repeats the check under `ownedWrite` after the boundary and before writing. The newer boundary protects captured model effort and selective Continue routing. A closed or unwritable world admits nothing.

Admission keeps the original submission identity, text, requested delivery and run, constraints, routing and attachment hashes. Explicit model, subject and reply-only selections must match their capture. Inputs start without a turn id. Repeating a submission returns the original durable receipt; changed content under that identity is refused. Each conversation accepts at most ten unresolved inputs, with the existing 16,000-character and twenty-attachment limits.

The append queue and expected log sequence arbitrate concurrent journal instances. A sequence conflict repeats preflight; a disk error is never repeated, because its outcome is uncertain. A duplicate receipt flushes the log again, since a readable line may survive an earlier failed `fsync`, and the store checks for foreign writes before returning one. A torn-tail replacement is synced before it is renamed into place. These are the existing local-filesystem crash guarantees, not a new claim about directory persistence or network filesystems.

Promotion appends one `input.promoted` event carrying the original message, constraints and new primary run. It refuses a changed route, a changed attachment hash or changed attachment bytes, another active run, a reused turn or run identity, a paused queue or a later FIFO input. The prepared run must name the latest conversation sequence, except that the scheduler can admit a pure FIFO tail while preparing: waiting inputs are excluded from context. Any other intervening event still requires rebuilding. Continue records the reviewed route for inputs already present without changing their original capture. Remove keeps history and applies only to never-offered queued input.

Native offer records name the Arke run, turn, native session, execution, input identity and attempt ordinal. Acceptance is separate from inclusion. An uncertain result pauses the queue, and only an exact correlated disposition resolves it. Startup turns unfinished offers into uncertainty and pauses waiting input without calling a harness; it leaves a conversation alone while this process has a live turn on it, and writes nothing to input history it cannot read. Archive and failed-run events also project a durable pause. A new admission never clears a pause.

Queued, accepted and uncertain inputs are not transcript and so are not evidence. Confirmed inclusion adds the original user message once, placed at its offer's position inside the targeted run, so late reconciliation still appears before that run's reply and pages with it. Promotion binds the message to its primary turn. Summaries keep included corrections and promoted messages, including a correction reconciled after its turn or after that turn's summary, without moving the summary boundary past a later unfinished turn. Snapshots omit native session and execution identities and carry every unresolved input plus at most ten settled rows, chosen by when they settled.

Unresolved inputs block conversation deletion and wrap-up. Both lifecycle intents commit against the sequence their preflight read, and admission refuses a durable deletion intent or an unfinished wrap-up intent, which closes the race from both sides. Retry refuses a conversation whose input history is damaged before reading model or constraint metadata from it.

## Running a queued primary turn

`WorldChatRunner.sendQueued` is the execution boundary for a scheduler-selected queue row. It reserves the same conversation slot as ordinary Send before its first read, then checks the queue's own rules (FIFO, pause, routing) before any model work. It rebuilds context and asks the journal to promote the original message, constraints and new run atomically. A refused or failed promotion never reaches session preparation or model dispatch. A Stop before promotion records a durable `stopped` pause, so the next advance cannot start the stopped turn; a world closing cannot be written to, and reopening pauses through recovery. A promoted turn that fails uses ordinary Retry with its captured constraints, never a second promotion.

Routing records the model the author asked for. `null` asks for the default, which the new turn resolves afresh (an agent override or the local default), and a named model is accepted only inside a production. Production setup conversations refuse additional input: their turns go through `ProductionSetupConversationStore`, whose guards a promotion through the plain log would bypass.

`ConversationInputs` shares a short admission gate with ordinary Send and Retry; it never holds the gate over model work. It validates subject and routing before selecting a row and again immediately before promotion. Each completed reply advances FIFO. Failure, unavailable routing, Stop and restart pause the queue; typing or sending another input does not resume it. Continue changes only waiting inputs with the same captured route as the first row, preserving later intentional model/effort choices.

Stop flushes a pause before requesting interruption and the runner retains its slot until the adapter's interrupt promise settles. If the pause cannot be flushed, it still requests interruption and fences advancement in memory until a pause or explicit Continue is durable. This uses the existing adapter interruption contract; it does not qualify native steering or prove native settlement beyond what each adapter reports.

The client retains only its unacknowledged submission and identity in per-window session storage, which survives reload without another window overwriting it. It queries that identity on reconnect instead of resending. A confirmed durable receipt clears only the matching draft; uncertain status leaves both words and identity intact. Closing the window can discard an unacknowledged local draft, while admitted messages remain in the world journal. Authoritative queue state comes from coordinator snapshots and receipts.

Application shutdown closes scheduler admission synchronously and combines the existing runtime
shutdown signal with each runner's world-closing signal. Every observed completion joins the
coordinator's background-work drain, so it settles before supervised processes and adapters are
disposed; completing a primary reply during shutdown cannot start another queued reply.

Known limits owed to later slices:

- Older run failures and archive pauses still use deterministic replay revisions. The active scheduler writes explicit failure pauses for pending input.
- Input history that fails replay blocks Delete and wrap-up (`pending-inputs`), and nothing repairs it yet. A deliberate discard or repair path is needed.
- Full native settlement and steering qualification remain deferred (R-9–R-15, R-32).

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

`adapter-opencode/test/v2-input-protocol.test.ts` launches its own hidden `opencode2` child with an isolated profile and no provider credentials. Admission probes use `resume: false`. A separate writing turn uses a scripted localhost provider to verify configuration, tools, confinement, final text/usage and permission confirmation without a paid request. Measured against **2.2.5**, executable SHA-256 `0c346fdaf519d2f23a31d3b6cb9d65e369a72d77cac6f027b5e0a06376ec3a43` (5 November 2026):

| Observation | Measured result | What it establishes |
|---|---|---|
| Same input id and payload, repeated | HTTP 200; one inbox row | Native admission deduplication |
| Same id, changed text | HTTP 200; original text retained | Replay returns the original input; no content-conflict refusal |
| Pending input cancellation | HTTP 204; inbox becomes empty | Cancellation while still pending |
| Nonexistent `expectedExecutionID` on an idle session | HTTP 200; input admitted | That precondition is not enforced |
| Interrupt on an idle session | HTTP 200; `{ interrupted: false }` | Idle success does not identify a stopped execution |

These do not prove model-input inclusion, completion races, unchanged execution budgets or lost-receipt reconciliation, so OpenCode keeps the queue fallback. The Claude adapter's ordinary SDK input stream is not treated as a steering contract either.

```powershell
$env:ARKE_TEST_OPENCODE2 = 'C:\path\to\opencode2.exe'
cd packages/adapter-opencode; node --import tsx --test test/v2-input-protocol.test.ts
```

A different build needs the measurement repeated; the OpenCode probe asserts the version it was measured against.

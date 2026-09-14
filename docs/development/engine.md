# Embeddable engine foundation

The supported journey is: read a world, propose a character from a sentence, accept or discard the proposal, request a portrait, read a permitted image, reconnect and close. Studio and an external Node host call the same application services. This is the first extraction from Coordinator.

The sentence service stages a sketch using existing sheet authoring. Studio still owns its writing-harness continuation. The public service does not promise to run that harness or produce a finished book.

```mermaid
flowchart LR
  Studio[Studio desktop or dev host] --> Services[World, proposal and illustration services]
  Backend[External Node backend] --> Services
  Services --> Policy[Host authority, content and allowance policy]
  Services --> Sessions[World sessions and authoritative save]
  Services --> Operations[Durable operation store]
  Services --> Queue[Existing job dispatcher]
  Sessions --> Domain[Existing sheet authoring and proposal gate]
  Queue --> Providers[Scoped provider clients and credentials]
```

## Responsibility inventory

| Responsibility | Owner | Remaining limitation |
|---|---|---|
| Settings, secrets, logs, ledger and operation journal construction | `application/studio-composition.ts`, called by `studio-host.ts` | Compatibility Coordinator constructor supplies this composition when omitted |
| Host lifecycle and UI dispatch | Coordinator, desktop main and dev entry | Most commands remain local-only |
| Per-caller world reads and exact media checks | `application/world-sessions.ts` | Host supplies projection and delivery policy; Studio retains its authenticated sole-author transport |
| Sentence proposals, accept/discard and resolution | `application/proposals.ts` | Existing gate owns commits and ripple checks |
| Portrait preparation, reservation and settlement | `application/generation.ts` | Other generation routes remain in their existing modules |
| Scoped world lifetime | `application/local-worlds.ts` or host `EngineWorldRepository` | Materialised folders are not distributed authoritative storage |
| Job state and provider recovery | Existing dispatcher with injected `JobStateStore` | Host must preserve credential, landing and ledger contracts |
| Durable request identity | `EngineOperationStore`; flushed local implementation | Local file assumes one process owns it |
| Remaining Coordinator work | Conversations, productions, Stage, audio/video, release, diagnostics, settings and UI events | Future extractions should follow existing domain modules |

## Public package

`@arke-studio/engine` is an ESM Node package, initially version 0.1.0, requiring Node 22.12 or later. The root exports application services and host contracts. `@arke-studio/engine/local` exports optional folder adapters, filesystem provider, operation journal and existing dispatcher. Neither entry constructs Electron or starts a server.

Build with `npm run build --workspace @arke-studio/engine`; pack with `npm pack --workspace @arke-studio/engine`. Install that tarball into the backend. Do not import coordinator source paths. Registry publication is a separate release action.

The package bundles shared contracts and relevant implementation. Runtime dependencies are Zod and YAML. Native better-sqlite3 is an optional dependency used only by the local filesystem/index adapter. Core-only hosts can install with `--omit=optional`; importing `./local` without SQLite gives an installation diagnostic. Node and SQLite declaration dependencies accompany its types. This is not a browser package. Package separation makes no change to the repository's license.

Consumers should pin a tested version. During 0.x, breaking public contract changes require a minor version bump, consumer tests and migration notes; compatible fixes use a patch version.

## Host construction and authority

Call `createEngine({ worlds, operations, policy, queue })`. All dependencies are required. The policy has no permissive fallback. Studio explicitly supplies its sole-author policy.

The host authenticates requests and constructs `EngineContext`: actor, security scope, executor and subject. Never trust these fields because a browser sent them. A scope is an authorization partition, not a world or subscription. Policy must check the relationship between scope, subject, actor and requested world, including revocation, on each call. Proposal decisions carry a proposal ID; portrait requests carry a sheet ID.

`worlds.read` projects a detached bundle for each caller and checks delivery against its hash. Reconnect calls this method again. It does not replay Studio's global snapshot. `worlds.media` checks artifact identity and hashes the returned bytes; approval for an earlier hash does not approve changed bytes. Its optional sheet ID is forwarded to both authorization and delivery checks; the host must validate the artifact belongs to that scope. Hosts must project held/private artifact metadata out of world reads. A successful job is a candidate, not an accepted portrait or child-safe output.

The generation model is host-resolved configuration, not a browser-provided model description or price. Host admission must inspect frozen requests and current allowance. The queue's clients, credential resolution, admission and authoritative artifact landing are host-owned. Credential resolution receives the durable job, including its engine context, on submit and recovery. Operator provider cost remains in the queue ledger; user allowance is a separate reservation and settlement contract.

## Save, retry and shutdown

A repository callback uses the explicitly named world and must retain ownership through the callback. `saved(operationKey)` resolves only after authoritative state is accepted. Uploading to a temporary directory is not a save receipt. The local adapter's optional `finalise` hook returns only an authoritative save acknowledgement and can delay or reject the receipt. Local snapshots, receipts and preconditions consistently use the materialised bundle's content hash. A host that exposes remote revision tokens must implement that consistently in its own world sessions, alongside authoritative restore and fencing.

Revision preconditions run inside the local write gate for propose, accept, discard and illustration preparation. `EngineWorldSession.illustrations` must check its supplied revision and freeze inputs in the same transaction. Accept can additionally bind the draft revision. External session implementations must preserve those semantics. Local ownership checks are not an atomic distributed fence; issue #468 remains a production prerequisite.

Mutation IDs are scoped by security scope, actor and world. Reusing an ID with different input is refused. Completed operations replay after restart, subject to current permission and content checks. A started operation has an uncertain outcome: its side effects cannot be repeated automatically. The host must reconcile durable save, queue and provider evidence before a separate recovery decision. Never delete a started row to make a retry work.

The operation store's insert-if-absent and completion must be durable and atomic across workers. The local journal validates its envelope, action-specific result and immutable record identity, syncs before acknowledging, and fails closed on malformed records or uncertain appends. It is not a distributed database. Keep it with authoritative operational state, separate from disposable caches.

Reconciliation validates the recorded subject and full resource, including its sheet, before delivery or allowance changes. Artifact policy checks retain that sheet identity. A different executor may resume work but cannot substitute another subject.

Portrait reservation precedes enqueue. Interrupted or partially enqueued batches retain their reservation and need reconciliation. Admission results preserve confirmed job IDs, per-request failures and an explicit needsReconciliation flag, including after replay. A completed operation record means the admission result was saved, not that every request succeeded; they cannot release funds while provider work may exist. The existing queue retains persist-before-submit and unknown-provider-outcome recovery. Terminal reconciliation reads every landed artifact and applies delivery policy to its actual bytes. Missing, unreadable or unapproved artifacts hold settlement. The approved artifact IDs and SHA-256 hashes accompany each job in the durable charge/release decision and the host settlement call. Both host calls must be idempotent by operation key, including when their response is lost. Unavailable or refusing output checks hold settlement until policy permits it; they do not release an outstanding reservation. Later policy changes may withhold delivery but cannot reverse an already recorded financial decision. A settled response reports `jobIds` from that durable financial decision and `deliverableJobIds` from the current output checks; those lists can differ. Missing queue evidence before a settlement decision returns `needs-reconciliation`, never perpetual `pending`. Existing settlement decisions can still finish after queue rows are removed.

The filesystem provider serializes world selection and scoped callbacks so navigation cannot close a store still in use. A scoped callback must use its supplied store and must not recursively select or open another world through the same provider.

The host owns queue lifecycle. Stop external admission, stop queue admission, drain or dispose provider work according to the queue contract, call `engine.close()`, then close a shared filesystem provider. Engine close rejects new calls, waits for active service work, drains operation state and closes its repository. It does not dispose a supplied queue. If cleanup fails, another `close()` retries draining and repository cleanup while admission stays closed; host cleanup adapters must be idempotent.

## Validation and remaining work

Coordinator `test/application/engine.test.ts` exercises the real filesystem gate, supplied policy, durable operation state and existing dispatcher: caller isolation, save refusal, duplicate replay, torn state, held bytes, settlement response loss, stale revisions and shutdown. Overlapping batches retain separate operation-keyed landing paths. `test/application/studio-lifecycle.test.ts` checks serialized world opens and failed shutdown after engine closure. Existing gate, ownership, transport and queue suites retain deeper regression coverage.

`npm test --workspace @arke-studio/engine` builds, packs, installs into an OS temporary directory outside the monorepo, executes the journey and typechecks an external consumer. It uses a deterministic provider and requires registry access for declared dependencies. CI runs it on Windows and Linux with the workspace tests. No paid generation is involved.

These tests establish an application boundary and simulated recovery behavior. Production hosts still need authoritative restore/finalisation, atomic fencing (#468), scoped secrets, real content policy, idempotent allowance accounting and operational recovery procedures. Aonik adapters, commercial workflows, monthly scheduling, printing and interactive episodes remain outside this package.

## Coordinator extraction toward a server host (epic #1182)

The first authoring extraction is internal to Studio. It does not expand the public engine API
or establish cloud authorization and storage guarantees.

| Responsibility | New owner | Still supplied by Studio |
|---|---|---|
| Validate conversation context, start/retry a turn, cancel production setup | `application/conversation-authoring.ts` | Authorized open store, cached runner and optional naming pass |
| Assemble writing sessions, leased retrieval, chapter/setup briefs, receipts and validation | `application/conversation-runs.ts` | Harness adapter, session configuration, query endpoint, model/research policy, action adapters and operator notifications |
| Open a prose workspace with its derived records; create/save/edit/restore/retire chapters | `application/prose-authoring.ts` | Authorized open store, request/result events, snapshot sequencing and save draining |

Coordinator keeps runner identity across commands, maps progress and results to Studio events,
and owns shutdown. Existing `world-chat/run.ts` remains the durable turn state machine;
`productions/ops.ts` and the proposal gate retain write and history rules. Direct chapter saves
do not become proposals or cut a new accepted version. Generated chapter proposals still use
the existing explicit acceptance path. The authoring service returns a completion promise so
Studio can publish a running turn before waiting for the model; optional naming never delays
the reply.

Regression baseline: `test/application/conversation-authoring.test.ts` covers the extracted
boundary, scratch/lease cleanup, rejected contexts, chapter grounding and stale-save/reopen
behaviour. Preserve the existing world-chat run, retry, cache, recovery and chapter/proposal
suites. Model quality and production cloud persistence are not demonstrated by these tests.

Next, move the remaining production creation/action orchestration behind scoped services and
add the public authoring contracts, durable operation/save outcomes and external consumer proof.
Only then consolidate the Studio server host: Electron-managed or standalone Node startup,
using the existing authenticated transport for desktop and browser clients. Kidz embeds the
engine in its own Node server and supplies its private product and Aonik integrations.

### Production creation and permission-card composition

`application/production-creation.ts` now owns the legacy local creation request reservation,
committed-slug lookup and domain creation call. Its commit notification lets Studio publish the
new world before acknowledging success; duplicate admission stays reserved until that callback
finishes. Coordinator maps outcomes to correlated events. The existing creation journal and
request-ID semantics are unchanged: this is not the durable, scoped public authoring API.

`application/conversation-actions.ts` composes the existing permission-card authority adapters
for both live decisions and recovery. Supplied adapters replace a default of the same kind.
The service moves its authority path after archival before notifying the host, preserving
terminal writes in the moved world even when publication fails. Coordinator supplies platform
callbacks and publishes UI state; `arke-actions/lifecycle.ts` remains the sole decision and
recovery state machine. There is no new permission journal or decision protocol.

Regression coverage includes `test/application/production-actions.test.ts`, production creation
acknowledgements, and the existing action lifecycle/coordinator/recovery suites. Production setup
continues to use `productions/setup-command.ts` and its reviewed creation path. Public authoring
contracts, scoped durable operations and the server host remain future work under #1182.

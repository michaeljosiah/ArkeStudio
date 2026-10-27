# Running and validating changes

Managed writing recovery (#2194) uses coordinator `test/recovery/harness.test.ts`,
`test/harness-runtime-change.test.ts` and `test/v2-launch.test.ts`. The native fixture assembles
the actual launcher with a protocol stand-in, starts the production host, crashes its child,
waits behind an admitted turn and reads flushed recovery control. It verifies no turn replay,
Suggest only, personal-path refusal with a retained circuit, cancellation before shutdown drain,
retained failed health/native-stop retry and runtime protocol refusal despite discovery metadata.
These tests need native filesystem/process access and make no paid request. The optional pinned
runtime check in `v2-launch.test.ts` is separate; a fixture is not a live-model qualification.
`test/harness/model-routing.test.ts`, `test/supervisor.test.ts` and
`test/application/studio-lifecycle.test.ts` cover the existing routing and lifecycle contracts.

Recovery `test/recovery/supervisor.test.ts` additionally injects early timer wakes and frozen/
reversed clocks. Recovery waits out the existing flushed intent's minimum deadline, with at most
eight wake checks, without creating another attempt or weakening `begin()` validation. The native
ComfyUI profile test exercises the same handover/restart path that exposed an early-wake CI failure.

The native writing fixture also accepts a prompt through the real adapter and exits without
emitting a terminal stream event. Confirm the local unknown-outcome event releases its turn wait
before automatic replacement, including Suggest only without replacement, with exactly one
persisted prompt marker. Credential rotation during replacement startup must confirm the old
child's exit and settle retained recovery before starting again; it cannot strand the writing fence.
`test/recovery/voxa.test.ts` uses the production host, actual Voxa client and a native protocol
stand-in to verify cancellation without replay, policy/personal ownership, compatible running
health and failed reconfiguration retaining its native handle/reservation until confirmed cleanup.
Voice package `test/recovery.test.ts` additionally drains queued synthesis, transcription and body
reads, checks reservation cancellation/disposal, and prevents WAV preprocessing from crossing a
cancelled request generation. These fixtures qualify lifecycle/protocol behavior, not live model
quality or real Voxa model loading. Run package typechecks after the final test edit.

Proactive storage service checks (#2194) use contracts `test/storage-health.test.ts` and coordinator
`test/storage/*.test.ts`. Run coordinator checks with native Windows process/filesystem access:
the volume fixture exercises a real directory/junction pair through the kernel-leashed reader,
and reservation persistence uses flushed atomic replacement. Capacity, quota, ENOSPC, forecast,
concurrency and shutdown faults are injected; no test fills a real volume or removes creative media.
The Windows native fixture is skipped on other operating systems. `test/storage/linux-volume.test.ts`
checks device sharing across bind aliases, escaped mount points, identity/remount changes,
unsupported/read-only filesystems, unsafe capacities, bounded metadata, coalescing and slow-read
abandonment without overlap. Its real directory/symlink fixture runs only on Linux and explicitly
reports unsupported filesystems; synthetic tests on Windows do not establish Linux qualification.
The Linux port qualifies ext2/3/4, XFS and tmpfs, with user/project quota limits disclosed as unknown.
Native filesystem syscalls may outlive the four-second observation deadline; one retained chain
blocks replacement until actual settlement and cannot publish late. Shutdown abandons observation
without creating a child process. macOS and other Linux filesystem ports remain outstanding.
`test/storage/application.test.ts` additionally starts the actual host/coordinator,
opens a disposable world, wakes collection and checks the authenticated reconnect snapshot and
journal exclusion. Client `test/storage-health.test.ts` checks the matching fold; contracts
`test/storage-diagnostics.test.ts` covers pure findings, stale/unknown facts and typed failures.
These checks establish observation and Diagnostics composition; write-path protection, recovery
and visual parity with approved turn 239 require separate end-to-end acceptance.
`test/storage/setup-files.test.ts` now runs two real streamed file installers against one shared
volume, verifies the second makes no request while held, and sends authenticated production-host
Install/Retry commands against a competing owner's intent. It checks known-length growth before
body reads, transport cancellation, bounded unknown-length responses, valid-prefix retention and
explicit ranged Resume with only the remaining byte reserved. Unavailable qualified native capacity
cannot start a transfer. `monitor.test.ts` covers post-report admission through the one-second
coalescing floor and cancellation on stop. `reservations.test.ts` bounds stalled read/save shutdown
and refuses late grants while retaining uncertain intent on reopen. Runtime-owned pull phases, other
landing/scratch/export/import owners and restart reconciliation still need their own acceptance.
The production-host file fixture additionally stalls progress-accounting persistence while a real
partial-file handle is admitted, quits with that save still blocked, verifies bounded shutdown and
the exact retained checkpoint, and refuses late grants after the old write finishes. Completed
existing files in a partly missing component must remain exact and consume no second reservation.
The mounted-destination fixture keeps a published file on a full volume while downloading a missing
file to a different volume. Reservation/replan fixtures invalidate another owner's capacity during
a blocked flush, refresh it, then verify the old grant stays revoked and its intent remains uncertain.

Setup native ownership checks use `test/setup/process.test.ts` and
`test/setup/host-process-cleanup.test.ts`, with native process/loopback/filesystem access. They run
literal disposable commands, hold the ownership gate, observe a helper surviving its command's exit,
bound output, cancel and confirm exit, retain an unconfirmed process, then confirm it without replay.
Windows additionally force-kills a disposable host and verifies kernel cleanup of its command/helper.
The production host test refuses setup cleanup, verifies other native owners still stop, and keeps
minimum storage/control settlement open until the cleanup retry. `local-setup.test.ts` checks held
leases/staging, silent/interactive installer refusal, Stop/dispose, read-only listing and removal.
Ordinary POSIX process-group behavior still requires Linux CI; deliberate daemon escape and complete
runtime-owned pull space planning are outside these checks. Run affected typechecks after the last test edit.

`test/storage/setup-archive.test.ts` runs the actual owned tar reader/extractor with tiny pinned
archives through tree and single-tool setup. It checks shared expansion reservations against a
competing file owner, changed expansion before native writes, unknown metadata, held native cleanup,
and one complete UUID checkpoint reused only by explicit Resume without HTTP. Activation occurs
after process and reservation settlement. `test/setup/archive-manifest.test.ts` covers supported
numeric GNU/BSD prefixes, unknown/device records, arithmetic/line bounds and native metadata without
extraction. Metadata mode retains no member output and has separate total-byte/entry/time bounds.
Already-cached checksum-pinned Windows ComfyUI/Ollama archives have also been read without extracting
them or downloading another runtime: expansion estimates were 4,910,957,043 and 2,231,700,495 bytes.
Both pinned CLI architectures were checksum-verified and inspected, establishing its 26 MiB peak
declaration. These estimates do not guarantee available space throughout extraction. Linux CI and
first-run native application acceptance remain distinct; other write owners and reconciliation remain.
Observation regressions also change mapping/capacity or fail a native read during a pending flush,
without calling explicit invalidation, and verify the grant is revoked with uncertain intent retained.

Recovery control tests (#2194) use contracts `test/recovery-policy.test.ts` and coordinator
`test/recovery/control.test.ts`. They inject crash/unknown writes, competing attempts, rolling
budgets, clock reversal, deliberate Stop/Suggest only, target changes during flush and shutdown.
Native filesystem access is needed for atomic control-file replacement. These establish the
durable gate. `test/recovery/commands.test.ts` checks flushed policy/presentation receipts,
held retry controls and failed persistence. `history-application.test.ts` sends the commands
over the authenticated host socket and verifies disk state and journal exclusion;
`remote-access.test.ts` refuses them through the real paired-device gateway. Contracts
`test/recovery-settings.test.ts` closes their argument schemas. Client `test/recovery-controls.test.tsx`
checks receipt correlation and the summary-clear confirmation, while `recovery-history.test.tsx`
checks notice mute/replay and read-only Activity navigation. Desktop `background-notifications.test.ts`
checks the separate opt-in, generic copy, focus, shutdown and Activity-only click.
`recovery/history.test.ts` traverses all 1,000 retained incidents with non-dividing page sizes,
checks stale filter/source/page-size cursors and labels failed persistence in memory. Client
`recovery-history-browser.test.tsx` checks pagination, stale reads, correlated snooze and remote
read-only controls. `recovery/export.test.ts` exports all retained summaries and poisons future
fields to verify enumeration plus the existing secret/path boundary. The authenticated host
fixture stalls a preference save while an actual owned child is running, then verifies bounded
shutdown confirms native exit without acknowledging an unconfirmed save. The supervisor fixture
ages attempts across a long live session, then exhausts the actual rolling window.
The host fixture repeats a blocked mode save: the authenticated command must end unconfirmed,
native exit must complete while the file write stays blocked, and no late saved receipt may appear.
Control faults cover a stalled read/authority write, bounded owner settlement behind that write,
no subsequent queued mutation, and unknown intent/attempt retention across reopen. A recovery-port
check releases a retained lease only after its owner confirms native cleanup, even if the control
writer remains unavailable; it does not turn that cleanup into fresh startup permission.
`test/recovery/supervisor.test.ts` additionally uses real native children to check
GPU waiting, verified replacement, queued startup exits, cancellation, policy/ownership refusal
and retained unhealthy processes. `test/recovery/application.test.ts` starts the actual host and
managed Ollama owner with a protocol fixture, verifying its flushed outcome and persisted policy.
It also updates an installed runtime through the real command with a tiny pinned archive, proving
setup owns the inference reservation and activation. `test/recovery/comfyui.test.ts` exercises
production-host recovery, isolated profile budgets, queued handover, personal-path refusal,
early shutdown fencing and failed native cleanup/reporting/retry. A blocked authorization flush
checks that clean shutdown settles its unstarted intent while preserving the spent attempt.
`test/setup/local-setup.test.ts` checks the file-change lease through writes/rechecks, failure and
release before activation. `test/ollama-engine.test.ts` checks retained installation reservations
after unconfirmed cleanup and release only after owner-confirmed stop. These establish the Ollama/ComfyUI paths, not other recovery owners, reviewed
interruption actions or successful inference. `test/job-leash.test.ts`
also verifies shared storage-reader job reuse and kernel cleanup on forced parent death on Windows.

Incident checks (#2194) use contracts `test/recovery-incidents.test.ts`, coordinator
`test/recovery/history.test.ts` / `history-application.test.ts`, and client
`test/recovery-history.test.tsx`. Faults cover notification admission before delivery, a newer
observation/mute during a write, restart identity and budget, lost scope/stale measurements,
two-reading capacity recovery with remounts, current engine identity, history caps, disk-full,
malformed/oversized files and shutdown drain. Stalled diagnostic reads/writes bound shutdown waiting and
report unavailable audit state; an already-issued atomic replacement may finish, with no further
batch or notification admitted. The native application fixture demonstrates a disk
warning before opening a world, one persistent incident and an authenticated reconnect snapshot;
history/notices never enter the world journal. Client checks prove muted warnings stay visible
and Review only navigates without a mutation command. These checks do not establish OS/toast
delivery, all lifecycle adapters, host policy commands, or final Studio visual parity.

Managed local runtime checks are listed in [Managed local runtimes](managed-local-runtimes.md#validation).
Use native Windows process/loopback access for the supervisor, Ming cancellation and file-handle
fixtures; sandbox IPC refusals do not establish an application regression. Model qualification
is offline and separate from these lightweight native lifecycle tests.
The [Ming integration checks](managed-local-runtimes.md#validation) cover complete model installation,
voice reference words, queue identity, chunking, controlled refusal and packaged worker resources.
The standard-library worker checks run with `python -B scripts/test-ming-worker.py`; CI's Node tests
exercise the host seams without model downloads. Native tests must also check confirmed process
exit and GPU-lane release; a returned WAV alone does not prove a complete reading.
`test/ming-process.test.ts` uses the real gated native executor with a lightweight Node fixture:
the same Python command preparation, stripped environment, private working directory and log,
ordinary helper surviving parent exit, failed cleanup retention and later GPU confirmation.
`test/local-gpu.test.ts` also proves a newly authorized reading confirms retained cleanup before
submission, never replays the old reading, and stays held after another failed confirmation.
These fixtures require no model download and do not establish narration/inference quality.

Baseline regression checks (#2079) use client `test/art-direction-step.test.tsx` and
`test/one-register.test.tsx`, contracts `test/world-chat-shape.test.ts`, and coordinator
`test/productions/audiobook-video.test.ts` / `test/world/store.test.ts`. Keep empty and accepted
location fixtures distinct; assert visible cast status without forbidding extra attributes.
Video-cache coverage needs two fully read manuscript chapters and an incomplete one, verifies
actual encode calls, then renders again without another encode. An outline-only fixture is not
a narrated chapter. Future-schema refusal must use the current supported version plus one and
preserve every world file, including pending rollback and roll-forward journals. Run coordinator
`test/world/ownership.test.ts` and `test/world/crash.test.ts` when changing that admission check;
supported recovery still runs under ownership before the scan. Keep the shape guide below its existing bound with all schema-owned
examples, typed fields, receipt rules and approval requirements intact. Run the full affected
files and package typechecks, and inspect Windows and Linux CI results.

Chapter authoring freshness (#2065) uses coordinator `test/world-chat/retrieval.test.ts`,
`actions.test.ts` and `chapter-brief.test.ts`. Read the complete `list_chapters` plan scope,
then advance another chapter's narration and approve a status-only edit. The manuscript must
remain exact. Prose, metadata, membership and order changes still refuse; full inventory and
full target reads still fence derived records. Partial, foreign and inappropriate scoped
receipts must not authorize actions. Native acceptance repeats authoring plus narration on
a disposable world through public commands; simulated summary changes alone are not that proof.

Canonical picture clothing (#2069) uses coordinator `test/productions/audiobook-picture-brief.test.ts`
and the existing `audiobook-picture-suggest.test.ts` / `audiobook-picture-only.test.ts` paths. Check
that a named other person wearing an outfit or handling their explicitly own clothing does not
suppress the depicted person's main-photo appearance. Keep warnings for unresolved garment
possessors (including a named actor removing her/his/their outer layer), ambiguous names, compound
clauses, the depicted person's own changes/removals, missing references and selected kit looks.
This advisory check neither rewrites historical checks nor establishes semantic wardrobe ownership.

Explicit chapter drafting (#1928) uses coordinator `test/world-chat/chapter-draft.test.ts`,
`chapter-brief.test.ts`, `run.test.ts`, `input-journal.test.ts` and `test/application/writing.test.ts`,
plus client `test/chapter-workspace.test.tsx`. Verify that the drafting presses require one complete
manuscript action, ordinary questions remain conversational, and advice gets only the existing
single corrective attempt. A drafting press must flush pending prose, wait for the latest save
acknowledgement, and cancel its queued request after a refusal or disconnection. Queued promotion,
reopen and explicit retry must retain the drafting
intent; full current-manuscript reads share the leased context budget. Native acceptance uses a
disposable Undersong copy: draft through the public command or chapter press, inspect the pending
proposal, accept and reopen, preserving unrelated plan fields and completed media. Compare the
unchanged chapter and global Chat composition at phone/tablet/desktop with master turn 227 revision
4 (227u/v/y) and turn 225. These checks do not establish the literary quality of generated prose.

Long conversation drafts (#1927) use coordinator `test/world-chat/turn-result.test.ts` and
`run.test.ts` and `summarisation.test.ts`, plus client `test/chat-reply.test.ts` and `chat-read-replies.test.tsx`.
Check exact retained/reopened text beyond 8,000 characters, strict whole-result validation,
chapter and paragraph display boundaries, and full-message Copy/Listen while paging.
Summary batches must fit the selected session's budget, retain every manuscript character,
and checkpoint only after all batches succeed; test cancellation and a later-batch failure.
Compare full-App phone/tablet/desktop light/dark captures with master turns 164 and 225;
check focus at each new part, sticky navigation/composer clearance and enlarged text.
Native acceptance additionally needs a real long writer reply and a reopened conversation;
scripted persistence and fixture rendering alone do not prove that workflow.

Coordinator import-order regressions (#2057) use
`node --import tsx --test packages/coordinator/test/productions/audiobook-grouped.test.ts`
from the repository root, without pre-importing Coordinator. Also run coordinator
`test/world-chat/attachments.test.ts` and `test/artifacts/artifacts.test.ts`; the former
loads artifact filing first in a fresh process and checks that chat retains the same
extension inventory. Check supported Node 22 as well as newer local runtimes; a passing
Windows run does not establish Linux success.

Prop library binding (#1921, SPEC-041 R-9/R-87..R-91) uses coordinator
`test/world-chat/retrieval.test.ts`, `actions.test.ts`, `action-guide.test.ts`,
`shape-drift.test.ts` and `test/references/prop-state.test.ts`; contracts
`test/prop.test.ts`; client `test/props-screen.test.tsx` and the shared reference-picker
consumer tests. Check exact record reassembly, complete scoped receipts, changed targets,
image bytes and reference changes, retired/superseded images and immutable take history.
Native acceptance additionally requires a real writer-prepared prop-image card, approval,
an explicit library replacement and reopening the world to verify all prior take bytes.
Compare full-App phone, tablet and desktop captures in light/dark with master turns 69
and 105f, including long filenames, reachable confirmation and native upload. A phone
capture uses browser composition, not Electron below its minimum window width.

Retained World Chat drafts (#2048): run coordinator `test/world-chat/retrieval.test.ts`,
`turn-result.test.ts`, `shape-drift.test.ts`, `run.test.ts`, `context.test.ts`, `action-guide.test.ts` and
`test/world/schema-version.test.ts`. The retrieval regression reopens location, character and
faction drafts beyond the visible message window, rejoins every page and compares exact sections,
metadata, evidence and group membership. It also checks revision/group changes between pages,
foreign cursors, unavailable hosts, world switches and the shared text budget. Turn validation
requires an exact final current-run draft receipt for updates, splits and duplicate creates;
it preserves unchanged historical source citations while still checking new citations and
refreshing world checks. Native validation
must additionally create and later revise those propositions through the configured writer;
scripted journal tests alone do not establish that workflow.

World Chat phone notes (#2050, SPEC-001 R-7) use client
`test/world-chat-phone-notes.test.tsx` alongside `world-chat.test.tsx` and
`world-chat-fidelity.test.tsx`. The hydrated regression covers empty and populated notes,
final-point ripple dismissal and wrap-up refusal without writing or deciding an action.
Review the full App at 320/390, 820 and 1440 in light/dark against master turns 164 and 225:
long cards, 20px prose, direct heading scrolling, offscreen keyboard focus, held-composer
clearance and a draft retained on return. Phone evidence must use a browser, not a native
Electron viewport below its minimum. These rendered checks are separate from the DOM test.

Story download recovery (#1950, SPEC-016 R-6): contracts `test/story-download.test.ts` covers
space arithmetic; coordinator `test/world/story-download.test.ts` covers pinned ranges,
whole-archive verification, cancellation, restart, changed releases, low space and cleanup.
Multipart cases also cover part-relative ranges, boundary and partial resume, ignored Range,
per-part corruption/size limits, untrusted descriptors and aggregate progress/space.
`test/world/story-release-parts.test.ts` verifies the packager's ordered slices reconstruct
the unchanged ZIP and refuses unsafe sizing or existing output files.
`test/application/story-install.test.ts` checks the public commands and admission/lifecycle
boundary; `test/remote-access.test.ts` rejects host-only commands at the gateway. Client
`test/story-download.test.tsx` and `test/settings-responsive.test.tsx` cover visible recovery
states and the shared Settings layout. Run each from its package using `node --import tsx --test`.
For native acceptance, use an isolated app root and the real pinned release: cancel, quit,
restart, resume, reopen the installed world and remove another retained download. Keep these
large downloads out of automated fixtures. Review full-App captures at 320/390, 820 and 1440
in light/dark against master turns 150a and 175a/c, including 44px coarse-pointer controls.

Audiobook header layout (#2041, SPEC-001 R-7) is measured by client
`test/audiobook-show-layout.test.tsx` using the full stylesheet cascade and a long production
title. Set `CHROME_PATH` if Chrome is not in a standard location. It checks touch browser widths
640/820 and desktop caption clearance at 1024/1440 (requested window sizes; assertions use
the measured viewport, which excludes platform decorations). Separately review the hydrated App at
320/390, tablet and desktop in light/dark, including keyboard activation and enlarged text.
A phone browser has no `.is-desktop` class: shrinking Electron's renderer below its native
1024px minimum retains 138px for Windows captions and is not a phone-browser test. Compare
master turns 159 and 225 for shared chrome, alongside 199 for the audiobook composition.

Character sheet layout (SPEC-001 R-7, master turn 161) uses
`node scripts/smoke-cast-layout.mjs` and the same command with `--reading`.
The first compares the prose column with the approved Fold frame; the second checks short and
long sheets from 320 through 1536 px, including enlarged text and scrolling below navigation.
Inspect the full-page phone, tablet and desktop captures alongside the applicable master.
Containment and reachable controls alone do not establish visual fidelity.

Story PDF publishing (SPEC-058) uses contracts `test/story-publication.test.ts`, coordinator
`test/publications/story-pdf.test.ts`, `test/publications/story.test.ts`, `test/publications/story-routes.test.ts` and
`test/story-pdf-runner.test.ts`, client `test/story-pdf.test.tsx`, `test/manuscript.test.tsx`
and `test/chapter-workspace.test.tsx`, plus desktop `test/story-publication-file.test.ts`.
Run these with `node --import tsx --test` from their respective workspace directories.
After `npm run build`, run `node apps/desktop/scripts/smoke-story-pdf.mjs`: it copies the built
worker/fonts outside the checkout and creates a real Unicode PDF without resolving development
dependencies from the repository. Run desktop `npm run smoke:main --workspace @arke-studio/desktop`
and `npm run verify:licenses --workspace @arke-studio/desktop` for packaging/asset changes.
The focused cases cover exact preview/create bytes, old formats, damage/Locate, cancellation,
timeout, captured-input retry and font/navigation/text fidelity. Actual browser worker/text-layer
rendering and every-page visual inspection of a long book are separate acceptance evidence;
passing extraction or mocked UI tests does not establish them. Keep private manuscripts and
their generated pages out of committed fixtures.

PR #1886 review regressions also exercise running-header fallback glyphs, nonbreaking-space
ToUnicode mappings, exact chapter destination coordinates, three-line paragraphs with scene
breaks, and draining phase writes on cancellation/timeout/worker failure. Coordinator
`test/remote-access.test.ts` checks the actual gateway's `.mjs` GET/HEAD MIME and nosniff headers,
so the preview fixture's own static server cannot conceal an unsupported module-worker response.

From `packages/client`, run `node --import tsx test/story-pdf-preview-smoke.mts` for the real
Chrome preview, then repeat with `--electron` for a sandboxed Electron file page. These use
synthetic Unicode content, the production content-security policy and the bundled PDF worker
at 1100, 390 and 320 px. They check authenticated loading, selectable text, keyboard navigation,
zoom and rapid page changes. The harness prints its evidence directory; Electron captures the
rendered page canvas, while Chrome captures the full preview controls. Neither attaches to the
installed app or opens a private world.

Shared media evidence: from `packages/coordinator`, run
`node --import tsx --test test/media/agent-media-tools.test.ts test/media/agent-speech.test.ts test/world-chat/media-inspection.test.ts`.
The first file uses real FFmpeg stereo and VFR fixtures; set `ARKE_AGENT_MEDIA_NATIVE_REQUIRED=1`
to fail when FFmpeg is unavailable, and optionally set `ARKE_FFMPEG`/`ARKE_FFPROBE` to host binaries.
Contract coverage and original-channel arithmetic live in `packages/contracts/test/agent-media.test.ts`.
`test/agent-audio.test.ts` covers script bounds. Speech tests exercise canonical multi-track
extraction, exact bytes through the Voxa protocol, word/source/view times, script wording diffs,
bad recognition, abort/late results, leases, budgets and schema-80 replay. The recognizer is a
deterministic fixture: these tests do not establish live model accuracy or perceptual listening.
Existing image, leased MCP, replay and take-review suites remain required regressions.

Global Chat (master turn 225, approved as turn 224 revision 6; restored/amended model turn 195)
uses client test/global-chat.test.ts for scope/draft/transcription/recovery and the existing conversation suites.
Build global-chat-224.native-build.mjs, then run global-chat-224.application-check.mjs with
fine pointer and --touch for the actual App lifecycle, overlays, scoped send and simulated keyboard.
The bridge and media are deterministic fakes; installed microphone/codec/Voxa and physical keyboard
acceptance remain host checks.

Shared composer/model layout
uses `test/composer-row-layout.test.tsx`, `test/composer.test.tsx`, `test/model-picker.test.tsx`
and `test/harness-model-controls.test.tsx` from the client directory. Full-App checks for
World Chat (#2051) include 320/390/820/1440 light/dark, empty/multiline drafts,
long fixed model labels, notes present/absent, attachment/read controls and keyboard clearance.
Its browser regression uses 296/366/747px composer boxes inside an 820px viewport to exercise
the shared rows and the <=1099px World Chat cascade; this is separate from full-App captures.
The whole-page design
verification commands are in `design-system/global-chat-224.notes.md`: build the native and
master readers, then run `global-chat-224.parity-check.mjs` with mouse and `--touch`.
They compare matching native/master specimens and measure empty/multiline drafts, clipping,
overlap, at least 8px above/below toolbar controls, icon centring, centre hit targets and picker bounds. A negative control reproduces the original
desktop screenshot regression. Reports are local `.dev/` evidence, not agent/coordinator
acceptance. The author approved implementation on 2026-10-13.

Production Chat end-to-end acceptance (#1427, SPEC-051 R-1..R-3) uses coordinator
`test/world-chat/production-acceptance.test.ts`. The same thirteen-step scenario runs with
stub providers and either an injected encoder or real FFmpeg/FFprobe; CI retains the native
film, subtitles and per-card approval/spend report on Windows and Linux. See the
[acceptance guide](production-chat-acceptance.md) for commands, coverage boundaries and the
remaining installed Windows real-provider journey. Queue `test/queue/dispatcher.test.ts`
also checks retryable Bench score filing without a second purchase.

Production readiness (#1422, SPEC-051 T-9) is covered by contracts
`test/production-readiness.test.ts` and `test/world-chat-shape.test.ts`; coordinator
`test/world-chat/production-readiness.test.ts`, `retrieval.test.ts`, `turn-result.test.ts` and
`run.test.ts`, plus native `test/productions/drawn-frame.test.ts`, `interactive.test.ts` and
`manuscript.test.ts`; and client `test/production-plan-card.test.tsx`. These check accepted
image slots, beat pictures/text/routing and scanned traversal evidence, saved book prose,
audible voice placements, base picture placement and unmuted subtitles. Full production
exports carry the captured source fingerprint; changed sources and unstamped old exports
cannot prove current delivery, including after restart. Coverage also includes complete fenced reads,
stale checklist refusal, suggestion-only persistence at schema 60, restart reconstruction,
and live checklist rendering without Approve. `test/productions/export-receipts.test.ts` checks
immutable world-owned completion receipts, malformed/partial delivery refusal and read purity;
it also checks legacy and saved-timeline native video completion after receipt persistence;
the manuscript coordinator test recovers delivery after the app diagnostic log is removed and
refuses to report done when receipt persistence fails. `dialogue-timing.test.ts`, `render-plan.test.ts`
and `rehearsal.test.ts` cover the shared current placement validation and covered-line walk.
Readiness regressions also exercise Stills without Cut, routing for every branching format,
bounded current-choice traversal summaries and status-only plan snapshots while percentage
events continue normally. Stills require no unsupported full-production export, branching formats
require an interactive package, display/dispatch metadata does not stale delivery, and first export
timestamps keep paging fences stable. The client card skips derivation across percentage-only
store updates. Run client tests from `packages/client`.

Production whole-cut chat (#1420, SPEC-051 T-7) is covered by coordinator
`test/world-chat/actions.test.ts` (the `production whole cut` suite), contracts
`test/timeline-commands.test.ts`, and client `test/timeline-card-history.test.ts`.
They exercise approval-only ordered assembly, exact history and stale cards, typed overlay
split/rejoin with independently edited audio retained, local transcription quotes with no
pre-approval STT calls, changed bytes, cited subtitle drafts, and direct human Undo/Redo
matching. The suite also refuses overlay windows beyond measured video, undoes/redoes rejoin
with its empty split track removed, and cleans failed transcription files only after a durable
failure, including restart cleanup without another speech call. The contracts test replays placement into a remembered tail hole through both
history stacks. Run client tests from `packages/client`. Installed-app and real Voxa
acceptance remains #1427.

Production sequencing (#1417, SPEC-051 R-14..R-17) is covered by contracts
`test/turn-action-sequencing.test.ts` and coordinator `test/world-chat/actions.test.ts`,
`turn-result.test.ts`, `generation-quotes.test.ts`, `production-generation.test.ts` and
`test/productions/scene-commands.test.ts`. The cases cover fixed new-shot identities, blocked
and denied parents, interrupted binding recovery before/after parent approval, schema-54
reader refusal, prospective generation without dispatch, stale parent results, single-version
atomic batches and combined selection cleanup. These tests use scripted actions and fake
admission ports; the installed-app journey remains a separate acceptance check.


Conversation image inspection (#1409) is covered by coordinator `test/world-chat/images.test.ts`
(leased scope, cloud privacy, durable disclosures and byte receipts, key art/candidates/kits,
prop states, artifacts, Bench takes, GIF/MKV codec delivery, cancellation, encoded payload
budgets and bounded metadata-free PNGs), `fold.test.ts`, `run.test.ts` and
`retrieval.test.ts`, and the three vision adapters' `test/adapter.test.ts` input cases. Client
`test/world-chat.test.tsx` verifies the notice before the reply. These are scripted tests and
do not claim live model comprehension. Desktop supplies the bounded ffmpeg rendition maker;
headless hosts may supply the same port, otherwise the fallback reads bounded non-interlaced
8-bit PNGs and explicitly refuses codecs it cannot decode. A text-only or unknown model must
refuse inspection without guessing image contents or raising the world schema.
Desktop `test/take-qc.test.ts` verifies that the shared media runner kills an active subprocess
when its owning turn aborts. Receipt projections deduplicate source identities and retain the
newest 256 entries; the append-only journal retains the complete byte audit.

Production take inspection (#1414, SPEC-051 R-43) uses `list_takes`'s copyable `imageSources`
and the `production-take` arm of `view_image`. A frame take supplies its produced image; a
video take supplies one poster, seeking to the recorded in-point for a pass segment. Its
optional start-frame source names the take's frozen seeding frame, never the shot's current
selection. Coordinator `images.test.ts` checks discovery, pixels, segment positions and
refusals; `actions.test.ts` checks that the card's reason counts only current bytes served to
its own completed turn. A receipt from another turn/run or a changed image leaves the reason
metadata-only. These remain scripted model tests; the codec smoke uses real ffmpeg bytes.
Original media checksums are recorded on new generated, uploaded and Bench-filed production
takes at schema 54. Legacy takes without a frozen hash remain metadata-only; current probe
sidecars are not a substitute for original identity. A start frame must match the artifact ID,
path and hash frozen in `params.frameArtifact`. Production video inspection streams a verified
private file snapshot (4 GiB scratch ceiling, eight-second verification budget) into the bounded
decoder, rather than using the 50 MiB image-input allocation ceiling. The image suite includes
a 52 MiB source and verifies snapshot cleanup; take arrival tests verify original hashes and
the schema-53 reader refusal.

Use Node 22.12 or later; CI uses Node 22. Run `npm ci` from the repository root. See [CONTRIBUTING.md](../../CONTRIBUTING.md#getting-set-up) for browser development and its authenticated session link; `npm start` builds and starts desktop, including its native rebuild.

Frozen production previews and turn approval (#1425) use client `test/production-card-body.test.tsx` and `test/production-plan-card.test.tsx`, plus coordinator `test/world-chat/actions.test.ts`, `test/arke-actions/lifecycle.test.ts` and `test/world/schema-version.test.ts`. They check all forty native shot rows, screenplay changes and removed blocks, eligibility, dependency completion, stopping at refusal, duplicate gestures and the schema-61 reader refusal. Run `node scripts/smoke-production-card-body.mjs` with Chrome installed (`ARKE_CHROME` overrides its path) to check the full client cascade at 360, 390, 984 and 1200 px, including readable native columns and scrolling to row forty. These are renderer and authority checks; the installed journey remains #1427.

Generation media and Select (#1425) also use client `test/production-card-media.test.tsx`, coordinator `test/world-chat/generation-quotes.test.ts` and the “Select prepares”/board cases in `test/world-chat/actions.test.ts`, plus contracts `test/production-card-media.test.ts`. They check sealed quote projection with zero dispatch, cross-purchase refusal, duplicate preparation, Deny/Approve/stale review fences, live filed results and retained receipts. The Chrome script above now checks native board grids, reference/result cards and take comparison at all four widths. This is layout coverage with fixture media addresses, not installed provider playback. Select sends `conversation-take-review-prepare`; only the resulting card’s separate decision changes a shot selection.

Timeline and export bodies (#1425) use client `test/production-timeline-export.test.tsx`, contracts `test/production-timeline-card.test.ts`, the whole-cut/editor-recovery/local-export cases in coordinator `test/world-chat/actions.test.ts`, and desktop `test/reveal-media.test.ts`. They check frozen native tracks, removed ghosts, affected ranges, exact approved tracks, schema-62 reader refusal after first use, export identity isolation, retained completion playback, and confined desktop reveal including world/window changes during lookup. The Chrome script includes timeline/export modes at all four widths; its fixture addresses establish layout, not installed playback. Run desktop `npm run smoke:main --workspace @arke-studio/desktop` after bridge wiring changes.

Live audio and non-shot result use (#1425) also use coordinator `test/world-chat/generation-card-results.test.ts`, `production-audio.test.ts` and `test/bench/conversation-quotes.test.ts`. They verify filed outputs during other in-flight work, exact recorded job correlation, unchanged sealed admission evidence, pending/discarded/foreign output refusal and safe media addresses. Client media tests cover voice results without picture Select, frozen audio reference players, retained results and Use as… requests naming the owning result/action/session. Use as… sends an ordinary human request in the same conversation; filing, performance review and cue placement still use existing separately decided authorities. Chrome adds an audio mode with expanded use controls at all four widths.

Production Chat Studio (#1426) uses client `test/production-studio.test.tsx` with the existing conversation, human-decision, card, timeline and frame-run cases. It checks non-authorizing Show, forty pending shots, live settlement, pinning, single mounted full-size cards, unsent drafts, proposal settlement, that a closed Studio draws no canvas, and that it renders to a string beside the global linkedom document the screen tests install. Phone Stage access (R-68) is the head's Conversation press in `test/scenes-layout.test.tsx`. Run `node scripts/smoke-production-studio.mjs` with Chrome installed (`ARKE_CHROME` overrides its path) for the full cascade at 360, 390, 984 and 1200 px: phone view switching, Fold/desktop columns, native shots/board/Stage/Cut, Understanding/Proposal, widening and preservation of the original composer/card DOM instances. These checks use fixture media; installed provider playback and the complete conversation journey remain #1427.

The Studio smoke uses the real contenteditable composer for #1923: mouse and keyboard input
before expansion, after card review, after closing and after reopening Studio must retain the
draft, focus and Send availability. No authoring message is submitted.

## Select the checks

Browser media import uses contracts/client `test/browser-media-import.test.ts` and coordinator
`test/artifacts/browser-media-import.test.ts`, `upload-artifacts.test.ts`, `test/productions/editor-import.test.ts`,
`test/transport.test.ts` and `test/remote-access.test.ts`. These cover selection/cancel, byte/name
bounds, confined spool cleanup, read-only refusal, the editor fence, unchanged desktop paths and
remote/model refusal. Run the client dev-session tests from `packages/client`, plus desktop
`test/transport-auth.test.ts`, `test/preload-auth.test.ts`, `npm run smoke:main --workspace @arke-studio/desktop`
and `node apps/desktop/scripts/smoke-editor-import.mjs` after building. The latter opens a real
sandboxed Electron file page and verifies the native File courier and private session capability.

For fixed-cut crossfades (SPEC-054), run client `test/editor-transitions.test.tsx`, contracts `test/editor-transitions.test.ts` and
coordinator `test/productions/editor-transition-requests.test.ts`. These cover exact ordered
pairs, short adjacent joins, independent protection, retained manual adjustments, fresh Review
after release/update, one-step Apply/Undo, source invalidation and schema 76. Coordinator regression
coverage also requires the derived-write gate to remain available while preparing audio-reactive
dependencies, then refuses changed Current or pending decisions on re-entry. The real FFmpeg
crossfade case in `test/media/editor-effect-native.test.ts` compares every frame of an odd-length
blend with source alpha, scoped effects and an upper picture track against the preview compositor.
Use `ARKE_EFFECT_NATIVE_REQUIRED=1` and `ARKE_EFFECT_EVIDENCE_DIR` to require and retain it.
Application acceptance additionally uses an isolated scratch world through the normal join,
batch, protection, Arke composite and export controls. Compare matching states with approved
designs 216–219 at desktop, Fold and phone sizes; the design fixture alone is not acceptance.
Client `test/cut-layout.test.tsx` also checks the inline phone transition Inspector, its retained
state across Fold resizing, and returning to the timeline without authoring a command.
For resource-limited local runs, put `--test-concurrency=4` **before the file globs** in each
workspace's Node test command. Client tests still require `packages/client` as their cwd.

For Air Particles and layer blending (SPEC-055), run contracts
`test/editor-air-particles.test.ts`, `test/editor-effect-proposal.test.ts` and
`test/editor-effect-renderer.test.ts`; client `test/editor-air-particles.test.tsx` and
`test/editor-picture-review.test.tsx`; coordinator
`test/productions/editor-picture-requests.test.ts`. These exercise deterministic late seeks,
physics/texture controls, Pattern protection and sticky edits, clip lineage across splits,
fixed passage protection, explicit Review/Release, exact Apply and one-step Undo.
Require the native `test/media/editor-effect-native.test.ts` suite with
`ARKE_EFFECT_NATIVE_REQUIRED=1`; its Screen/Add case compares source alpha, clip opacity,
scoped/composition effects and crossfades against the shared compositor (at most four
8-bit channel levels of native rounding). After building, run
`node --import tsx apps/desktop/scripts/smoke-editor-effects.mjs` for all seven presets
through the sandboxed Electron file-page worker. Compare live Inspector, phone sheet and
Arke cards with approved turns 220–223; label locally staged cards as fixtures when no
model call was made. Keep world media and acceptance captures outside the public repository.

For editor effects T-1 (SPEC-053 accepted), run contracts `test/editor-effects.test.ts`,
`test/editor-effect-protection.test.ts`, `test/editor-request.test.ts`, `test/timeline.test.ts`
and `test/render-plan.test.ts`, together with coordinator `test/productions/timeline-effects.test.ts`,
`test/productions/editor-requests.test.ts`, `test/productions/timeline.test.ts` and the timeline
migration/world schema tests. These verify authored state, retained phase/fades, granular
protection, direct-human versus generic acceptance authority, schema-floor persistence and
legacy compatibility. They do not establish renderer or real-UI acceptance; that evidence is
recorded with the subsequent implementation slices. Run the root lint/typecheck/build gates
after the final test edit and run client tests from `packages/client`.

Editor effects T-2 adds contracts `test/editor-effect-renderer.test.ts`, client
`test/editor-effect-preview.test.ts` and coordinator `test/media/editor-effect-native.test.ts`.
The native tests use real FFmpeg/FFprobe (`ARKE_FFMPEG`/`ARKE_FFPROBE` or PATH); set
`ARKE_EFFECT_EVIDENCE_DIR` to retain measured parity evidence. The frame-boundary case covers
stills, video, scoped alpha and composition alpha at exact
half-open intervals after gaps, at 24/25/30 fps and inside nonzero export windows. Run
`node --import tsx scripts/smoke-editor-effects-preview.mjs` for real Chrome decoding, source
alpha, contained targets, multiple picture layers, all six presets and seek/worker checks.
`node --import tsx scripts/benchmark-editor-effects.ts --output <report.json>` records the
runtime, hardware, capability profile, frame digests, near/far seek times, worst overlap raster
times and process memory. The native production acceptance CI job repeats these measurements
on Windows and Linux and retains the reports. These fixtures establish renderer behaviour;
the two real scratch-world manual/Arke music-video passes remain distinct acceptance evidence.
Host changes also require desktop `smoke:main` and a real sandboxed Electron file-page smoke.
Run `node --import tsx apps/desktop/scripts/smoke-editor-effects.mjs` after the build to check
the emitted worker under the built page's CSP and Electron sandbox; `ARKE_EFFECT_SMOKE_REPORT`
optionally retains its report. This complements `node apps/desktop/scripts/smoke-editor-import.mjs`
for the private transport/native file bridge.

Editor effects T-3 adds contracts `test/editor-effect-analysis.test.ts`, coordinator
`test/productions/editor-effect-analysis.test.ts`, `editor-effect-analysis-cache.test.ts`,
`test/editor-effect-analysis-transport.test.ts` and `test/media/editor-effect-audio-native.test.ts`,
plus client `test/editor-effect-analysis.test.ts` and `test/editor-effect-readiness.test.tsx`.
The native tests use real FFmpeg PCM: ordered mixed sample rates/layouts, shared limiting,
ducking, source windows, muted silence, cancellation and file/executable replacement. The
`test/media/ffmpeg-graph-probe.test.ts` checks host capability refusals; the native audio fixture
also runs a graph larger than Windows' argument limit from a file with a spaced path. Exercise
both FFmpeg 6's legacy graph option and FFmpeg 7–9's option-file syntax in platform checks. Set
`ARKE_EFFECT_NATIVE_REQUIRED=1` to require FFmpeg, and `ARKE_EFFECT_EVIDENCE_DIR` to retain the
native report. `node --expose-gc --import tsx scripts/benchmark-editor-effect-analysis.ts
--output <report.json>` measures streaming DSP, bounded cue/curve preparation, reactive seeking
and the eight-layer Smoke profile; its `--expect-fixtures-sha256` option gates cross-platform
feature/pixel identity. CI retains this report alongside native and browser evidence.
Analysis must leave timeline bytes, revision, Undo and production object identity unchanged.
Ready metadata and fetched manifests are separate; test stale arrivals and same-fingerprint file
replacement as well as authored edits. Changes to the manifest route also require the actual
sandboxed Electron file-page transport smoke and `smoke:main`.

Editor effects T-4 adds client `test/editor-effect-library-tracks.test.tsx`,
`editor-effect-inspector.test.tsx`, `editor-effect-target-area.test.tsx`,
`editor-effect-controls.test.tsx`, `editor-effect-integration.test.ts` and
`editor-effect-draft-analysis.test.tsx`, with the readiness and shared gesture suites. Contracts
`test/editor-effect-authoring.test.ts` and `editor-effects.test.ts` cover protected response
selection, explicit beat overrides, uncovered passages and signed retained curve phase.
Exercise gesture cancellation, stale saved revisions, overlap selection, normalized area/curve
typing and dragging, exact boundary versus fixed passage protection, and explicit Release.
Use the real authenticated editor at desktop, Fold and 390/320px phone sizes in both themes;
keep screenshots of keyboard focus, scrollable Inspector sections, target/source choices and
export readiness. Real manual authoring evidence is separate from component fixtures.

Editor effects T-5 adds contracts `test/editor-effect-proposal.test.ts`,
`editor-effect-review.test.ts` and `timeline-trusted-steps.test.ts`; coordinator
`test/productions/editor-effect-requests.test.ts`, `test/world-chat/effect-proposal-authority.test.ts`,
`effect-proposal-scope.test.ts`, `effect-proposal-reads.test.ts` and the candidate cases in
`test/productions/editor-effect-analysis.test.ts`. Run the existing timeline/request, world
commit/recovery/schema, conversation lifecycle/action/retrieval and transport suites too.
Check mixed human/model protection, old-parent sticky revisions, exact scoped Release, limits,
read-only resume, stale media/profile/resolution, crash recovery, and receipt retries after Undo.
For ordinary effects chat, include `world-chat/action-guide.test.ts` and the after-Apply cases in
`effect-proposal-authority.test.ts`: no form is required to prepare a bounded proposal, editor
scope cannot be overridden, invalid bindings are refused, and no review/release/apply authority
is inherited. Client `editor-effect-preparation-panel.test.tsx` checks authored effect selection
on ordinary messages as well as passive arrangement preparation.
Native analysis tests require FFmpeg/FFprobe; use `ARKE_EFFECT_NATIVE_REQUIRED=1` to make missing
native support fail. The precommit validator must not prepare analysis, and tests must exercise
an external metadata change while the write gate suppresses watcher adoption.

Editor effects T-6 adds client `editor-effect-arrangement-request.test.ts`,
`editor-effect-arrangement.test.tsx`, `editor-effect-proposal-card.test.tsx`, and the
`editor-effect-review-*` tests for exact controller/transport joining, navigation, position,
readonly legacy trims, source freshness, pending projection and shared playback. Include
`editor-effect-frozen-analysis.test.tsx`, `editor-effect-integration.test.ts`,
`human-decisions.test.tsx` and `production-studio.test.tsx`; coordinator
`test/world-chat/human-decisions.test.ts` checks unsaved revision-zero proposal projection.
Run the real authenticated editor and configured Arke harness for the two acceptance exports.
Capture Current before preparation/arrival, the exact reviewed version after a human Review,
pending adjustment/Undo, sticky revision arrival, explicit Release/review, stale Update and
one-revision Apply. Check desktop, Fold and 390/320px sheets in both themes, one soundtrack and
unchanged playhead across comparison. Component fixtures are not evidence of a real model run
or a delivered video. Verify full-song exports and actual preview captures with FFprobe/FFmpeg.

For the approved editor effects designs 213–215, regenerate with
`node design-system/editor-effects-213.mjs`, record new turns with
`node design-system/check-master.mjs --record`, then rebuild the companion with
`node design-system/build-review.mjs`. Run `node design-system/editor-effects-213.check.mjs`
for headless Chrome drawings and isolated review interactions; `CHROME` overrides its binary.
Screenshots and the report go to ignored `.dev/editor-effects-design/`. Inspect desktop,
Fold, phone, target/time placement, granular protection, audio-source selection, Advanced,
changed-source and changed-base states, composite cards before/after explicit review entry,
and revisions arriving without replacing the preview, then run the standard master
render and companion checks below. Synthetic audio/AI fixtures establish design behaviour
only, not real analysis, model execution, export parity or installed-app acceptance. See
[the design notes](../../design-system/editor-effects-213.notes.md).

For design-only production conversation work, turn 196 in the design master is the reference
for the thirteen card families and Studio layouts (#1424). Generate its companion with
`npm run design:review`, check it with `npm run design:review -- --check`, and run
`node design-system/check-master.mjs --render` with Chrome installed (`CHROME` overrides the
binary path). Inspect the desktop, 984px Fold and 390px phone frames, including Show/Back,
pinned canvas, Stage conversation access, group approval stopping and all forty shot rows.
This verifies the drawing and loaded Geist fonts; it is not installed-app acceptance for
#1427. Card implementation (#1425) and Studio implementation (#1426) need their renderer
and command behavior checks when built.

From the repository root, the complete code gate is:

```powershell
npm run lint
npm run typecheck
npm run build
npm test
```

Lint checks source text, holds the client to its source policies (`scripts/check-client-policy.mjs`: the token files match the design-system baseline byte for byte, no colour is hard-coded outside them, a light-ramp surface says what it becomes in dark, and no credential material is handled client-side), rejects duplicate `specId` declarations in the private document set when it is present (`scripts/check-spec-ids.mjs`), and runs oxlint over packages/apps; it does not lint all maintenance scripts. The `specId` check passes silently where the specifications are absent, which is the normal case in CI and in a clone without the private document set — it verifies identity only on machines that actually hold the specs to break. Run `node scripts/check-spec-ids.mjs` to check specification identity alone, including new files before staging them. Do not run `npm run format`: existing house formatting and Prettier disagree. `tsx` executes tests without typechecking, so typecheck after the last source or test edit.

For one workspace, run these from the repository root:

```powershell
npm test --workspace @arke-studio/client
npm run typecheck --workspace @arke-studio/client
```

For individual files, set the working directory to the owning workspace. For example, from `packages/client`:

```powershell
node --import tsx --test test/routes.test.tsx test/dev-session.test.ts
```

From `packages/coordinator`:

```powershell
node --import tsx --test test/gate/proposals.test.ts test/world/commit.test.ts
```

A test holds onto behaviour: it renders a component or a route and reads the DOM, or it calls the module and reads the result. It does not read a source file as text and assert on it with a regex — such a test can fail only when someone edits the file, never when the program does the wrong thing, and it fails on every rename (the coarse-pointer selector list in the old `tokens.test.ts` cost a CI round for naming classes that had left with their markup). Rules about the text of the source belong in the lint step beside the other source checks; layout that only a browser can measure belongs to a headless-browser check, not to a unit suite. In render tests, hold onto roles, `aria-label`s, `data-` attributes and counts before copy, and derive fixture facts from the fixture rather than spelling them out.

Client tests use workspace-relative paths and must run with `packages/client` as cwd. Workspace npm scripts set that cwd for you. Check worktree-local package resolution before trusting cross-package results; see [worktree rules](../../CLAUDE.md#worktrees).

The Windows CI other-workspaces job first checks the Codex file helper's private pipe and independent junction-mutation fixture with the Unicode/binary transfer and reparse regressions. This bounded preflight reports a native startup failure before the dependent adapter sessions each spend their own startup timeout; the full file-access suite still runs in the normal test gate.

Windows shard 3 likewise runs `test/harness/owned-child.test.ts` first to verify native process inspection and abrupt-exit cleanup before the full coordinator shard. These preflights retain the ordinary test assertions and remain part of the later full suites.

Coordinator `test/harness/stage-model-journey.test.ts` carries a live Stage model override through image-read receipts, canonical provenance, Keep, reopen and cancellation. It uses scripted model responses and PNG fixtures with the real coordinator and world persistence; renderer output and generation quality are separate checks.

Whole-delivery Loop changes need client `test/editor-loop.test.tsx`, `editor-loop-media.test.ts`,
`playback-engine.test.ts`, `plan-audio.test.tsx`, `cut-layout.test.tsx`,
`editor-effect-review-transport.test.tsx` and `editor-effect-preview.test.ts`. Run them from
`packages/client`. The cases cover overshoot, short wraps below media drift tolerances, immediate
resume of ended sources, stale worker results, absolute effect frames and local-only controls.
Also exercise the actual Loop button at desktop and 320px width with real short video/audio and
the long-song effect arrangement, retaining paused frames after wrap and switching
Current/Suggested without starting another soundtrack. Unit fixtures do not establish real-time
decoding or visual/audio continuity.

## Fixtures and cleanup

Codex image changes run adapter-codex `test/adapter.test.ts`, providers
`test/codex-client.test.ts` and `test/manifest.test.ts`, contracts `test/provider-plans.test.ts`,
coordinator `test/harness/codex-image-runner.test.ts`, `test/spec008/codex-image-startup.test.ts`,
`test/queue/dispatcher.test.ts`, `test/application/story-media.test.ts`, `test/world-chat/generation-quotes.test.ts` and the audiobook
picture/illustration suites. Client coverage includes `test/dispatch-bar.test.tsx`,
`test/providers.test.tsx`, `test/queue-toaster.test.ts`, Bench, founding-build and audiobook
picture tests. The ordinary suites use fixtures and consume no account allowance.
Startup coverage holds the Codex probe pending while the transport opens, then verifies that
the real founding-service wiring accepts validated external sign-in without a stored API key.
For a live check, use an installed Codex with ChatGPT sign-in and a synthetic one-image reference;
verify the returned image visually and stop the adapter in `finally`. Record only the version,
image-item field names/types, byte count and MIME type, never account details or image payloads
in test logs. The Windows 0.160.0 check for PR 1554 verified base64 PNG output and reference
preservation. Quota refusal is fixture/protocol coverage, not a deliberately exhausted account.

Standalone host changes also run coordinator `test/studio-server.test.ts`, existing
`test/transport.test.ts` and Studio host lifecycle tests. The Node journey uses a copied
world, disables paid AI, exercises authenticated manuscript download and reopens saved prose.
Its response waits allow 30 seconds for filesystem-backed operations on shared runners, with
a 120-second bound on the complete journey. A socket close fails immediately; a missing reply
names the phase and recent frame types/sequences without logging payloads. These are correctness
bounds, not an application latency target.
Run client `test/manuscript.test.tsx`, `test/image-download.test.tsx`,
`test/dev-session.test.ts` and `test/dev-session-server.test.ts` for the browser path.
Desktop composition changes still require the desktop checks below.

Client `test/fixture-state.ts` provides fixture state; navigation samples are in `src/screens/registry.ts`. Read an adjacent screen test for DOM/store setup. Coordinator tests commonly copy world fixtures into temporary directories and inject providers or clocks. Reuse `test/queue/fake-provider.ts` for suitable queue scenarios and adjacent domain helpers rather than calling paid providers in ordinary regression tests.

Close stores, sockets, watchers, timers and supervisors in test cleanup before deleting temporary files. A leaked watcher can leave the runner alive after assertions finish. Fixture data under [fixtures](../../fixtures) supplies tests and development seeding only; it is not the downloadable story or an installer resource. Edit it intentionally and keep its size budget. Story-download tests use small in-memory ZIPs and never fetch the full release; see [story releases](story-releases.md) for release validation.

## Boundary-specific checks

Production Chat context and state-read changes run coordinator
`test/world-chat/production-contexts.test.ts`, `test/world-chat/context-validation.test.ts`,
`test/world-chat/entry-context.test.ts`, `test/world-chat/action-guide.test.ts`,
`test/world-chat/context.test.ts`, `test/world-chat/run.test.ts`,
`test/world-chat/retrieval.test.ts` and `test/world/schema-version.test.ts`.
Client `test/scene-workspace-dock.test.tsx` checks context changes between shots and Stage.
The regressions cover bounded current action outcomes in later prompts, complete paged
production reads, changed-record cursors, durable frame-run reads without provider inputs,
explicit editor-request read requirements and the lazy schema-50 context boundary.
Run client tests from `packages/client`, and typecheck after the last test edit.

For conversation command reachability and input policy, run contracts
`test/world-chat-actions.test.ts`, coordinator `test/arke-actions.test.ts`,
`test/world-chat/action-guide.test.ts`, `test/world-chat/turn-result.test.ts` and
`test/world-chat/actions.test.ts`. They check that every advertised path has a guide and an
approval adapter, commands without paths name `no-model-action`, execution-blocked kinds never
become new cards, and `conversationSchema` excludes unsupported variants such as live-source
audio detachment and editor placement during plain filing while preserving human transport.
They also check that old pending visual-facts cards remain readable and deniable but cannot write,
chat duplicates cannot copy reviewed facts, and obsolete Bench permission labels stale the
card without execution. Keep `test/world-chat/shape-drift.test.ts` and `test/arke-actions/review-regressions.test.ts`
in the regression set for stored-card compatibility and decisions made on another surface.

Generation quote changes also run coordinator `test/world-chat/generation-quotes.test.ts`,
`test/bench/conversation-quotes.test.ts`, `test/world-chat/retrieval.test.ts`,
`test/audio/performances.test.ts`, `test/references/takes.test.ts`,
`test/references/background-finalization.test.ts` and
`test/world/founding-build.test.ts`. These cover preparation without jobs, default routing,
price/expiry/reference changes, pending result filing, frozen Bench reservations and cast audio,
founding retry authority and interrupted admission without automatic resubmission. Run
`node --import tsx --test` with those repository-relative test paths; no paid provider is used.
The quote regressions cover concurrent world-image/master-look
admission, distinct establish-look media, long shared Bench briefs, uncertain queue and
reservation admission without resubmission, empty provider results, and JPEG/WebP prop landing
with staging cleanup. Background finalization checks use a real prop state and verify that
chat-generated character sheets remain pending for separate selection.

Bench chat changes also run coordinator `test/bench/chat.test.ts`,
`test/bench/conversation-quotes.test.ts`, `test/bench/subject-coordinator.test.ts`,
`test/world-chat/generation-quotes.test.ts` and `test/world-chat/service.test.ts`; contracts
`test/world-chat-actions.test.ts`; client `test/bench-subject-session.test.tsx`. They exercise
approval-only session creation, Deny without side effects, crash rejoining without another
purchase, complete reference composers, immutable reruns, paged route privacy and stale
cursors, Keep/Select/Discard through the action lifecycle, source hashes and attachment
retention, runtime eligibility, public voice catalogue pagination, cloned-voice consent and byte changes, automatic audio disclosure, accepted-production discard recovery and refused-action schema preservation. The client regression sends a message from world Bench without a production id.

Production Chat generation also runs coordinator `test/world-chat/production-generation.test.ts`,
`test/world-chat/production-take-filing.test.ts`, `test/world-chat/actions.test.ts`,
`test/bench/subject.test.ts`, `test/bench/subject-coordinator.test.ts` and
`test/takes/boundary.test.ts`; contracts `test/schemas.test.ts` checks Activity recovery.
These cover exact admission after approval, no admission on denial, selected-frame/video byte
changes, missing kits, retakes, image boards and video pass segments, candidate-only arrival,
recovery after media moves or a segment record is missing, and explicit Bench filing/acceptance.
Filing preserves the Bench source and refuses changed media, settings or destination selection.
Clearing a frame retains immutable takes and the accepted video selection.
Keep `test/arke-actions/review-regressions.test.ts` in this set: finalized quoted jobs settle
their open conversation cards after filing/ledger settlement, including failure and cancellation.
Filing recovery repairs the idempotent Bench journal link before completing the card, and a
first-frame route neither clears cast audio nor records an upload acknowledgement for it.

Production Chat audio changes run coordinator `test/world-chat/production-audio.test.ts`,
`test/bench/chat.test.ts`, `test/bench/conversation-quotes.test.ts`,
`test/audio/performance-generation.test.ts`, `test/audio/performances.test.ts`,
`test/audio/table-read.test.ts`, `test/audio/character-sample.test.ts` and
`test/world-chat/action-guide.test.ts`; contracts `test/world-chat-actions.test.ts`,
`test/bench.test.ts` and `test/world-chat-shape.test.ts`; client
`test/human-decisions.test.tsx` and `test/bench-subject-session.test.tsx`.
These check quoted assigned voices, stale voice refusal, approval-only local preparation,
recovery without another provider purchase or tool run, unselected generated dialogue,
native human review and timing fences, production music ownership, denied cue dependencies,
separate editor acceptance, typed audio edits and named SFX refusal. Typecheck after test edits.
An installed-app audition and real provider qualification remain separate acceptance work.

Frame-run and planned-dispatch chat changes also run `test/world-chat/production-batch.test.ts`,
`test/productions/frame-run.test.ts`, `test/productions/frame-run-coordinator.test.ts`,
`test/productions/dispatch-plans.test.ts` and `test/dispatch-refusal.test.ts` in the coordinator.
They check Generate/chat quote parity, read-only preparation, stale shots, durable run/plan
authorization, freshly quoted resume and retries, immutable board parents, late boundary byte
pins, human continuation gates, live card settlement and cancellation recovery without a
second purchase. The retired unplanned scene-dispatch command must refuse explicitly.
The same suite checks real jobs/plan receipts through model-action preparation: frame run/step
identities are discoverable without exposing job internals, plan cancellation observes current
folded state, automatic plan policies disclose their authorization, and long prompt display
does not alter frozen job prompts. A proven pre-authority refusal settles stale; an unreadable
authority continues to require reconciliation.

Production human controls also run coordinator `test/world-chat/human-decisions.test.ts`,
`test/productions/stage-review.test.ts`, `test/arke-actions/human-decision-parity.test.ts`,
`test/audio/character-sample.test.ts` and `test/audio/preparation.test.ts`, plus client
`test/human-decisions.test.tsx`, `test/scene-stage.test.tsx` and `test/voice-sample-take.test.tsx`.
These exercise ordinary screen commands settling the thread, read-only voice review discovery,
inline rights attestations, operation-specific cross-surface voice settlement, metadata-only
voice discovery with full Resume/Accept revalidation, retained Stage draft reopening without
overwriting unsaved edits, stale/duplicate Keep, discard, settled-draft archival, path containment
and interrupted host completion from pending or archived drafts without another construction. The parity
fixture requires every pipeline human command's in-thread surface and keeps those commands
out of model preparation. This scripted evidence does not replace installed-renderer acceptance.

Book/audio standards experiments use the separate [publication interoperability checks](publication-interop.md#reproduce).
They install their own locked development dependencies and exercise Readium, package closure and EPUBCheck.

| Change | Additional evidence |
|---|---|
| Contracts/wire state | Typecheck consumers; affected client/server state and transport tests |
| World writes/ownership | Commit, watcher/reconciliation and affected gate/domain tests; preserve recovery and ownership-loss behavior |
| Jobs/spend | Dispatcher, ledger and affected provider tests; unknown-outcome/recovery cases |
| Transport/preload | Coordinator transport, desktop transport-auth/preload-auth, client dev-session/dev-session-server tests; an actual sandboxed Electron file-page smoke check per CLAUDE.md |
| Build/runtime delivery | Desktop package tests and `npm run smoke:main --workspace @arke-studio/desktop`; relevant runtime/packaging checks |
| Documentation only | Verify local links, paths, command names and claims; application tests are unnecessary unless executable behavior also changes |

Host Node loads `better-sqlite3`; desktop uses the Electron native build through its alias/rebuild setup. A successful Node test does not establish packaged native loading. See [maintenance](maintenance.md) before changing either arrangement.

## Local image generation

Local Qwen Image 2.1 runs on the ordinary engine and has an opt-in provider GPU check; see
[Qwen setup and validation](qwen21.md).

Local Krea 2 image generation has an opt-in GPU check and offline custom-node installer tests;
see the [Krea 2 integration guide](krea2.md). A returned PNG must be inspected visually: provider
success alone does not establish usable image quality.

## Writing engines and model control

Run the adapter package suites plus coordinator `test/harness/`, `test/v2-launch.test.ts`,
and client `test/harness-model-controls.test.tsx`, `test/agents.test.tsx`,
`test/settings-general.test.tsx`, `test/production-setup.test.tsx`. Catalog tests cover
canonical/legacy references, discovery failure and retry, precedence and Stage image capability.
Adapter tests exercise captured settings, confined tool access, cancellation and final-turn events.
OpenCode discovery tests require v2 2.0.26 and prove a v1-only installation cannot launch.
Coordinator `test/studio-server.test.ts` also proves the real Node composition can satisfy the
mandatory readiness gate with explicitly selected healthy ComfyUI and Ollama services.

For an OpenCode v2 pin change, stage the exact runtime and qualify the actual binary:

```powershell
npm run prepare:opencode2 --workspace @arke-studio/desktop
$env:ARKE_TEST_OPENCODE2 = (Resolve-Path apps/desktop/build-resources/opencode2/opencode2.exe).Path
node --import tsx --test packages/adapter-opencode/test/v2-input-protocol.test.ts packages/adapter-opencode/test/v2-image-protocol.test.ts packages/adapter-opencode/test/v2-copilot-protocol.test.ts packages/coordinator/test/v2-launch.test.ts
$env:ARKE_OPENCODE2_CMD = $env:ARKE_TEST_OPENCODE2
$env:ARKE_LIVE_HARNESS = '1'
node --import tsx --test packages/adapter-opencode/test/live-credential-store.test.ts
Remove-Item Env:ARKE_LIVE_HARNESS, Env:ARKE_OPENCODE2_CMD, Env:ARKE_TEST_OPENCODE2
npm run verify:licenses --workspace @arke-studio/desktop
npm run smoke:main --workspace @arke-studio/desktop
```

The tests use disposable profiles, a scripted localhost provider and synthetic credentials.
They verify authenticated launch, the exact server version, native Ollama discovery with an endpoint-only configuration, pinned
agent/model configuration, Copilot discovery held pending with no early inference and a native
Claude Messages response after the route settles, a file-tool loop, outside-directory denial, final text/usage, approval
confirmation, and durable key add/restart/removal. They make no paid requests and do not qualify
live cloud-provider inference or OAuth sign-in. Ordinary CI skips the native probes; its protocol
fixtures still run. The [inbox evidence](conversation-inputs.md#opencode-v2-inbox) does not qualify
native steering.

OpenCode image changes also run `packages/adapter-opencode/test/v2-images.test.ts` and the
coordinator's `test/world-chat/images.test.ts`. Verify that cloud aliases exposed through a
loopback Ollama server remain cloud destinations: only bounded read-only model metadata
with local architecture and no upstream route can qualify local inspection. Redirects,
unknown/oversized metadata and cancellation must never send media or authorize locality.
The exact-binary image probe above uses an
isolated scripted vision provider and MCP server to verify decoded pixels from both inline
PNG attachments and direct `view_image` results. Native MCP registration is asynchronous;
the probe allows bounded ordinary reads while the direct tool catalogue settles, without
enabling Code Mode or widening the agent's permissions. It asserts the measured local
Ollama endpoint and does not establish image comprehension, video motion or audio quality.

Discovery/launcher regressions also reject older and newer v2 versions with no fallback,
retain the installed version and required pin in the unavailable reason, and create no child.

For the bundled OpenCode Copilot startup race (#1696), run adapter-opencode's package suite
and coordinator `test/harness/session-files.test.ts`. Adapter `test/v2-model-readiness.test.ts`
scripts the scoped catalogue protocol: global-ready/location-pending,
separate Beats/Continuity/Cast locations, default/fallback choices, 503 warm-up, unsupported or
missing routes, cancellation, deadlines and incorrect scope. It verifies no prompt is sent
before readiness and failed creation retires the unpublished session. These fixtures make no
vendor calls; they do not prove account connectivity or repair a permanently failed runtime sync.

Host lifecycle checks include coordinator `test/harness/owned-child-linux.test.ts` and
`test/harness/owned-child-windows.test.ts`. They use real native processes on their respective
platforms: the Linux cases sweep a long-named executable and its helpers after an uncatchable owner exit;
the Windows case creates a helper between snapshots, after a failed leash, and checks cleanup
after its parent exits. Both platforms are needed to verify these ownership boundaries.

The Codex real-binary protocol test is opt-in:

```powershell
$env:ARKE_CODEX_SMOKE_COMMAND = "C:\path\to\codex.exe"
$env:ARKE_CODEX_SMOKE_CATALOG = "C:\path\to\model-catalog.json"
npm test --workspace @arke-studio/adapter-codex
```

The catalog file contains the app-server's model metadata (`{ "models": [...] }`), without
credentials. The test creates an isolated profile and a scripted localhost Responses provider;
no paid generation request is sent. It verifies actual model-visible tools and direct image
delivery for the catalog's model profiles. Ordinary CI uses the deterministic protocol fixtures.
For host changes also run `npm run smoke:main --workspace @arke-studio/desktop`.
After building, `node --import tsx apps/desktop/scripts/smoke-harness-models.mjs` checks
the real sandboxed file-page controls, saved agent/production models, reload and pending engine
selection against a real coordinator with scripted discovery. It makes no generation call and
retains screenshots in its printed disposable directory for visual inspection.
Set `ARKE_SMOKE_CATALOG_DELAY_MS=1500` to also exercise model selection and saving while
catalog refreshes temporarily disable those controls.

## Remembered remote access

`node scripts/smoke-founding-controls.mjs` renders the founding front door and its working
composer, host Remote access settings and the Lines sheet at 1200×791 and 1600×1000 in
headless Chrome. It checks empty-section suppression, composer admission, the shared settings
row geometry and the speaker summary, and retains screenshots in its printed temporary
directory. It uses disposable state and makes no model, world or hosting changes.

Client `test/remote-session.test.ts`, `test/remote-pairing.test.tsx` and `test/dev-session.test.ts`
cover stalled worker registration/activation, storage refusal, session-request deadlines,
network restoration and handshake retries without accepting late socket events. These tests
also cover cancellation without `AbortSignal.any`, worker policy refusal and preserving
the one-use pairing POST beyond the session-probe deadline. The real Serve
smoke below also loads the built install manifest, favicon and 192/512/180px home-screen icons
before pairing, and checks that the desktop file page does not advertise web installation.
On a physical phone, install from the browser menu, verify the home-screen icon and standalone
launch, then resume with the PC/Tailscale temporarily unavailable. Browser profiles can differ
between a tab and an installed app, requiring a separate approval. This manual check is still
needed; an Electron smoke does not establish iOS or Android installation.

Run coordinator and desktop `test/remote-access.test.ts`, client `test/remote-access.test.tsx`
and the transport/preload regressions above. The focused suites cover code expiry/replay,
approval persistence, origin/host confinement, revocation, and preserving other Serve mappings.
Duration coverage includes all four choices, legacy 90-day defaults, settings persistence while
off and across restart, approval-time selection without rewriting existing devices, fixed cookie
deadlines, renewable Never cookies, revocation, and failed writes without preference changes.
Link-sharing tests cover native clipboard success/failure, host-owned address selection,
and hiding the local QR/Copy link controls while hosting is stopped. The live smoke decodes
the rendered QR pixels with an independent decoder and checks the actual native clipboard.
They also check host-file command rejection over live sockets, approved-cookie promotion after
restart, stale forwarding with damaged or missing settings and a damaged registry, port retention
when cleanup fails, preservation of damaged records, and first launch without Tailscale.
Publication tests verify that ownership is committed before Serve runs, both initially and
after Disable, and that a failed ownership write prevents publication.
Desktop `test/startup.test.ts` covers cleanup retries without a second host and slow remote
unpublication before the core shutdown deadline.
After building, an opt-in real HTTPS check is:

```powershell
node --import tsx apps/desktop/scripts/smoke-remote-access.mjs --tailscale
```

This requires a desktop display, connected Tailscale with HTTPS certificates enabled, and an
unused HTTPS port 8444. It temporarily maps only that port and removes its own mapping on exit.
It uses copied fixtures and a disposable profile, with no generation. It exercises the built
sandboxed Electron file page, duration selection, phone-sized browser pairing and Never approval, persistent HttpOnly cookies,
authenticated WSS and media, browser reopen, coordinator/gateway/registry restart with a fresh
process capability, and revocation. Inspect the
screenshots in its printed temporary directory. This host-local check does not replace actual
phone/second-computer testing or an installed-app sign-in/reboot check; record those separately.

After building, `node apps/desktop/scripts/smoke-background-startup.mjs` uses the sandboxed
file page and built preload to verify hidden first paint, readiness fallback, host startup,
and visible failure recovery. It exercises Windows and macOS login inputs on the current
machine; it does not claim an actual macOS or OS sign-in test.

## Desktop appearance

For appearance bootstrap or reload changes, run `node apps/desktop/scripts/smoke-theme.mjs`.
It bundles only the preload and theme entry point, then checks first-paint system/explicit
choices across reloads of a sandboxed Electron file page. It uses a disposable profile and
process-local theme overrides; a desktop display is required.

## Chapter workspace layout

For chapter layout changes, run `node scripts/smoke-chapter-layout.mjs` from the root with a
desktop display. It renders fixture chapters in sandboxed Chromium at laptop and desktop sizes,
checks the manuscript and stacked cards, the Markdown selection gutter, and model resets on
series and microdrama overviews. It never opens a user's world. Set `ARKE_LAYOUT_SCREENSHOT`
to a PNG path to capture the 1200×791 source view for visual inspection.

## Audiobook layers

For changes to the audiobook player, the Export audiobook sheet or a window-wide layer opened from
a page head, run `node scripts/smoke-audiobook-overlays.mjs` from the root with Chrome installed
(or `ARKE_CHROME`). It renders the fixture book's door and a chapter at 320, 390, 820, 1100, 1440, 1920 and 2560
wide, plus 200% text at 1440 and desktop chrome at the native 1024px minimum. The show page checks
turn 199's hero and portrait composition for a single narrator, several cast members and long
titles, including Reading access. Chapters follow the cast in the scrolling page; fitting them
above the fold is not a reason to shrink the approved artwork. Titlebar controls
must not overlap or enter the native window-button area. Use `--viewport desktop-min`, `phone`
or `small-phone` for a focused check. Phone cases use browser chrome: shrinking an Electron
CDP viewport to 390px retains its 138px native-button reservation and does not establish a phone
browser defect. Verify the host mode as well as viewport size when assessing screenshots.
Listen covers the window; Export is a native modal on the body,
within the viewport, with no transformed ancestor or horizontal overflow. The chapter export
starts at This chapter, blocks an incomplete reading, keeps its options under the missing-block
read quote, refreshes readiness when saved takes arrive, and returns focus to its stable opener.
Phone export actions are at least 44px. Listen leads the head, and the chapter's Voices rail names
a designed voice and never overlaps it. `--out <dir>` keeps the screenshots; `--baseline <rev>`
renders the changed screens as they were at that revision and asserts nothing.

## Dialogs and sheets

Every sheet and dialog is drawn on the document's body, never where it is opened. `EditorDialog`
and the hand-rolled scrim-and-sheet dialogs (the voice catalogue and clone, the voice sample flow,
the voice picker, the Bench's lyrics and brief windows, the archive sheet, the shot delete
confirmation) go through `BodyLayer`; `PageSheet` is a native `<dialog>` portalled to the body.
A `position: fixed` layer is fixed to the window only while no ancestor has a transform, and the
page heads and columns enter with `fy-fade-up`, whose transform Chrome keeps as the containing
block after it settles, so a dialog mounted in place is a clipped box over whatever it was opened
from. There is no opt-out. A menu that places itself from a button's rectangle (the production
switcher, the chat list's row menu) is drawn on the body for the same reason.

Two consequences when you write one. CSS cannot reach a dialog through a screen ancestor
(`.fy-screen .fy-dialog`, `[data-screen="x"] .fy-sheet`) or through a custom property the screen
defines, because the dialog is no longer inside it: class the dialog's own panel
(`panelClassName`) or define the property on `:root`. And a DOM test finds the dialog on the
body, not in the container it mounted into: use `dialogRoot(container)` from
`packages/client/test/dialog-root.ts`, and remove the host container (not the body) in teardown.
SSR tests are unaffected, since `BodyLayer` renders in place on the server.

Run `node scripts/smoke-dialog-overlays.mjs` from the root with Chrome installed (or
`ARKE_CHROME`) after changing any of them. It opens Export and Import manuscript, the Cut's export
and keyboard sheets, the voice catalogue and the clone dialog at 390, 820, 1440 and 2560 wide,
each from a page in which every ancestor of the opener has a transform (the worst the page can
be), and checks each layer is on the body, has no containing ancestor, is inside the window and is
centred (a phone's sheets are full width from the bottom). `--out <dir>` keeps the screenshots and
`measurements.json`; `--viewport phone|tablet|laptop|ultrawide` runs one width; `--baseline <rev>`
renders the dialog sources as they were at that revision and asserts nothing, which is how to see
the check fail on the old mounting.

## Independent editor media

After building desktop, run `node apps/desktop/scripts/smoke-editor-import.mjs` from the repository root. It opens a hidden sandboxed Electron file page with the built preload, supplies real file-backed selections, and verifies ordered path resolution and private authentication. It uses a temporary profile and requires a desktop display (it is separate from headless CI).

For an actual encode/decode of the zero-scene import, detach and edit journey, set `ARKE_TEST_FFMPEG` to the installed ffmpeg executable and run coordinator `test/productions/editor-import.test.ts` from `packages/coordinator`. Without that variable, only the native encode case skips; persistence, stale revision, cancellation and role regressions still run. The native case creates its own short test footage and removes the original source files before exporting.

## Conversational video production setup

After `npm run build`, run `node --import tsx apps/desktop/scripts/smoke-production-setup.mjs`
from the repository root. It uses a real coordinator, the built client and sandboxed preload,
a disposable fixture world, and a scripted writing harness. It checks keyboard tabs at a narrow
width, composer reachability, reviewed creation, retained conversation/questions, and narrative
and scene reopen. No paid model or media call is made. A desktop display is required; screenshots
are retained at the printed temporary path for visual inspection.

The focused domain suites are contracts `test/production-setup.test.ts`, coordinator
`test/productions/setup.test.ts`, `setup-plan.test.ts`, `setup-run.test.ts`, and client
`test/production-setup.test.tsx`. The lifecycle suite injects actual commit journal failures;
its recovery assertions must pass without dismissing external-edit warnings.

## World overview on phone and Fold7

`node scripts/smoke-world-layout.mjs` bundles the real world layout and overview with the
complete client stylesheet stack, then opens disposable fixtures in headless Chrome. Set
`ARKE_CHROME` if Chrome is not at the platform's default installation path. It checks 360,
375 and 390px phones, a 600px window, Fold7 and desktop, including sticky tabs, active Canon
and Cast visibility, long file-warning paths, pending portraits and keyboard renaming.

The reported temporary directory contains implementation screenshots, the four turn 160
master frames and geometry measurements. Main composition bounds must agree within one CSS
pixel. Status bars and home indicators are excluded; the phone's bottom safe area is simulated
as 20px. Cast drift is frozen in both captures, and actual hover/pointer media queries are
asserted. Counts and progress remain derived from the fixture, so copy differs from the
master's illustrative data. Inspect the pictures alongside the measurements.

`node scripts/smoke-world-layout.mjs --baseline <pre-change-commit>` also renders the old
world component and fidelity stylesheet against the same desktop fixture for comparison.

## Launch surface and remote pairing

`node scripts/smoke-launch-layout.mjs` renders the real launch components in sandboxed
Chromium at turn 158's desktop, minimum-window, phone and Fold7 sizes. It keeps screenshots
and layout measurements in the reported temporary directory, alongside frames extracted from
the design master. Mobile safe-area inputs are simulated in the fixture CSS; device status
bars, the home indicator and the canvas-only Loop mark are excluded from the comparison.
Every master variant is explicitly mapped to an implementation frame, with geometry checked
within one CSS pixel for fractional `dvh` rounding. The typing frame subtracts the master's
drawn keyboard from the app viewport. Check the images as well as these geometry, overflow
and touch-target assertions.

After building, `node --import tsx apps/desktop/scripts/smoke-remote-access.mjs --tailscale`
checks the served client over actual Tailscale TLS with disposable world data and profiles.
It uses an unused HTTPS port 8444, restores its own mapping, and exercises approval over a
world screen through the real sandboxed Electron file page/preload, persistent cookies,
browser reopen, host restart and revocation. It requires an available Tailscale connection.
Physical phone/Fold7 keyboard and bookmark testing is still a separate acceptance step.

## Character pages and phone sheets

Run `node scripts/smoke-character-layout.mjs` from the repository root for design turn 162.
It bundles the real screens and the complete client cascade against disposable fixtures, opens
headless Chrome, and saves screenshots and measurements beside the temporary path it prints.
Set `ARKE_CHROME` if Chrome is installed somewhere other than the platform default. The server
binds only to loopback and serves the disposable bundle and committed design assets.

The check covers 360, 375 and 390px phones, a 600px window, Fold7 and 1360×850 desktop,
including dialogs opened after scrolling, the sample review, long names and pending candidates.
It also checks an unaccepted legacy portrait at every width: the adoption control remains
reachable, sends the existing acceptance command and disables while that acceptance is pending.
Inspect the paired `ch162*` master frames and application screenshots; the phone status bar
and Fold7 status bar are excluded from both app crops. The fixture simulates a 20px bottom safe
area. `--baseline <revision>` captures the desktop before the change; `--viewport phone375`
and `--pages-only` help iterate on a bounded visual failure.
Combine `--pages-only --route kit` to check Reference and portrait adoption without the other
character surfaces; `--route` also accepts `looks` or `voice`.
Add `--import-look` to `--pages-only --route looks` to check the file/name/type form, correlated
failure and success receipts, and that import leaves acceptance to the existing gallery. This
also adds 768px tablet, 1920px desktop and a 480px-high window: the import uses the bounded
generation-dialog frame above phone width, keeps its footer visible, contains keyboard focus,
and restores the opener on Escape without sending an import. Busy/error and phone/desktop dark
captures supplement the normal views; compare them with turn 162, rather than relying on
containment assertions alone.

The master's sheet starts 84px below the page area's top, after the 52px bar and 57px pill strip
(193px in the app viewport). Character generation routes retain that phone backdrop while
remaining full-frame dialogs on desktop. Shared page geometry is compared within one CSS pixel.

Fixture copy, provider availability and the master’s illustrative content are separate from
layout: a pending look offers acceptance, an accepted look offers attachment/promotion, and
generation previews show actual returned candidates. No screenshot check dispatches a provider
call or assigns a real voice.

## Bible and Canon on phones and Fold7

Run `node scripts/smoke-bible-canon-layout.mjs` from the repository root, with Chrome installed
(or `ARKE_CHROME` pointing to its executable). The local fixture harness captures the five React
screens and turn 163 at 390px and 984px, plus 360px, 375×812, 600px, 844px, 984×1092 and
1360×850 checks. It exercises contents, Restore, heading navigation, amendment, settlement,
new entries, answers/refusals and long text, and measures the grids, rails, touch media queries
and overflow. It simulates a 20px bottom safe area. No coordinator or paid provider is used.

The script prints its temporary artifact directory. `--viewport phone` selects the 390px pass;
`--baseline <revision>` captures desktop using that revision's original screens. Compare
`measurements.json` and the paired PNGs with `master-measurements.json`. Master crops omit the
47px phone / 32px Fold OS status bar; the full-height checks use the requested browser viewport.
Fixture counts, version dates and available transcripts remain live data, not design placeholders.

The DOM suite `test/bible-canon-layout.test.tsx` covers the settlement controls in the sheet,
draft retention through resize, Bible Restore and inline price confirmation, and CSS-owned canon
geometry. Run it from `packages/client`; typecheck after changes.

## World Chat and Artifacts on phones and Fold7

Run `node scripts/smoke-chat-artifacts-layout.mjs` with Chrome installed (or `ARKE_CHROME`
pointing to it). The full React app and client cascade run against a local fixture, without a
coordinator or provider. The script captures all eight turn 164 frames and exercises the phone
list/New flow, row and conversation sheets, understood/Accept all, the Fold history drawer,
filtered viewer navigation, swipe, Details/Escape, long text, overflow and a simulated bottom
safe area. Widths include 360, 375, 390, 600, 860, 984, 1024, 1200 and 1360; the requested Fold viewport is
also checked at 984×1092. OS status bars are omitted from the matching master crops.

The printed temporary directory contains PNGs, `measurements.json` and
`master-measurements.json`. `--viewport phone` selects the 390px pass; `--baseline <revision>`
captures desktop with the original screens for comparison. Fixture counts, record names and
available commands stay truthful to app data. Turn 164 remains the phone/artifact geometry
reference; World Chat's desktop split now carries the available height through its shared
portal host and lets the author collapse notes (#1993). The smoke checks navigation/composer
bounds, notes toggling and inner overflow. For native acceptance, prepare a disposable pending
review and verify the unsent draft and action survive collapse/reload at 1024/1200/1536px.

`--production-history` exercises the distinct production-context history route (#2019), using
the same app and cascade at those nine widths. It checks a pending action, a completed receipt,
the shared global panel, retained draft and selected conversation after remount, and phone
Back/list navigation with a remembered world conversation. It verifies a visible phone Canvas
entry, pending-consequence history order and Fold drawer dismissal after choosing a row.
Retained production-page conversations must rehost at their history URL, including a trailing
slash; phone Back must also uncover the list when invoked inside the global Chat panel.
Desktop and phone also receive dark-theme captures. Inspect the complete
screenshots against turns 164/196/225; a passing overflow check alone is not design acceptance.
The native check opens a saved production conversation and verifies its exact card and draft
across reload without sending a message or deciding a card.

Run `test/chat-artifacts-layout.test.tsx` from the client package alongside `world-chat`,
`artifact-viewers`, `artifacts` and `production-artifacts`. It covers command revision binding,
empty/nonempty desktop notes, phone New, menu confirmation, reply read/copy controls and filtered navigation that retains the selected artifact across
live insertions. Typecheck after test edits.

## Productions on phones and Fold7

Run `node scripts/smoke-productions-layout.mjs` with Chrome installed (or `ARKE_CHROME`
pointing to it). It renders the actual app with schema-checked film, story and episodic fixtures,
without a coordinator or provider. It checks Productions, the door, the reachable CHOOSE step two,
the production switcher, settings, season/episode Arke sheets, long text and touch navigation drawers at
360, 375, 390, 600, 984 and 1360px. The Fold also runs at the requested 984×1092. Phone captures
simulate a 20px bottom safe area; master crops omit the OS status bars.

The printed temporary directory contains screenshots and measured geometry for all seven turn
166 master frames. `--viewport phone` runs just 390px; `--baseline <revision>` renders desktop
with that revision's screens. Compare the PNGs and JSON geometry. WATCH still opens its setup
conversation: the drawn legacy WATCH form is not a reachable step-two fixture. Counts, content,
media and available model choices remain app data rather than static design copy.

The client `test/productions-layout.test.tsx` covers every format's page destinations, switching,
coarse-pointer folding, resize across the phone breakpoint, season/episode Arke sheets, desktop menu focus, the held footer and WATCH routing.
Run alongside the existing new-production, dashboard, development and production-navigation tests.
Typecheck after test changes.

## Art direction on phones and Fold7

Run `node scripts/smoke-art-direction-layout.mjs` with Chrome installed (or set
`ARKE_CHROME`). It uses the real app and schema-checked local fixtures for accepted and
empty pictures, long descriptions, staged changes and generation previews. Captures cover
360, 375, 390, 600, 984 and 1360px, including the Models sheet and the held acceptance action.
The printed directory includes all seven turn 167 master frames and measured geometry.
`--viewport phone` narrows a run; `--hover --viewport desktop` checks invisible picture
doors using Chrome's real pointer/hover media queries. Add `--baseline <revision>` to
render the earlier desktop with the same fixture. Touch controls are checked at every width.

Client `test/art-direction-layout.test.tsx` covers touch doors, full titles, model access
and the authored/staged footer commands. Run alongside art-direction-step, generation-dialog,
dispatch-bar and chrome tests. Typecheck after test changes.

## Cast on phones and Fold7

Run `node scripts/smoke-cast-layout.mjs` with Chrome installed (`ARKE_CHROME` overrides
its location). The real app and complete CSS cascade use an isolated fixture and local media,
without a coordinator or paid generation. Captures cover Cast, Locations, Factions, Props,
character overview, long names and prop creation at 360, 375, 390, 600, 984 and 1360px.
The printed directory includes PNGs, measurements and all eight turn 161 master frames.
`--viewport phone` narrows a run; `--baseline <revision> --viewport desktop` checks the
unchanged desktop with the same fixture. Compare geometry and images; counts and sheet
content remain live data. Character rename, duplicate, promote and retire remain available.

`--reading` checks short and long character prose at 320/390/600/984/1024/1200/1536px,
including enlarged text and 125% CSS zoom. It verifies full-width details below identity,
unchanged section text, no horizontal overflow and reached headings below navigation (#1996).
The narrower CSS viewports also exercise zoom reflow. Native acceptance compares the entire
sheet text before/after and verifies section Read aloud/Copy controls at 1024/1200/1536px.

Run client `test/cast-layout.test.tsx` alongside props, pending-sheets, character-pages
and world-card-heights tests, and typecheck after changing tests.

## CI

Additional conversation input (#1138) has journal, recovery and compatibility coverage in
coordinator `test/world-chat/input-journal.test.ts`, and queued-turn execution in `run.test.ts`,
beside the existing store, recovery, summarisation and wrap-up suites. The opt-in Codex and
OpenCode native protocol probes, their environment variables and the builds they were measured
against are in [conversation inputs](conversation-inputs.md#native-protocol-evidence). They make no
paid model call and do not qualify an adapter for native steering.

For Gemini preset activation, run providers `test/gemini-activation.test.ts` and
`test/google-tts.test.ts`, coordinator `test/audio/performance-generation.test.ts` and
`test/voice/service.test.ts`, `test/audio/table-read.test.ts`, `test/voice/page-read.test.ts` and
`test/voice/voiced-read.test.ts`; run client `test/gemini-voice-preference.test.tsx`,
`test/character-dialog.test.tsx` and `test/voice-line.test.tsx` from its package.
These use fixtures: catalogue discovery is read-only, saved selections survive recommendation
changes, and setup never generates audio. See [Gemini speech](gemini-speech.md) for the paid
qualification boundary; fixture tests do not establish listening quality or account quota.
`node --import tsx scripts/smoke-gemini-voices.mjs` renders both pickers in a sandboxed
Electron file page at 1200 × 790 and 1024 × 640, blocks network requests, checks retained
selection/no generation and saves screenshots for visual inspection.

For publications, run coordinator `test/publications/`, desktop `test/publication-host.test.ts`
with `preload-auth.test.ts` and `transport-auth.test.ts`, and client `test/publications.test.tsx`
with `routes.test.tsx` from the client package. After building, the real desktop file-page check is:

```powershell
$env:ARKE_TEST_FFMPEG = 'C:/path/to/ffmpeg.exe'
$env:ARKE_TEST_FFPROBE = 'C:/path/to/ffprobe.exe'
node apps/desktop/scripts/smoke-publications.mjs
```

It opens the built client/preload without a coordinator or world, pins directory and ZIP packages,
removes their source files, blocks external network requests and checks video, two caption tracks,
captions off, seeking and keyboard play/pause. It leaves `.dev/publication-player.png` for visual
inspection and removes its temporary profile/package. The same variables enable the coordinator's
real encode/ZIP/decode test. The smoke requires a desktop display (or an appropriate Linux display
environment); ordinary CI unit tests do not replace it.

[ci.yml](../../.github/workflows/ci.yml) runs on Windows and Linux with four coordinator shards and a separate other-workspaces job per platform. Shard 1 runs lint, typecheck, build and the CI planner tests. [ci-test.mjs](../../scripts/ci-test.mjs) partitions coordinator tests using Node's discovered file list and discovers every other workspace with a test script. To inspect a shard locally, run `node scripts/ci-test.mjs 1/4` from the root; this is only that coordinator shard, not the complete CI gate. Run `node scripts/ci-test.mjs workspaces` for the other workspaces, or omit the selector for the complete unsharded test run. `node --test scripts/ci-test-plan.test.mjs` checks that the job plans cover every discovered workspace without duplication or omission.

The runner uses a silence guard as well as a workflow timeout. Diagnose leaked resources before treating a silent run as merely slow. Local Windows success cannot establish Linux path/case correctness. Packaging/release workflows perform additional delivery work beyond CI's build.

## AI Stage and camera-reference changes

Follow [Stage evaluation](stage-evaluation.md) for fixture constraints, the actual WebGL/MP4 gate
and separate live-model cinematic evaluation. Focused regression set from the repository root:

```powershell
node --import tsx --test packages/contracts/test/staging.test.ts packages/contracts/test/stage-camera-semantics.test.ts packages/contracts/test/stage-scenes.test.ts packages/coordinator/test/productions/stage-construction.test.ts packages/coordinator/test/productions/stage-playblast.test.ts
```

Use the client scene-workspace tests for Keep/Discard and scope controls, and coordinator scene
commands/bench tests for versioning, restore and reference admission. No paid generation is part
of the normal gate.

For the embeddable Node package, run `npm test --workspace @arke-studio/engine`. This builds and installs the packed artifact outside the checkout, runs the initial authoring journey and validates declarations. It requires registry access but no paid provider. Coordinator `test/application/engine.test.ts` covers the shared services; see the [engine guide](engine.md).

## Scenes, shots and Stage on touch (turn 168)

From the repository root, run `node scripts/smoke-scenes-layout.mjs`. It bundles the actual app and all client styles with `scenes-layout-fixture.ts`, serves local fixture media, and uses headless Chrome at 360, 375, 390, 600, 984 and 1360 CSS pixels. The check renders all eight turn-168 master frames beside the live Scenes, scene, shot, field, action sheet, Arke and Stage views. It checks horizontal overflow, native sheets, omitted phone Flow, and all four Stage gestures through real touch input. The printed temporary directory retains PNGs, layout measurements and the gesture camera poses. Set `ARKE_CHROME` if Chrome is elsewhere.

`--viewport phone`, `--viewport fold`, and `--viewport desktop --hover` narrow the run. `--baseline <git-ref> --viewport desktop --hover` renders the previous implementation with the same fixture for desktop comparison. The renderer test `scenes-layout.test.tsx` covers reorder/insert without drag, delete confirmation, synopsis, Rename, additional Camera settings, and resizing out of Flow. Keep the existing scene-workspace, shot-page, Stage and frame-run suites in the regression set; the browser check does not substitute for their write/acceptance tests.

## Generate and the frame run on touch (turn 169)

Run `node scripts/smoke-generate-layout.mjs` from the repository root. It renders the actual
takes, Advanced lens, contact sheet, generation dialog, run bar and Review at 360, 375, 390,
984 and 1360 pixels, alongside all eight master frames. Advanced lens also runs at 600, 820
and the 1024px native minimum: the preview must fill its column, the take strip must follow
it, and decision buttons must fit without overlap. At 600px the preview, strip and brief
stack in the phone's order with in-flow tablet controls. It exercises explicit rejection
citations, model availability, touch targets, native sheets, arrow navigation and a real touch
swipe. The printed temporary directory keeps the PNGs and geometry. The fixture uses FFmpeg
to make a local landscape clip; no provider is contacted. Set `ARKE_CHROME` if needed.

Use `--viewport phone`, `--viewport narrow`, `--viewport tablet`, `--viewport fold`,
`--viewport native-min`, or `--viewport desktop --hover` to narrow the run,
and `--baseline <git-ref> --viewport desktop --hover` to compare the previous implementation.
The `generate-layout.test.tsx` renderer suite covers payloads, offline rejection, variants
acceptance and run commands; retain takes-view, frame-run and scene-workspace-preview tests.

### Cut on phones and Fold (turn 170)

Run `node scripts/smoke-cut-layout.mjs` from the repository root. It mounts the actual Cut with
saved timeline state at 360, 375, 390, 812 landscape, 984 and 1360 pixels, renders all eight
turn-170 master frames, and saves screenshots and geometry in the printed temporary directory.
The phone checks exercise native Trim, Library, Add shots, Export and Arke sheets, plus real
Chrome touch pan and pinch. FFmpeg creates local clips and audio; no provider is contacted.
Use `--viewport phone`, `--viewport turned`, `--viewport fold` or `--viewport desktop --hover`;
`--baseline <git-ref> --viewport desktop --hover` captures the previous mouse layout with the
same media. Inspect the PNGs alongside the master; geometry alone is not a visual sign-off.

`test/cut-layout.test.tsx` covers touch thresholds, audio menus, canceled long presses, remote
import refusal, frame stepping, compact timecode entry, draft retention on resize, base-lane
protection and explicit Library placement. Retain the existing editor drag/drop, trim, playhead,
Library, export and undo suites when changing these paths.

### Develop, Overview and the composer on touch (turn 171)

Run `node scripts/smoke-develop-layout.mjs` to render the actual Develop conversation, understood
and staged sheets, story Overview, acts, style and film Narrative at 360, 375, 390, 599, 600, 768,
852, 899, 900, 984, 1200, 1360 and 2040
pixels. It captures all eight master frames for visual comparison, checks overflow and held
controls, and exercises coarse-pointer Return, model sheets, read sources and narrative saves.
Develop also checks empty notes, timeout retry, elapsed time and Stop, plus collapsing and
reopening notes without losing staged proposals. It closes Studio through its normal control
to exercise the resting conversation. `--viewport desktop-small --hover` reproduces #1926.
Below 900px it also checks that the conversation fills the available width and that notes and
staged/conflicted proposals remain reachable in their sheet (#2008). `--viewport tablet-start`,
`tablet`, `tablet-end` and `fold-start` cover the tablet layout and its grid boundary.
Use `--viewport phone`, `--viewport fold` or `--viewport desktop --hover` to narrow the run;
`--baseline <git-ref> --viewport desktop --hover` supplies the previous mouse layout.

The renderer suite `test/develop-layout.test.tsx` covers revision-safe points, staged acceptance
reasons, draft and pending retention across resizing, device file selection, per-act speech,
narrative conflicts and keyboard viewport insets. Device uploads are limited to 16 MiB, accept
bytes rather than host paths, and reuse the conversation attachment writer. Run contracts
`test/browser-attachment.test.ts` and coordinator `test/world-chat/browser-upload.test.ts`,
`test/remote-access.test.ts` and `test/voice/page-read.test.ts` for that boundary and the speech
source. Preserve the existing conversation, composer, production and page-read regression suites.

### Seasons, episodes, branch map and setup on touch (turn 172)

Run `node scripts/smoke-season-layout.mjs` for the real React screens with the full CSS cascade,
the fixture in `packages/client/test/season-layout-fixture.ts`, and all eight master frames.
Chrome checks 390, 360 and 375px phones, 984px Fold and 1360px desktop; episode menu reorder,
episode promise reading and scene creation, Arke and understood sheets, choice creation without
dragging, pinch zoom with a 44px screen-space port, and setup without automatic keyboard focus.
Screenshots and measured geometry are saved to the reported temporary directory.
Use `--viewport desktop --hover` for the fine-pointer desktop, and `--baseline <revision>`
to compare the pre-change screen sources. Selection/gesture renderer coverage is in
`test/season-layout.test.tsx`; run it with the existing development, branch-map, setup and
interactive-player suites. Coordinator `test/voice/service.test.ts` covers authoritative
episode promise reads. No hardware touch device is assumed by these checks.

### Chapters and audiobook on touch (turn 173)

Run `node scripts/smoke-chapter-responsive.mjs` for real React captures at 360, 375, 390,
984 and 1360px, including all eight turn-173 frames and 165l/m. The run checks overflow,
chapter actions, native passage selections, Notes and block sheets, and narrator selection.
Use `--viewport desktop --hover` for the unchanged mouse layout or add `--baseline <revision>`
to render its prior implementation. Inspect the emitted screenshots alongside the master.
`test/chapter-layout.test.tsx` covers source selectionchange, card actions, draft retention
and attended passage decisions; retain the chapter-workspace, chapter-audiobook,
audiobook-door, production-story, manuscript and player suites. Chrome emulates coarse
pointers; a real touch-device check is additional when hardware is available.

### Settings, Activity, account and remote ownership (turn 175)

Run `node scripts/smoke-settings-responsive.mjs` for actual React captures at 360, 375, 390,
984 and 1360px, alongside all eight turn-175 master frames. It checks sections and detail
navigation, stacked defaults, overflow, 44px touch targets, two Fold model cards across,
device-only pairing facts, populated Downloads/local-model rows, and Activity surviving an outside scroll before closing on a tap.
Use `--viewport acceptance`, `--viewport fold`, or `--viewport desktop --hover` for a focused
run; `--baseline <revision>` renders the earlier desktop sources. Visually inspect the emitted
PNGs against the master. Add `--remote` to a desktop run to check paired-browser ownership at
wide widths. These are emulated Chrome viewports, not physical-device testing.

Run `node --import tsx scripts/smoke-remote-host-boundary.mts` for a real Chrome session paired
over local HTTPS against the gateway. It verifies every named host command returns a typed
refusal without disconnecting, an allowed command still works, and the trusted transport
still passes the same commands. Conversation decisions receive a gateway-imposed restriction;
coordinator `test/arke-actions/lifecycle.test.ts` checks the durable action before approval or replay,
while keeping remote denial and ordinary authored approvals available. Chrome and OpenSSL must be installed (`ARKE_CHROME` and
`ARKE_OPENSSL` override their paths); the temporary certificate and pairing state stay local.
Keep contracts `test/remote-command-access.test.ts` (exhaustive command/prepared-action ownership and mixed
payloads), coordinator `test/remote-access.test.ts`, client `test/settings-responsive.test.tsx`,
the existing Settings/Activity/account/chrome suites, and desktop transport/preload auth tests
in the gate. The browser notification preference is device-local and tested separately from
the PC's background-notification command.

General speech selectors are covered by client `test/settings-general.test.tsx`. The retired
local speech route must stay absent from recipes, manifest preferences, setup downloads and
voice candidates; regressions live in provider `test/comfyui.test.ts`, desktop
`test/comfyui-setup.test.ts`, and coordinator `test/voice/service.test.ts`. Old queued model
identities must refuse before contacting an engine.

For SPEC-051 R-55/R-57 (#1425), client `production-card-body.test.tsx` and
`frame-run.test.tsx` cover frozen native Stage targets, exact playblast completion,
live run correlation and per-job frame thumbnails. The focused `approved Stage action`
coordinator case verifies host replay and recovery preserve the immutable video receipt;
`retained construction` cases preserve human Keep without another renderer handoff.
The production-card Chrome smoke also checks Stage and run bodies at all four widths.

Audiobook proposal and spend reviews (#1675) use client `test/chapter-audiobook.test.tsx`
and `test/sheet-stacking.test.tsx`. Run `node scripts/smoke-audiobook-panels.mjs` with Chrome
installed (`ARKE_CHROME` overrides its path) for the native modal journey at 1800, 1200, 800
and 390 px: open dock and block, receive an illustration, receive a read quote above it,
Escape back to the proposal, then accept once. It checks one active dialog, keyboard focus,
contained price controls and absence of background purchases, and writes screenshots and
measurements into the printed temporary directory. The fixture uses invented prose and a
capturing bridge; no installed app, world or paid provider is involved.

Chapter narration Activity (turn 206, #1684) has focused contracts identity/cost tests,
coordinator `test/productions/audiobook-activity.test.ts` for restart, corruption and stop
ordering, and `audiobook-grouped.test.ts` for provider success followed by local alignment
and durable block writes. The grouped suite also covers local transcription failure, preserved
received WAVs across reopen, retry without synthesis and previously completed groups. It checks
paid grouped Hear retries against the original cache identity and world/production/chapter scope,
without creating chapter takes;
`test/voice/transcription-rate.test.ts` distinguishes an HTTP 503 from a successful empty
transcript (#1932). Client `activity-panel.test.tsx` and
`queue-toaster-lifetime.test.tsx` cover one row and bounded receipts. Run
`node scripts/smoke-audiobook-activity.mjs` with Chrome (`ARKE_CHROME` overrides its path)
for synthetic screenshots and overflow/action measurements at 1400, 390 and 320 px.
`node scripts/smoke-audiobook-parity.mjs --output <review-directory>` renders the eight approved
turn206 frames directly from the master alongside real components at matching viewports. Its
`paired.html` preserves full frames and separately crops the affected receipt/footer/panel;
the master chapter background is schematic, while the actual side uses the retained chapter
screen. The harness uses its own headless Chrome profile and public synthetic content.


Chapter export inclusion (turn 209, #1688) has scoped listening/player and video regressions in
coordinator `test/productions/audiobook-listening.test.ts` and `audiobook-video.test.ts`. They
cover incomplete/missing chapter refusal, manifests, delivery identity, unchanged encode reuse
and interrupted-job recovery; client `audiobook-export.test.tsx` covers scope/format changes and
stale readiness, and `chapter-audiobook.test.tsx` covers the missing-block quote and return.
Run `node scripts/smoke-chapter-scope-parity.mjs --out <review-directory>` for fourteen literal
master/full-App pairs: chapter action menus, normal Read, ready Direction, Activity, both export
formats/scopes, blocked recovery, render progress and desktop/phone return. The bridge validates
its synthetic events and asserts no export fallback, no implicit read confirmation, no cancellation
on close, selected-block/focus return and reserved native footers. Use `--frame 209o --width 320`
or `--frame 209o --text-scale 2` in a separate output directory for supplementary narrow/text-zoom
captures. Retained detailed destinations and known schematic differences are labelled explicitly
in `paired.html`; screenshots alone do not establish universal visual parity. Chrome runs headless
with a dedicated profile; this test never attaches to the installed app or a private world.

### Private story Publish (turn 224)

Contracts test/story-publication.test.ts, coordinator test/publications/story.test.ts, and
client test/manuscript.test.tsx cover optional style rules, explicit approval, stale proposals,
version restoration, dependent narration, frozen files, cancellation and retry. Run client
tests from packages/client. Transport and desktop authentication regressions remain required.

Run node scripts/smoke-story-publish.mjs to build the real component and sandboxed preload,
open an Electron file page, and check desktop/Fold/phone layouts, approval/preview/create controls,
the native save IPC bridge and authenticated media. Its save dialog and coordinator responses
are fixtures, so it does not prove a real OS file-picker interaction. Set
ARKE_STORY_LAYOUT_OUTPUT to retain screenshots.

From packages/coordinator, set ARKE_STORY_CODEC_SMOKE=1 and run
node --import tsx --test --test-name-pattern="real AAC M4B" test/publications/story.test.ts
with FFmpeg/ffprobe on PATH (or ARKE_FFMPEG/ARKE_FFPROBE). This opt-in test builds two actual
chapter mixes, verifies AAC, chapter order, author metadata, cover art and packaged EPUB text.
ARKE_STORY_SMOKE_OUTPUT retains the EPUB, M4B and probe report. Test tones replace provider
speech; no generation is charged. External EPUB validation and physical phone import/playback
are separate acceptance checks and must be reported separately.


## Optional local audio listener

See [audio listening](audio-listening.md) for host setup, focused tests and the live-quality
boundary. CI shard 1 on Windows/Linux runs the stdlib Python worker protocol test without weights
or GPU. The ordinary coordinator suite includes listening schemas, canonical waveform handoff,
native Stop/output bounds, lease/source revocation, MCP and schema-81 replay. Actual music,
perceived-emotion and voice-delivery accuracy requires an installed-model smoke and human review.

Chapter review: run the contract evidence tests, coordinator production and harness review tests, and client review tests described in [chapter-review.md](chapter-review.md). Include action registry and picture-brief tests when changing orchestration or camera guidance. Fixture tests do not establish live-model judgment quality.


### Snapshot size and slow remote delivery

Run contracts `test/job-summary.test.ts`, coordinator `test/socket-writer.test.ts`,
`test/transport.test.ts` and `test/remote-access.test.ts`, plus client
`test/snapshot-history.test.ts` from the client directory. These cover payload projection without
journal mutation, recovery metadata, byte/frame queue bounds, stalled sends, event ordering,
negotiated history retention and fresh history on reconnect. Keep the transport-auth,
preload-auth and both dev-session regressions listed in CLAUDE.md. After building, run
`node --import tsx apps/desktop/scripts/smoke-transport-flow.mjs` for the real sandboxed file-page
hello, compact/repeated snapshots and authenticated media range. This disposable local check
uses no generation and does not establish performance on a physical phone or through Tailscale.

Illustrated EPUB (#2033) adds coordinator `test/publications/story-illustrations.test.ts` and
`story-routes.test.ts`, contracts `test/story-publication.test.ts`, and client
`test/audiobook-export.test.tsx`. Run the client checks with `packages/client` as cwd. Verify the
built Electron app too: image inspection must not depend on PDFKit standard-font lookup in the
main bundle. For a real illustrated story, use Publish with Include attached illustrations,
review all selected chapters, inspect captured pages, Create, restart, and verify the same edition.
Compare PNG/JPEG inventory and manuscript text/order to the captured input; inspect phone,
tablet and desktop layouts against approved turn 224. This does not establish physical reader
or Send to Kindle compatibility.

For ready-edition EPUB preview (#2062), verify the Publications route with no world open,
chapter navigation and captured pictures, Done/close focus return, and no preparation or
provider command. Client `audiobook-export.test.tsx` exercises those interactions; coordinator
`publications/story-illustrations.test.ts` reopens the service after moving the entire source
world away and compares the ready edition and EPUB bytes. Compare the reader sheet against
master 224d/224h at phone, tablet and desktop widths.

Audiobook connection interruption (#2067): coordinator `test/productions/audiobook-grouped.test.ts`
covers thrown and durable offline failures in solo/grouped reads, no later provider requests or
review flags, exact saved-take/part preservation and explicitly confirmed recovery. Run it with
`test/queue/classify.test.ts` and `test/productions/audiobook-activity.test.ts`; queue retry policy
and witnessed terminal errors remain separate. Compare the existing turn-206 Activity interruption
wording at phone, tablet and desktop widths. Synthetic component screenshots do not establish
native provider recovery; report any controlled live interruption separately.

## Completed result storage

Run coordinator `test/queue/artifact-files.test.ts`, `result-storage.test.ts`,
`dispatcher.test.ts`, `speech-pricing.test.ts` and `test/storage/job-artifacts.test.ts`, plus
the shared storage regression directory. These require ordinary native filesystem access for
atomic temporary-file rename; a restricted sandbox's denied rename is not a disk-full fault.
The tests inject capacity/accounting failures with small synthetic bytes, never fill a disk,
contact a provider, run inference or delete source media. They cover exact result recovery after
provider expiry, rejected accepted-facts appends, ownership loss before publication, complete
prefix reuse, repeated legacy receipt recovery, partial publication and all-published adoption
without another payload grant, cancellation, accounting reconciliation and unchanged charge identities. Run all
affected types after final test edits. Full CI remains necessary for Windows/Linux differences.
The result-storage tests also hold checkpoint/world writes after completed inline/remote output,
then admit another engine through the real shared GPU scheduler. Retrieval must finish first;
handover must settle before the next inference, and later job settlement cannot release that
other owner's reservation. No submit, poll, fetch or charge is repeated during local storage retries.

Regeneration also covers a larger ordinary destination being replaced by a smaller valid result
after normal capacity admission. Different-sized staging/destination files are cache misses;
private receipt blobs retain strict bounds/digest validation. The Linux production-factory test
requires its actual `linux-mountinfo` source and measured/quota-limited or explicitly unsupported
facts, rather than the historical unsupported-only expectation.

## Studio operational session boundary

Run contracts `test/confinement.test.ts` and coordinator `test/harness/operational-confinement.test.ts`,
`test/harness/session-files.test.ts` and `test/local-gpu.test.ts`. Native filesystem access is needed
for role-root identity, preparation writes and the existing host/queue cleanup cases. Operational
tool refusals are exercised through the actual OpenCode v2, Claude and Codex gates, including
research enabled and rewritten briefs. Configuration tests inspect what reaches adapter preparation
and pin the same operational role at creation, excluding world/author notes, query URLs, skills
and other-role overrides. GPU tests verify background sessions wait behind normal creative work,
preserve FIFO within each priority and cancel without releasing the admitted owner's lane.
These tests make no model call and do not qualify the production Studio integration, repair
registry, cloud/spend authorization or matched turn-239 visual gate.

Run coordinator `test/studio-assistant/*.test.ts` for the conversation core and private owner. Its native
file-backed/protocol fixtures verify bounded private history, interrupted phase reconciliation,
closed evidence and delegation, one-use nonlocal payload approval, route/generation fences,
late shutdown suppression, retained unknown model ownership and explicit draft-only handoff.
The composition case joins the actual conversation store, service, session runner and shared
GPU wrapper behind admitted creative work. It uses a synthetic protocol adapter, not a live
model. Native filesystem access is required for flushed atomic replacement. These tests establish
the core boundaries; they do not prove production model-route/spend or UI integration, provider spend
approval, live explanation quality, reviewed repair execution or visual parity.
Review regressions run through model validation, shared GPU and runtime-change wrappers in
production order: changing the route/locality or process generation during the GPU wait must
prevent the native send, and cancelling a queued turn must permit a new independent request
without releasing admitted creative work. Missing lifecycle revisions are refused. OpenCode
`test/v2-adapter.test.ts` verifies the concrete revision changes on confirmed exit/disposal;
`test/harness-runtime-change.test.ts` checks guarded sends cannot bypass runtime replacement/
recovery admission and that a rejecting final fence makes no native call.

Private-channel checks use coordinator `test/studio-assistant/transport.test.ts`, the existing
`test/transport.test.ts`/`test/remote-access.test.ts`, contracts `test/studio-assistant.test.ts`
and client `test/studio-assistant-transport.test.ts` (run client tests from that package).
They check two authenticated sockets, per-connection sequencing, initial reconciliation,
closed/refused reply capabilities, host-only paired-browser refusal, strict command bounds
and exclusion from common client state. Reconnect sends no private history automatically.
Client `test/studio-assistant.test.ts` covers retained drafts/model choices, repeated send
presses, correlated create/send, late receipts and observation-only reconnect. The component
suite `test/studio-assistant-view.test.tsx` mounts the production provider and titlebar to check
lazy private watch/unwatch, focus return, prompt-only draft changes and disclosure-specific
cloud consent. `test/global-chat.test.ts` checks named draft staging, exact replacement review
and capture/creation holds. Run from `packages/client`, then run the client typecheck after the
last test edit. These DOM/protocol checks do not establish native model operation or rendered
turn-239 parity. Do not replace required visual evidence with source/CSS assertions.
After building, `node --import tsx apps/desktop/scripts/smoke-transport-flow.mjs` checks a real
hidden sandboxed Electron file page and built preload, including a correlated private reply,
history negotiation/reset, hidden capability and authenticated media range. No model, paid
request or approved design-master rendering is involved.
`host.test.ts` additionally runs the production coordinator with a synthetic host model: private
history survives world opening/restart, wrong/duplicate cloud approvals cannot dispatch, and
non-requesting sockets/common state receive no transcript. Held history I/O returns unconfirmed,
keeps its pending admission, permits cancellation and cannot start late work after stop.
`store.test.ts` holds an actual atomic write through bounded shutdown, then verifies replacement
history waits for its settlement before reading/saving. The same-path barrier is not a multi-host
lock. These tests do not qualify real model-route/spend/trace privacy integration or the dialog.

## System status (turn 240)

Run contracts/coordinator/desktop `system-resources.test.ts`, coordinator
`system-resources-application.test.ts`, and client `system-panel.test.tsx`, `chrome.test.tsx`
and `settings-diagnostics-refresh.test.tsx`. Run client tests with `packages/client` as cwd.
The transport fixture needs ordinary native filesystem/loopback access for atomic temporary
world writes and authenticated WebSockets. The resource unit tests inject missing, reversed,
future/stale and uncooperative measurements, plus retained cleanup failure. They run no models
and fill no disk. Existing owned-process lifecycle tests qualify the reused GPU reader's job,
parent-lifetime and native cleanup boundary. Typecheck affected consumers after final test edits.

The deterministic actual-component review is built by
`node design-system/system-status-240.native-build.mjs` and served by
`node design-system/system-status-240.serve.mjs`. Compare native SystemPanel/AppChrome/PageSheet
against approved turn 240 at desktop/tablet/phone/reduced height in light/dark. Verify fixed
header/footer, independent body scroll, native modal Tab/Escape/focus return, unavailable/stale
readings, no refresh-time future-clock flicker and the existing Diagnostics handoff. This fixture
is separate from live-host collection and packaged Electron/physical-device keyboard acceptance;
see [system status](system-status.md).

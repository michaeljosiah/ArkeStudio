# Running and validating changes

Production whole-cut chat (#1420, SPEC-051 T-7) is covered by coordinator
`test/world-chat/actions.test.ts` (the `production whole cut` suite), contracts
`test/timeline-commands.test.ts`, and client `test/timeline-card-history.test.ts`.
They exercise approval-only ordered assembly, exact history and stale cards, typed overlay
split/rejoin with independently edited audio retained, local transcription quotes with no
pre-approval STT calls, changed bytes, cited subtitle drafts, and direct human Undo/Redo
matching. The contracts test replays placement into a remembered tail hole through both
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

## Select the checks

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

Windows CI shard 2 first checks the Codex file helper's private pipe and independent junction-mutation fixture with the Unicode/binary transfer and reparse regressions. This bounded preflight reports a native startup failure before the dependent adapter sessions each spend their own startup timeout; the full file-access suite still runs in the normal test gate.

Windows shard 3 likewise runs `test/harness/owned-child.test.ts` first to verify native process inspection and abrupt-exit cleanup before the full coordinator shard. These preflights retain the ordinary test assertions and remain part of the later full suites.

Coordinator `test/harness/stage-model-journey.test.ts` carries a live Stage model override through image-read receipts, canonical provenance, Keep, reopen and cancellation. It uses scripted model responses and PNG fixtures with the real coordinator and world persistence; renderer output and generation quality are separate checks.

## Fixtures and cleanup

Standalone host changes also run coordinator `test/studio-server.test.ts`, existing
`test/transport.test.ts` and Studio host lifecycle tests. The Node journey uses a copied
world, disables paid AI, exercises authenticated manuscript download and reopens saved prose.
Run client `test/manuscript.test.tsx`, `test/image-download.test.tsx`,
`test/dev-session.test.ts` and `test/dev-session-server.test.ts` for the browser path.
Desktop composition changes still require the desktop checks below.

Client `test/fixture-state.ts` provides fixture state; navigation samples are in `src/screens/registry.ts`. Read an adjacent screen test for DOM/store setup. Coordinator tests commonly copy world fixtures into temporary directories and inject providers or clocks. Reuse `test/queue/fake-provider.ts` for suitable queue scenarios and adjacent domain helpers rather than calling paid providers in ordinary regression tests.

Close stores, sockets, watchers, timers and supervisors in test cleanup before deleting temporary files. A leaked watcher can leave the runner alive after assertions finish. Fixture data under [fixtures](../../fixtures) also supplies the development/sample world: edit it intentionally and check its consumers, not as disposable test output.

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

Local Qwen Image 2.1 starts an isolated worker after download and has opt-in managed-runtime and provider GPU checks; see
[Qwen setup and validation](qwen21.md). Its runtime unit tests need Python but no GPU.

Local Krea 2 image generation has an opt-in GPU check and offline custom-node installer tests;
see the [Krea 2 integration guide](krea2.md). A returned PNG must be inspected visually: provider
success alone does not establish usable image quality.

## Writing engines and model control

Run the adapter package suites plus coordinator `test/harness/`, `test/v2-launch.test.ts`,
and client `test/harness-model-controls.test.tsx`, `test/agents.test.tsx`,
`test/settings-general.test.tsx`, `test/production-setup.test.tsx`. Catalog tests cover
canonical/legacy references, discovery failure and retry, precedence and Stage image capability.
Adapter tests exercise captured settings, confined tool access, cancellation and final-turn events.

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
(or `ARKE_CHROME`). It renders the fixture book's door and a chapter at 390, 820, 1440 and 2560
wide, opens Listen and Export, and checks each layer covers the window from the body with no
transformed or contained ancestor, Listen leads the head, and the chapter's Voices rail names a
designed voice and never overlaps it. `--out <dir>` keeps the screenshots; `--baseline <rev>`
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
Inspect the paired `ch162*` master frames and application screenshots; the phone status bar
and Fold7 status bar are excluded from both app crops. The fixture simulates a 20px bottom safe
area. `--baseline <revision>` captures the desktop before the change; `--viewport phone375`
and `--pages-only` help iterate on a bounded visual failure.

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
safe area. Widths include 360, 375, 390, 600, 860, 984 and 1360; the requested Fold viewport is
also checked at 984×1092. OS status bars are omitted from the matching master crops.

The printed temporary directory contains PNGs, `measurements.json` and
`master-measurements.json`. `--viewport phone` selects the 390px pass; `--baseline <revision>`
captures desktop with the original screens for comparison. Fixture counts, record names and
available commands stay truthful to app data; the master is the geometry reference.

Run `test/chat-artifacts-layout.test.tsx` from the client package alongside `world-chat`,
`artifact-viewers`, `artifacts` and `production-artifacts`. It covers command revision binding,
phone New, menu confirmation, reply read/copy controls and filtered navigation that retains the selected artifact across
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

[ci.yml](../../.github/workflows/ci.yml) runs on Windows and Linux with four shards per platform. Shard 1 runs lint, typecheck and build. [ci-test.mjs](../../scripts/ci-test.mjs) partitions coordinator tests and runs other workspaces on shard 2. To inspect a shard locally, run `node scripts/ci-test.mjs 1/4` from the root; this is only that test shard, not the complete CI gate.

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
984 and 1360 pixels, alongside all eight master frames. It exercises explicit rejection
citations, model availability, touch targets, native sheets, arrow navigation and a real touch
swipe. The printed temporary directory keeps the PNGs and geometry. The fixture uses FFmpeg
to make a local landscape clip; no provider is contacted. Set `ARKE_CHROME` if needed.

Use `--viewport phone`, `--viewport fold`, or `--viewport desktop --hover` to narrow the run,
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
and staged sheets, story Overview, acts, style and film Narrative at 360, 375, 390, 984 and 1360
pixels. It captures all eight master frames for visual comparison, checks overflow and held
controls, and exercises coarse-pointer Return, model sheets, read sources and narrative saves.
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

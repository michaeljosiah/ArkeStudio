# Running and validating changes

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

## Desktop appearance

For appearance bootstrap or reload changes, run `node apps/desktop/scripts/smoke-theme.mjs`.
It bundles only the preload and theme entry point, then checks first-paint system/explicit
choices across reloads of a sandboxed Electron file page. It uses a disposable profile and
process-local theme overrides; a desktop display is required.

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

## CI

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

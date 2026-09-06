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

Lint checks source text, rejects duplicate `specId` declarations under `docs/specifications/`, and runs oxlint over packages/apps; it does not lint all maintenance scripts. Run `node scripts/check-spec-ids.mjs` to check specification identity alone, including new files before staging them. Do not run `npm run format`: existing house formatting and Prettier disagree. `tsx` executes tests without typechecking, so typecheck after the last source or test edit.

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

Client tests use workspace-relative paths and must run with `packages/client` as cwd. Workspace npm scripts set that cwd for you. Check worktree-local package resolution before trusting cross-package results; see [worktree rules](../../CLAUDE.md#worktrees).

## Fixtures and cleanup

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

## Independent editor media

After building desktop, run `node apps/desktop/scripts/smoke-editor-import.mjs` from the repository root. It opens a hidden sandboxed Electron file page with the built preload, supplies real file-backed selections, and verifies ordered path resolution and private authentication. It uses a temporary profile and requires a desktop display (it is separate from headless CI).

For an actual encode/decode of the zero-scene import, detach and edit journey, set `ARKE_TEST_FFMPEG` to the installed ffmpeg executable and run coordinator `test/productions/editor-import.test.ts` from `packages/coordinator`. Without that variable, only the native encode case skips; persistence, stale revision, cancellation and role regressions still run. The native case creates its own short test footage and removes the original source files before exporting.

## CI

[ci.yml](../../.github/workflows/ci.yml) runs on Windows and Linux with four shards per platform. Shard 1 runs lint, typecheck and build. [ci-test.mjs](../../scripts/ci-test.mjs) partitions coordinator tests and runs other workspaces on shard 2. To inspect a shard locally, run `node scripts/ci-test.mjs 1/4` from the root; this is only that test shard, not the complete CI gate.

The runner uses a silence guard as well as a workflow timeout. Diagnose leaked resources before treating a silent run as merely slow. Local Windows success cannot establish Linux path/case correctness. Packaging/release workflows perform additional delivery work beyond CI's build.

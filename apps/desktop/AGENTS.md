# Desktop

Read the root guidance and [code map](../../docs/development/code-map.md). Paths below are relative to this package.

`src/main.ts` is the platform composition root: it constructs the coordinator and injects credentials, transports, media tools, runtime setup and shell integration. `src/startup.ts` defines startup support; `src/preload.ts` is the renderer boundary. Keep domain behavior in coordinator/contracts and platform-specific effects here.

For bridge changes inspect client `src/arke-bridge.d.ts` and transport usage. Preserve private capability handling, endpoint-scoped media headers and redirect removal; the precise rules are in [CLAUDE.md](../../CLAUDE.md). A mock or data-URL smoke test does not establish sandboxed Electron file-page behavior.

For lifecycle changes follow `shutdownConfirmed()` and the `before-quit` path through `Coordinator.stop()`, including startup-failure cleanup. Inspect `src/take-qc.ts` and `src/media-probe.ts` for native media process handling; preserve timeouts and cleanup when extending it.

Build/runtime ownership lives in `scripts/` and package.json. Read [maintenance.md](../../docs/development/maintenance.md) before changing bundled runtimes or generated assets. Host Node and Electron use different native SQLite binaries; preserve the rebuild and alias arrangement. External copyleft media executables remain separate processes; see CONTRIBUTING.md.

Use package tests for platform helpers, `smoke:main` for the built main bundle and the relevant packaging checks for delivery changes. See [testing.md](../../docs/development/testing.md). Building is not packaging, and neither alone proves first-run runtime setup works.

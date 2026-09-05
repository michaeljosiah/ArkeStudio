# Coordinator

Read the root guidance and [code map](../../docs/development/code-map.md). Paths below are relative to this package.

`src/coordinator.ts` composes application services, routes wire commands and publishes state. Search the exact message `kind` from contracts to find a handler, then follow its domain imports. Place domain behavior beside its existing owner (`gate/`, `world/`, `productions/`, `queue/`, `voice/`, `world-chat/`, `bench/`) and keep shared pure calculations in contracts.

`src/world-provider.ts` is the interface; `src/world/provider.ts` is the filesystem implementation. Read `world/store.ts`, `world/commit.ts` and the relevant gate operation before changing writes. Authored acceptance, production edits, operational journals and derived caches have different rules. Consult [filesystem operations](../../docs/filesystem-operations.md), SPEC-002 and SPEC-004 rather than routing every write through an invented common gate.

Preserve the ownership, authenticated transport and flushed-journal rules in [CLAUDE.md](../../CLAUDE.md). For changes to job recovery, also read SPEC-009's crash model. An unknown provider outcome is not permission to resubmit.

Track asynchronous work and its cancellation/drain in the existing lifecycle. Inspect `Coordinator.stop()`, WorldStore close and supervisor cleanup when adding timers, watchers, provider work or subprocesses. Work must not resurrect a service during shutdown.

If an event or snapshot changes, inspect both `src/read-model.ts` and client `src/lib/store.ts`, plus shared frames/events schemas. Concrete adapter imports belong in `src/harness/v2-launch.ts`; desktop and dev use that assembly boundary.

Tests generally mirror domain folders under `test/`. Use [testing.md](../../docs/development/testing.md) for commands. Persistence tests should exercise a temporary copied world and close stores/watchers before removing it. Reuse adjacent fake providers, fixture helpers and injected dependencies. Run typecheck after test edits.

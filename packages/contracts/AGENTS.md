# Contracts

This package owns shared Zod schemas, domain types and pure decisions used across client, coordinator and adapters. Read the root guidance first.

Find the owning domain module through `src/index.ts`. Keep shared calculations here when both UI and coordinator need them; filesystem, network and Electron effects belong in their owning packages. Export new public vocabulary through the index using the existing style.

For wire changes trace `src/frames.ts` and `src/events.ts` into coordinator command handling/read-model and client store. For persisted-schema changes inspect coordinator scanning, migration and commit behavior plus fixture compatibility. A stricter schema can invalidate existing worlds even when newly created examples pass.

Use adjacent tests under `test/` for meaningful schema boundaries and calculation cases. Typecheck affected consumers as well as this package; tsx tests do not check types. Document the relevant spec requirement when changing domain behavior.

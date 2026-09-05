# Client

Read the root guidance and [code map](../../docs/development/code-map.md). Paths below are relative to this package.

Start with `src/App.tsx` for routes and `src/screens/registry.ts` for navigation-test sample paths. Screens compose `components/` and `domain/` presentation; `domain/connected.tsx` connects domain UI to commands and state. For a new route, update the registry and its fixture-backed navigation coverage where applicable.

`src/lib/store.ts` owns transport, command helpers, authoritative state folding and transient request state. `src/lib/selectors.ts` derives views; component-local state owns local panels and selections. Follow the existing category instead of adding a second authoritative copy of a world entity. Changes to shared events require checking coordinator `read-model.ts` as well as this store.

Keep reusable pure domain decisions in contracts. UI controls do not replace coordinator validation or acceptance/spend decisions. Desktop bridge types live in `src/arke-bridge.d.ts`; coordinate changes with desktop preload and its tests.

Match neighboring components and the token files under `src/theme/tokens/`. Read the applicable design reference for visual work. Preserve the existing house formatting; do not run the root formatter.

Run tests with this package as cwd; `npm test --workspace @arke-studio/client` does that from the repository root. See [testing.md](../../docs/development/testing.md) for single-file commands and fixture setup. Authentication changes need both dev-session tests and desktop integration checks as described in [CLAUDE.md](../../CLAUDE.md).

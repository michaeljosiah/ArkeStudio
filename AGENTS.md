# Working in Arke Studio

Arke Studio is a local-first worldbuilding and production app: an npm workspaces monorepo with a React client, a TypeScript coordinator and an Electron desktop shell. Worlds are portable folders; the app presents and operates on them.

## Read first

1. Read [CLAUDE.md](CLAUDE.md) for the shared operational rules. Despite its name, those rules apply to all coding agents: worktree isolation, shared stash, cleanup, formatting, transport authentication, world ownership and journal durability. Keep those rules there rather than copying them into other guides.
2. Use [the developer index](docs/development/README.md) and [code map](docs/development/code-map.md) to locate the implementation and tests for your task.
3. Read the relevant capability spec under [docs/specifications](docs/specifications) and any linked ADR. Check its status: proposed designs and historical reviews are not implemented guarantees.
4. Follow the scoped AGENTS.md in the package you change. Inspect `git status --short` before editing; concurrent sessions may have unrelated work in this checkout.

## Placement

| Area | Responsibility |
|---|---|
| `packages/contracts` | Shared schemas, domain vocabulary and pure calculations |
| `packages/coordinator` | Application orchestration, world persistence, acceptance, jobs and spend |
| `packages/client` | Routes, screens, UI state and rendering the coordinator's state |
| `packages/providers` | Provider protocols, capabilities and model catalogue |
| `packages/adapter-*` | Writing harness protocols behind shared contracts |
| `packages/voice` | Local Voxa sidecar protocol |
| `apps/desktop` | Platform composition, preload, native media tools and packaging |

Keep shared domain calculations in contracts and side effects in the owning coordinator/platform service. Follow existing domain modules before adding responsibilities to coordinator.ts or client store.ts. Concrete harness assembly belongs in coordinator `harness/v2-launch.ts`; see CLAUDE.md for the dependency rule.

## Validation and maintenance

Use Node 22.12 or later; CI uses Node 22. Install the locked dependencies with `npm ci`. The full code gate is `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test`. Use [the testing guide](docs/development/testing.md) to choose focused tests and required platform checks. Documentation-only edits need link/content checks, not an application test run. Do not run the repository-wide formatter; see CLAUDE.md.

Behavior changes need the relevant spec amendment or a reference to the requirement being implemented; see [CONTRIBUTING.md](CONTRIBUTING.md). Update the code map when entry points, ownership or workflows change, and update testing/setup instructions with command changes. Keep this file an orientation, with detailed reasoning in the linked documents.

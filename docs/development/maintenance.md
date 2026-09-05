# Generated files, assets and delivery

Commands below run from the repository root unless stated otherwise. Read the script before running a generator: regeneration can fetch remote data or change many files and is not part of ordinary documentation validation.

| Output or asset | Owner / source | Maintenance route |
|---|---|---|
| `packages/providers/src/fal-catalogue.generated.ts` | `packages/providers/scripts/sync-fal-catalogue.mjs`; public FAL catalogue plus script-curated capabilities | `node packages/providers/scripts/sync-fal-catalogue.mjs`; review prices, route IDs and curated constraints, then run provider checks. Do not hand-edit generated output. |
| Shipped model manifest | `packages/providers/src/manifest-data.ts` and generated catalogue | Change the appropriate source; follow registry/provider consumers and tests. |
| Sample world | `fixtures/worlds/the-undersong`, coordinator `src/world/sample-world.ts` | Shared by tests, dev seeding and desktop sample-world delivery. Validate affected fixtures and installer resources when changing its structure. |
| Client/desktop build output | Client Vite config; `apps/desktop/scripts/build.mjs` | `npm run build`; edit source, not dist output. Desktop build also builds the client. |
| Native SQLite | Desktop `scripts/rebuild-native.mjs` and package aliases | `npm run rebuild:native --workspace @arke-studio/desktop`; preserve host-Node versus Electron ABI separation. |
| Bundled local runtimes | Desktop `scripts/prepare-runtimes.mjs`, runtime source/support helpers and build resources | `npm run prepare:runtimes:x64 --workspace @arke-studio/desktop` or `prepare:runtimes:arm64`; check matching runtime tests and licence verification. |
| OpenCode runtime | Desktop `scripts/prepare-opencode2.mjs` | `npm run prepare:opencode2 --workspace @arke-studio/desktop` defaults to x64; inspect script arguments for other targets. |
| Windows packaging | Desktop package scripts, `.github/workflows/package.yml`, `release.yml` | `npm run package --workspace @arke-studio/desktop` prepares runtimes, verifies licences, builds and packages with publish disabled. This is larger than a build check. |
| Licence inventory | `THIRD-PARTY-NOTICES.md`, `licenses/`, desktop `scripts/verify-licenses.mjs` | `npm run verify:licenses --workspace @arke-studio/desktop`; packaging additionally requires prepared-runtime checks. |
| Design references | `design-system/`, client theme/components | Prototype HTML is a design input, not a shipped client bundle. Keep implemented UI and intended design distinctions explicit. |

`.dev/` contains local development state and private session handoffs. It must remain gitignored and unavailable through Vite serving. Do not use it as documentation evidence that exposes tokens or world content. For temporary cleanup use the existing `clean:temp` script; for branch/worktree cleanup follow [CLAUDE.md](../../CLAUDE.md#never-hand-roll-branch-or-worktree-deletion).

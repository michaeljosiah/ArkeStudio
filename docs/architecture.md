# Architecture

This is the implementation-backed reference for how Arke Studio's code is arranged: what runs
where, what may depend on what, and which boundaries are load-bearing.

The capability specifications describe intended behaviour; this document describes the current
code, the same way [`filesystem-operations.md`](filesystem-operations.md) does for what the
application writes to disk. Where a specification and this document disagree, this document is
the one that was read off the source — and the disagreement is worth an issue.

It is deliberately not a tour of features. Each capability has a spec in
[`specifications/`](specifications), and this document links to them rather than restating them.

---

## 1 · The shape, in one paragraph

A React renderer over a coordinator that runs **inside the Electron main process**, with the
filesystem as the only durable truth. There is no server on the hot path, no database of record
and no git. The coordinator owns the domain; it holds no reference to Electron, to React, or to
any provider SDK. Everything it cannot do without touching the host — spawn a process, open a
dialog, encrypt a secret, run ffmpeg, call a model — arrives as an injected function, and the two
hosts that inject them ([`apps/desktop/src/main.ts`](../apps/desktop/src/main.ts) and
[`packages/coordinator/src/dev.ts`](../packages/coordinator/src/dev.ts)) are the only places the
whole system is assembled.

## 2 · Process topology

```
┌─ Electron main process ──────────────────────────────────────────────────────────────────────┐
│ apps/desktop/src/main.ts — the window, every host port, supervision, updates                 │
│                                                                                              │
│ ┌─ Renderer (sandboxed) ──────────┐          ┌─ Coordinator (in-process) ──────┐             │
│ │ packages/client                 │          │ packages/coordinator            │             │
│ │ React over one external store   │          │ domain · accept gate · canon    │             │
│ │ reaches the host only through   │◀── ws ──▶│ derived index · job queue       │             │
│ │ window.arke — no Node, no paths │   :port  │ ledger · child supervision      │             │
│ └─────────────────────────────────┘          └─────────────────────────────────┘             │
│                                                                                              │
│ ┌─ OpenCode ───────────┐ ┌─ Claude Code ─────────┐ ┌─ Voxa ─────────┐ ┌─ ComfyUI ──────────┐ │
│ │ child process        │ │ Agent SDK query()     │ │ child process  │ │ child, or attached │ │
│ │ HTTP + SSE           │ │ in-process; the SDK   │ │ HTTP + WS      │ │ where it already   │ │
│ │ cwd = the proposal   │ │ spawns the verified   │ │ .NET, self-    │ │ runs               │ │
│ │ supervised, leashed  │ │ binary itself         │ │ contained      │ │ HTTP + WS          │ │
│ └──────────────────────┘ └───────────────────────┘ └────────────────┘ └────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
             │                         │                     │                    │
             ▼                         ▼                     ▼                    ▼
      LLM providers             LLM providers        Kokoro · Whisper       local recipes
   (keys as spawn env)      (keys as SDK options)    on this machine        on this GPU

  the job queue dispatches direct: FAL · Higgsfield · ElevenLabs · OpenAI · Anthropic · Ollama
  ffmpeg · ffprobe · espeak-ng are spawned as separate executables, and never linked
```

| Process | Started by | Protocol | Absent means |
|---|---|---|---|
| Renderer | Electron, one `BrowserWindow` | `window.arke` → ws + http on loopback | — |
| Coordinator | The host, in-process | — | — |
| OpenCode | `ChildSupervisor`, via `assembleHarness` | HTTP + SSE on an allocated loopback port | The authoring lane has no harness; screens say so |
| Claude Code | The Agent SDK, per `query()` | async iterable; no server | Bring-your-own harness is unavailable, with the reason |
| Voxa | `ChildSupervisor` | HTTP + WS | Local speech is unavailable; cloud voice still works |
| ComfyUI | `ChildSupervisor` when Arke owns the install; otherwise attached where it already runs | HTTP + progress WS | Local image/video recipes cannot be dispatched |
| ffmpeg / ffprobe | Spawned per use | argv + stdout | Exports, motion QC and duration measurement state the reason rather than guessing |

ffmpeg and espeak-ng are invoked as **separate executables and never linked**. That is a licence
constraint, not a preference — see [CONTRIBUTING.md](../CONTRIBUTING.md) and
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

## 3 · The composition root

`CoordinatorOptions` in [`coordinator.ts`](../packages/coordinator/src/coordinator.ts) is the port
list, and reading it is the fastest way to learn what the domain refuses to know how to do. Each
field is a capability the host supplies; an absent one is an ordinary state with a stated
consequence, never a crash.

| Port | Supplied by the desktop as | Absent means |
|---|---|---|
| `provider` | `FsWorldProvider` over the app root | — (required) |
| `adapter` | Whatever `assembleHarness` discovered | No authoring lane |
| `cipher` | Electron `safeStorage` | Keys cannot be stored |
| `dispatchClients` | `createProviderClients(...)` from `@arke-studio/providers` | Nothing can be dispatched |
| `ffmpeg`, `mediaProbe`, `takeQcAnalyzer`, `takePosterMaker`, `boundaryFrameMaker` | Resolved ffmpeg/ffprobe binaries | The feature states why, and records no measurement |
| `pickFiles`, `chooseClaudeExecutable`, `openPath` | Electron dialogs and `shell` | Attaching says so instead of doing nothing |
| `voice` | Voxa sidecar client + catalogue | Local speech unavailable |
| `comfyui` | `ComfyUiEngineService` + host directory pickers | Local recipes unavailable |
| `updates` | `electron-updater` commands | No in-app update |
| `nativeIndex` | Whether the Electron-ABI SQLite binding loaded | The derived index is degraded, and says so |

Two invariants make this checkable rather than aspirational, and both hold today:

- **No `electron` import outside `apps/desktop/src`.** `grep -rl '"electron"' packages apps
  --include='*.ts' --include='*.tsx'` returns `main.ts` and `preload.ts`, nothing else. (Without
  the filters it also finds the packaging scripts and a manifest, which is not the same claim.)
- **No `react` import outside `packages/client`.** The coordinator and contracts have none.

A third is visible in the manifests: `@arke-studio/providers` and `@arke-studio/voice` are
**devDependencies** of the coordinator, not dependencies. The only file in
`packages/coordinator/src` that imports them is `dev.ts` — which is a host, not domain code.
Anything else importing them at runtime would be the dependency rule breaking, and the manifest
would say so.

## 4 · Packages and the dependency rule

| Package | What it is | Depends on (in-repo) | src | test |
|---|---|---|---|---|
| `packages/contracts` | Zod schemas, ids, and the pure judgements client and coordinator must agree on | — | 19,507 | 5,332 |
| `packages/coordinator` | The world on disk, the accept gate, canon, the index, jobs, dispatch | contracts, both adapters | 43,645 | 39,860 |
| `packages/client` | The React app — the only UI | contracts | 33,270 | 11,506 |
| `packages/providers` | Provider clients, the model manifest, the ledger's price facts, ComfyUI recipes | contracts | 4,848 | 3,445 |
| `packages/adapter-opencode` | The OpenCode harness adapter (v1 and v2) | contracts | 2,978 | 1,987 |
| `packages/adapter-claude` | The Claude Code harness adapter, over the Agent SDK | contracts | 1,212 | 695 |
| `packages/voice` | The Voxa sidecar client | contracts | 151 | 166 |
| `apps/desktop` | The Electron shell: main, preload, updater, packaging | everything | 2,345 | 669 |
| `design-system` | Prototypes, tokens, assets — not built or typechecked | — | — | — |

The rule is one-way and has one shape: **`contracts` depends on nothing in this repository, and
everything else depends on `contracts`.** The client never imports the coordinator; the
coordinator never imports the client; neither imports a provider SDK. Where the coordinator needs
something owned by a package it must not depend on — the ComfyUI recipe catalogue in `providers`,
the local voice presets in `voice` — the value is injected by the host instead, and the comment at
the injection site names the direction it is protecting. The roster and skill registry are
injected too, though they live in `contracts`: the coordinator resolves a family and asks for a
document, and never learns how a prompt is assembled.

## 5 · The client ↔ coordinator boundary

One [`Transport`](../packages/coordinator/src/transport.ts) binds a single loopback port serving
both a WebSocket and an HTTP endpoint.

**Frames.** A client sends `hello`; the coordinator answers with a `snapshot` of the whole
`ClientState`, then `event` frames. Sequence numbers are monotonic **per connection**, and a
reconnecting client gets a fresh snapshot rather than a replay — partial replay is deliberately
not offered (SPEC-001 D4). The protocol is wide and flat: **220 `ClientMessage` kinds** and
**85 `DomainEvent` kinds**, both discriminated unions in
[`frames.ts`](../packages/contracts/src/frames.ts) and
[`events.ts`](../packages/contracts/src/events.ts).

**Validation runs in both directions.** Every frame is `FrameSchema.parse`d on the way out, so a
frame that fails its own schema never reaches a client. Inbound, the two failure modes are
handled differently on purpose: bytes that are not JSON close the socket, because that is
transport corruption; valid JSON that fails the schema is *dropped and logged*, because that is
version skew between a renderer and a coordinator from different builds, and closing the socket
made the whole app read as disconnected on one keystroke.

**Media is HTTP, not frames.** `GET /media/<world-slug>/<world-relative-path>` serves read-only
files with `Accept-Ranges` and full `Range` support — without ranges a `<video>` element reports
an empty `seekable` and silently refuses every `currentTime` assignment, so playback works and
scrubbing does not. Responses are `Cache-Control: no-store`, because kit grids and boards are
overwritten in place on recompile. Path-traversal guarding belongs to the resolver the host
injects, not to the transport.

**The preload bridge** ([`preload.ts`](../apps/desktop/src/preload.ts)) exposes exactly one
object, `window.arke`: connect, send, subscribe, and a handful of host actions. No Node, no
Electron, no filesystem paths, and never a credential. The renderer names a *destination* for an
attachment; the host names the *path*; the two only meet in the frame that leaves the preload.

## 6 · State

`ClientState` has six top-level keys — `app`, `worlds`, `world`, `worldChat`, `bench`,
`authoringRuns` — and is the entire contract for what a screen may render.

[`ReadModel`](../packages/coordinator/src/read-model.ts) folds world loads and domain events into
that shape. It is a pure state container: validation happens at the boundaries (transport out,
provider in) and never in the fold.

The client store ([`lib/store.ts`](../packages/client/src/lib/store.ts)) is a single
`useSyncExternalStore` holding connection status plus that same `ClientState`, and it folds
incoming events **with the same rules as the coordinator's read model**. That duplication is real
and worth naming: two implementations of one fold can drift, and the mitigation is that a
reconnect replaces the client's state wholesale with a server snapshot, so drift is bounded by the
next reconnect rather than permanent. View state — tabs, panels, selection — stays in components
and is never sent.

## 7 · Two execution paths, and why they stay apart

Conflating them is the main architectural risk the specifications exist to prevent.

- **The authoring path** — world genesis, sheet edits, canon threads, scene drafting — runs
  through a harness as an agentic loop confined to a staging directory, and produces
  **proposals**. Nothing it writes becomes an authored fact without an accept.
- **The media path** — images, video, voice — runs through Arke's **own job queue**, calling
  providers directly.

The harness never dispatches media. The job queue lands generated media and operational records
but never authors canon, sheets or scenes. The accept gate ([SPEC-004](specifications/004.the-accept-gate.md))
protects authored facts; operational and generated writes follow the mutation matrix in the master
spec §3.1.

## 8 · Durable truth: the world folder

The folder is the only durable truth; everything else is derived and deletable. The rules the code
actually enforces:

- **One commit primitive.** Every mutation to an *open* world goes through
  [`world/commit.ts`](../packages/coordinator/src/world/commit.ts), and atomicity, base-hash
  verification, history, versioning and the change log live there once. A commit is a journalled
  transaction with three states — `prepared` (journal on disk, nothing live touched), `committing`
  (snapshots and staged files written, renames may have begun), `done`. Opening a world rolls back
  from `prepared` and rolls **forward** from `committing`, every step idempotent against recorded
  hashes. Creating a world is the one path outside it: the directory, `world.json` and the first
  change line are three steps, not one transaction, which `filesystem-operations.md` states
  rather than hides.
- **Staleness is detected, never merged.** A commit whose base hash moved raises
  `CommitStaleError` and stops.
- **Atomic writes everywhere else.** Write a sibling `.tmp-<id>`, flush, rename over the target;
  a failed rename removes the temporary file.
- **Append-only records.** `changes.jsonl` per world; `queue/jobs.jsonl`, `ledger.jsonl` and
  `provider-calls/calls.jsonl` at the app root. A torn final line is tolerated and repaired on the
  next append.
- **One owner at a time.** [`world/lock.ts`](../packages/coordinator/src/world/lock.ts) claims
  ownership by exclusive create and by nothing else — read-then-write is not a lock. The record
  holds pid and start time, never a machine identifier; a dead pid or a stopped heartbeat is
  reclaimed, because the alternative is locking a user out of their own work.
- **Windows paths are long.** `toExtendedLength` is applied at the filesystem edge throughout;
  paths stored inside JSON are portable and use `/`.

What each operation creates, replaces, appends, moves or removes is enumerated in
[`filesystem-operations.md`](filesystem-operations.md).

## 9 · Derived state: the index

SQLite with FTS5, in two databases: `%APP_ROOT%\.index\app.db` (the world registry the picker
renders from without opening any world, plus jobs and ledger mirrored from their append-only logs)
and `<world>\.index\world.db` (the per-world cache canon search and ripple queries read). Both are
rebuildable from a full scan — deleting either can never lose spend history,
because the logs are the truth.

The native binding is a seam, not an import: index code takes a constructor
([`index-db/sqlite.ts`](../packages/coordinator/src/index-db/sqlite.ts)) because tests and the dev
coordinator need the Node-ABI build of `better-sqlite3` while the Electron main process needs an
Electron-ABI build (aliased `better-sqlite3-electron`, rebuilt by `@electron/rebuild`). FTS5's
presence is proved once per open rather than assumed.

## 10 · The authoring lane in detail

Two adapters implement one `HarnessAdapter` interface
([`contracts/src/adapter.ts`](../packages/contracts/src/adapter.ts)), and their difference is
structural rather than cosmetic:

- **OpenCode** is a supervised child holding sessions behind HTTP + SSE. Capabilities come from
  probing the live server's OpenAPI document at init, not from a pinned version, so a user's newer
  install degrades the UI to the surface it actually exposes instead of failing.
- **Claude Code** has no server. The Agent SDK is a `query()` over an async iterable, so the
  session table, turn bookkeeping and event multiplexing live in the adapter, and `dispose()` is
  the only thing between an abandoned adapter and a live subprocess. Confinement is enforced in a
  `canUseTool` callback Arke owns rather than a config file the harness is trusted to honour —
  stronger where it applies, and verified per binary by a confinement probe rather than assumed.

The interface carries both `sessionFiles` (what to write beside the work) and `prepareSession`
(the same settings as call options) because a file-shaped seam alone silently excluded the harness
that has nothing to write — and the symptom was a lane that started, authenticated, ran turns, and
answered every question about the world with "I have nothing on that in front of me".

**The agent's reads go through a tool, not the filesystem.** Its working directory is its proposal;
everything else it may read it asks for from the
[`WorldQueryServer`](../packages/coordinator/src/harness/world-query.ts), served over MCP
streamable HTTP on loopback. The surface has no write operation and no path parameter anywhere in
it, so it cannot be steered at the disk. Two surfaces share the port: `/mcp` resolves against
whichever world is open (right for authoring agents, which have no life beyond it), and
`/mcp/<lease>` resolves against the world its lease was minted for (right for World Chat runs,
which outlive a moment of UI state). A malformed path under `/mcp/` is rejected rather than
falling back to the ambient surface, because falling back is the bypass the lease exists to
prevent.

## 11 · The media lane in detail

[`queue/dispatcher.ts`](../packages/coordinator/src/queue/dispatcher.ts) is durable before the
network and never trusts silence: every state transition is appended to the journal **before** the
action it authorises, and a gap in observation is an unknown to reconcile, never a failure to
retry. Failures are classified ([`queue/classify.ts`](../packages/coordinator/src/queue/classify.ts))
into backoff behaviour; returned artifacts are verified before they are landed
([`queue/verify.ts`](../packages/coordinator/src/queue/verify.ts)); terminal charges append one
record to the ledger, including applicable failures and cancellations.

`@arke-studio/providers` holds the client per provider, the shipped model manifest, and the
ComfyUI recipe graphs. Note the direction at the ComfyUI boundary: everything the coordinator's
engine service knows about a recipe arrives as **facts** — digests, node classes, file lists —
never a graph. The graph lives in the providers package and crosses into the coordinator as an
already-substituted request at dispatch, which is what keeps that rule auditable by dependency
direction alone.

## 12 · Cross-cutting rules

- **Schemas at the boundaries, nowhere else.** Parse on the way in and on the way out; the fold
  and the domain trust their types.
- **Secrets never reach the renderer.** Keys live encrypted at the app root, reach the harness as
  spawn environment, and are scrubbed from owner-visible payloads through a shared
  `SecretRegistry`. Provider-call records are redacted before they are written.
- **A supervised child is never orphaned.** Every spawn is tethered three ways: a kernel Job
  Object leash to this process's lifetime, a pidfile ledger the next startup sweeps, and — for
  Windows shell shims, where the pid Arke holds is a `cmd.exe` wrapper and the real work is its
  grandchild — a snapshot of live descendants taken once the child is healthy.
- **An absent capability is a state, not an error.** Every optional port documents its own
  consequence at the point of declaration, and the surface that depended on it says what is
  missing rather than failing silently or pretending it worked.

## 13 · Build, packaging and running

| Command | What happens |
|---|---|
| `npm run dev` | Vite dev server for the client; `npm run dev:coordinator` runs the coordinator standalone over `.dev/root`, seeded from `fixtures/` |
| `npm run build` | Every workspace: Vite builds the client, esbuild bundles `main.ts` and `preload.ts` to CJS |
| `npm start` | Build, rebuild native modules for Electron, launch |
| `npm run package` | Stage runtimes and OpenCode, verify licences, build, then electron-builder → one NSIS installer, Windows **x64 only** |

Three packaging facts are load-bearing and were each learned from a failure:

- **x64 only, deliberately.** ARM64 was built until 0.2.9 and should not have been:
  `better-sqlite3` publishes no ARM64 prebuild for Electron, cross-compiling it needs an MSVC
  component no packaging machine has had, and `rebuild-native --allow-missing` swallowed the
  failure — so every ARM64 installer ever produced shipped with the derived index silently
  switched off. Windows on ARM runs the x64 binary under emulation, which is the honest fallback
  until the toolchain is in place. `--allow-missing` is not passed any more, for the same reason.
- The main bundle carries a banner shim so `import.meta.url` survives the ESM→CJS flattening. A
  dependency that reads it at module scope otherwise gets `undefined`, and the main process dies
  before the first window — invisible to tests, typecheck and dev, all of which run real ESM.
- The app version is read from `package.json` at build time rather than repeated in an npm script,
  so the About box cannot disagree with what electron-builder shipped.

## 14 · Tests

232 test files, all on `node:test` with `tsx` — no Vitest, no Jest, no browser runner. The client's
tests run under the same runner as the coordinator's. CI ([ci.yml](../.github/workflows/ci.yml))
runs lint, typecheck, build and test on **both** Windows (what ships) and Ubuntu (what catches path
and case assumptions), with a 25-minute ceiling because a leaked file watcher once held a runner
until GitHub's six-hour default killed it.

Coordinator tests are nearly as large as coordinator source — 39,860 lines against 43,645 — which
is what CONTRIBUTING's rule about the four expensive, quiet areas (the world folder, the accept
gate, the job queue, packaging) costs when it is actually followed.

## 15 · Designed, not built

Stated here because the gap between spec and code is otherwise invisible from the source:

- **The four host ports** — `IdentityProvider`, `EntitlementProvider`, `ContentPolicy`,
  `ReleaseTarget` ([SPEC-025](specifications/025.the-host-ports.md), status: draft) — do not exist
  in `packages/contracts` yet. Today the engine answers each of their questions by assuming the
  answer: one person, at one machine, spending their own money, publishing to a local file.
- **The narrative-game graph** and **recovery from the archive** are specified and not written.
- **Voice mode** is in build.

## 16 · Where this document is thin, and what it found

It does not describe screens. The client's 33k lines of source are organised as `screens/` over
`components/` over `lib/store.ts`, and the largest screens (`production.tsx`, `world.tsx`,
`shell.tsx`) are large enough that "the shape of the client" is a document this one does not
attempt. Nor does it describe any capability's behaviour — that is what the specs are for.

Four places where prose and code have drifted, found by reading one against the other:

- `docs/specification.md` §1.2 and §1.3 predate `packages/adapter-claude` and the ComfyUI engine.
  Sections 2 and 4 above are the current topology and package map, and §1 now says so rather than
  reading as current. The spec's §1.2 diagram is left alone: it states a decision, and amending it
  is a specification change.
- `README.md` did not list `packages/adapter-claude`, which ships. Added.
- `README.md` says the installers are "Windows 11, x64 and ARM64". Packaging has produced x64 only
  since after 0.2.9 (§13), so that line overstates what ships. Left as it is: which architectures
  the product claims is a release decision, not a documentation one.
- `.github/workflows/release.yml` still describes "one serialized upload after both architectures
  pass" in a job that builds one. Left as it is, for the same reason.

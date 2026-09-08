# Arke Studio compared with Director Studio

Read on 8 September 2026 against `ai2764/Director-Studio` at `f50c6b8` ("feat: support runtime
custom H3 workflows", 6 September 2026) and this repository's working tree. Both were read as
source; neither was run. Nothing here is a benchmark, a performance claim or a test result — it is
a design comparison with file citations, written to answer three questions: where are we ahead,
where are we behind, and what should we actually copy.

## The short version

Director Studio is a single-purpose local pre-production workbench, welded deliberately and
explicitly to one video model (MiniMax H3 Ref2AV) reached through ComfyUI. Arke Studio is a
world-first production platform that happens to include that capability as one recipe among many.
On almost every axis where the two overlap, Arke is further along — including on H3 itself, which
is the thing Director Studio is built around.

Two exceptions are real, and both are worth acting on:

1. **Director Studio arbitrates VRAM between its own local LLM and its own local image/video
   engine. We do not.** We measure free VRAM and then tell the user to close other programs —
   including Ollama, which we installed and started. This is the single most actionable finding
   in this document.
2. **Director Studio lets a user import their own ComfyUI H3 graph at runtime without exposing a
   graph editor**, through a deterministic inspect → confirm → validate → test → activate flow with
   sha256-pinned immutable snapshots and an automatic fallback. SPEC-021 R-1's refusal to expose
   graphs is still right as a default; their design shows that "no graph editor" and "no user
   graphs at all" are separable choices.

Three smaller ideas are worth taking, and are named in §5.

## 1 · What each project is

|  | Arke Studio | Director Studio |
|---|---|---|
| Premise | The world is the durable asset; productions are developed from it | The project is a script plus a shot list; assets are a typed library beside it |
| Scope | Story and video, canon, sheets, productions, scenes, shots, takes, cut, editor, export, voice | Pre-production: assets, shot planning, H3 prompt authoring, clip generation |
| Video model posture | Model-agnostic manifest; H3 is one recipe of seven and one row among many | H3 Ref2AV only, by explicit v1 rule; the domain vocabulary *is* H3's socket vocabulary |
| Shell | Electron desktop, embedded coordinator | FastAPI serving a Vite build on `127.0.0.1:8790`, plus a one-file portable `.exe` |
| Stack | TypeScript monorepo, npm workspaces | Python backend, React frontend, PowerShell build |
| Public history | at least 349 commits (the checkout here is shallow, so that is a floor), 1 author | 5 commits total, 1 author, first public release 4 September 2026 |
| Source (non-test) | ~206k lines TS/TSX | ~27.6k lines Python + ~9.8k lines TS/TSX |
| Tests | 456 files, ~138k lines, ~5,500 cases | 69 backend files (~26k lines, 472 cases) + 28 frontend files (182 cases) |
| Docs | 43 capability specs, 3 ADRs, illustrated architecture, ~31.8k lines | One 211-line `ARCHITECTURE.md`, a 24 KB README, 9 plan/spec notes (~3.2k lines) |
| CI | GitHub Actions, Windows + Linux, four shards each | None — no `.github/` directory |
| Licence | AGPL-3.0-only, with a CLA and third-party notices | No `LICENSE` file |

The size gap is not the interesting part. Director Studio's backend test-to-source ratio (26k test
lines against 27.6k source lines) is close to ours, and its code is legible for its size. The
interesting part is that the two projects made opposite bets about model coupling, and one of them
has already paid off.

## 2 · Where we are clearly stronger

### 2.1 Durability

`backend/app/core/jobs/store.py:96` persists a job record with `path.write_text(...)` — no
temp-and-rename, no fsync, nowhere in `backend/app/core/` does either appear. A crash or a full
disk mid-write truncates the record. Worse, `save_job` will `shutil.rmtree` a destination and
`shutil.move` a job directory when a job acquires a `project_id` (`store.py:85–93`), so an
interrupted save can lose the whole directory rather than one file.

Ours is the subject of a standing operational rule (CLAUDE.md, issue #826): `JobJournal`,
`LedgerFile` and `ProviderCallStore` use `appendFlushed` inside a `WriteQueue` — write, file sync,
close, then acknowledge — before any external side effect, and SPEC-009 §2.2.1 states the crash
model they are built against. World writes go through `world/atomic.ts`.

### 2.2 The local HTTP surface is authenticated

`backend/app/main.py:41–46` mounts `CORSMiddleware` with `allow_origins=["*"]` and
`allow_credentials=True`, and there is no authentication anywhere on the API. That server exposes
every project, every file, and the endpoint that submits jobs to the MiniMax cloud API on the
user's key. Any local process, and any page the user visits that can reach `127.0.0.1:8790`, can
read the library and spend money.

This is precisely the class of bug our issue #825 removed: loopback is an address, not
authorization. `Transport` requires a fresh 32-byte capability for the WebSocket hello and every
media GET; there is no unauthenticated fallback; the desktop mints the token in main and passes it
over private startup IPC. It is worth noting because we did not always have it either.

### 2.3 Money is visible

Director Studio has no cost model at all. Nothing in `backend/app/` mentions price, cost or spend.
A MiniMax submission is a fire-and-hope. We show real currency before spend, hold a micro-USD
ledger (`spend/ledger.ts`, SPEC-008), and record a charge as unknown rather than zero when an
outcome is unwitnessed (`queue/dispatcher.ts:2033–2038`).

### 2.4 Model-agnosticism, and H3 specifically

Director Studio's domain model is H3's socket vocabulary. `Picture 1–9`, `<Audio 1–3>`, a frame
grid of `n % 17 == 5` in the range 124–362 (`core/h3/frames.py:1`), a fixed six-section prompt, and
a `ShotStatus` machine whose terminal gate is `assert_h3_submittable`. When H3 is superseded, that
is a domain rewrite.

Ours declares what each model accepts (`contracts/manifest.ts`: `referenceImages`, `referenceRoles`,
`startFrame`, `endFrame`, resolutions, aspects, pricing), and the fal rows are generated from fal's
own catalogue rather than written from memory — a script that exists because a hand-written row for
"Seedance 2.0" pointed at the v1 route.

And on H3 itself we are ahead of the project built around it. `docs/development/h3-reference-video.md`
describes stable author-side `@Image N` / `@Video N` / `@Audio N` tokens resolved to dense
transmitted order, one audio ordinal reserved per video soundtrack so that adding a motion clip
cannot silently re-point a voice tag, world-relative paths with hashes and measured durations
journalled before preparation, and a measured validation run (RTX 3080 10 GB, 656.5s, free RAM
bottoming at 407 MiB — which is where the recipe's 4 GiB free-RAM floor comes from). Director
Studio's H3 path injects prompt, size, frame count and up to nine `LoadImage` nodes.

### 2.5 The second half of the pipeline does not exist over there

No timeline, no cut assembly, no export, no subtitles, no TTS. Their "Voice" tab is
`LibraryPage lockedKind="voices"` — a folder of uploaded recordings used as H3 audio references.
We have SPEC-037/038/039 (timeline, playback, audio, subtitles, export, unified editor), Kokoro and
cloned voice, transcript comparison, audio QC, rights and clearance.

### 2.6 Continuity

Their `core/media/tail_frame.py` extracts the last decoded frame of a clip into a pending Layout —
useful, and about 350 lines. Ours (`takes/boundary.ts`) seeks just short of the out-point rather
than to the true last frame, runs a supersession sweep, and declines to overwrite a picture a
person chose (`takes/drawn-frame.ts:34`).

### 2.7 Recipe safety versus node-ID patching

Our recipes bind parameters to declared input slots only (`providers/comfyui/recipes.ts`,
`RecipeParamSpec.bind`), pin checkpoint sha256 digests verified against publisher metadata, and
require a new `recipeVersion` for any change rather than an edit in place. Substitution can reach
the declared slots and nothing else — a mechanical guarantee, not a review comment.

Director Studio's bundled pipelines patch nodes by literal ID (`58`, `59`, `11`, `15`, `23`, `13`,
`20`, `28`, `44`, `54` for the actor workflow alone) and document the mapping in a hand-maintained
README table that goes stale the moment a graph changes. Their own README admits the failure mode:
"Merely changing `SAVE_NODES` is not sufficient for a structurally different actor graph."

### 2.8 Specification discipline

43 capability specs with numbered requirements cited from the code, 3 ADRs, and specs that state
plainly what is designed but not built (`docs/development/status.md`). Their equivalent is a
211-line architecture document that is already drifting — it still lists a `first_frame/` pipeline
that the shipped tree calls `ref_frame/`.

## 3 · Where they are stronger

### 3.1 VRAM arbitration between the LLM and the generation engine — the real gap

`backend/app/core/vram/orchestrator.py` is a single-owner exclusive lock over the GPU with two
claimants, `llm` and `comfy`:

- `before_comfy_job(pipeline_id)` waits for the GPU to be free, then **always** unloads Ollama
  (`keep_alive=0`) before the submit, whether or not it believed the model was resident.
- `llm_session()` waits, takes ownership, and calls ComfyUI's `POST /free` *while holding
  ownership*, so a Comfy job cannot start mid-free.
- Contention **queues** rather than failing: `_wait_until_free` blocks on a condition variable with
  a timeout, and the wait reason is surfaced to the UI ("Waiting for GPU: Comfy (h3_ref2va)").
- Agent context is serialised to `data/projects/<id>/agent/context.json` before every unload, so the
  planning agent survives being evicted from VRAM mid-conversation.
- `reserve_generation` / `GenerationActiveError` lets a chat turn refuse to cut ahead of a running
  local generation, with the queue of reservations attached to the error.
- `ensure_llm_ready` **distrusts its own cache**: "Never trust `_llm_ready` alone — Comfy unload /
  `keep_alive=0` can desync it" (`orchestrator.py:272`). It re-reads `size_vram` from Ollama, and
  when a model loads but reports `size_vram == 0` it warns that the model is on CPU and will be
  slow rather than silently being slow.

We have the ingredients and not the arbiter. `comfyui/engine.ts` measures free VRAM and the
engine's reclaimable PyTorch reservation, and it is careful about the difference between advisory
readiness and authoritative dispatch. But when it refuses, the sentence it produces is *"close
other programs using the graphics card"* (`engine.ts:1442`) — and on a machine where we installed
Ollama, started it, and are holding a model resident for the writing harness, one of those programs
is us. We serialise ComfyUI to one concurrent job (`coordinator.ts:2193`: `{ comfyui: 1, kokoro: 1 }`)
and we ask the engine to unload when a lane drains (`dispatcher.ts:598`), but nothing coordinates
across engines. On the 10–12 GB cards SPEC-021 and SPEC-022 are explicitly sized for, that is the
difference between a working local pipeline and half an hour of paging.

Also missing and cheap: their "is the model actually on the GPU" check. We have no equivalent of
reading `size_vram` back and telling the user their local model fell to CPU.

### 3.2 Runtime custom H3 workflow import

`backend/app/workflow_profiles/h3/` (2,252 lines across inspector, validator, store, models) admits
a user's own ComfyUI graph without ever showing them a graph:

- **Inspect, output-first.** `inspector.py` parses with hard structural limits before anything else
  — 8 MiB, 2,000 nodes, 10,000 edges, depth 32, 64 KiB per string — then lists terminal video nodes
  and walks backward from the chosen output to find the `MiniMaxH3ReferenceToVideo` node and an
  optional seed node. Node titles are shown before class names and IDs.
- **Confirm.** The user confirms the discovered boundary. The application injects prompt, width,
  height, frame count, Picture 1–9, Audio 1–3 and an optional seed, and nothing else — models,
  samplers, LoRAs, upscalers, interpolation and muxing stay exactly as the graph defines them.
- **Validate the boundary only.** `validate_h3_contract` checks the selected boundary against a
  synthetic request; it deliberately does not try to understand the graph.
- **Test before activation.** A 56-frame real run, retaining video only from the selected output
  node, with the test job's snapshot digest checked against the profile's before activation
  (`store.py:689–701`).
- **Immutable snapshots.** Graph and mapping are each content-addressed by sha256 and loaded from
  the same immutable bytes (`store.py:105–108`). Queued and running jobs keep the snapshot captured
  when they were submitted; switching profiles cannot disturb work in flight.
- **Explicit fallback.** A profile that becomes unavailable or changed falls back to the built-in
  official workflow with a named reason (`_fallback("profile_changed" | "profile_unavailable")`).
- **Never bundled.** Imported profiles live under external `data/workflow_profiles`, and the build
  script verifies the release archive contains the official workflow and no imported profile.

SPEC-021 §2.3's reasoning for R-1 remains sound: a raw node ID, a sampler name or a LoRA path is a
recipe-authoring decision, shipped and versioned. But R-1's stated question is *"can a user construct
a graph Arke did not author?"*, and this design answers a narrower one: can a user **substitute** a
graph behind a boundary Arke authored, with the same bounded parameter set, verified by a real run
before it is trusted? That is not a graph editor and it is not unbounded reach. It is worth
considering as an opt-in engine-level capability for the ComfyUI power users who are a real slice
of our local-generation audience — separate from the recipe catalogue, never a `recipeVersion`, and
carrying its own provenance on every take it produces.

### 3.3 Agent contract as a hot-reloaded file, with on-demand stage guides

`skill_loader.py` reads `DIRECTOR_SKILL.md` from disk before **every** inference — "deliberately do
not cache it" (`skill_loader.py:29`) — resolving in order: `DS_DIRECTOR_SKILL_PATH`, then
`~/.codex/skills/director/SKILL.md`, then the packaged default. `stage_guides.py` loads only the
guides a stage needs, from a closed set of seven (`script-planning`, `storyboard-validation`,
`reference-strategy`, `reference-frame-generation`, `visual-qc`, `h3-prompt-writing`, `video-qc`),
each wrapped in a tagged block. The core contract is mandatory; the guides are additive.

Ours (`contracts/src/skills.ts`) is better where it counts — a skill has an id, a version bumped on
every body change, a model family, an optional model narrowing, a purpose, and it is recorded on the
proposal it shaped (SPEC-019 R-14..R-20), so two scenes drafted under different guidance are
distinguishable after the fact. But the bodies are TypeScript string literals. Tuning a paragraph of
craft guidance means a rebuild and a release, and there is no supported way for a user to override
it.

The synthesis is obvious and cheap: keep the versioning and provenance exactly as they are, move the
bodies to shipped markdown read at run time, and document an override path. That makes prompt
iteration a text edit for us and a supported customisation for advanced users, without touching the
property that a proposal records which guidance shaped it.

### 3.4 Model-capability truth enforced in code

`core/h3/prompt.py` carries a battery of regexes whose only job is to catch the planning LLM
claiming a capability the runtime does not have: a Picture that "activates at 3s", a reference that
"is the first frame", a switch "from `<Picture 1>` to `<Picture 2>` at 4s". H3 conditions on every
Picture across the whole clip and has no first/last-frame socket in Ref2AV, and their skill document
says so in prose — but the regexes exist because prose alone did not hold.

The technique is inelegant and the implementation is brittle. The idea is not. Our manifest already
knows `accepts.startFrame`, `accepts.endFrame` and `accepts.referenceImages` per model, and we have
a prompt-review boundary (`contracts/prompt-review.ts`, `references/prompt-review.ts`). I did not
find a check that reads drafted prompt text against the *declared* capabilities of the model it is
bound for. A capability-truth check there would be cheap, would generalise across the manifest
rather than hard-coding one model's sockets, and would catch a class of failure that currently costs
a dispatch to discover.

### 3.5 Smaller things

- **A mobile surface for free.** `/mobile` entrypoint, `MobileAssetWorkspace`, `MobileShotDrawer`,
  `MobileLibraryOverview`. Because the backend is an HTTP server, reviewing takes on a phone on the
  same LAN costs them nothing. We are Electron-only, and the same need waits on SPEC-025's host
  ports. Not a reason to change architecture — a reminder that "review a take on my phone" is a real
  need with a cheap answer.
- **An operator-grade extension procedure.** `ARCHITECTURE.md`'s "Adding the next feature (e.g.
  Costume)" is five numbered steps naming the exact files. Their README's workflow-replacement
  section goes further: a worksheet with four columns, focused tests to run, then the full suite,
  then rebuild, then one real run per replaced workflow before distribution. Our code map is a
  better *map* and a worse *procedure*. Adding "how to add a recipe" as a numbered procedure is an
  afternoon.
- **Narrow, error-code-driven graph repair.** `integrations/comfy_mcp.py`'s
  `_repair_save_video_dynamic_codec` fixes a graph only when ComfyUI's validator returns
  `required_input_missing` for `format.codec` on a `SaveVideo` node — an upstream API change, not a
  guess. We pin recipes, which is right; a narrow repair keyed on a specific validator error code is
  a reasonable complement for when ComfyUI moves under a pinned recipe.

## 4 · What not to take

- Wildcard CORS with credentials on an unauthenticated local API (§2.2).
- Non-atomic, unsynced job persistence (§2.1).
- Regex intent routing over free user text. `agents/director/intent.py` decides provider selection
  and append-versus-replace semantics from keyword patterns in English *and* Chinese
  (`再加|再来|补充|额外增加`). It works until it doesn't, and when it doesn't the user gets a
  charge on the wrong provider. Structured actions are better and we already have them.
- Boundary tests that assert re-export identity. `test_director_module_boundaries.py` is largely
  `assert chat.detect_intent is intent.detect_intent`. Those stay green while the behaviour rots.
- Welding the domain vocabulary to one model's sockets (§2.4).

## 5 · Recommended follow-ups

Ranked by value over cost. None of these is in flight; each would need its own issue and, where it
changes behaviour, a spec amendment.

| # | Change | Where it lands | Why |
|---|---|---|---|
| 1 | Arbitrate VRAM across engines: one owner between the local LLM and ComfyUI, queueing rather than refusing, with the wait reason surfaced | `coordinator/src/comfyui/engine.ts`, `queue/dispatcher.ts`, a new cross-engine lock; SPEC-021 §2.7 / SPEC-033 | We currently blame the user for contention we created (§3.1) |
| 2 | Verify local-model residency and warn on CPU fallback | Ollama client + Local AI rows (SPEC-033) | A model silently on CPU reads as "our app is slow" (§3.1) |
| 3 | Capability-truth check on drafted prompts against `accepts.*` | `references/prompt-review.ts` boundary | Catches invented sockets before dispatch, generalised across the manifest (§3.4) |
| 4 | Move skill bodies to shipped markdown read at run time, keeping id/version/provenance | `contracts/src/skills.ts` → shipped docs; SPEC-019 R-14..R-20 | Prompt iteration without a release; a supported override path (§3.3) |
| 5 | A numbered "add a recipe" procedure with exact files and the tests to run | `docs/development/code-map.md` | Their operator documentation is better than ours (§3.5) |
| 6 | Consider an opt-in user-supplied ComfyUI graph behind an authored boundary — inspect, confirm, validate, test, activate, snapshot, fall back | New; would need a SPEC-021 amendment reconciling with R-1 | The largest open design question this comparison raises (§3.2) |

Items 1–3 are defect-shaped and independent of any product decision. Item 6 is a genuine
product/architecture question and should not be started without one.

## 6 · Method and limits

Both trees were read, not run. `ai2764/Director-Studio` was read at `f50c6b8` with five public
commits, so nothing here should be read as a judgement of a mature project's engineering — it is a
first public release by one author, and the parts that are good are good on their own terms. Line
citations are accurate as of the commits named at the top. No claim is made about either project's
runtime behaviour, output quality or performance; where measured figures appear (the RTX 3080 run in
§2.4) they are quoted from our own documentation, not reproduced here.

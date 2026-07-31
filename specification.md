---
specId: ARKE-STUDIO
slug: arke-studio
title: Arke Studio — local-first world-authoring and production studio
status: draft
owner: core-maintainers
sourceOfTruth: filesystem
platform: windows-first
created: 2026-07-31
updated: 2026-07-31
---

<!-- The master product specification. Capability specs (SPEC-001…) break out of §19. -->

# 0 · Product

## 0.1 Thesis

**The world is the asset.** Characters, locations, factions and canon live as one versioned
source; productions are projections of it; every generation cites it. Author once, produce
everywhere.

Most creative AI tools scope characters to a project and forget them when it ends. Arke
Studio inverts that: the world outlives every production drawn from it, and a change to a
sheet changes it everywhere that sheet is cited.

Three mechanics carry the product. Everything else is surface.

1. **The accept gate.** Nothing enters the record without a human accept. Sheet edits, canon
   entries, scene drafts and takes all arrive as *proposals*, are ripple-checked against
   canon, and only become real when accepted.
2. **Canon that refuses.** The world answers questions only from canon, with per-entry
   citations. When canon is silent it says so, cites the closest entries, and offers to open
   a thread. It never invents behind your back.
3. **Reference kits that compile.** Locked reference tiles compile into one model sheet that
   rides along with every generation on every provider, so consistency is structural rather
   than a function of prompt luck.

## 0.2 What v1 is

A free, MIT-licensed, local-first desktop application. Worlds are folders of readable files
on the user's own disk. Provider keys live in the OS credential store. Nothing leaves the
machine except the dispatches the user approves.

## 0.3 Scope

**In scope**

- World authoring: characters, locations, factions, canon, artifacts.
- Canon: versioned entries, grounded Q&A with citations, refusal-with-receipts, open threads.
- Reference kits and compiled model sheets.
- Voice assignment and dialogue generation.
- Productions in three formats: **story**, **video**, **stills**.
- Scene drafting, shot cards, per-shot and whole-scene dispatch, takes, the cut, exports.
- Provider configuration (FAL, Higgsfield, ElevenLabs, OpenAI, Anthropic, local runtimes).
- Activity: running jobs, the needs-you queue, the spend ledger.

**Out of scope for v1**

- **Arke Kids.** A separate product; removed from this repository.
- **Games** as a production format. Story, video and stills only.
- Any account, subscription, billing or cloud backend. Arke Studio is free and offline-capable.
- Any dependency on git. See §2.4 — versioning is explicit in the world folder.
- Automated drift detection (§6.4), semantic canon search (§4.3), realtime conversational
  voice (§7.1). Each is designed for but deliberately deferred.
- macOS and Linux builds. The code stays portable; only Windows is shipped and tested.

## 0.4 Platform and distribution

Windows 11 first (x64 and arm64), delivered as a signed NSIS installer. The application is
an Electron shell embedding a Node coordinator, serving a React client, and supervising two
child processes: the OpenCode harness and the Voxa voice sidecar.

macOS and Linux are non-goals for v1 but nothing in this specification may assume Windows
path semantics in the domain layer — all path handling goes through Node's `path` module and
world files use forward slashes internally.

## 0.5 Glossary

| Term | Meaning |
|---|---|
| **World** | The unit of authorship. A folder holding sheets, canon, artifacts and productions. |
| **Sheet** | A versioned entity record — character, location or faction. |
| **Canon** | The world's settled rules, lore, timeline, factions and tone, as numbered entries. |
| **Canon revision** | A single monotonic counter for the whole world's canon. |
| **Proposal** | A staged, not-yet-accepted change to any world entity. |
| **Ripple** | The computed consequences of accepting a proposal. |
| **Reference kit** | The set of reference tiles for a sheet — turnarounds, poses, expressions. |
| **Model sheet** | One compiled image, generated from a sheet plus its locked tiles, sent as reference with every generation. |
| **Production** | A work drawn from the world: a story, a video or a set of stills. |
| **Shot** | The atomic unit of video work: framing, camera, audio direction, sheet references. |
| **Take** | One immutable generated result for a shot. Accepted takes assemble the cut. |
| **Dispatch** | Sending one or more jobs to a provider. |
| **Artifact** | A user file filed against the world and linkable to anything. |

---

# 1 · Architecture

## 1.1 Architectural decision

**A thin React client over a local coordinator, with the filesystem as the only durable
truth.** No cloud backend on the hot path, no database of record, no git.

Two independent execution paths hang off the coordinator, and conflating them is the main
architectural risk this specification exists to prevent:

- **The authoring path** — world creation, sheet edits, canon threads, scene drafting — runs
  through **OpenCode** as an agentic file-editing loop confined to a staging directory.
- **The media path** — images, video, voice — runs through Arke Studio's **own job queue**,
  calling FAL, Higgsfield, ElevenLabs and the Voxa sidecar directly.

OpenCode never dispatches media. The job queue never edits world files. The accept gate is
the only thing that writes to the live world, and it is the same gate for both paths.

## 1.2 Process topology

```
┌─ Electron main ────────────────────────────────────────────────┐
│                                                                │
│  ┌─ Renderer ─────────┐        ┌─ Coordinator (in-process) ─┐  │
│  │  React client      │◀──WS──▶│  domain model, accept gate │  │
│  └────────────────────┘        │  index, job queue, ledger  │  │
│                                └─────┬───────────────┬──────┘  │
│                                      │               │         │
│                     ┌────────────────┘               └───────┐ │
│                     ▼                                        ▼ │
│  ┌─ OpenCode (child) ────────┐          ┌─ Voxa (child) ──────┐ │
│  │  headless server          │          │  self-contained .NET│ │
│  │  HTTP + SSE               │          │  HTTP + WS          │ │
│  │  cwd = world, writes      │          │  Kokoro / Whisper   │ │
│  │  confined to .proposals/  │          │  cloud TTS routing  │ │
│  └───────────────────────────┘          └─────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
                     │                                │
                     ▼                                ▼
            LLM providers                  FAL · Higgsfield · ElevenLabs
         (via OpenCode config)              (via the job queue, direct)
```

The coordinator runs **in the Electron main process**, not as a separate server. It is the
same shape as Arke's `apps/desktop`, which embeds `@arke/coordinator` and serves the client
as one signed app.

## 1.3 Package map

```
arke-studio/
  apps/desktop/            Electron shell: main, preload, updater, child supervision
  packages/client/         React client (the only UI)
  packages/coordinator/    Domain model, accept gate, index, job queue, ledger
  packages/contracts/      Zod schemas: world entities, events, adapter interface
  packages/adapter-opencode/  OpenCode harness adapter
  packages/providers/      FAL, Higgsfield, ElevenLabs, OpenAI, Anthropic clients
  packages/voice/          Voxa sidecar supervision and client
  design-system/           The approved design baseline (prototypes, tokens, assets)
```

## 1.4 Code adopted from Arke

Copied, not depended on. The Arke repository is a separate product on its own release
cadence; v1 duplicates the code and preserves the contract, and v2 extracts shared npm
packages once both products have stopped moving.

| From Arke | Adopted as | Adaptation |
|---|---|---|
| `packages/contracts/src/adapter.ts` | `packages/contracts` | Capability probe, `SessionRef`, `CreateSessionInput`, `SendMessageInput`, `AgentModel`, `PermissionDecision`, `RememberedGrant` — kept as-is. |
| `packages/adapter-opencode/*` | `packages/adapter-opencode` | Kept whole. Its OpenAPI-driven capability probe is version-tolerant, which is what makes OpenCode v2 safe to target. |
| `coordinator/trace.ts` | `coordinator/changes.ts` | Append-only trace becomes the world's `changes.jsonl`. |
| `coordinator/projection.ts`, `read-model.ts` | `coordinator/index/*` | The derived read-model pattern becomes the rebuildable index (§2.6). |
| `coordinator/session-store.ts`, `grant-store.ts` | unchanged | Session and remembered-grant persistence. |
| `coordinator/credential-resolver.ts` | `coordinator/credentials.ts` | Retargeted at Electron `safeStorage` (§14.2). |
| `apps/desktop/*` | `apps/desktop` | Shell, updater and packaging template. |

**Requirement**

- **R-ARCH-1** The adopted OpenCode adapter SHALL retain its OpenAPI capability probe rather
  than pinning an OpenCode version.
  - **WHEN** the bundled OpenCode is replaced by a user's newer installation **THEN** the
    adapter advertises only the capabilities that installation's `/doc` actually exposes, and
    degrades the UI to that surface rather than failing.

## 1.5 Data flow

Every mutation follows one path, without exception:

```
intent → agent or form → proposal staged in .proposals/
       → ripple computed from the index
       → human accept
       → live file written · previous snapshotted to .history/ · version bumped
       → changes.jsonl appended
       → index updated · event pushed to the client
```

---

# 2 · The world on disk

## 2.1 Principles

1. **The folder is the only durable truth.** Delete everything else and the world survives.
2. **Readable by hand.** Prose in Markdown with YAML frontmatter; structure in JSON. A user
   can open a world in a text editor, understand it, and edit it.
3. **No git.** History is explicit files, not a VCS. Arke Studio never runs `git`, never
   requires it, and never assumes it is installed.
4. **Everything derived is deletable.** The index and thumbnails rebuild from a full scan.
5. **Portable.** Copying the folder to another machine carries the whole world. Nothing
   references an absolute path.

## 2.2 Folder layout

```
%USERPROFILE%\ArkeStudio\
  config.json                     app config: routing defaults, alert thresholds (never keys)
  queue\
    jobs.jsonl                    append-only job log, all worlds
  ledger.jsonl                    append-only spend ledger, all worlds
  logs\

  worlds\
    the-undersong\
      world.json                  name, logline, tone, genre, canonRevision, timestamps
      canon\
        CANON-002.md
        CANON-043.md
      characters\
        maren-kest.md
      locations\
        the-vigil.md
      factions\
        the-ebb-council.md
      references\                 reference kits and compiled model sheets, per sheet
        maren-kest\
          kit.json                tile inventory: angle, status, source take
          head-front.png
          head-left-three-quarter.png
          model-sheet-v5.png
      artifacts\
        artifacts.json            index of filed artifacts and their links
        harbour-bells.wav
        undersong-treatment.pdf
      productions\
        saltlight\
          production.json         format, title, status, timestamps
          story.md                overview / script / prose, per format
          scenes\
            04-the-verse-rises.json
          takes\
            tk_01J8F.../take.json
            tk_01J8F.../clip.mp4
          cut.json                ordered accepted takes, audio tracks, gaps
          exports\
      .proposals\                 staged, not yet accepted (see §3.2)
      .history\                   full snapshots of superseded versions (see §2.5)
      .index\                     derived, deletable (see §2.6)
      changes.jsonl               append-only change log for this world
```

**Timeline** is not a top-level section. The design prototype shows an early `Timeline` nav
item later replaced by `Canon`, and canon already carries a `timeline` entry type
(`CANON-031 · timeline`). Timeline entries are canon entries; a Timeline view is a filter.

## 2.3 File formats

### 2.3.1 `world.json`

```json
{
  "id": "the-undersong",
  "name": "The Undersong",
  "logline": "A drowned god still sings beneath the harbour.",
  "tone": "quiet dread",
  "genre": "coastal fantasy",
  "canonRevision": 42,
  "created": "2026-05-02T09:14:00Z",
  "updated": "2026-07-30T18:22:00Z"
}
```

### 2.3.2 A sheet — `characters/maren-kest.md`

```markdown
---
id: maren-kest
type: character
name: Maren Kest
role: Tide-caller
billing: lead
version: 4
status: locked          # sketch | locked
voice:
  provider: elevenlabs
  voiceId: v_8Kq2
  label: Low tide
  assignedAtVersion: 4
canonRules: [CANON-002]
links: [bray-half-hitch, the-chorister]
created: 2026-05-02
updated: 2026-07-14
---

## Essence
Tide-caller. She hears the verse under the harbour and pulls the water where it needs to go.

## Appearance
Salt-crusted braids, pale grey eyes, oilskin coat with a bioluminescent thread at the collar.

## Relationships
Trusts Bray with her life, not her secrets. The Chorister knows her true note.

## Voice · written
Low and even. Speaks to the water before she speaks to people.
```

Locations and factions share the schema with different section headings — locations use
`Look` / `Sound` / `Customs` and carry `region`; factions use `Wants` / `Fears` and carry
member links.

**Canon rules are owned by canon, not by the sheet.** The `canonRules` frontmatter key holds
references only. The sheet view renders those entries read-only with the affordance *"edit in
canon, not here"*. This is the single most important structural rule in the sheet model: it
is what prevents two sources of truth for the same fact.

### 2.3.3 A canon entry — `canon/CANON-002.md`

```markdown
---
id: CANON-002
type: rule              # rule | lore | location | faction | timeline | tone | thread
title: Tide-calling
status: settled         # proposed | settled | open
introducedAt: 1         # canon revision
settledAt: 12
amendedAt: 42
links: [maren-kest, CANON-031]
---

A caller cannot move a tide she has not stood in. The song costs hearing, one verse at a time.
```

An open thread is a canon entry with `status: open` and `type: thread`. It occupies a
CANON-nnn id from creation so that conversations can cite it before it settles.

### 2.3.4 A scene — `productions/saltlight/scenes/04-the-verse-rises.json`

```json
{
  "id": "sc_04",
  "number": 4,
  "slug": "the-verse-rises",
  "title": "The verse rises",
  "status": "accepted",
  "inherits": { "location": "the-vigil", "timeOfDay": "night", "tone": "quiet dread" },
  "board": { "version": 2, "compiledAt": "2026-07-29T11:02:00Z", "image": "board-v2.png" },
  "shots": [
    {
      "id": "sh_12",
      "number": 12,
      "title": "Maren at the rail, listening",
      "description": "@maren-kest grips the rail of @the-vigil, head tilted, she hears it first.",
      "camera": "MCU · slow push-in",
      "audio": { "kind": "vo", "speaker": "maren-kest", "line": "the verse, under the water" },
      "durationSec": 4.0,
      "frame": { "takeId": "tk_01J8A...", "status": "accepted" },
      "acceptedTakeId": "tk_01J8F..."
    }
  ]
}
```

`@id` tokens inside `description` are live references to sheets. They are resolved at prompt
assembly and are what makes a shot's cast computable rather than guessed.

### 2.3.5 A take — `productions/saltlight/takes/tk_01J8F.../take.json`

```json
{
  "id": "tk_01J8F...",
  "shotId": "sh_12",
  "index": 3,
  "kind": "clip",         // clip | frame | still | voice | sheet
  "status": "accepted",   // unreviewed | accepted | rejected
  "provider": "fal",
  "model": "seedance-2.0",
  "provenance": {
    "canonRevision": 42,
    "sheets": { "maren-kest": 4, "the-vigil": 2 }
  },
  "prompt": "…",
  "references": ["references/maren-kest/model-sheet-v4.png"],
  "startFrame": "takes/tk_01J8A.../last-frame.png",
  "params": { "aspect": "16:9", "resolution": "720p", "durationSec": 6, "seed": 4417 },
  "cost": { "estimatedUsd": 0.1300, "actualUsd": 0.1284 },
  "dispatchedAt": "2026-07-30T14:01:12Z",
  "completedAt": "2026-07-30T14:02:04Z",
  "media": "clip.mp4"
}
```

Takes are **immutable**. A rejection appends a `rejection` object; it never edits the take.

**Requirements**

- **R-WORLD-1** A world SHALL be fully described by its folder, with no state held outside it
  except the derived index, the app-level job queue and the app-level ledger.
  - **WHEN** a world folder is copied to another machine and opened **THEN** every sheet,
    canon entry, production, take, version history and artifact link resolves identically.
- **R-WORLD-2** Arke Studio SHALL NOT invoke `git` or require it to be installed.
  - **WHEN** the application runs on a machine with no git **THEN** every feature works.
- **R-WORLD-3** No file in a world SHALL contain an absolute path or a provider key.
  - **WHEN** a world is exported or shared **THEN** it carries no machine-specific or secret data.

## 2.4 Versioning

Two independent tracks. This is the model the design prototype already implies, and it is
correct because canon and sheets are different kinds of thing.

**Canon has one monotonic world-level revision.** `world.json` holds `canonRevision`. Accepting
any canon change increments it once. Individual entries record which revisions touched them —
`introducedAt`, `settledAt`, `amendedAt` — which is exactly how the prototype reads:
*"written day one · settled v12 · last amended v42"*. CANON-002 does not have forty-two
versions; it has six, stamped with the world revision at which each landed.

The reason canon is world-scoped: a proposal is ripple-checked against *all* of canon, so
"what did canon look like at dispatch" must be a single number.

**Each sheet has its own monotonic version.** `sheet v4 → v5`, independent of canon and of
every other sheet. The reason: sheets are cited individually, so a take must record
`maren-kest: 4`, not a world-wide snapshot.

**Provenance records both.** Every take carries `{ canonRevision, sheets: {…} }`. That pair is
what makes *"accepted takes stay on the version they were made with"* and *"14 reference images
predate v5"* computable rather than decorative.

**Requirements**

- **R-VER-1** Accepting any canon change SHALL increment `world.canonRevision` exactly once,
  and stamp the affected entry's `amendedAt` (or `settledAt`, or `introducedAt`) with the new value.
  - **WHEN** two canon entries are accepted in one proposal **THEN** the revision advances by
    one, not two, and both entries record the same revision.
- **R-VER-2** Accepting a sheet change SHALL increment that sheet's `version` by one and leave
  every other sheet and the canon revision untouched.
- **R-VER-3** Every take SHALL record the canon revision and the version of each sheet cited at
  dispatch, and that record SHALL NOT change when those entities are later revised.
  - **WHEN** Maren advances to v5 **THEN** takes made against v4 still report v4, and the cut
    still plays them.

## 2.5 History and the change log

**History as full snapshots, not diffs.** On accept, the outgoing file is copied verbatim to
`.history/<kind>/<id>/v<n>.md` before the new content is written. Diffs would mean
reimplementing merge and patch machinery with no VCS underneath; a sheet is 2–5 KB, so six
versions costs about 25 KB. *"Full history · 6 versions"* becomes a directory listing, and
restoring a version is a file copy.

Canon snapshots are keyed by canon revision (`.history/canon/CANON-002/v42.md`); sheet
snapshots by sheet version (`.history/characters/maren-kest/v4.md`).

Binaries are never snapshotted. Takes are immutable and addressed by id, so the reference is
the version.

**`changes.jsonl`** is append-only, one JSON object per line, and is the world's audit trail:

```json
{"ts":"2026-07-30T18:22:04Z","entity":"characters/maren-kest","fromVersion":4,"toVersion":5,
 "fieldsChanged":["appearance","voice-written"],"source":"chat:sess_9f2",
 "canonRevisionAfter":42,"proposalId":"pr_01J8H..."}
```

It is the backing store for the Activity feed, the input to index rebuilds, and the record
that answers "how did this get here".

**Requirements**

- **R-HIST-1** Accepting a change SHALL write the outgoing version to `.history/` before the
  live file is modified.
  - **WHEN** the application is killed mid-accept **THEN** either the old file is intact or the
    snapshot exists alongside the new file; no state loses both.
- **R-HIST-2** The application SHALL offer restoring any historical version as a *new* proposal
  rather than an in-place rollback.
  - **WHEN** a user restores Maren v4 while the sheet is at v6 **THEN** a proposal is staged
    whose content is v4 and whose acceptance produces v7.
- **R-HIST-3** `changes.jsonl` SHALL be append-only and SHALL never be rewritten or compacted
  by v1.

## 2.6 The derived index

A **SQLite** database at `.index/world.db`, written via `better-sqlite3`. It is a cache: it is
never the source of truth, it is safe to delete, and it rebuilds by scanning the world folder
and replaying `changes.jsonl`.

It exists because the product's UI asks questions the folder cannot answer cheaply:
*"23 artifacts from this sheet"*, *"everything that cited this sheet at dispatch"*,
*"14 refs · 3 productions"*, *"3 productions pick up v5 on their next dispatch"*, the Activity
feed, and weekly spend aggregation.

Tables: `entities`, `citations` (who references what, and at which version), `takes`, `jobs`,
`ledger`, and `canon_fts` — an FTS5 virtual table over canon titles and statements.

**Lexical search only in v1.** FTS5 with BM25 ranking backs both the canon search box and the
"closest match" result in the refusal state (§4.3). Embeddings are a v2 concern.

**Requirements**

- **R-IDX-1** Deleting `.index/` SHALL cause a full rebuild on next open with no data loss.
  - **WHEN** `.index/` is removed and the world reopened **THEN** every count, citation and
    ripple result matches its pre-deletion value.
- **R-IDX-2** The index SHALL be rebuilt automatically when its schema version, or the world's
  last-modified scan, does not match its recorded state.
- **R-IDX-3** No write path SHALL read a value from the index that it then persists to a world
  file, other than ids being linked.

## 2.7 Concurrency and external edits

One process owns a world at a time, enforced by a lock file. Hand edits made while the world is
closed are picked up by the scan on open. Hand edits made while it is open are detected by a
watcher, which marks the index stale and prompts a reload rather than merging.

---

# 3 · The accept gate

## 3.1 The universal pattern

Every mutation to the world — from any source, agent or human, prose or form — passes through
the same four states:

```
draft → proposed → ripple-checked → accepted | discarded
```

The UI copy is consistent and load-bearing: *"Nothing changes until you accept."* This is a
single implementation used by canon, sheets, scenes, story overviews and locations. Takes use
a variant (§10.5) because their content is a binary that already exists.

## 3.2 Proposals

A proposal is a directory under `.proposals/<proposalId>/` containing the *complete proposed
files*, not patches:

```
.proposals/pr_01J8H.../
  proposal.json      kind, target entity, source, session id, created
  characters/maren-kest.md      the full proposed file
  ripple.json        computed consequences (§3.3)
```

The authoring agent writes here and nowhere else (§17.3). Because the proposal is whole files,
accepting is a move, and the UI's side-by-side "current vs proposed" is a plain two-file
comparison with no patch application to get wrong.

## 3.3 Ripple checks

Ripples are **computed from the index, never asked of the model.** The LLM writes the prose
that explains a ripple; it does not determine what the ripples are. This is what makes
*"14 reference images predate v5, regenerate looks after accept"* trustworthy.

Computed ripples for a sheet change:

| Ripple | Computed from |
|---|---|
| Reference tiles older than the new version | `citations` where target = sheet, kind = tile |
| Productions that will pick up the new version | `citations` where target = sheet, scoped to productions with unfinished shots |
| Scene briefs that re-render their cast block | scenes whose shots `@`-reference the sheet |
| Canon entries that own the sheet's rules | the sheet's `canonRules` |
| Accepted takes pinned to the old version | `takes` where `provenance.sheets[id] < newVersion` |

For a canon change, additionally: contradiction candidates (lexical overlap against other
entries, surfaced for human judgement, never auto-blocking), entries gaining a cross-reference,
and productions whose next dispatch will see the new revision.

**Requirements**

- **R-GATE-1** No world file outside `.proposals/` SHALL be written except by an accept.
  - **WHEN** an authoring agent runs to completion without a human accept **THEN** the live
    world is byte-identical to before.
- **R-GATE-2** Ripple facts SHALL be computed from the index; model output SHALL only supply
  their human-readable explanation.
  - **WHEN** the model's prose and the computed ripple set disagree **THEN** the computed set
    is displayed and the prose is suppressed.
- **R-GATE-3** Accepting SHALL be atomic across all files in the proposal.
  - **WHEN** a proposal touches a sheet and two canon entries **THEN** either all three land
    with one canon-revision bump, or none do.
- **R-GATE-4** Discarding a proposal SHALL delete its staging directory and leave no trace in
  the world other than a `changes.jsonl` line recording the discard.

## 3.4 Chat and form duality

Canon entries, sheets, locations and scenes are all authorable two ways, and the prototype
shows both as tabs on the same screen: **Chat** (talk it out, the model drafts) and **Form**
(the fields directly). Both produce the same proposal, and switching tabs mid-edit preserves
work because the proposal, not the conversation, is the state.

- **R-GATE-5** The chat and form authoring modes SHALL write to one proposal, and switching
  between them SHALL NOT discard staged content.

---

# 4 · Canon

## 4.1 Entries

Numbered `CANON-nnn`, allocated monotonically per world and never reused. Types: `rule`,
`lore`, `location`, `faction`, `timeline`, `tone`, `thread`. Statuses: `proposed`, `settled`,
`open`.

An entry's detail view shows its statement, its links, what cites it, its version history
keyed by canon revision, and what changing it would ripple into.

## 4.2 Revisions

Per §2.4. The Canon screen header shows the current revision (`THE UNDERSONG · 42 ENTRIES`,
`canon v42`), and every production records the revision it last dispatched against.

## 4.3 Q&A, grounding and refusal

The canon Ask box answers **only** from canon entries, with per-entry citations. This is the
feature the website leads on and it must not degrade into general model knowledge.

Two outcomes:

**Answered.** The response cites every entry it drew on, by id, and offers *"Open CANON-002"*
and *"Save as lore note"*.

**Refused.** When no entry can answer, the response says so explicitly — *"The canon doesn't
answer this, and it won't guess"* — reports the search performed (*"Searched all 42 entries"*),
cites the closest non-answering entries by BM25 rank, and offers *"Draft an answer in context"*
and *"Open as thread · CANON-043"*.

Refusal is decided by **retrieval, not by the model's self-assessment.** If lexical retrieval
returns no entry above a relevance floor, the refusal state renders without an LLM call at
all. When retrieval does return candidates, the model is given those candidates only, and is
instructed that it may answer solely from them.

**Requirements**

- **R-CANON-1** A canon answer SHALL cite at least one canon entry id, and SHALL be generated
  from retrieved entry text only.
  - **WHEN** the model returns an answer citing no entry **THEN** the answer is discarded and
    the refusal state renders.
- **R-CANON-2** When retrieval returns no entry above the relevance floor, the refusal state
  SHALL render without dispatching an LLM call.
- **R-CANON-3** The refusal state SHALL report the number of entries searched and cite the
  closest non-answering entries.
- **R-CANON-4** Canon entry ids SHALL be allocated monotonically and never reused, including
  after an entry is deleted.

## 4.4 Threads

An unanswered question becomes an open thread, holding a CANON id from creation. A thread is
authored in the same chat/form gate as any entry, and accepting it closes the thread and
settles the entry.

- **R-CANON-5** Accepting a thread SHALL settle the entry, close the thread, and increment the
  canon revision once.

---

# 5 · Sheets

## 5.1 Lifecycle

`sketch → locked`. A sketch is referenceable but flagged; locking makes a sheet citable as
canon-grade. The Cast screen reports the split (*"4 canon-locked · 2 sketches"*).

Locking is itself an accept: it stages a proposal whose only change is `status`, so the ripple
check runs and the version increments.

## 5.2 Creation paths

Three, per the prototype's New-character dialog:

1. **From a sentence** — drafted against the world's canon, tone and existing cast.
2. **From an image** — appearance, wardrobe, age and mood are read from the image; name, voice
   and relationships stay the author's to write. The source image is filed as an artifact with
   provenance.
3. **Duplicate a sheet** — copies as a new sketch, links the source sheet as origin, leaves the
   source untouched.

All three land as sketches. *"Nothing is canon until you lock it."*

## 5.3 Editing

Chat or form, one proposal (§3.4). The proposed-sheet panel shows changed fields with
before/after, the computed ripple list, and the accept/discard pair.

**Requirements**

- **R-SHEET-1** A sheet SHALL declare canon-owned rules by reference only, and the sheet editor
  SHALL render them read-only with a link to the owning canon entry.
  - **WHEN** a user attempts to edit a canon rule from a sheet **THEN** they are directed to the
    canon entry, and no sheet-local copy is created.
- **R-SHEET-2** Creating a sheet from an image SHALL file that image as an artifact linked to
  the new sheet, recording it as the drafting source.
- **R-SHEET-3** Duplicating a sheet SHALL produce a sketch linked to the source at the source's
  current version, and SHALL NOT modify the source.

---

# 6 · Reference kits and model sheets

This is the consistency machinery, and it is the product's technical differentiator.

## 6.1 Tiles

A sheet's reference kit holds tiles in three groups:

- **Head turnaround** — front, left ¾, right ¾, back.
- **Full-body turnaround** — front, left, right, back. Gated on the head turnaround being
  locked, because body generations use locked head tiles as reference.
- **Poses and expressions** — open-ended, added as productions need them.

Each tile is `pending`, `rendering`, `generated` or `locked`. Locking a tile is what admits it
to the reference set.

## 6.2 Compilation

Locked tiles plus the sheet compile into a **model sheet** — a single image, in one of three
formats:

| Format | Produced by | Cost |
|---|---|---|
| **Pitch board** | Generated (an image model, from a long art-directed prompt) | Metered |
| **Classic grid** | Composited locally from tiles | Free, instant |
| **Expression board** | Generated | Metered |

The rendering style defaults to the world's art direction, and an override travels with the
sheet only — *"the canon doesn't change"*.

The generated formats come back as takes and land on the sheet only on accept.

## 6.3 The consistency contract

The compiled model sheet is attached as a reference image to **every** generation that cites
that sheet, on every provider that accepts references. Where a provider does not accept
references (the prototype's Halcyon 1.5: *"takes no reference images, the start frame carries
the look"*), the UI states that plainly at dispatch and the sheet's identity is carried in the
prompt text instead.

## 6.4 Drift

**Human-only in v1.** The product surface says *"drift gets flagged, not filed"*; in v1 that
flagging is a human act — rejecting a take with a cited sheet field. Automated comparison of a
take against its model sheet is designed for and deferred.

**Requirements**

- **R-REF-1** Every dispatch citing a sheet SHALL attach that sheet's current compiled model
  sheet as a reference, where the target model accepts reference images.
  - **WHEN** the model accepts no references **THEN** the dispatch dialog states so before the
    user commits, and the sheet's identity is carried in the prompt.
- **R-REF-2** Full-body turnaround generation SHALL be blocked until the head turnaround is
  fully locked.
- **R-REF-3** A compiled model sheet SHALL record the sheet version and the tile set it was
  compiled from, and the UI SHALL flag it as stale when either has advanced.
- **R-REF-4** The classic-grid format SHALL compile locally with no provider call and no cost.

---

# 7 · Voice

## 7.1 The Voxa sidecar

Voxa is a .NET 10 framework. It ships as a **self-contained binary** supervised by Electron
main, exposing HTTP and WebSocket on a loopback port allocated at startup.

**v1 uses batch synthesis and push-to-talk transcription only.** Nothing in the Studio design
needs conversational voice — every chat panel is typed. But the sidecar is built as a genuine
Voxa pipeline host with the realtime `/voice` WebSocket mounted and unused, because that is
the same build effort and makes realtime a configuration change later rather than a rewrite.

Surface consumed by v1:

| Endpoint | Use |
|---|---|
| `POST /tts` | A dialogue line → a voice take. Text, voice id, delivery, format. |
| `POST /stt` | Push-to-talk dictation into any chat panel. |
| `GET /voices` | The available local voice catalog. |
| `GET /health` | Readiness and model-download state. |
| `WS /voice` | Mounted, unused in v1. |

Local models download on first use, not at install: **Kokoro** for TTS (92 MB int8 / 163 MB
fp16 / 325 MB fp32, plus the espeak-ng phonemizer) and **whisper.cpp** for STT. The design
prototype's *"Local voice · 2.1 GB"* is wrong by an order of magnitude and the download screen
should say so.

Changes to the Voxa repository are in remit. Expect to add a headless studio profile and a
stable JSON contract for the two endpoints above.

## 7.2 Voice assignment

A voice belongs to the **sheet**, not the production or the line. *"A character's voice is part
of their sheet; retakes keep the voice, only the read changes."*

The voice picker offers sources — ElevenLabs, OpenAI, Local, uploads — and matches candidates
against the sheet's *written* voice description, previewing with the character's own canon
lines rather than a stock sentence.

**Local is preset-only.** Kokoro pins a fixed catalogue of style vectors; it cannot synthesise
an arbitrary new voice. Cloning is cloud-only in v1. The picker states this rather than letting
a user hunt for a clone button under "Local".

## 7.3 Generation

A dialogue line generates against the sheet's assigned voice with a per-take **delivery**
(measured, whispered, breaking, cold). Delivery shapes the take only; the voice belongs to the
sheet. Voice takes are auditioned against the cut before landing in it.

**Requirements**

- **R-VOICE-1** A voice SHALL be assigned to a sheet and inherited by every line that sheet
  speaks, across every production.
  - **WHEN** a line is retaken with a different delivery **THEN** the voice is unchanged.
- **R-VOICE-2** Assigning a voice SHALL pass through the accept gate and increment the sheet
  version, and the ripple SHALL list the productions affected.
- **R-VOICE-3** The voice picker SHALL preview candidates using the character's own canon
  dialogue.
- **R-VOICE-4** Local voices SHALL be presented as a fixed catalogue, and voice cloning SHALL
  be offered only for providers that support it, disabled with a stated reason elsewhere.
- **R-VOICE-5** The application SHALL start and remain fully usable when the Voxa sidecar fails
  to start, with voice features disabled and a stated reason.

---

# 8 · Productions

## 8.1 Formats

Three in v1: **story** (novel, script, serial), **video** (short film, music video, series),
**stills** (visual album, key art sets). Games are out of scope.

A production is created inside a world and inherits its cast, locations, canon and tone
automatically. The New-production dialog states this: *"joins The Undersong · shares all 6
characters"*.

## 8.2 Day one

A new production's dashboard is not an empty state to be tidied — it opens with everything the
world already knows, plus seeds drawn from the world's open canon threads and from other
productions' loose ends. This is the thesis made visible at the moment it matters most.

## 8.3 Story

A story production is a **chapter tree**, not one document. The overview (spine, acts, gaps) is
authored through the chat gate and steers drafting; chapters hang beneath it.

```
productions/undersong/
  production.json
  story.json              overview: logline, acts, spine, target length
  chapters/
    01-the-tide-lower-than-ever.md
    02-what-the-water-left.md
```

A chapter carries frontmatter — number, title, status, version, word count, the sheets and
canon entries it draws on — and prose in the body.

**Chapter prose is not gated.** The accept gate protects *the world*, and chapter prose is
production output, not world state. Gating every paragraph of a novel would make the product
unusable for the thing it claims to do. The line is the same one takes draw: generated content
is gated on arrival, human-authored content is not.

So: an agent-drafted chapter arrives as a proposal and is accepted or discarded like anything
else, and accepting cuts a new chapter version with a `.history/` snapshot. Once accepted, the
chapter is a document the author edits directly, autosaving in place without cutting versions.
A new version is cut only by an accepted draft or an explicit save-point.

What *is* gated is anything a chapter implies about the world. When drafting surfaces a new
fact — a name, a rule, a place — it is proposed as a canon entry or a sheet edit through the
ordinary gate, separately from the prose.

## 8.4 Video

The deepest surface: scenes, shots, boards, dispatch, takes, the cut, audio, exports. §§9–12.

## 8.5 Stills

Frame sets generated from sheets and locations without a timeline. Shares dispatch, takes and
the accept gate; skips the cut.

**Stills is not a separate entity model.** A stills *frame* is a shot minus duration, camera
motion and audio direction. `production.format` drives which fields and panels render, so the
dispatch, take and accept paths are the same code. Forking the entity would fork the pipeline
for a format that shares almost all of it, which is where the two paths would begin to drift.

Stills does need one surface video does not: a **contact sheet**. A visual album is judged on
coherence across the set, which cannot be assessed one take at a time in a shot card. The
contact sheet shows every frame at its accepted take, at size, in a grid, with accept and
reject inline. It is a re-rendering of existing data, and the same view backs video's Board tab.

**Requirements**

- **R-PROD-1** Creating a production SHALL NOT copy world entities into it; productions
  reference the world.
  - **WHEN** a sheet advances **THEN** every production sees the new version at its next
    dispatch without any per-production migration.
- **R-PROD-2** A story production SHALL hold its prose as one file per chapter beneath the
  production, each independently versioned.
- **R-PROD-3** Direct human edits to chapter prose SHALL save without passing through the accept
  gate and without cutting a version; agent-drafted chapters SHALL arrive as proposals and cut a
  version on accept.
  - **WHEN** an author types into an accepted chapter **THEN** no proposal is created and no
    ripple check runs.
- **R-PROD-4** World facts surfaced while drafting SHALL be proposed as canon or sheet changes
  through the ordinary gate, separately from the prose that surfaced them.
- **R-PROD-5** Stills frames SHALL share the shot entity, dispatch path and take model with
  video, differing only in which fields the format renders.
- **R-PROD-6** A stills production SHALL provide a contact-sheet view of every frame at its
  accepted take, supporting accept and reject without leaving the view.

---

# 9 · Scenes and shots

## 9.1 Scene drafting

Scenes are drafted in conversation. The model proposes a draft — a location, a cast, props,
and an ordered shot list with durations — and canon-checks as it goes, surfacing what it
verified (*"the thread glows only when a tide is callable · CANON-002 holds here"*).

Accepting a scene creates its shots as cards. **Nothing is dispatched by accepting a scene.**

## 9.2 Shot cards

A shot carries: number, title, description with `@` sheet references, camera direction, audio
direction, duration, an optional pinned start frame, and its takes.

Every shot inherits the scene's location, sheets and tone, shown as chips on the scene header.

## 9.3 Boards

A scene compiles a **board** — frames, order, timings and labels — kept in step with the shots.
Recompiling is local and free. The board is exportable as PNG and lands in artifacts on every
compile. In whole-scene dispatch the board rides along as the scene reference; in per-shot
dispatch each frame is sent instead.

**Requirements**

- **R-SCENE-1** Accepting a scene SHALL create its shots and dispatch nothing.
- **R-SCENE-2** `@` references in a shot description SHALL resolve to sheet ids, and SHALL be
  the source of that shot's cast for prompt assembly and reference attachment.
- **R-SCENE-3** Board compilation SHALL be local, free, and repeatable, and SHALL file the
  compiled board as an artifact.

---

# 10 · Dispatch

## 10.1 The job queue

A durable, append-only queue at `%USERPROFILE%\ArkeStudio\queue\jobs.jsonl`, app-level rather
than world-level so the Activity screen can show everything at once. Each job records its
world, production, target entity, provider, model, parameters, estimated cost, status and
timestamps.

States: `queued → running → succeeded | failed | cancelled`. Jobs survive restart; on start-up
the queue reconciles `running` jobs against provider status where the provider supports it,
and marks them `failed` with a stated reason where it does not.

Failures are not charged and say so (*"provider timeout · not charged"*), and offer retry.

## 10.2 Prompt assembly

A shot's prompt is **assembled from the world** — sheet essence and appearance, location look,
tone, camera and audio direction — and is then freely editable. Edits stay on the shot; the
canon does not change from there. A Reset restores the assembled version.

## 10.3 Per-shot and whole-scene dispatch

Both in v1. The dispatch dialog presents the trade honestly, with computed estimates for each:

**Per shot** — one clip per shot, each seeded by its own frame. Any shot can be retried alone;
cast stays pinned per shot. Cost is the sum of the shots.

**Whole scene** — one pass from a compiled brief (contact sheet plus shot list). Best motion
continuity, but a retry re-runs the whole pass. Where the scene exceeds the model's per-clip
cap, it is **packed into passes** — the prototype's *"19.5s over the 15s cap · packs into 2
passes"* — and the packing is computed from the model manifest's duration limit.

Shots without an accepted frame are called out before dispatch, with the option to generate
from the brief alone or to go back and pin a frame first.

**Sketch-cited shots get the same treatment.** A sketch has no locked tiles, therefore no
compiled model sheet, therefore no identity reference rides along — a materially different
generation, and the exact failure this product exists to prevent. The dispatch dialog names the
specific sketches the shot cites, states the consequence, and offers to lock them first. It
does **not** block: generating first looks is how a sketch becomes locked, so blocking would
close the only path out of sketch-hood. The Cast screen's locked/sketch count is ambient world
information and is not a substitute for this per-dispatch notice.

## 10.4 Continuity chaining

Each clip opens on the **last frame of the clip before it**. The queue extracts the final frame
of an accepted take and pins it as the next shot's start frame, so continuity is a property of
the pipeline rather than of the prompt.

Frame extraction is local, via the bundled ffmpeg.

## 10.5 Takes

Takes arrive `unreviewed` and are reviewed one at a time: **Accept** locks the take into the
cut; **Reject** requires citing what drifted, by sheet and field.

Rejections are **logged only in v1**. The record is written to `changes.jsonl` and surfaced in
the shot's history, so that the eventual "rejections teach the shot" behaviour has a corpus to
learn from — but v1 does not mutate prompts from rejections.

**Requirements**

- **R-DISP-1** Every dispatch SHALL present a computed cost estimate before the user commits.
- **R-DISP-2** Whole-scene dispatch SHALL compute pass packing from the target model's duration
  cap and display the resulting pass count and cost before commit.
- **R-DISP-3** A dispatch SHALL record the canon revision and each cited sheet's version onto
  every take it produces.
- **R-DISP-4** Failed jobs SHALL NOT be charged to the ledger, SHALL state the failure reason,
  and SHALL offer retry.
- **R-DISP-5** Accepting a take SHALL extract its final frame and make it available as the
  following shot's start frame.
- **R-DISP-6** Rejecting a take SHALL require a cited sheet and field, and SHALL record the
  citation without modifying the shot's prompt.
- **R-DISP-7** The queue SHALL survive process restart with no job lost or silently duplicated.
- **R-DISP-8** A dispatch citing a sketch SHALL name that sketch before commit and state that no
  model sheet will accompany the generation, and SHALL allow the dispatch to proceed.
  - **WHEN** a shot cites two locked sheets and one sketch **THEN** only the sketch is named,
    and the dispatch is not blocked.

---

# 11 · The cut

The cut is **assembled from accepted takes only**. It is not a timeline the user drags; a card
moves because the work moved. Gaps are explicit and are what is left to shoot
(*"13 of 15 shots covered · 2 gaps · 30s uncovered"*).

`cut.json` holds the ordered shot references, the audio tracks, and nothing that duplicates a
take's own record.

- **R-CUT-1** The cut SHALL contain only accepted takes, and SHALL recompute when a take's
  accepted status changes.
- **R-CUT-2** Uncovered shots SHALL render as explicit gaps with their shot labels and durations.

---

# 12 · Audio

Three track kinds: **dialogue** (voice takes, per §7), **score**, **ambience**. Ambience is
commonly a filed artifact rather than a generation. Tracks reference takes and artifacts;
`cut.json` records placement.

- **R-AUD-1** A dialogue track entry SHALL reference the speaking sheet and the voice take, and
  SHALL show which sheet version the voice was assigned at.

---

# 13 · Artifacts

Recordings, documents, boards, stems and images filed against the world and linkable to any
sheet, canon entry, location, production or shot. Filed by drag-and-drop or on import of a
folder.

Artifacts are also produced by the system: compiled boards, source images used to draft a
sheet, and reference material imported at first run. System-filed artifacts record their
provenance.

Cross-production filing is automatic: *"everything that cited this sheet at dispatch"* is a
query against the `citations` table, not a curated list.

## 13.1 World import

*"Already have a canon in documents? Import a folder."* Import is two stages, and the second is
optional and always gated.

**Stage one — file.** Every importable file is copied into `artifacts/` and indexed. This
always happens, never fails on content, and is complete on its own: the user has their material
in the world, linkable to anything.

**Stage two — lift.** An extraction pass reads the filed documents and **proposes** canon
entries and sheets from them. Each candidate is a separate proposal citing the artifact and the
location within it that produced it, so acceptance is per-fact rather than all-or-nothing. A
document that yields thirty candidates produces thirty proposals the user works through, not
one bulk import that silently rewrites the world.

Nothing extracted enters the world without an accept, and every accepted entry keeps a link
back to the source artifact — so months later, "where did this come from" has an answer.

**Requirements**

- **R-ART-1** Filing an artifact SHALL copy it into the world folder, never reference it in
  place.
- **R-ART-2** Every artifact SHALL record whether it was user-filed or system-produced, and
  system-produced artifacts SHALL record what produced them.
- **R-ART-3** Importing a folder SHALL file every importable file as an artifact before any
  extraction is attempted, and SHALL succeed at that stage regardless of extraction outcome.
- **R-ART-4** Extraction SHALL produce one proposal per candidate fact, each citing its source
  artifact and location within it.
  - **WHEN** a user accepts three of thirty candidates **THEN** the other twenty-seven leave no
    trace in the world, and the three carry links to their source.

---

# 14 · Providers, keys and cost

## 14.1 Provider set

| Provider | Capabilities | Route |
|---|---|---|
| **FAL** | image, video | Gateway — the predominant route for image and video models |
| **Higgsfield** | image, video | Gateway |
| **OpenAI** | LLM, image | Direct |
| **Anthropic** | LLM | Direct |
| **ElevenLabs** | voice TTS, cloning | Direct |
| **Ollama** | LLM | Local runtime — dual-routed, see §14.1.1 |
| **Kokoro** | voice TTS | Local, via Voxa |
| **whisper.cpp** | voice STT | Local, via Voxa |

A provider is entered once and its key covers every capability it lists. The Settings screen's
"Who does what" section sets the default provider per capability; any production can override
per dispatch.

Local runtimes that this machine cannot run stay **visible and disabled with the reason**
(*"Needs 24 GB VRAM. This machine has 12 GB. Cloud video still works."*), which is a
deliberate product behaviour, not an error state.

### 14.1.1 Ollama is dual-routed

Ollama is reached two ways, and this is the only provider for which that is true:

- **Directly by Studio**, for cheap non-authoring work that never touches the accept gate:
  prompt assembly, summarising a take's rejection, naming and slug suggestions, matching a
  voice candidate against a written voice description. These are short, high-frequency calls
  where a round-trip through the harness would add latency and cost for no benefit.
- **Through the harness**, as an authoring provider, when no online LLM provider is configured
  or selected. Studio writes it into OpenCode's configuration alongside the cloud providers
  (§17.2), so authoring degrades to local rather than becoming unavailable.

The two routes are the same runtime and the same models; only the caller differs. Both record
zero cost (R-PROV-6).

## 14.2 Keys

Keys are stored via Electron's **`safeStorage`** (DPAPI-backed on Windows), never in a world,
never in an export, never in a log, and never in a diagnostics bundle. Keys are written into
OpenCode's configuration by Studio at harness start-up (§17.2) — Studio owns them and passes
them down.

## 14.3 The model manifest

A hand-maintained manifest, seeded from FAL's and Higgsfield's catalogues, declaring per model:
capabilities (reference images, start frame, end frame), duration cap, resolution and aspect
options, and cost. This is what powers the model picker's honest capability copy
(*"Seedance 2.0 · refs · frames · 15s"* against *"Halcyon 1.5 · frames only · 12s"*) and the
pre-dispatch estimate.

## 14.4 Cost

**v1 denominates in USD, not credits.** The design prototype mixes both — `est. 13 cr` beside
`~$0.24` — and "credits" implies a prepaid balance that Arke Studio, being free and
bring-your-own-key, does not hold. Showing real money is more honest and removes a conversion
the product has no authority to define. *This is a deliberate deviation from the prototype and
is the one place the implementation should be expected to differ visibly from the approved
design.*

The manifest is the **primary** source for the pre-dispatch estimate, because that is the
number that influences the decision and it must be available before the call. Provider-reported
actuals, where returned, reconcile the ledger afterwards.

`ledger.jsonl` is append-only: one line per completed job, recording world, production,
provider, model, estimate, actual and timestamp. The Activity screen aggregates it by week and
by provider, and the alert threshold is checked against it.

**Requirements**

- **R-PROV-1** A provider key SHALL be entered once and satisfy every capability that provider
  declares.
- **R-PROV-2** Keys SHALL be stored only in the OS credential store, and SHALL never appear in
  a world file, an export, a log or a diagnostics bundle.
  - **WHEN** a diagnostics bundle is generated **THEN** it contains no key material and no world
    content.
- **R-PROV-3** Local runtimes the machine cannot run SHALL be listed, disabled, and annotated
  with the specific reason.
- **R-PROV-4** Pre-dispatch estimates SHALL come from the model manifest and SHALL NOT require
  a provider round-trip.
- **R-PROV-5** The ledger SHALL record estimate and actual separately, and SHALL never be
  rewritten.
- **R-PROV-6** Local runs SHALL be recorded at zero cost and labelled as unmetered.
- **R-PROV-7** Studio SHALL call Ollama directly for non-authoring work, and SHALL additionally
  offer it as a harness authoring provider when no online LLM provider is configured or selected.
  - **WHEN** no cloud LLM key is present but Ollama is running **THEN** authoring remains
    available through the harness rather than being disabled.

---

# 15 · Activity

One screen for everything the application is doing and what it costs: **Running**, **Needs
you**, **Earlier today**, and the week's spend by provider.

**Global, with a world filter defaulting to the active world.** Three reasons the underlying
queue and ledger are global rather than per-world:

- **Spend is per-key, not per-world.** One API key produces one bill. A weekly alert threshold
  that counted a single world would under-report and fail the only job it has.
- **Jobs compete for shared limits.** Rate limits, key quotas and the machine itself are shared.
  A per-world queue gives two open worlds no place to serialize against one rate limit.
- **Needs-you is better global.** Returning after a week, the useful question is "what is waiting
  on me", not per-world archaeology.

The filter keeps the common case quiet: most work happens inside one world, so the view opens
scoped to it with a visible toggle to All.

The needs-you queue is the product's task list, and it is computed rather than curated:
unreviewed takes, scene drafts awaiting acceptance, board images awaiting approval, proposals
left open.

- **R-ACT-1** The needs-you queue SHALL be computed from world and queue state, and SHALL NOT
  be a stored list.
- **R-ACT-2** Model downloads SHALL appear as running work with progress, alongside generations.
- **R-ACT-3** The job queue and the spend ledger SHALL be global across worlds, and the Activity
  view SHALL default to the active world with a toggle to all worlds.
  - **WHEN** two worlds are open and both dispatch **THEN** their jobs serialize against one
    shared rate limit, and the week's spend totals both.

---

# 16 · Exports

The cut stays the source; an export is a render of it. Three presets: **review cut** (1080p,
burned-in timecode), **master** (ProRes, 4K upscale, clean), **social excerpt** (9:16, scene
selection, captions).

Rendering is local via bundled ffmpeg. Gaps export as black slates carrying their shot labels,
so an incomplete cut still produces a reviewable artefact.

Worlds themselves export as readable files — which for this architecture means copying the
folder. *"Your canon is a readable format, not a proprietary lock."*

- **R-EXP-1** Exports SHALL render locally with no provider call.
- **R-EXP-2** Uncovered shots SHALL export as labelled slates rather than being silently omitted.
- **R-EXP-3** Exporting a world SHALL produce a folder that reopens identically on another
  machine.

---

# 17 · The harness

## 17.1 What OpenCode is used for

The authoring path only: drafting worlds, editing sheets, authoring canon entries and threads,
drafting scenes and story overviews, and answering canon questions from retrieved entries.

OpenCode is a file-editing agent, and a world is a folder of readable files. That correspondence
is the reason this works: "edit the canon" is literally a file edit, and OpenCode's tool loop,
session tree and permission model map onto the accept gate almost directly.

**OpenCode never dispatches media.** Image, video and voice generation belong to the job queue
(§10.1).

## 17.2 Lifecycle and configuration

OpenCode v2 is **bundled** with the installer, and the application **checks for an existing
installation first** and prefers it. Whichever is used, its capabilities are probed from its
OpenAPI document rather than assumed (§1.4).

Studio owns provider keys and writes OpenCode's configuration at start-up, passing down the
LLM providers the user configured in Settings — including a running Ollama, so that authoring
degrades to local rather than becoming unavailable when no cloud key is present (§14.1.1). The
user never configures OpenCode directly and is never asked for a key twice.

## 17.3 Confinement

Each authoring session runs with the world folder as its working directory and **write
permission scoped to `.proposals/`**. This is what makes the accept gate structural rather than
advisory: an authoring agent cannot modify the live world even if it tries.

## 17.4 Permissions

OpenCode's permission prompts are surfaced, but rendered as Studio concepts in Studio's
language — an approval to proceed, not a tool-call dialog. Remembered grants (`always`) persist
across restarts and are revocable, reusing Arke's `grant-store`.

**Requirements**

- **R-HARNESS-1** Authoring sessions SHALL be confined to `.proposals/` for writes.
  - **WHEN** an authoring agent attempts to write a live world file **THEN** the write is
    refused and the attempt recorded.
- **R-HARNESS-2** The application SHALL prefer an existing OpenCode installation over the
  bundled one, and SHALL report which it is using.
- **R-HARNESS-3** Studio SHALL write the harness's provider configuration from its own settings,
  and SHALL never require the user to configure the harness directly.
- **R-HARNESS-4** Harness permission prompts SHALL be presented in Studio's own language,
  without exposing harness-internal tool names.
- **R-HARNESS-5** The application SHALL start and remain usable for non-authoring work when the
  harness is unreachable, with authoring disabled and a stated reason.

---

# 18 · Non-functional requirements

- **N-1 · Offline.** Every local operation — opening worlds, browsing, editing via forms,
  compiling grids, playing the cut, exporting — works with no network. Only dispatches and
  agent-assisted authoring require one.
- **N-2 · Crash safety.** No accept, job or ledger write may leave the world in a state where
  both the old and new versions are absent. Writes are staged and renamed.
- **N-3 · Startup.** Opening a world with 50 sheets, 200 canon entries and 500 takes reaches an
  interactive state in under two seconds on a warm index.
- **N-4 · Index rebuild.** A full rebuild of the same world completes in under ten seconds.
- **N-5 · Privacy.** No telemetry in v1. Diagnostics are user-initiated and contain no world
  content and no keys.
- **N-6 · Licence.** MIT. Third-party licences are enumerated in-app; the espeak-ng phonemizer
  Voxa uses is GPL and must remain a separate executable, never linked.
- **N-7 · Installer.** Signed NSIS. The bundled OpenCode and self-contained Voxa put the
  installer above 200 MB; models are downloaded on first use, not shipped.
- **N-8 · Accessibility.** Full keyboard navigation, reduced-motion respected, and no
  information conveyed by colour alone — the design system is monochrome, so imagery carries
  colour and the UI must not depend on it.

---

# 19 · Delivery plan

Capability specs break out of this document in dependency order. Each becomes its own
`specification.md` in the Arke house format.

| Spec | Title | Depends on |
|---|---|---|
| SPEC-001 | Foundation — monorepo, contracts, coordinator, Electron shell | — |
| SPEC-002 | The world on disk — layout, schemas, versioning, history | 001 |
| SPEC-003 | The derived index and the change log | 002 |
| SPEC-004 | The accept gate — proposals, ripples, chat/form duality | 002, 003 |
| SPEC-005 | Harness adapter — OpenCode lifecycle, confinement, permissions | 001, 004 |
| SPEC-006 | Canon — entries, revisions, grounded Q&A, refusal, threads | 004, 005 |
| SPEC-007 | Sheets — lifecycle, creation paths, editing | 004, 005 |
| SPEC-008 | Providers, keys, the model manifest and the ledger | 001 |
| SPEC-009 | The job queue and dispatch | 008 |
| SPEC-010 | Reference kits and model-sheet compilation | 007, 009 |
| SPEC-011 | Voice — the Voxa sidecar, assignment, generation | 007, 009 |
| SPEC-012 | Productions, scenes, shots and boards | 004, 007 |
| SPEC-013 | Takes, the cut, audio and exports | 009, 012 |
| SPEC-014 | Activity, needs-you and spend | 003, 009 |
| SPEC-015 | Artifacts, world import and fact extraction | 002, 003, 004 |
| SPEC-016 | First run, onboarding and packaging | all |

**Phase 1 — prove the loop.** 001 → 002 → 003 → 004 → 005 → 007. A world can be created, a
sheet drafted by an agent, ripple-checked and accepted, with history and an index behind it.
Nothing generates yet, and that is the point: the gate is the product.

**Phase 2 — make it produce.** 008 → 009 → 010 → 012 → 013. Sheets compile into model sheets,
scenes dispatch, takes assemble a cut.

**Phase 3 — finish it.** 006, 011, 014, 015, 016.

---

# 20 · Resolved decisions

The questions this document opened during review, and how they were settled. Recorded so the
reasoning survives the decision.

| # | Question | Resolution | Where |
|---|---|---|---|
| 1 | Story format depth | Chapter tree, one file per chapter. Prose edits are ungated; agent drafts are gated. | §8.3 |
| 2 | Stills surface | Same entity and pipeline as video, format-driven rendering, plus one contact sheet. | §8.5 |
| 3 | World import | Two stages: always file as artifacts, then optionally lift facts as per-candidate proposals. | §13.1 |
| 4 | Activity scope | Global queue and ledger, view filtered to the active world by default. | §15 |
| 5 | Sketch citation | Warn per-dispatch naming the specific sketches; never block. | §10.3 |
| 6 | Ollama's role | Dual-routed: direct for cheap non-authoring work, through the harness as an authoring fallback. | §14.1.1 |

## 20.1 Still open

- **Cost denomination.** §14.4 specifies USD where the prototype shows credits. Flagged as the
  one deliberate, visible departure from the approved design; reversible if credits are wanted
  as a display unit.
- **Extraction quality bar.** §13.1 commits to lifting facts from imported documents. What
  precision is acceptable before the proposal list becomes noise the user stops reading is a
  question only real documents can answer.
- **Chapter save-points.** §8.3 cuts a version on accepted drafts and explicit save-points.
  Whether authors want a manual save-point control, or expect versions purely from drafts,
  should be settled against a real writing session.

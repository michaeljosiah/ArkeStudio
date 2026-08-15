---
specId: ARKE-STUDIO
slug: arke-studio
title: Arke Studio — local-first world-authoring and production studio
status: draft
owner: core-maintainers
sourceOfTruth: filesystem
platform: windows-first
created: 2026-07-31
updated: 2026-08-03
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

1. **The accept gate.** Nothing enters the authored record without a human accept. Sheet edits,
   canon entries and scene drafts arrive as *proposals* and are ripple-checked against canon.
   Generated takes land as immutable operational records; acceptance controls which take is used.
2. **Canon that refuses.** The world answers questions only from canon, with per-entry
   citations. When canon is silent it says so, cites the closest entries, and offers to open
   a thread. It never invents behind your back.
3. **Reference kits that compile.** Locked reference tiles compile into one model sheet that
   rides along with every generation on every provider, so consistency is structural rather
   than a function of prompt luck.

## 0.2 What v1 is

A free, MIT-licensed, local-first desktop application. Worlds are folders of readable files
on the user's own disk. Provider keys live in an app-owned encrypted file protected by the OS
key store and a user-only ACL (§14.2). Nothing leaves the machine except approved dispatches.

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
- macOS and Linux builds. Only Windows is shipped; CI also tests Linux for portability.

## 0.4 Platform and distribution

Windows 11 first (x64 and arm64), currently delivered as an unsigned NSIS installer. Signing is
required before v1. The application is
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
| **Bible** | The author's own prose about the world — thinking, not record. Ungated, versioned, cited by nothing. |
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

OpenCode never dispatches media. The job queue lands generated media and operational records but
does not author canon, sheets or scenes. The accept gate protects authored facts; operational and
generated writes follow the mutation matrix in §3.1.

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
│  │  cwd = proposal, writes   │          │  Kokoro / Whisper   │ │
│  │  confined to that folder │          │  local speech only  │ │
│  └───────────────────────────┘          └─────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
                     │                                │
                     ▼                                ▼
            LLM providers                  FAL · Higgsfield · ElevenLabs
         (via OpenCode config)              (via the job queue, direct)
```

The coordinator runs **in the Electron main process**, not as a separate server. It is the
same shape as Arke's `apps/desktop`, which embeds `@arke/coordinator` and serves the client
as one packaged app.

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

Authored mutations follow this path:

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

This layout is illustrative. The implementation-backed operation ledger at
[`filesystem-operations.md`](filesystem-operations.md) is the current reference
for which operation creates, replaces, appends, moves or removes each path, including lazy
directories and temporary files.

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
      bible.md                    the author's own prose about the world (§4.5) — ungated, versioned
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
        harbour-bells.wav
        harbour-bells.wav.json    sidecar: id, kind, hash, origin, links
        undersong-treatment.pdf
        undersong-treatment.pdf.json
      productions\
        saltlight\
          production.json         format, title, status, timestamps
          story.md                overview / script / prose, per format
          scenes\
            04-the-verse-rises.json
          takes\
            tk_01J8F.../take.json
            tk_01J8F.../clip.mp4
          cut.json                audio tracks and placement only; picture comes from selections
          exports\
      .proposals\                 staged, not yet accepted (see §3.2)
      .history\                   full snapshots of every committed version (see §2.5)
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
  "worldId": "01J8F3K2QW9VZX4N7M0RTYB6HC",
  "slug": "the-undersong",
  "schemaVersion": 1,
  "name": "The Undersong",
  "logline": "A drowned god still sings beneath the harbour.",
  "tone": "quiet dread",
  "genre": "coastal fantasy",
  "canonRevision": 42,
  "nextCanonId": 45,
  "created": "2026-05-02T09:14:00Z",
  "updated": "2026-07-30T18:22:00Z"
}
```

**`worldId` is a ULID, not the slug.** The slug is a filename and a user can rename a world;
the queue and the ledger are global and outlive any one world. Keying global records on a slug
would mean a rename orphans a world's spend history, and two users' `the-undersong` folders
collide in one ledger. Global records key on `worldId`; the slug is display and path only.

**Clone policy.** A world folder copied on disk carries its `worldId`, which makes the copy
indistinguishable from the original to the queue and ledger. On open, the application detects a
`worldId` already registered at a different path and asks: *this is the same world moved* — keep
the id and update the registered path — or *this is a copy* — mint a new `worldId`, leaving the
original's history with the original. It never guesses, because both answers are reasonable and
only the user knows which happened.

**`nextCanonId` is the allocation counter.** Canon ids must be monotonic and never reused
(R-CANON-4), which cannot be satisfied by taking the maximum of existing ids: retire CANON-043
and the maximum drops, so the next entry reuses 43 and every citation to the retired entry now
resolves to a different one. The counter is persisted, and reserved atomically — a proposal that
will create an entry reserves its id at proposal time under the world lock, so two concurrent
proposals cannot receive the same number. A reservation abandoned by a discarded proposal is
simply a gap; gaps are correct and reuse is not.

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

A take is an **immutable generation record**. It has no status, because status is a review
decision and review decisions are not properties of what a provider returned.

```json
{
  "id": "tk_01J8F...",
  "jobId": "jb_01J8E...",
  "passId": "ps_01J8E...",           // present when produced by a whole-scene pass (§10.3)
  "coversShots": ["sh_12"],          // one shot per-shot; several for a pass segment
  "kind": "clip",                    // clip | frame | still | voice | sheet
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

### 2.3.6 Review decisions — `productions/saltlight/reviews.jsonl`

Append-only. One line per decision. A take is never edited by being reviewed, and a take
reviewed twice has two lines, the later winning.

```json
{"ts":"2026-07-30T14:04:11Z","takeId":"tk_01J8F...","shotId":"sh_12",
 "decision":"accept","by":"user"}
{"ts":"2026-07-30T13:58:02Z","takeId":"tk_01J8C...","shotId":"sh_12",
 "decision":"reject","by":"user",
 "citation":{"sheet":"maren-kest","field":"appearance","note":"coat drifted off-sheet"}}
```

### 2.3.7 Shot selection

Which take a shot currently uses lives in `productions/<p>/selections.json`, **not** in the scene
file:

```json
{ "sh_12": { "acceptedTakeId": "tk_01J8F...", "startFrameTakeId": "tk_01J8A..." } }
```

Selections are **operational** (§3.1), and scenes are **gated**. Putting a selection inside the
scene file would mean accepting a take mutates a gated entity — which would either drag every
take review through a proposal and ripple check, or quietly punch a hole in the gate. Separating
them keeps the scene file purely authored structure and lets review stay the fast, reversible act
it needs to be.

Three separate things that the earlier draft conflated into one mutable `status` field:

| Concern | Lives in | Mutability |
|---|---|---|
| What the provider produced | `take.json` | Immutable, write-once |
| What a human decided about it | `reviews.jsonl` | Append-only |
| What the cut currently uses | `selections.json` | Mutable, single-valued |

This is why the cut can recompute when a selection changes without any take being rewritten,
and why a rejection is a durable record rather than an edit to the thing being rejected.

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

### 2.4.1 What is versioned, and what is not

Not every gated entity earns a version. A version exists so that something else can *cite* it;
where nothing cites an entity, a version is ceremony that must still be maintained correctly,
which is a cost with no return.

| Entity | Versioned | Cited by | History |
|---|---|---|---|
| Canon entry | By world canon revision | takes, sheets, entries, threads | Yes |
| Character / location / faction sheet | Own monotonic version | takes, shots, tiles, model sheets | Yes |
| Story chapter | Own monotonic version | nothing; the reader is the consumer | Yes |
| Scene | Own monotonic version | shots inherit from it; boards compile from it | Yes |
| Story overview | Own monotonic version | scene drafting cites it | Yes |
| Production metadata | Unversioned | nothing | Change logged only |
| Cut | Unversioned, derived | nothing; recomputed from selections | Not applicable |
| Artifact | Unversioned, immutable | anything may link it | Superseding files a new artifact |
| Reference tile | Unversioned; carries source sheet version | model sheets | Superseding regenerates |
| Model sheet | Carries source sheet version and tile set | dispatches | Superseding recompiles |

Three consequences worth stating outright, because each was ambiguous in the earlier draft:

- **Scenes are versioned.** They are cited — shots inherit a scene's location and tone, and a
  board compiles from a scene at a point in time — so *"board v2, in step with shots"* needs a
  scene version to be in step *with*.
- **The cut is derived, never versioned.** It is a projection of shot selections; versioning a
  projection creates a second truth about what the film is. Restoring an earlier cut means
  restoring the selections that produced it.
- **Artifacts are immutable.** Replacing an artifact files a new one and relinks; editing one in
  place would silently change what a three-month-old citation refers to.

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

One process owns a world at a time, enforced by a lock file. Hand edits made while a world is
open are detected by a watcher, which marks the index stale and prompts a reload rather than
merging.

**Hand edits made while the world was closed need an explicit reconciliation**, because simply
scanning them in would let a change enter the record with no version bump, no snapshot and no
audit line — quietly defeating the gate for anyone with a text editor.

On open, every entity file's hash is compared against the hash recorded at its last commit. A
mismatch is an **external edit**, and it is reconciled, not absorbed:

1. The world opens normally and lists the externally-edited files for explicit reconciliation.
2. Each is validated against its schema. Files that no longer parse are reported and excluded;
   the user fixes or reverts them.
3. The user accepts the external edits as a single reconciliation commit, or reverts them from
   `.history/`.
4. Accepting runs the ordinary commit transaction: snapshots the last-committed version, bumps
   each affected entity's version, bumps the canon revision if canon changed, and writes a
   `changes.jsonl` line with `source: "external-edit"`.

The result is that hand-editing remains fully supported — it is a promise the format makes —
while the version history stays a true account of what happened. What is not supported is a hand
edit that leaves no trace.

Reconciliation is skipped for one case: a world whose `.history/` and `changes.jsonl` are absent
is being opened for the first time — an imported or hand-authored folder — and is adopted as-is
at version 1.

---

# 3 · The accept gate

## 3.1 The mutation matrix

The gate does not apply to everything a world contains, and the earlier draft's claim that it
did was wrong — it contradicted chapter autosave, board compilation, take arrival and the
change log itself. What the gate protects is **the authored record**: the facts a production
cites. Four classes, with different rules:

| Class | Members | Rule |
|---|---|---|
| **Gated** | canon entries, sheets, scenes, story overviews, production metadata, artifact links, agent-drafted chapters | Proposal → ripple → accept. Versioned, snapshotted, logged. |
| **Direct authored** | chapter prose after acceptance (§8.3), the world bible (§4.5) | Written by the author — or, for the bible, by World Chat. Versioned at every save, snapshotted, logged. No proposal. |
| **Operational** | `changes.jsonl`, the job queue, the ledger, review decisions, lock files, the index, shot selections | Written by the system as work happens. Append-only where applicable. Never versioned, never gated — these *are* the record of gating, and gating them would be circular. |
| **Generated media** | takes and their binaries, compiled boards, extracted frames | Written on arrival by the job queue or a local compile. Immutable and content-addressed. Not gated for *existing*; gated for **admission** — what a shot cites and what enters the cut. |

The distinction that resolves the contradiction is between **existing** and **being cited**. A
take exists the moment a provider returns it, and pretending otherwise would mean holding
generated media in limbo outside the world. What requires acceptance is a take becoming the
shot's answer. The same is true of a compiled board: compiling files it, accepting it makes it
the scene's board.

*"Nothing changes until you accept"* remains true of everything a production cites. It was never
true of the audit trail, and should not have been claimed.

## 3.2 The gated pattern

```
draft → proposed → ripple-checked → accepted | discarded
```

One implementation, used by every gated member above.

## 3.3 Proposals

A proposal is a directory under `.proposals/<proposalId>/` containing the *complete proposed
files*, not patches:

```
.proposals/pr_01J8H.../
  proposal.json      kind, targets, base hashes, reserved ids, source, session, created
  characters/maren-kest.md      the full proposed file
  ripple.json        ripples as computed at propose time — advisory preview only
```

Because proposals are whole files, accepting is a move and the side-by-side comparison is a
plain two-file diff with no patch application to get wrong.

**Every proposal records the base it was drafted against.** `proposal.json` carries, per target,
the entity's version and a content hash at the moment drafting began:

```json
{
  "id": "pr_01J8H...",
  "targets": [
    { "path": "characters/maren-kest.md", "baseVersion": 4, "baseHash": "sha256:9f2c…" }
  ],
  "baseCanonRevision": 42,
  "reservedCanonIds": [],
  "source": "chat:sess_9f2"
}
```

Without this a proposal can silently destroy newer work: two authoring sessions open on one
sheet, or one session open while the file is hand-edited, and the second accept overwrites the
first with no indication. **Accept verifies every base hash under the world lock** and refuses
a stale proposal, offering to rebase it onto current content and recompute its ripples. Staleness
is detected, never merged.

## 3.4 Ripple checks

Ripples are **computed from the index, never asked of the model.** The LLM writes the prose
that explains a ripple; it does not determine what the ripples are. This is what makes
*"14 reference images predate v5, regenerate looks after accept"* trustworthy.

**Ripples are computed twice.** The set shown while a proposal is open is a preview against the
world as it was then. The set that governs is recomputed **at accept, under the world lock,
after base-hash verification** — because between drafting and accepting, a take may have landed,
a tile may have been locked, or another proposal may have been accepted. Accepting against a
stale ripple list would show a user one set of consequences and produce another.

Where the recomputed set differs materially from the preview, the difference is surfaced and the
accept is re-confirmed rather than completed silently.

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

## 3.5 The accept transaction

Renaming files one at a time cannot give all-or-nothing across a multi-file accept: a crash
between the first rename and the last leaves the world half-changed, with `world.json`,
`.history/` and `changes.jsonl` all potentially out of step. The filesystem offers no
transaction, so the specification must define one.

**An intent journal**, at `.commit/<commitId>.json`, written and flushed *before* any live file
is touched. It records the complete plan:

```json
{
  "commitId": "cm_01J8H...",
  "proposalId": "pr_01J8H...",
  "phase": "prepared",
  "canonRevisionFrom": 42, "canonRevisionTo": 43,
  "files": [
    { "path": "canon/CANON-044.md",
      "action": "create",
      "newHash": "sha256:1a4b…",
      "historyPath": null },
    { "path": "characters/maren-kest.md",
      "action": "replace",
      "baseHash": "sha256:9f2c…", "newHash": "sha256:77de…",
      "historyPath": ".history/characters/maren-kest/v4.md" }
  ]
}
```

**Commit sequence.** Each step is durable before the next begins:

1. Acquire the world lock. Verify every `baseHash`. Recompute ripples. Reserve any canon ids.
2. Write the journal with `phase: "prepared"`. Flush.
3. Write every `.history/` snapshot. Flush.
4. Write staged copies of every new file alongside their targets. Flush.
5. Set `phase: "committing"`. Flush. **This is the point of no return.**
6. Rename every staged file into place, and write `world.json` last of all — its
   `canonRevision` is the world's single observable statement about which revision it is at.
7. Append to `changes.jsonl`. Flush.
8. Set `phase: "done"`, then delete the journal and the proposal directory.

**Recovery on open**, driven by the journal's phase:

| Phase found | Meaning | Action |
|---|---|---|
| `prepared` | Crashed before the point of no return | **Roll back.** Delete staged files and snapshots written by this commit. The world is untouched. |
| `committing` | Crashed mid-apply | **Roll forward.** Re-run steps 6–8 idempotently; hashes identify which renames already happened. |
| `done` | Crashed during cleanup | Delete the journal and proposal directory. |

Roll-forward is safe because every step from 6 on is idempotent against the recorded hashes: a
file already matching `newHash` is skipped, and `changes.jsonl` is appended only if its line for
this `commitId` is absent. Roll-back is safe because before step 5 nothing live has changed.

Two commits are never in flight at once — the world lock guarantees it — so a journal found on
open is unambiguous.

**Requirements**

- **R-GATE-1** No **gated** entity (§3.1) SHALL be written to the live world except by an
  accept.
  - **WHEN** an authoring agent runs to completion without a human accept **THEN** no gated
    entity has changed.
  - **AND** operational records, direct-authored chapter prose, and generated media follow their
    own rules in §3.1 and are not covered by this requirement.
- **R-GATE-2** Ripple facts SHALL be computed from the index; model output SHALL only supply
  their human-readable explanation.
  - **WHEN** the model's prose and the computed ripple set disagree **THEN** the computed set
    is displayed and the prose is suppressed.
- **R-GATE-3** Accepting SHALL be atomic across every file in the proposal, implemented by the
  journal protocol in §3.5.
  - **WHEN** the process is killed at any point during an accept **THEN** on next open the world
    reflects either all of the change or none of it, including `world.json`, `.history/` and
    `changes.jsonl`.
- **R-GATE-4** Discarding a proposal SHALL delete its staging directory, release any reserved
  canon ids without reusing them, and leave no trace in the world other than a `changes.jsonl`
  line recording the discard.
- **R-GATE-6** Accepting SHALL verify every recorded base hash under the world lock, and SHALL
  refuse a proposal whose base has moved.
  - **WHEN** a sheet advanced from v4 to v5 while a proposal against v4 was open **THEN** the
    accept is refused and a rebase is offered; the newer content is never overwritten.
- **R-GATE-7** Ripples SHALL be recomputed at accept, under the lock, and a material difference
  from the preview SHALL be surfaced for re-confirmation.
- **R-GATE-8** Canon ids reserved by a proposal SHALL be allocated atomically under the world
  lock and SHALL NOT be reused if the proposal is discarded.

## 3.6 Chat and form duality

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

Refusal is decided in **two independent stages**, and both must pass for an answer to render.

**Stage one — retrieval.** If lexical retrieval returns no entry above the relevance floor, the
refusal state renders with no LLM call at all. This is cheap, fast, and impossible for a model
to talk itself out of.

**Stage two — grounding.** Clearing the floor is *not* evidence that an entry answers the
question. BM25 ranks by shared vocabulary, so a question about who collects rent in the Drowned
Quarter will surface the entry describing the Drowned Quarter at a high score while that entry
says nothing about rent. A model handed that entry and asked to answer will produce a fluent
answer with a real citation attached to a claim the entry does not support — which is precisely
the failure the product exists to prevent, made *more* dangerous by looking sourced.

So the model does not return prose. It returns a structured response:

```json
{
  "outcome": "answered",            // answered | cannot_answer
  "claims": [
    { "text": "No. A caller cannot move a tide she has not stood in.",
      "entryId": "CANON-002",
      "excerpt": "A caller cannot move a tide she has not stood in." }
  ]
}
```

Every claim must name a supporting entry **and quote the span of that entry supporting it**. The
model is instructed that if the retrieved entries do not support an answer, the correct response
is `cannot_answer` — and that returning it is a success, not a failure.

**Excerpts are then verified mechanically.** Each excerpt must appear in the entry it cites,
normalised for whitespace. This is a deterministic check the model cannot argue with, and it is
what turns "cites an entry" into "is supported by an entry".

**Verification is all-or-nothing.** A single unverifiable excerpt fails the whole answer, which is
retried once with the failure named, and refused if it fails again. Dropping the bad claim and
showing the rest would be worse than it sounds: an answer of *"No, she cannot"* plus *"unless she
has stood in that water before"* becomes a false absolute when the second claim is silently
removed. A partial answer is the same plausible-but-unsupported failure in a subtler form, and
refusal is a safe outcome where distortion is not.

**Requirements**

- **R-CANON-1** A canon answer SHALL consist of claims, each naming a supporting entry and
  quoting the span of that entry which supports it.
  - **WHEN** any claim's excerpt does not appear in the entry it cites **THEN** the whole answer
    is rejected, retried once with the specific failure named, and refused if it fails again.
  - **AND** no answer SHALL be rendered from a partially verified claim set.
- **R-CANON-2** When retrieval returns no entry above the relevance floor, the refusal state
  SHALL render without dispatching an LLM call.
- **R-CANON-3** The refusal state SHALL report the number of entries searched and cite the
  closest non-answering entries.
- **R-CANON-4** Canon entry ids SHALL be allocated monotonically from the persisted
  `nextCanonId` counter and never reused, including after retirement or a discarded reservation.
- **R-CANON-6** The response contract SHALL offer the model an explicit `cannot_answer` outcome,
  and that outcome SHALL render as a refusal rather than an error.
  - **WHEN** entries clear the relevance floor but none answers the question **THEN** the product
    refuses, citing them as closest matches.

## 4.4 Threads

An unanswered question becomes an open thread, holding a CANON id from creation. A thread is
authored in the same chat/form gate as any entry, and accepting it closes the thread and
settles the entry.

- **R-CANON-5** Accepting a thread SHALL settle the entry, close the thread, and increment the
  canon revision once.

## 4.5 The world bible

Canon holds what the world has **decided**. The bible holds what the author **thinks** — intent,
mood, direction, the half-formed — as one Markdown document, `bible.md`, at the world root.

The two are not two copies of one thing, and the ownership rule (§4.1) is not weakened by the
bible's existence, because the bible owns nothing. Nothing cites it, nothing generates from it,
and the grounded Q&A pipeline never answers out of it: an answer drawn from a musing would look
exactly like an answer drawn from canon, which is the failure §4.3 exists to prevent.

It is **direct authored** (§3.1): no proposal, no accept. Two writers share it — the author, in
the editor or in any text editor, and World Chat, which describes edits in its turn result for
the coordinator to apply. The version is what makes that safe. Every save cuts one, snapshots to
`.history/bible/`, and writes a `changes.jsonl` line; a write against a version that has moved is
refused rather than merged. An unwanted edit is one restore away, and for a document that cites
nothing that is a better trade than an approval step on thinking out loud.

The whole document is loaded into every World Chat turn, untrimmed. This is the one context
section with no bound (§8.5's discipline is about *unbounded history*, and the bible is the same
size on turn fifty as on turn one), so what protects the author is visibility rather than a cut:
the Bible screen shows its size and per-turn cost, and the agent is instructed not to append to it
unprompted.

- **R-BIBLE-1** The bible SHALL be one Markdown document at the world root, and a world without
  one SHALL open normally rather than reporting a problem.
- **R-BIBLE-2** Every save SHALL cut a version, write a `.history/` snapshot and append a change
  line, whether the author or World Chat wrote it.
- **R-BIBLE-3** A write against a version that has since moved SHALL be refused, never merged.
- **R-BIBLE-4** Bible edits from a turn SHALL be all-or-nothing with that turn: a failed edit
  rejects the whole turn, and no reply describing an edit SHALL persist without it.
- **R-BIBLE-5** The bible SHALL be given to the model whole and never truncated, labelled as
  context rather than canon, and SHALL NOT be citable as candidate evidence.
- **R-BIBLE-6** Hand-edits to the bible while a world is open SHALL be adopted, not reported as
  external modification (§2.7) or queued for reconciliation (R-28).

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

**A locked sheet may have no compilation matching its current version** — lock a sheet at v5 when
the newest model sheet compiled at v4, and R-REF-1's "attach the current model sheet" and
R-REF-3's "flag it stale" are in tension. The resolution is that the dispatch **attaches the
newest available compilation and names the gap**: *"model sheet is v4; Maren is at v5"*, with
recompiling offered inline. It does not block, because the alternative to a slightly stale
reference is no reference at all, which is strictly worse for consistency. Where no compilation
exists at any version, the dispatch is treated exactly as a sketch citation (§10.3).

- **R-REF-1** Every dispatch citing a sheet SHALL attach that sheet's newest compiled model
  sheet as a reference, where the target model accepts reference images.
  - **WHEN** the model accepts no references **THEN** the dispatch dialog states so before the
    user commits, and the sheet's identity is carried in the prompt.
  - **AND WHEN** the newest compilation predates the sheet's current version **THEN** it is
    attached anyway, the version gap is named before commit, and recompiling is offered.
  - **AND WHEN** no compilation exists at any version **THEN** the dispatch is treated as a
    sketch citation under R-DISP-8.
- **R-REF-2** Full-body turnaround generation SHALL be blocked until the head turnaround is
  fully locked.
- **R-REF-3** A compiled model sheet SHALL record the sheet version and the tile set it was
  compiled from, and the UI SHALL flag it as stale when either has advanced.
- **R-REF-4** The classic-grid format SHALL compile locally with no provider call and no cost.
- **R-REF-5** Where a dispatch's references exceed the target model's accepted count, selection
  SHALL be deterministic and the dropped references SHALL be named before the user commits.
  - **WHEN** a shot cites four sheets and the model accepts two references **THEN** the two
    carried are stated, the two dropped are named, and no reference is silently discarded.
- **R-REF-6** Exactly one compilation per sheet SHALL be designated the one that rides along with
  dispatches, defaulting to the newest accepted and overridable by the user.

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

**The sidecar serves local inference only.** Voxa ships speech packages for ElevenLabs, OpenAI
and others, and Arke Studio does not use them: cloud voice routes through the ordinary provider
path (§14) and the job queue (§10.1), so there is one money path, one idempotency protocol and
one ledger. Routing cloud speech through the sidecar would put cost capture and reconciliation
inside a process that knows nothing about either. The voice picker presents local and cloud
voices uniformly; only the routing beneath differs.

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
- **R-VOICE-2** Assigning a voice SHALL commit directly — it is the author's own pick, not a
  drafted change awaiting review — while still incrementing the sheet version, and the ripple
  SHALL list the productions affected.
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
Recompiling is local and free. The current board stays in the production's board storage; an
explicit export files an immutable artifact. In whole-scene dispatch the board rides along as the scene reference; in per-shot
dispatch each frame is sent instead.

**Requirements**

- **R-SCENE-1** Accepting a scene SHALL create its shots and dispatch nothing.
- **R-SCENE-2** `@` references in a shot description SHALL resolve to sheet ids, and SHALL be
  the source of that shot's cast for prompt assembly and reference attachment.
- **R-SCENE-3** Board compilation SHALL be local, free, and repeatable. Exporting a board SHALL
  file an immutable artifact; recompiling alone SHALL NOT accumulate artifacts.

---

# 10 · Dispatch

## 10.1 The job queue

A durable, append-only queue at `%USERPROFILE%\ArkeStudio\queue\jobs.jsonl`, app-level rather
than world-level so the Activity screen can show everything at once. Each job records its
world, production, target entity, provider, model, parameters, estimated cost, status and
timestamps.

States: `queued → submitting → running → succeeded | failed | cancelled`.

**Durability alone does not prevent duplicate dispatch.** An append-only queue records intent,
but a crash between the provider accepting a request and Arke Studio recording the returned job
id leaves work that is running, paid for, and invisible. On restart the job looks un-submitted
and is sent again — a second charge for a generation the user did not ask for twice.

The queue therefore uses an **outbox with idempotency keys**:

1. A job is written `queued` with a generated **idempotency key**, durable before any network
   call.
2. It moves to `submitting`, durable, *then* the provider is called — with the idempotency key
   attached where the provider honours one.
3. The provider's job id is recorded and the state moves to `running`, durable.

A job found in `submitting` on restart is of **unknown remote state** and is never blindly
resent. It is reconciled: providers that support lookup by idempotency key are queried and the
existing remote job adopted; providers that support listing recent jobs are searched by the key
carried in request metadata; providers that support neither leave the job `needs-reconciliation`
and the user is asked, with the estimated cost of a possible duplicate stated plainly.

Reconciliation runs on start-up and on reconnect, and it is the only path that resumes a
`submitting` job.

**Terminal outcomes are always reconciled against provider-reported charges** (§14.4). Arke
Studio cannot promise a failed job was not billed — providers charge for timeouts, partial
completions and some cancellations — so it records what the provider says rather than asserting
zero.

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

### 10.3.1 The pass model

A whole-scene pass returns **one clip spanning several shots**, which does not fit a take
belonging to a single shot. Passes are therefore first-class:

```json
{
  "id": "ps_01J8E...",
  "sceneId": "sc_04",
  "shotPlan": [
    { "shotId": "sh_12", "startSec": 0.0, "endSec": 4.0 },
    { "shotId": "sh_13", "startSec": 4.0, "endSec": 9.0 },
    { "shotId": "sh_14", "startSec": 9.0, "endSec": 13.5 }
  ],
  "takeId": "tk_01J8G...",
  "costUsd": 0.34
}
```

**Segmentation is virtual.** The pass's shot plan comes from the shot durations sent in the brief,
so boundaries are known before dispatch rather than inferred afterwards. On arrival, one derived
take is created per shot — each carrying `passId`, the same provenance, and an **in/out range into
the pass's media** rather than a file of its own.

Cutting real files would force a choice between re-encoding every segment, which costs quality and
time on media the user may reject, and keyframe-aligned copying, which lands boundaries wherever
the keyframes happen to be rather than where the shots are. A range costs nothing, is exact, and
keeps the pass as the single stored artifact; the one encode happens at export.

**Cost allocation.** The pass carries the real charge; segments carry an allocated share
pro-rata by duration, marked as allocated rather than measured. The ledger records the pass, not
the segments, so totals never double-count.

**Review granularity.** Segments are reviewed individually — a user may accept two shots from a
pass and reject the third. Rejecting a segment does not invalidate the pass or the other
segments. But because a retry re-runs the whole pass, the dispatch dialog says so before commit:
*"a retry re-runs all three shots"*.

**Frame chaining** takes the last frame of the **pass**, not of its final segment, so a pass
boundary and a shot boundary that coincide do not produce a duplicated frame.

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

## 10.5 Takes and review

Per §2.3.5–2.3.7, three things stay separate: the immutable take, the append-only review
decision, and the shot's current selection.

A take is **unreviewed** when no decision line in `reviews.jsonl` names it — a derived state,
not a stored one, which is why a take is never rewritten by being reviewed.

**Accept** appends an accept decision and sets the shot's `acceptedTakeId`. Both happen in one
commit, because a decision without a selection would leave the cut disagreeing with the record.
**Reject** appends a decision citing what drifted, by sheet and field, and leaves any existing
selection alone.

Re-reviewing is ordinary: a later decision line supersedes an earlier one for the same take, and
selecting a different take moves `acceptedTakeId`. Nothing is erased, so the shot's history reads
as what actually happened.

Rejections are **logged only in v1** — the corpus for the eventual "rejections teach the shot"
behaviour, which v1 does not implement.

**Requirements**

- **R-DISP-1** Every dispatch SHALL present a computed cost estimate before the user commits.
- **R-DISP-2** Whole-scene dispatch SHALL compute pass packing from the target model's duration
  cap and display the resulting pass count and cost before commit.
- **R-DISP-3** A dispatch SHALL record the canon revision and each cited sheet's version onto
  every take it produces.
- **R-DISP-4** Every terminal job outcome SHALL record the provider-reported charge where one is
  available, including failures, partial completions and cancellations, and SHALL state the
  failure reason and offer retry.
  - **WHEN** a provider bills for a timed-out generation **THEN** the ledger records that charge
    rather than asserting zero.
  - **AND WHEN** a provider reports no charge, or reports none **THEN** the entry records zero
    and marks it as provider-reported rather than assumed.
- **R-DISP-5** Accepting a take SHALL extract its final frame and make it available as the
  following shot's start frame; for a pass, the frame SHALL be taken from the pass rather than
  from its final segment.
- **R-DISP-6** Rejecting a take SHALL require a cited sheet and field, and SHALL record the
  citation without modifying the shot's prompt or the take.
- **R-DISP-7** The queue SHALL survive process restart with no job lost and none dispatched
  twice.
  - **WHEN** the process is killed between a provider accepting a request and the job id being
    recorded **THEN** the job is reconciled by idempotency key on restart, never blindly resent.
  - **AND WHEN** a provider supports neither key lookup nor recent-job listing **THEN** the job
    is held for the user to decide, with the cost of a possible duplicate stated.
- **R-DISP-9** A whole-scene pass SHALL carry an explicit shot plan, SHALL be segmented locally
  into per-shot takes, and SHALL allocate cost pro-rata to segments while recording the real
  charge once against the pass.
  - **WHEN** a pass covering three shots completes **THEN** three segments are reviewable
    independently and the ledger shows one charge, not four.
- **R-DISP-10** A take SHALL be immutable once written, and review decisions SHALL be recorded
  append-only rather than by editing the take.
- **R-DISP-8** A dispatch citing a sketch SHALL name that sketch before commit and state that no
  model sheet will accompany the generation, and SHALL allow the dispatch to proceed.
  - **WHEN** a shot cites two locked sheets and one sketch **THEN** only the sketch is named,
    and the dispatch is not blocked.

---

# 11 · The cut

The cut is **assembled from accepted takes only**. It is not a timeline the user drags; a card
moves because the work moved. Gaps are explicit and are what is left to shoot
(*"13 of 15 shots covered · 2 gaps · 30s uncovered"*).

`cut.json` holds the audio tracks and their placement, and nothing else — **the picture cut is
derived**, not stored. It is the ordered shots of the production's scenes, each resolved through
its `acceptedTakeId`. Storing the sequence would create a second answer to "what is the film",
and the two would drift the first time a selection changed.

This is why §2.4.1 leaves the cut unversioned: restoring an earlier cut means restoring the
selections that produced it, which the shot histories already hold.

- **R-CUT-1** The picture cut SHALL be derived from shot selections rather than stored, and SHALL
  reflect a changed selection without any separate reconciliation step.
  - **WHEN** a shot's accepted take changes **THEN** the cut reflects it immediately, and no
    stored sequence can disagree with the shots.
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

**Stage two — lift.** An extraction pass reads the filed documents and **proposes** canon entries
and sheets from them, each citing the artifact and the location within it that produced it, so
acceptance is per-fact rather than all-or-nothing.

Candidates are reviewed as **one batch**, not as thirty open proposals. Per-fact acceptance is the
requirement; thirty entries queued for review is not, and would bury the needs-you queue under a
single import. The batch is one item awaiting the user, and each candidate accepted within it
commits on its own.

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
| **Higgsfield** | image, video | Gateway — driven through its own CLI, which also holds its credential |
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

**`safeStorage` is an encryption primitive, not a store.** It encrypts and decrypts against an
OS-held key (DPAPI on Windows); the resulting ciphertext is Arke Studio's to place. Saying "keys
live in the OS credential store" is imprecise, and the imprecision hides the decisions that
matter.

**At rest.** Ciphertext is written to `%USERPROFILE%\ArkeStudio\credentials.dat`, outside every
world folder so no world export can carry it. The file's ACL is reset on write to the current
user only, inherited permissions removed. Plaintext exists only in main-process memory, for the
duration of a request.

**Reaching the harness.** OpenCode needs provider credentials, and writing them into its
configuration file would put plaintext keys on disk — undoing the whole arrangement. Two rules:

- Credentials are passed to the harness **by environment variable at spawn**, never written to
  its configuration file. The bundled harness is launched by Arke Studio, so its environment is
  Arke Studio's to set.
- Where a harness version genuinely cannot read credentials from the environment, a
  configuration file is written to a per-session directory with a user-only ACL, and **deleted
  when the session ends and on next start-up** — a crash must not leave keys on disk
  indefinitely.

An existing user-installed OpenCode may hold its own credentials in its own configuration. Arke
Studio does not read, modify or take responsibility for those; it passes its own by environment
and states in Settings which provider credentials came from where, so a user is never confused
about which key is paying.

**In logs.** A redaction filter is applied at the logging boundary, not at each call site, so a
new call site cannot leak by omission. Anything matching a configured provider key, or the
common key shapes, is replaced before a line is written. Diagnostics bundles are generated
through the same filter and contain no world content.

## 14.3 The model manifest

A hand-maintained manifest, seeded from FAL's and Higgsfield's catalogues, declaring per model:
capabilities (reference images, start frame, end frame), duration cap, resolution and aspect
options, and cost. This is what powers the model picker's honest capability copy
(*"Seedance 2.0 · no refs · 15s"* against *"Higgsfield Soul 2.0 · refs ×1"*) and the pre-dispatch
estimate.

Higgsfield rows come from `higgsfield model list --json` and are keyed on its `job_type`, which
is the string a dispatch actually names. The earlier rows were written from the HTTP
documentation and neither of them dispatched: one was spelled differently in the live catalogue,
and the other named a model that does not exist in it at all (issue 137). A row whose price
cannot be established does not ship — an estimate is shown and accepted before money is spent, so
a guessed rate is worse than an absent model.

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
- **R-PROV-2** Keys SHALL be stored as `safeStorage` ciphertext in an app-level file with a
  user-only ACL, outside every world folder, and SHALL never appear in a world file, an export,
  a log or a diagnostics bundle.
  - **WHEN** a diagnostics bundle is generated **THEN** it contains no key material and no world
    content.
  - **AND WHEN** a world is exported **THEN** it carries no credential, because none was ever
    inside it.
- **R-PROV-8** Credentials SHALL reach the harness by environment variable at spawn; where a
  configuration file is unavoidable it SHALL be per-session, user-only, and deleted on session
  end and on next start-up.
  - **WHEN** the application is killed with a session open **THEN** no plaintext credential
    file survives the next start-up.
- **R-PROV-9** Log redaction SHALL be applied at the logging boundary rather than at call sites.
  - **WHEN** a new code path logs an object containing a key **THEN** it is redacted without that
    path having been changed.
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
- **R-ACT-4** The needs-you queue SHALL be ordered by a defined urgency class before recency, so
  that unresolved spend and blocked work precede routine review.
  - **WHEN** a job awaits reconciliation and forty takes await review **THEN** the reconciliation
    is listed first.
- **R-ACT-5** Needs-you items for worlds that are not open SHALL be presented as counts with the
  time they were last computed, and SHALL NOT be presented as current.

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

The earlier draft claimed an authoring agent "cannot modify the live world even if it tries",
enforced by scoping write permission to `.proposals/`. **That claim was false.** A harness
permission prompt is a check inside the harness's own tool loop; a process running as the user
with the world reachable on disk can write to it through any path the prompt does not mediate —
a shell tool, a script it authors and runs, a library call. And since an existing user-installed
OpenCode is *preferred* (R-HARNESS-2), Arke Studio does not control which tools are present.

Confinement is therefore layered, with each layer doing what it can actually do, and the residual
risk stated rather than assumed away.

**1 · The world is never the working directory.** An authoring session's cwd is its proposal
directory, pre-populated with copies of exactly the entities in scope, plus read-only context the
agent needs. The agent edits those copies. Every relative path it touches lands in the proposal
by construction, and changed files become the proposal's targets on session end. This is not a
restriction the agent is asked to respect — it is the only world it is shown.

Materialisation is also where base hashes are captured (§3.3), so the copy and the staleness
check come from one act.

**2 · Escape-capable tools are denied.** Shell, process execution and network tools are disabled
in the session's harness configuration. This is best-effort — it depends on the harness honouring
its own configuration — and is treated as reducing likelihood, not as a boundary.

**3 · Out-of-band writes are detected, not prevented.** This is the layer that actually holds.
Base-hash verification at accept (R-GATE-6) compares every target against the world as last
committed. A write that reached the live world by any route changes its hash, the accept refuses,
and the user is told the file changed outside the gate. The world lock ensures no legitimate
writer competes. Detection is achievable where prevention is not, and detection at the gate is
sufficient for the gate's purpose: nothing enters the *record* unnoticed.

**4 · Reconciliation catches the rest.** An out-of-band write that is never followed by an accept
is caught on next open by external-edit reconciliation (§2.7), which forces it through versioning,
snapshotting and the audit log rather than letting it pass silently.

**Residual risk, stated.** A sufficiently determined or malfunctioning agent with shell access
can corrupt or destroy world files between commits. Arke Studio detects this and preserves
history, but does not prevent it. True prevention needs an OS boundary — a restricted token, job
object or AppContainer on Windows, confining the harness process to its proposal directory —
which is the correct hardening and is deferred, because it must be validated against a harness
Arke Studio does not own and would otherwise block the foundation. §20.1 records it.

## 17.4 Permissions

OpenCode's permission prompts are surfaced, but rendered as Studio concepts in Studio's
language — an approval to proceed, not a tool-call dialog. Remembered grants (`always`) persist
across restarts and are revocable, reusing Arke's `grant-store`.

**Requirements**

- **R-HARNESS-1** An authoring session's working directory SHALL be its proposal directory,
  pre-populated with copies of the entities in scope; the live world SHALL NOT be the working
  directory.
  - **WHEN** an agent writes to any relative path **THEN** the write lands inside the proposal.
- **R-HARNESS-6** A write that reaches a live world file outside the gate SHALL be detected —
  at accept by base-hash verification, or at next open by external-edit reconciliation — and
  SHALL NOT be silently absorbed.
  - **WHEN** a world file changes between materialisation and accept **THEN** the accept is
    refused and the change reported.
- **R-HARNESS-7** Shell, process-execution and network tools SHALL be disabled in authoring
  sessions, and this SHALL be documented as risk reduction rather than as a security boundary.
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
- **N-7 · Installer.** NSIS, currently unsigned; signing is required before v1. OpenCode and Voxa
  are included only when their external build resources are staged; models are downloaded rather
  than shipped. The sample world **is** shipped — 12 MB, so that first run needs no network to
  show what the application is for (SPEC-016 R-6, D12).
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
| SPEC-003 | The derived index and its queries | 002 |
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
| SPEC-017 | World art direction, and the two-image character kit | 010 · amends 010 |
| SPEC-018 | Voice mode — speaking to the studio | 004, 005, 011 |
| SPEC-019 | Long-form video, bound references, skills and locked-parameter tasks | 005, 008, 009, 010, 012, 013, 017 · amends 010, 012 |
| SPEC-020 | Production-scoped casts and artifacts — the guest cast | 002, 003, 004, 007, 012, 015 · amends 007, 012, 015 |
| SPEC-021 | Local image and video generation — a curated recipe catalogue over ComfyUI | 008, 009, 016 |

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

## 20.1 Corrections from specification review

A review of the first draft found fifteen defects, five of them contradictions rather than gaps.
Recorded here because the reasoning matters more than the fix.

| # | Defect | Correction | Where |
|---|---|---|---|
| 1 | The accept gate claimed to cover every world write, contradicting chapter autosave, the change log, board compilation and take arrival | Mutation matrix: gated / direct-authored / operational / generated media, distinguishing *existing* from *being cited* | §3.1 |
| 2 | Harness confinement claimed to be structural; permission prompts cannot bind a process running as the user | Layered: proposal directory as cwd, escape tools denied, out-of-band writes **detected** at accept and on open. Residual risk stated | §17.3 |
| 3 | Multi-file atomicity claimed from ordinary renames | Intent journal with prepare / commit / done phases and roll-back or roll-forward recovery | §3.5 |
| 4 | Proposals had no base version, so a second accept could destroy newer work | Base hashes per target, verified under the lock; ripples recomputed at accept | §3.3, §3.4 |
| 5 | Refusal rested on BM25 score and a citation check, which permits sourced-looking unsupported answers | Claims must quote a supporting span; excerpts verified mechanically; explicit `cannot_answer` outcome | §4.3 |
| 6 | Takes were called immutable but carried mutable status | Split: immutable take, append-only `reviews.jsonl`, mutable shot selection | §2.3.5–2.3.7 |
| 7 | A whole-scene pass spans shots; a take belonged to one | First-class pass with a shot plan, local segmentation, pro-rata cost, per-segment review | §10.3.1 |
| 8 | A durable queue cannot prevent duplicate dispatch after a crash mid-submit | Outbox with idempotency keys and a reconciliation path per provider capability | §10.1 |
| 9 | "Failed jobs are not charged" is not ours to promise | Provider-reported charges recorded for every terminal outcome | §10.1, R-DISP-4 |
| 10 | Closed-world hand edits were absorbed by scanning, bypassing versioning and audit | Explicit reconciliation commit with snapshots, version bumps and a logged source | §2.7 |
| 11 | `safeStorage` was described as a credential store, and harness config would put keys on disk | Ciphertext file with a user-only ACL; credentials by environment at spawn; boundary-level log redaction | §14.2 |
| 12 | `world.id` was a slug, but queue and ledger are global and copies share it | ULID `worldId` plus an explicit moved-or-copied prompt | §2.3.1 |
| 13 | Canon ids could be reused after retirement | Persisted `nextCanonId`, reserved atomically under the lock; discarded reservations leave gaps | §2.3.1, R-CANON-4 |
| 14 | Versioning was undefined for scenes, overviews, productions, cuts and artifacts | Explicit table of what is versioned, cited and snapshotted | §2.4.1 |
| 15 | A locked sheet with no matching compilation had undefined dispatch behaviour | Attach newest, name the gap, offer recompile; treat absent compilation as a sketch citation | §6.3 |

## 20.2 Still open

- **An OS confinement boundary for the harness.** §17.3 detects out-of-band writes but does not
  prevent them. A restricted token, job object or AppContainer would, and needs validating
  against a harness Arke Studio does not own. The highest-value hardening after v1.
- **Cost denomination.** §14.4 specifies USD where the prototype shows credits. The one
  deliberate, visible departure from the approved design; reversible if credits are wanted as a
  display unit.
- **The relevance floor.** §4.3's two stages make refusal robust, but the floor's value is not
  knowable without a real world and a question set. Configuration until evidence sets it.
- **Extraction quality bar.** §13.1 commits to lifting facts from imported documents. What
  precision keeps the proposal list readable is a question only real documents can answer.
- **Chapter save-points.** §8.3 cuts a version on accepted drafts and explicit save-points.
  Whether authors want a manual control should be settled against a real writing session.
- **Pass segmentation fidelity.** §10.3.1 segments on the shot plan's boundaries. Whether a
  model honours requested shot durations closely enough for those boundaries to land on the
  intended cuts is an empirical question about each video model.

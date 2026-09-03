# Filesystem operations

This is the implementation-backed reference for what Arke Studio creates, replaces, appends,
moves, and removes. The capability specifications describe intended behavior; this document
describes the current code.

Path shorthand:

- `R` is `%USERPROFILE%\ArkeStudio`, unless `ARKE_STUDIO_ROOT` overrides it.
- `W` is a world folder, normally `R\worlds\<world-slug>`.
- Paths stored inside JSON use `/`; Windows paths below use `\` for readability.
- Unless stated otherwise, a directory is created lazily by the first operation that needs it.

## Write behavior

| Kind | Current behavior |
|---|---|
| Atomic file write | Creates the parent directory, writes a sibling `.tmp-<id>`, flushes it, then renames it over the target. A failed rename removes the temporary file. |
| Journalled world commit | Uses `W\.commit\<commit-id>.json` and `W\.commit\staging\...`; writes history, lands live files, appends `changes.jsonl`, then removes that commit's journal and staging. Opening a world recovers interrupted commits. |
| Append-only record | `W\changes.jsonl`, `R\queue\jobs.jsonl`, `R\ledger.jsonl`, and `R\provider-calls\calls.jsonl` gain lines. A torn final line is tolerated and repaired on the next append. |
| Media plus metadata | Some media is copied or moved before its JSON record is written. These pairs are not one filesystem transaction, so interruption can leave an orphan media file. |

A new world does **not** start with empty `canon`, `characters`, `productions`, `artifacts`,
`references`, `.history`, or `exports` directories.

## Application operations

| Operation | Creates, changes, or removes |
|---|---|
| First launch | Creates `R\worlds\`, `R\queue\`, `R\logs\`, and `R\config.json` if absent. Opening the app index creates `R\.index\app.db`; SQLite may add `-wal` and `-shm` files. |
| Save settings | Creates or replaces `R\settings.json` by temporary-file rename. |
| Save provider key | Creates or replaces encrypted `R\credentials.dat`, then restricts its ACL to the current user. Keys are never stored in a world. |
| Remember or revoke permission | Creates or replaces `R\grants.json`. Revocation marks a grant revoked rather than deleting its history. |
| Queue or update a job | Appends the complete job state to `R\queue\jobs.jsonl`. |
| Finish a metered job | Appends one terminal charge record to `R\ledger.jsonl`, including applicable failures and cancellations. |
| Record a provider call | Appends one redacted request and response record to `R\provider-calls\calls.jsonl`, then restricts it to the current user — `icacls` on Windows, mode `600` elsewhere. Past 2,000 records or 50 MiB the file is compacted by temporary-file rename, dropping the oldest. A filesystem without ACL support is tolerated. |
| Run the application | Appends logs under `R\logs\` and replaces `R\run\children.json` as supervised children start and stop. |
| Verify a ComfyUI checkpoint | Creates or replaces a digest receipt under `R\.index\comfyui-digests\`. An unchanged file is identified by its exact size, timestamps, device and inode, so later launches do not read the checkpoint again. These receipts are derived caches and may be deleted. |
| Stage an application update | Creates or replaces the update receipt `R\update\pending.json` by temporary-file rename, recording the target version and whether it lands on restart or on close. The next start reads the receipt and removes it before reporting the outcome; the paths that abandon an install remove it too. |
| Download local runtime | Streams to `R\models\<component>\<file>.partial`, validates it, then renames it to the real filename. Ollama's installer is staged at `R\models\.staging\OllamaSetup.exe` and removed after successful installation. |
| Paste a file | Writes `R\.spool\<id>\<name>`. Filing copies it into a world; the next application start removes the spool. |

## World lifecycle

### Create a world

The creation primitive creates only:

```text
R\worlds\<world-slug>\
|-- world.json                          id, slug, metadata, canonRevision 0, nextCanonId 1
|-- art-direction\art-direction.json    only when a look is chosen at creation
|-- bible.md                            only when a founding conversation supplies Bible prose
`-- changes.jsonl                       one world-created line, plus a Bible v1 line when supplied
```

The slug is filesystem-safe and collision-suffixed. Creation is not one transaction: the
directory and `world.json` can exist before the initial change line is appended.

A look chosen at creation is written directly as an accepted v1 record. It does not go through
a proposal or a world commit, so it has no `W\.history\art-direction\v1.json` behind it.

Bible prose supplied by a founding conversation creates `bible.md` at v1 and logs a second creation
line with source `genesis`. Opening the new world seeds `.history\bible\v1.md`. A world with no
supplied prose has no Bible file or Bible history snapshot.

The UI opens the world immediately after creating it, so a normal **Begin in this world** flow
also creates the lock and derived index files described below.

| Operation | Creates, changes, or removes |
|---|---|
| Open read-write | Recovers `W\.commit\`, creates `W\world.lock`, creates or replaces `W\.index\scan-state.json`, and opens `W\.index\world.db`. The lock timestamp is refreshed while open. |
| Close | Replaces `W\.index\scan-state.json`, closes SQLite, and removes `W\world.lock`. |
| Delete index manually | Deleting `W\.index\` or anything under `R\.index\` removes caches only. The next open or checkpoint verification rebuilds them from durable files. |
| Reconcile external edit | Recommits, versions, snapshots, and logs changed versioned files. Logs unversioned changes. A file deleted outside the app remains deleted and gains a `deleted: true` change line. |
| Archive world | Closes the world and moves the whole directory from `R\worlds\<slug>` to `R\archive\<slug>`. A collision adds a timestamp. |

There is no implemented permanent world deletion or restore-from-archive operation.

### Begin from a new-world conversation

Chat first creates `R\.genesis\<genesis-id>\`. It may contain `opencode.json`, `draft.json`,
and copied attachments under `attachments\`.

Pressing **Begin in this world** has these effects:

| Step | Creates, changes, or removes |
|---|---|
| Create and open | Creates `world.json` and `changes.jsonl`, then adds `world.lock` and `.index\...` while open. A look chosen in the conversation also creates `art-direction\art-direction.json`; Bible prose creates `bible.md` at v1, appends its own change line, and open seeds `.history\bible\v1.md`. |
| Carry attachments | Copies each attachment to `W\artifacts\<safe-name>` and creates `W\artifacts\<safe-name>.json`. |
| Clean up | Removes `R\.genesis\<genesis-id>\` after carried attachments finish. |

The characters, locations and threads the conversation gathered are held in `draft.json` and
carried no further. Beginning a world does not stage them as proposals, write sheets under
`W\characters\` or `W\locations\`, or open canon threads. The draft schema admits up to eight
of each; they are read only to decide whether the draft has settled anything yet, and go with
the sandbox when it is removed.

## Proposals, canon, sheets, and art direction

| Operation | Creates, changes, or removes |
|---|---|
| Stage proposal | Creates `W\.proposals\<proposal-id>\proposal.json`, `ripple.json`, complete proposed target files, and `_base\...` copies for existing targets. An agent session also adds `opencode.json`. |
| Update, rebase, or resolve proposal | Atomically replaces proposed targets, proposal metadata, and the ripple preview. Live authored files do not change. |
| Accept proposal | Runs one journalled world commit, writes live targets and history, changes `world.json` where required, appends `changes.jsonl`, then removes that proposal directory. |
| Discard proposal | Recursively removes that proposal directory and appends a discard line. Reserved canon numbers remain consumed. |
| Reserve canon ID | Replaces `W\world.json` with a higher `nextCanonId` and appends an allocation line. It does not create `canon\` or an entry. |
| Create canon entry | Stages `canon\CANON-nnn.md`; acceptance creates the live file and `.history\canon\CANON-nnn\v<revision>.md`, replaces `world.json`, and appends the audit log. |
| Amend or settle canon | Replaces the same canon file, writes history snapshots, increments the world canon revision, and appends the log. |
| Create or duplicate sheet | Stages then creates one Markdown file under `characters\`, `locations\`, or `factions\`, plus its v1 history snapshot. |
| Edit, lock, rename, or assign voice | Replaces the same sheet file and writes its next history snapshot. Rename changes frontmatter only; the id and filename do not move. |
| Retire sheet or canon | Replaces the existing file with `retired: true`. It is not moved or deleted. |
| Save or adopt Bible | An editor save or World Chat edit creates or replaces `W\bible.md` without a proposal. A detected hand edit to an existing Bible while the world is open commits the text as the next version. These writes add `W\.history\bible\v<n>.md` and append `changes.jsonl`; a save against a moved base is refused. A Bible first created externally has no prior version to adopt: the next open loads it and seeds its current snapshot rather than inventing a change. |
| Restore version | Reads a file under `W\.history\` — including a Bible or scene version — and commits that content as a new live version. Later history remains. |
| Change art direction | Replaces `W\art-direction\art-direction.json`, or creates it when the world was not born with a look. Each accept writes `W\.history\art-direction\v<n>.json`. |

## Productions, chapters, scenes, and boards

| Operation | Creates, changes, or removes |
|---|---|
| Create production | Plain Story or Video creation creates `W\productions\<production>\production.json`. Microdrama creation also creates `season.json` and creates or updates its world-level Series record in the same commit. It does not copy sheets or pre-create scene, chapter, take, audio, or export directories. |
| Create chapter | Creates `...\chapters\<chapter>.md` and `W\.history\productions\...\chapters\<chapter>\v1.md`. |
| Save or reorder chapter | Replaces the same chapter file and refreshes its current-version history snapshot. Reordering changes frontmatter; no file moves. |
| Draft and accept scene | Stages then creates `...\scenes\<nn>-<slug>.json` and its history snapshot. Shots are objects inside this JSON, not separate files. |
| Edit prompt override | Replaces the scene JSON without advancing the scene version. |
| Compile board | Creates or replaces `...\boards\scene-<number>.png`, then replaces the scene JSON with its board record while preserving scene version. It does not create an artifact. |
| Export board as artifact | Creates a timestamped PNG under `W\artifacts\` and a matching `.png.json` sidecar. Each invocation keeps one new immutable artifact. |

## Jobs, takes, reviews, and exports

Provider output is first verified under `W\.staging\<job-id>\`, renamed into its requested
world-relative landing directory, and then removed from staging.

Implemented landing directories include:

- Shot: `W\productions\<production>\incoming\<shot-id>\...`
- Whole-scene pass: `W\productions\<production>\incoming\<scene-id>-pass-<index>\...`
- Reference candidate: `W\references\<sheet>\incoming\...` or `candidates\...`
- World image: `W\incoming\world-image\candidate.png`
- Cloud voice preview: `W\.cache\voice-previews\<hash>.mp3`
- Dialogue audio: `W\productions\<production>\audio\...`

| Operation | Creates, changes, or removes |
|---|---|
| Record production take | Moves landed media into `...\takes\tk_<id>\<media>`, removes its incoming directory, and creates `take.json`. A whole-scene pass also creates metadata-only take directories for shot ranges; media is not duplicated. |
| Accept take | Creates or replaces `...\reviews.jsonl` and `...\selections.json` in one world commit. It does not edit the take or scene. |
| Reject take | Creates or replaces `...\reviews.jsonl` only. The selection and take stay unchanged. |
| Save audio placement | Creates or replaces `...\cut.json`. It holds audio tracks and placement only; picture order comes from scenes and `selections.json`. |
| Render production | Encodes to `W\.cache\exports\ex_<id>.mp4`, then renames the complete file to `W\exports\<name>.mp4`. Cancel or failure removes the staged file. |
| Export whole world | Recursively copies to `R\exports\<world>-<timestamp>\`. Includes `.history`; excludes `.index`, `.commit`, `.proposals`, `.staging`, `.cache`, `world.lock`, and temporary files. The whole copy is not atomic, so failure can leave a partial export directory. |

## Artifacts and extraction

| Operation | Creates, changes, or removes |
|---|---|
| File artifact | Copies the source to `W\artifacts\<safe-name>` and creates `<safe-name>.json`. The source is untouched. If identical bytes already exist, no binary is copied and the existing sidecar may be replaced to merge links. |
| Supersede artifact | Creates a new binary and sidecar. The old binary, sidecar, and existing links remain. |
| Import folder | Files each visible file separately and flattens the source hierarchy into `W\artifacts\`. The original relative directory is retained in sidecar provenance. Hidden and system files are skipped. |
| Extract facts | Creates scratch work under `R\.extract\extract-<id>\` and replaces the artifact sidecar as candidates are recorded, accepted, or rejected. Accepted facts additionally create canon or sheet proposals. |

## References, voice, and world image

| Operation | Creates, changes, or removes |
|---|---|
| Record reference take | Copies media to `W\references\<sheet>\takes\tk_<id>\` and creates `take.json`. |
| Accept reference or change kit | Creates or replaces `W\references\<sheet>\kit.json`. Review-bearing changes also create or replace `W\references\reviews.jsonl`. Superseded media remains. |
| Upload main-photo candidate | Copies to `W\references\<sheet>\candidates\upload-<id>.<ext>`. Choosing it copies it into an immutable reference take, changes `kit.json`, records a review, then deletes the candidate. |
| Compile classic grid | Legacy angle-tile command path, not offered by the current character-reference screen: creates or replaces `W\references\<sheet>\model-sheet-v<version>-grid.png`, then creates or replaces that sheet's `kit.json`. |
| Preview voice | Creates or reuses `W\.cache\voice-previews\<hash>.<ext>`. Current model-driven formats include Kokoro WAV, cloud MP3, and ComfyUI cloned-voice FLAC. |
| Dictate | Returns transcript text and does not persist the captured audio. |
| Generate world image | Lands `W\incoming\world-image\candidate.png`. Accept copies it to `W\world-art.png` and deletes the candidate; discard deletes only the candidate. |

## Filesystem operations not implemented

The current API does not implement:

- Permanent deletion of a world, production, scene, chapter, sheet, canon entry, take,
  artifact, or reference kit.
- Restoring an archived world through the application.
- Renaming or moving world, production, scene, chapter, or sheet files.
- Separate shot files; shots live inside scene JSON.
- Atomic all-at-once copying of a whole-world export.
- Seeding sheets or canon threads from a new-world conversation. Beginning a world creates the
  world and carries its attachments; the draft's characters, locations and threads are dropped.

## Known cleanup gap

Canon Q&A removes its temporary sandbox. Art-direction and extraction helper sandboxes under
`R\.art\` and `R\.extract\` are not currently swept automatically.

Verified against coordinator, provider and desktop code on 2026-08-27.

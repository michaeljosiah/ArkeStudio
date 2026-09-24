# Publication contracts, compilation and local delivery

The implemented foundation of SPEC-048 supplies the shared contract for a portable video
publication, source capture, directory integrity verification, a video compiler, recoverable local
publication delivery and bounded ZIP writing/extraction. Desktop adds an export-sheet action and
a world-independent player at `/publications`.
Track the remaining work in [issue #1228](https://github.com/michaeljosiah/ArkeStudio/issues/1228).

`packages/contracts/src/publication.ts` exports the video manifest schema, compatibility reader,
portable asset path rules and dependency receipt/fingerprint helpers. The owning tests are
`packages/contracts/test/publication.test.ts`. These are new output contracts; no existing world
schema, production record or timeline is migrated by importing them.

## Manifest boundary

`readPublicationManifest(value, supportedCapabilities?)` takes an already parsed JSON value and
returns either a validated `VideoPublicationManifest` or a named refusal: `invalid-manifest`,
`unsupported-schema`, `unsupported-profile`, or `unsupported-capability`. Its default capability
set describes this validator's vocabulary, not a claim that a player has been installed.

Video v1 binds one inventoried MP4 or WebM asset and optional WebVTT tracks. Each track explicitly
names captions or subtitles, a language, a label and whether it is default. At most one is default.
An inventory entry carries a relative path, media type, byte length and full lowercase hexadecimal
SHA-256 digest (without the `sha256:` prefix used by some world contracts). Referenced assets must
exist in the inventory with the correct media type; unreferenced assets are refused in this first
profile, which has no construction-recipe attachment yet.

The manifest is strict about content and build fields. Optional extensions belong in `metadata`,
keyed by an absolute namespace URL and containing bounded JSON. They carry no executable semantics.
Unknown required capabilities are refused even when the rest of the content parses. Books,
audiobooks and interactive video currently return `unsupported-profile`.

Portable paths use ASCII alphanumeric, dash, underscore and dot segments separated by `/`.
The compiler will mint these filenames independently of Unicode display titles. Absolute paths,
URL escapes, traversal, Windows device names, trailing dots, case collisions, file/directory
conflicts and collisions with the root `publication.json` are rejected.

Successful parsing is **not package verification**. The coordinator directory verifier below
checks file integrity. The ZIP reader below bounds extraction sizes and rejects duplicate
entries before extraction. General reader WebVTT timing and codec preflight remain player work.
The schema cannot establish those facts from a JSON description alone.

## Dependency boundary

`PublicationCaptureSchema` describes a dependency receipt. It holds
hashed source records and measured media, a resolved-plan hash, settings hash, compiler identity
and optional timeline revision. Record/media keys must be unique within their inventories.
The receipt remains internal; only its fingerprint is public build provenance.

`publicationCaptureText` produces canonical receipt JSON by using explicit field order and sorting
the record/media inventories by key. `fingerprintPublicationCapture` hashes those UTF-8 bytes with
Web Crypto SHA-256, usable from Node and the renderer. Callers must supply canonical full-plan and
settings hashes; this helper does not canonicalize arbitrary JSON or read the world.

Changing a selection, source bytes, resolved trim/order, settings or compiler identity must change
the receipt even when the timeline revision stays the same. The tests exercise this distinction.
Possessing a valid receipt does not prove that the dependencies were captured or that the compiler
declared all of them.

## Coordinator file services

`capturePublicationInputs(store, request, scratchRoot, options?)` in coordinator
`src/publications/capture.ts` accepts a receipt and exact key-to-world-relative-path maps for its
records and media. The profile compiler must supply a complete dependency set, derived from
the same records as its resolved plan and settings. This service does not discover dependencies,
resolve a RenderPlan or validate the plan/settings hashes on its behalf.

Under `WorldStore.ownedRead`, capture checks the declared record hashes, copies and hashes media
into a unique child of an existing host-owned scratch directory, then rechecks every source record
and media file. It rechecks disk ownership before returning the receipt, fingerprint, copied media
paths and an idempotent `dispose()` function. No returned host path belongs in a public manifest.
App writes wait for capture; subsequent source edits do not change the copies. External file edits
are detected by hashes and file identity/stat checks. As with world ownership, these checks are
not an atomic filesystem fence against a process actively swapping ancestors.
The read operation shares the write queue and ownership checks, but never suppresses watchers or
runs a post-write rescan: it does not edit the world. Queued watcher work can run after the read.

Caller cancellation and world close abort in-flight capture. Failure removes only its unique
scratch child; successful callers must dispose it after consuming the copies. Files are synced
before return, but this is temporary input storage, not a durable completion receipt or recovery
protocol. The optional `onCopied` progress callback runs inside the world gate: it must not await
another operation needing that gate, including `store.close()`.

`verifyPublicationDirectory(directory, options?)` in `src/publications/verify.ts` runs without a
world. It reads bounded UTF-8 JSON, rejects duplicate object keys (including escaped aliases),
negotiates compatibility, checks the directory's exact file
inventory and streams every asset through SHA-256 and length validation. Links/junctions,
non-portable names, case aliases and unlisted files are refused. Directory enumeration is streamed
and bounded by count and depth. Defaults cap the manifest at 1 MiB, each asset at 32 GiB, total
package bytes at 64 GiB and directory entries at four times the contract's asset-count limit.
Source capture has a separate configurable `recordBytes` bound of 64 MiB per editable record;
timeline/history records do not inherit the small manifest limit. Hosts can tune these limits;
actual media reads/copies are also bounded by declared media lengths.

The verifier returns the parsed manifest, manifest digest, measured total bytes and canonical
directory path. `PublicationFileError.code` distinguishes compatibility, path, limit and integrity
refusals; ordinary filesystem errors retain their system codes. Verification grants point-in-time
integrity, not lasting trust in an externally editable folder. The future player must pin or
reverify inputs and validate codecs and captions before presenting them.
Before returning, the verifier checks the inventory again and revalidates the identity, size and
timestamps recorded for every hashed file, detecting edits to earlier assets while later ones
were being read. The optional `onAssetVerified` callback reports each completed asset hash.

Run the focused tests from `packages/contracts`:

```powershell
node --import tsx --test test/publication.test.ts
```

Run the coordinator service regressions from `packages/coordinator`:

```powershell
node --import tsx --test test/publications/*.test.ts test/world/ownership.test.ts test/world/store.test.ts
```

## Video compilation

`compileVideoPublication(store, request, options)` in coordinator `src/publications/video.ts`
compiles a video production or episode. The request names publication identity, edition, title,
language, preset, expected timeline revision and zero or more subtitle-track choices. Each choice
explicitly names `captions` or `subtitles`, a readable label and default state; its language comes
from the saved track. Contracts `src/publication-video.ts` validates the request and derives a
clean RenderPlan plus each track's sidecar projection using the existing planner. Episode cues
are clipped/rebased by that same planner. Missing picture slates, unmeasured sound, invalid
timelines, unavailable tracks and interactive routing are refused. Intentional blank intervals
remain valid, including a plan with no source media. Legacy song-clock delivery requires a saved
timeline, as the shared planner does; legacy captions also require a saved timeline.

The host supplies its existing encoder and media probe, the encoder build identity and an existing
scratch root. Capture accepts a trusted preparation callback so discovery and copying share one
world gate. The compiler scans fresh state, preserves the existing placed-performance byte check,
and conservatively includes the scanner's **whole authored inventory**, plus a hash of the selected
production, artifact catalog and world metadata. It hashes the full resolved plan/track projection
and delivery settings. This deliberately overcaptures records: unrelated authored changes can
invalidate a build. A second scan checks derived inputs and the inventory, including previously
absent records, before capture's final file/hash/ownership checks. Consumed artifact bytes must
match their recorded hash. The preparation/revalidation callbacks must never await another
operation needing the world gate.
Editable record receipts have their own 65,536-entry limit, separate from the 4,096 media-asset
limit. Unordered take/performance/rehearsal inventories are scanned in stable path order, so
filesystem enumeration does not change the fingerprint. A consumed take with an existing but
stale media measurement is refused even when sound is muted; a genuinely unmeasured take with
no measurement sidecar can still supply picture under the shared planner's existing rules.

After capture, the gate is released. Every encoder input (picture, overlay and sound) is rewritten
to a captured file; the world is no longer used for rendering. The compiler probes temporal
inputs and refuses missing streams or out-of-source seek ranges. Existing short-source hold/pad
behavior stays in the shared FFmpeg graph. It writes H.264/yuv420p MP4, with AAC when sound is
present, and checks the output's video, audio and duration through the host probe. Encoder
availability and codec decoding support still belong to the platform/player.
Video overlays must have enough source for their full window, because the shared graph passes
through to the lower picture at EOF. Discovery passes cancellation into authored reads, review
logs, performance-byte checks and streamed take hashing. It omits operational proposals, change
history, conversation/bench sessions and staged reference artwork that do not feed the compiler.

The temporary package contains only `publication.json`, `movie.mp4` and requested `text-N.vtt`
files. No world paths or private source records enter the manifest. Blank lines and unsupported
control characters in cues are refused because they would split WebVTT blocks and lose text.
Output files are synced, inventoried and independently verified before returning. Capture storage
is then removed. The returned package includes an idempotent `dispose()`; callers must consume it
and dispose it. Failure, cancellation or world close removes this operation's temporary files.
No destination is promoted or reported as durably completed, and a process crash can leave
scratch files. The publisher below consumes this temporary output and adds promotion and retry
reconciliation.

Regression coverage includes scope parity in contracts `test/delivery-scopes.test.ts` and compiler
lifecycle in coordinator `test/publications/video.test.ts`. To also encode, probe and decode real
media, set `ARKE_TEST_FFMPEG` and `ARKE_TEST_FFPROBE` to executable paths before running that test.
Typecheck consumers after changes. The remaining user-facing work is the independent player and
export action, including persisted operation ids, progress, cancellation and retry controls.

## Recoverable local delivery

Coordinator `src/publications/publish.ts` exports `publishVideoPublication(store, request, options)`.
The host supplies the compiler ports, an existing trusted local `outputRoot`, a persisted UUID
`operationId` and `format: "directory" | "zip"`. The video wrapper fingerprints the request,
world identity and encoder identity. Reusing an operation id with different settings refuses as
`operation-conflict`. Source edits after preparation do not change the saved edition: retries
verify that edition without scanning the world or running the encoder again.

The lower-level `publishPublication(request, build, options)` accepts a trusted compiler callback
that returns a disposable verified directory. Hosts must persist its operation id, publication id,
format and complete request fingerprint before starting, and mint a new publication id for a new
edition. The publisher cannot infer omitted settings from a caller's fingerprint. It coordinates
by operation id within one output root; copying an edition elsewhere preserves its publication id.
It does not supply a global publication registry or deduplicate different operation ids.

Each operation allocates `<outputRoot>/<operationId>/`. Internal recovery records live there,
outside the portable package:

```text
<operationId>/
  operation.json                    immutable request identity
  prepared.json                     chosen attempt and measured package/ZIP hashes
  complete.json                     acknowledgement of verified promoted output
  attempt-XXXXXX/
    publication/                    portable directory, or publication.zip
```

Compilation and package copying use a unique attempt directory on the destination filesystem.
Every copied package file and the ZIP are flushed; the exact inventory and hashes are verified
before a prepared receipt selects the attempt. Receipts are written to flushed temporary files
and installed with exclusive hard links, so neither retries nor competing processes overwrite
records. Processes may prepare competing candidates; one wins and losing attempts are discarded.
The in-process queue also avoids redundant compilation for ordinary concurrent callers.

A prepared directory is renamed inside its selected attempt; the ZIP is installed with a
no-replace hard link. Existing targets are verified, never treated as permission to overwrite.
Completion is recorded only after the promoted output is verified against the prepared receipt.
If a process stops before or after promotion, retry reconciles the recorded attempt and destination.
A missing completion record never means that no output exists. A damaged, missing or conflicting
prepared/completed edition is refused and preserved rather than rerendered under the same operation.
The returned `path` names only the portable directory/ZIP; recovery records must not be shipped.

Cancellation is checked during copying, ZIP work and verification, and before entering promotion
and completion. Before preparation, failures remove the current attempt. After preparation, an
interruption preserves the selected attempt/output for reconciliation. Once completion installation
starts, its outcome must be reconciled even if the caller loses the acknowledgement. The optional
`onPhase` hook observes prepared/promoted/completed boundaries; it must not recursively await a
publisher on the same operation. The caller must await/drain its publisher promise on shutdown.
The video wrapper combines caller cancellation with world close.

This supports process-crash recovery on a trusted local filesystem with hard links and same-volume
rename (such as NTFS/ext4). It does not promise recovery from arbitrary power loss, an atomic fence
against hostile path replacement, or correctness on network/actively synchronized storage. It does
not change the existing world ownership protocol. Abrupt exit before preparation can leave orphan
attempts or receipt temporaries; there is no automatic orphan sweep yet. ZIP staging may retain a
second hard-link name to the completed archive; it does not duplicate its stored bytes.

## ZIP portability and reader limits

Coordinator `src/publications/archive.ts` uses [yazl](https://github.com/thejoshwolfe/yazl) for
streamed ZIP/ZIP64 output and [yauzl](https://github.com/thejoshwolfe/yauzl) for bounded extraction.
Files are stored without recompressing already encoded media. `writePublicationZip` requires an
absent destination and writes only the verified inventory, with `publication.json` at root. It is a
container writer, not a completion API; the publisher validates its output before promotion.

`extractPublicationZip(archive, scratchRoot, options?)` first pins the archive to its own scratch
child, then validates all central-directory paths and declared sizes before extracting anything.
It rejects traversal, non-portable names, duplicates/case aliases, file/directory collisions,
links/special files, encryption and unsupported compression. Stored and deflated entries and ZIP64
are supported, including ordinary explicit directory entries. Extraction streams enforce actual
expanded lengths and CRC32; the existing directory verifier then validates the manifest and full
SHA-256 inventory. Missing/unlisted assets, incompatible manifests and tampered data still refuse.
Malformed archives report `invalid-package`; filesystem and cancellation errors remain distinct.

The directory byte/count limits also govern extraction. Pinned archives are bounded to the package
byte limit plus 16 MiB for container overhead. The returned `ExtractedPublication` owns its pinned
ZIP and verified extracted directory; `dispose()` removes those copies and leaves the input alone.
The scratch root must have space for both forms. No extraction result implies codec support or
caption-semantic validation; the player still owns those checks.

`test/publications/delivery.test.ts` covers malformed archives, receipts, cancellation, preservation
of existing output, abrupt process exit and competing processes. `test/publications/video.test.ts`
includes compiler-to-publisher retry after source edits and opt-in real-media ZIP decode.

## Desktop publishing and playback

In Cut → Export film, **Publish playable edition** chooses title, edition, language, full production
or episode, ZIP/folder and explicitly selected caption/subtitle tracks. The resolution comes from
the export sheet. Each selected track has an editable label and kind; only one may be default.
The shared publication plan refuses gaps, stale/invalid timelines and unsupported source state
before starting. Native folder selection chooses the output root, outside managed world storage.

Desktop `src/publication-host.ts` flushes an immutable intent under
`<appRoot>/publications/operations/<operationId>.json` before starting. This preserves the request,
world id, format, encoder build identity and private output root. IPC exposes only opaque ids and
status. Jobs show phases, cancellation, retry, Play and Show in folder. On restart saved operations
appear as **Check or retry**; reconciliation verifies completion before showing success. Prepared
output can finish without a world or encoder. An unprepared retry needs the source world and same
encoder build; changed settings require a new edition. Shutdown aborts and drains jobs before
closing the world provider. The renderer does not own operation lifetime.

Worlds → **Open publication** opens a directory or ZIP without opening a world or making a provider
call. Coordinator `openPublication` pins it into a private scratch child, verifies the inventory,
then preflights media and captions. It never serves the original mutable package. Desktop's separate
authenticated loopback endpoint resolves only session/asset ids, supports byte ranges, checks
origins, and accepts no query credentials. Main injects the private capability for this window and
endpoint only. The public bridge contains neither paths nor credentials.

The current native media preflight accepts H.264/AAC MP4 and VP8/VP9 WebM with Opus/Vorbis,
one video and at most one audio stream, with 8-bit 4:2:0 video. Other codecs get `unsupported-codec`.
The browser also checks `canPlayType`; later decode/asset errors remain visible. Caption preflight
accepts bounded UTF-8 WebVTT with cue ids, plain timing lines, native cue text and NOTE blocks.
It refuses styles, regions, cue settings, invalid/reversed/out-of-order times and cues beyond the
movie (50 ms rounding tolerance). Each sidecar is limited to 8 MiB. This is deliberately narrower
than all of WebVTT; future support needs explicit fixtures rather than silently discarding features.

The client uses native media controls and an explicit captions/off selector. Resume time and caption
choice live in browser storage keyed by publication id and manifest digest, outside immutable files.
Only the desktop host currently supplies disk opening/export; the reusable HTML player receives
verified URLs. No browser upload host, book/audio/interactive profile or OTIO adapter is claimed.
Closing/replacing playback removes its owned copy. Abrupt exit can leave scratch files; no orphan
sweep or power-loss durability guarantee is added by the UI.

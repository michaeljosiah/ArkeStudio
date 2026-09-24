# Publication contracts and video compiler

The implemented foundation of SPEC-048 supplies the shared contract for a portable video
publication, source capture, directory integrity verification and a video compiler that returns
a verified temporary package. Durable publication, ZIP delivery, a player and an export command
are not yet implemented.
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
checks file integrity. A future ZIP reader must also bound extraction sizes and reject duplicate
entries before extraction. WebVTT timing and codec preflight remain separate, unimplemented checks.
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
scratch files. A future publisher must add no-overwrite promotion and retry reconciliation before
this API is exposed as a completed user export.

Regression coverage includes scope parity in contracts `test/delivery-scopes.test.ts` and compiler
lifecycle in coordinator `test/publications/video.test.ts`. To also encode, probe and decode real
media, set `ARKE_TEST_FFMPEG` and `ARKE_TEST_FFPROBE` to executable paths before running that test.
Typecheck consumers after changes. Next work adds durable package promotion/recovery and ZIP,
then wires an independent player and export action.

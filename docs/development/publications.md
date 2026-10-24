# Publication contracts, compilation and local delivery

The implemented foundation of SPEC-048 supplies the shared contract for a portable video
publication, source capture, directory integrity verification, a video compiler, recoverable local
publication delivery and bounded ZIP writing/extraction. Desktop adds an export-sheet action and
a world-independent player at `/publications`.
Track the remaining work in [issue #1228](https://github.com/michaeljosiah/ArkeStudio/issues/1228).
The opt-in [book/audio interoperability spike](publication-interop.md) records external-format
fixtures and reader evidence; it does not add supported application profiles.

The [private story publishing design review](../../design-system/publish-private-review.html)
records approved turn 224 (revision 2, 2026-10-13). Story and Audiobook now share a Publish sheet
for standalone EPUB and AAC M4B files. SPEC-058 extends this flow with a typeset PDF. This is separate from the video-v1 manifest/player protocol;
the protocol still refuses unsupported book/audio profiles.

The coordinator's publications/story.ts owns host-local editions under
<appRoot>/story-publications/<edition UUID>/. story-review.ts checks every explicitly selected
chapter in manuscript order against a fresh world scan. Audiobook readiness uses the existing
block plan, kept takes, measured durations, recorded-take clearance and chapter mix. Missing,
stale, flagged or misplaced material blocks audio; users can fix it, leave out a chapter, or
choose book only. Publishing never starts speech generation.

Formatting & style has an optional Avoid em dashes rule, off by default. Each suggestion shows
exact source text, an editable proposal and potentially affected recordings. Apply uses the
ordinary base-hash-guarded manuscript save with a new restorable version. Keep stores a decision
for that exact paragraph/rule/selection. Stale proposals refuse. Existing audio dependency checks
identify changed spoken blocks; presentation-only changes do not invent replacement narration.

Prepare preview captures source receipts and media through the existing publication capture
boundary, then builds the actual EPUB/M4B outside the world write gate. The EPUB preview reads
its packaged XHTML in a sandboxed frame. Audio uses the existing mix semantics, with ordered
chapter markers and optional PNG/JPEG cover art. Create edition rechecks source identity and
output hashes before marking the files ready. Failed/cancelled preparations retain captured
inputs for retry; incomplete files are not delivered. Completed files are immutable to the app
and remain usable after the source world moves or closes. Missing/changed files are refused. Desktop Locate restores only a file whose digest matches the same edition; it cannot substitute a different book.

M4B preparation saves and reports the current stage through the existing edition phase:
rendering each chapter, encoding the combined audiobook, then checking its output. Reopening
Publish shows that saved phase. These stages do not estimate a percentage or completion time.
The preparation view follows approved turn 224: edition identity and cover, one row per selected
output, the shared indeterminate loading indicator, and Back to story. Closing the sheet keeps
the host operation running; Cancel preparation remains available in its footer. Built rows still
wait for edition checks and do not expose files for delivery.
The cover preview reads only the captured, digest-checked cover through the authenticated preview
route, so accepting or removing its original world candidate cannot break it. Remote browsers
name the desktop host; disconnected clients wait for a refreshed edition before showing activity.

Private story previews use a separate authenticated media route. Native Save and download delivery
require a ready edition after Create has rechecked the source; preview playback does not approve
delivery. Reconnecting reloads the selected saved operation. Audio preparation removes temporary
chapter WAVs and encoder metadata after success, failure or cancellation, retaining captured inputs
for retry. Readiness checks apply to selected chapters and their shared narration dependencies.

Publications lists private editions across worlds. Authenticated media delivery supports range
requests, including paired remote browsers. Desktop Save uses a main-process dialog and resolves
only inventoried edition files; the renderer cannot supply arbitrary host paths. Browser Save
uses a download response. Send to Kindle is an explicit manual EPUB handoff. M4B import uses an
external audiobook app and does not promise Kindle audio, Amazon delivery receipts or synchronized
reading/listening positions. MP3/WAV export and a new portable book/audio player profile remain
later work. Physical Kindle/phone import, offline listening, seek and resume need device acceptance
testing; encoder and layout checks alone do not establish these.

`packages/contracts/src/publication.ts` exports the video manifest schema, compatibility reader,
portable asset path rules and dependency receipt/fingerprint helpers. The owning tests are
`packages/contracts/test/publication.test.ts`. These are new output contracts; no existing world
schema, production record or timeline is migrated by importing them.

## Attached EPUB illustrations

Publish offers **Include attached illustrations**, off by default and available only with EPUB.
It reuses the current audiobook picture bindings and their manuscript positions; no recording or
image generation is required. Pictures appear before their block's first manuscript paragraph,
in block order, with chapter-opening artwork after the heading. Existing joined-block placement
keeps its first picture; retained pictures hidden by a join and unused takes are not exported.
The saved frame description supplies alternative text, with a chapter/passage label when a
chosen image has no frame description. This fallback identifies the attachment; it is not an
invented visual description.

Missing or unlisted pictures, changed passage or look bindings, unreadable records and unsupported
images block the illustrated edition. Reattach or review those pictures in the chapter, or leave
the option off for an ordinary text-and-cover EPUB. PNG/JPEG inputs are bounded to 20 MiB and
40 megapixels each, 1,000 placed pictures and 2 GiB of distinct image inputs. Original image bytes
are retained through the existing hash-checked publication capture; no other takes are bundled.

Original-image illustrated editions use compiler version 4. `publications/story-illustrations.ts` resolves and
checks bindings; `story-epub.ts` streams the same package parts used by the manuscript writer,
hashing each captured image while writing. Cancellation and failures remove the unfinished ZIP.
Preview reads just the packaged XHTML/CSS and serves only captured, inventoried illustrations
through the authenticated preview route. Its frame permits same-origin media for paired browsers
but no scripts. Ordinary text-only exports and previously captured editions remain supported.

An illustrated EPUB can explicitly choose **Reading size · up to 2048 px** instead of the
default **Original images**. Compiler version 5 captures both originals and distinct reading
copies, with profile version 1, the host encoder identity, dimensions and byte digests. It reuses
Arke Player's no-upscale, aspect-preserving fit: JPEG at FFmpeg q4, or PNG to preserve an alpha
channel/tRNS transparency. The cover follows the same EPUB-only choice; PDF/M4B keep their
original covers. `publications/story-epub-images.ts` owns these captured copies and
`references/reading-image.ts` shares the existing fit with Arke Player. No world image or prior
edition is changed. Retries use the exact saved copies without reconversion; preview serves the
same images packaged in the EPUB. The Files view shows the saved choice and measured final size,
not an estimate or promised reduction. Check source-critical lettering in Preview before Create.
The local codec smoke is `ARKE_STORY_CODEC_SMOKE=1` with `ARKE_FFMPEG` pointing to the installed
encoder, running `test/publications/story-illustrations.test.ts` from the coordinator package.

## Story PDF editions

PDF uses the same explicit chapter selection, review, captured preview and Create boundary as
EPUB/M4B. Select PDF in Publish and choose Book (6 × 9 in), A4 or Letter, bundled serif/sans,
10–14 pt body text, 1.25–1.6 line spacing, contents and running headers. PDF-only preparation
needs no narration or FFmpeg. The authoritative prose supplies paragraphs, emphasis and scene
breaks; metadata supplies the title page and optional subtitle/edition label. Unsupported text
or layout refuses rather than silently dropping words. The old Word/EPUB export is unchanged.

`publications/story-pdf.ts` plans pages explicitly, renders with PDFKit/fontkit and independently
parses the bytes with PDF.js. Bundled DejaVu faces, Noto Emoji fallback and their hashes travel in compiler identity;
the system font collection is not used. Validation checks source-to-plan paragraph fidelity,
parsed text, navigation, embedded fonts, page bounds and reading structure. The private
`pdf-validation.json` receipt stays beside the edition, outside the PDF. PDF captures use story
compiler version 3; existing EPUB/M4B identities and supported old captured inputs remain readable.

`story-pdf-runner.ts` runs the compiler in a worker and waits for termination on cancellation,
failure or timeout. The limits are 200 chapters, two million text code points, 5,000 pages,
100 MiB PDF, 20 MiB/40-megapixel cover and 120 seconds. V8 heap limits and sampled heap plus
external allocation enforce a 512 MiB worker budget; this is not an operating-system RSS cap.
Large inputs can refuse before the page ceiling. The coordinator does not hold the world gate
while formatting. Retry checks the frozen renderer/font identity; it cannot silently use a
new renderer to reinterpret an old edition. The worker refuses PDF.js's optional
`@napi-rs/canvas` addon, which the packaged worker cannot resolve anyway: in a source checkout
each finished worker unloaded it, and on Windows that unload intermittently crashed the whole
process (0xC0000005).

Client `story-pdf-preview.tsx` displays the actual authenticated candidate PDF with canvas and
selectable text, page/zoom/chapter controls and no native download/annotation actions. Only a
ready edition offers Save PDF. Desktop resolves the inventoried `story.pdf` through the same
digest checks as other formats; Locate must restore matching bytes. The standalone file needs
neither Arke nor the original world. This is a reading PDF with tagged text and bookmarks, not
a claim of PDF/UA, PDF/X, print-house or retailer certification. V1 accepts Latin prose,
including Igbo/Yoruba diacritics, plus supported symbols and emoji. Non-Latin letters and
unsupported glyphs are refused with their location; a language tag alone does not establish coverage.

Desktop builds bundle the worker and font assets. Headless development uses the source worker
through tsx. See [maintenance](maintenance.md) for asset ownership and [testing](testing.md)
for focused checks and the isolated built-worker smoke. Native packaging, browser preview
and full-length rendered-page acceptance remain distinct evidence from schema/unit checks.

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

The export sheet defaults 9:16 productions to `vertical-master` (1080×1920, CRF 18),
and keeps an explicitly chosen preset for that production. Other productions retain the
review default. Every preset uses the production frame rate (SPEC-038 R-32). The expanded
Publish section states dimensions, frame rate and quality before submission (issue #1252).

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
Compiler version 2 disables inherited global/stream metadata and chapter mappings. Source camera
tags, notes and stale chapter markers are not publication metadata; FFmpeg may still write its own
normal encoder/container tags.
Video overlays must have enough source for their full window, because the shared graph passes
through to the lower picture at EOF. Discovery passes cancellation into authored reads, review
logs, performance-byte checks and streamed take hashing. It omits operational proposals, change
history, conversation/bench sessions and staged reference artwork that do not feed the compiler.

The temporary package contains only `publication.json`, `movie.mp4` and requested `text-N.vtt`
files. No world paths or private source records enter the manifest. Blank lines and unsupported
control characters in cues are refused because they would split WebVTT blocks and lose text.
Output files are synced, inventoried and independently verified before returning. Capture storage
is then removed. The returned package includes an idempotent `dispose()`; callers must consume it
and dispose it. Failure, cancellation or world close removes this operation's temporary files
when using the one-shot `compileVideoPublication` API.
No destination is promoted or reported as durably completed, and a process crash can leave
scratch files. The publisher below consumes this temporary output and adds promotion and retry
reconciliation.

Regression coverage includes scope parity in contracts `test/delivery-scopes.test.ts` and compiler
lifecycle in coordinator `test/publications/video.test.ts`. To also encode, probe and decode real
media, set `ARKE_TEST_FFMPEG` and `ARKE_TEST_FFPROBE` to executable paths before running that test.
Typecheck consumers after changes. Desktop uses `prepareVideoPublication` to capture under
`withWorldStore`, releases provider access, then calls the returned `render()` once. Rendering
uses only the operation signal and pinned inputs, so switching/closing the source world after
capture does not block or cancel it. An unused capture must be disposed; rendering owns cleanup
once started. The one-shot compiler retains its world-close cancellation behavior.

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
After target verification, the ZIP's `staged.zip` alias is removed, including on recovery.
Concurrent link changes can change inode timestamps; bounded retries repeat the complete
checked read without weakening identity or digest checks.
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
The shared publication plan refuses missing-picture slates, stale/invalid timelines and unsupported
source state before starting. Deliberate blank gaps publish as black. Native folder selection
chooses the output root, outside managed world storage.

Desktop `src/publication-host.ts` flushes an immutable intent under
`<appRoot>/publications/operations/<operationId>.json` before starting. This preserves the request,
world id, format, application compiler version, encoder build identity and private output root. IPC exposes only opaque ids and
status. Jobs show phases, cancellation, retry, Play and Show in folder. On restart saved operations
appear as **Check or retry**; reconciliation verifies completion before showing success. Prepared
output can finish without a world or encoder. An unprepared retry needs the source world and same
encoder build and application compiler version; changed settings require a new edition. Legacy
intents lacking an application compiler version can reconcile prepared output but cannot build.
After the final intent hard link is installed, temporary-alias cleanup is best effort and cannot
hide the saved job. Shutdown aborts and drains jobs before
closing the world provider. Provider access lasts only through capture, so world selection remains
available during encoding. The renderer does not own operation lifetime.
Unreadable/incompatible intent files are preserved and reported individually without hiding valid
jobs or blocking unrelated playback. A changed encoder on an unprepared retry explicitly requires
a new edition; conflicting saved operation identities and damaged prepared/completed data are
likewise non-retryable, while transient system
errors remain retryable. Native picker waits are raced against shutdown/renderer cancellation;
late dialog answers cannot restart work. Clean video-v1 uses no drawtext: the adapter
refuses accidental text-drawing graphs, while ordinary exports retain their bundled-font checks.

Worlds → **Open publication** opens a directory or ZIP without opening a world or making a provider
call. Coordinator `openPublication` pins it into a private scratch child, verifies the inventory,
then preflights media and captions. It never serves the original mutable package. Desktop's separate
authenticated loopback endpoint resolves only session/asset ids, supports byte ranges, checks
origins, and accepts no query credentials. Main injects the private capability for this window and
endpoint only. The public bridge contains neither paths nor credentials. Named domain refusals
map to fixed product copy, including when their internal messages contain filesystem errors.

The current native media preflight accepts H.264/AAC MP4 and VP8/VP9 WebM with Opus/Vorbis,
one video and at most one audio stream, with 8-bit 4:2:0 video and no other embedded streams.
Subtitle, data and attachment streams are refused; selectable text belongs in inventoried sidecars.
Other codecs get `unsupported-codec`.
The browser also checks `canPlayType`; later decode/asset errors remain visible. Caption preflight
accepts bounded UTF-8 WebVTT with cue ids, plain timing lines, native cue text and NOTE blocks.
It refuses styles, regions, cue settings, invalid/reversed/out-of-order times and cues beyond the
movie (50 ms rounding tolerance). Each sidecar is limited to 8 MiB. This is deliberately narrower
than all of WebVTT; future support needs explicit fixtures rather than silently discarding features.
Compiler and player share `src/publications/captions.ts`: generated sidecars must pass the same
8 MiB, syntax and measured-movie duration checks before publication. The encoder's broader
frame/container tolerance does not allow captions extending more than 50 ms beyond the movie.

The client uses native media controls and an explicit captions/off selector. Resume time and caption
choice live in browser storage keyed by publication id and manifest digest, outside immutable files.
Only the desktop host currently supplies disk opening/export; the reusable HTML player receives
verified URLs. No browser upload host, book/audio/interactive profile or OTIO adapter is claimed.
Cancelled or failed opens preserve current playback. A candidate video loads beside the current
movie and remains hidden until Chromium decodes its first frame. Codec/decode failures or a 30-second
readiness timeout discard only the candidate; promotion keeps its decoded element and closes the
previous session after unmount. The host allows at most two sessions for this handoff. Closing playback
removes its owned copy. A renderer reload/crash cancels pending opens and releases playback copies
without cancelling host-owned export jobs. Abrupt exit can leave scratch files; no orphan
sweep or power-loss durability guarantee is added by the UI.

Ready EPUB files offer **Preview EPUB** from their saved edition, including on the
world-independent Publications page. The existing captured-book preview opens in a read-only
sheet with chapter navigation and restores focus to its opener when closed. It reads frozen
text and inventoried images without opening or checking the mutable source world. The saved
edition and deliverable bytes do not change; this is not a new preparation or publication.

## Arke Player world packages, parts and the guide

Export → Arke Player (SPEC-058, turns 233, 235, 236) writes a world package, not a publication: a
stored ZIP with `world.json` first and every file it inventories, played natively by Arke Player and
never run. Contracts `world-package.ts` holds the readers, strict as SPEC-048 R-17 asks: schema 2
adds a production's listening document, schema 3 the world's guide (SPEC-059), and schema 4 is a
**part**, the chapters released since an edition. A guide document is version 1, or version 2 when it
carries teasers. `arke-player-release.ts` holds what each release held and where a production's
releases stand; `world-guide.ts` holds the Guide record and `guideDocument`.

The readers are one reader in two languages. Arke Player's `arke_world` reads the same shared
fixtures, which are its own: `packages/arke_world/test/fixtures/{listening,guide,part}`, written by
its `tool/make_*_fixtures.py`. Copy them byte for byte into `packages/contracts/test/fixtures/world-package/`
whenever they change, and change both readers together.

Coordinator:

- `productions/arke-player-export.ts` makes an edition, `exports/<slug>-player-<date>.zip`, or with
  `part` a part, `exports/<slug>-part-<date>.zip`, under R-4's capture: staged, read back by
  `world-package.ts`'s `checkWorldPackageZip`, and checked again under the world's gate before it is
  named. Beside each it writes a `.zip.json` record that Publications lists and that keeps the
  `release` (its chapters, and on a part the edition it follows). A part names its edition by
  `editionFingerprint`, which must stay arke_world's to the byte. A part's chapters run on from the
  last release, counting every manuscript chapter, so none is skipped.
- `productions/world-guide.ts` writes the Guide record (`set-guide-entry`, `set-guide-teasers`; a
  first teaser raises the world to schema 108), drafts the guide with world paths, and packs it:
  pictures fitted to 1024 px, teaser pictures to 1280, voice lines and clips cut as M4A.
  `arke-player-guide-export.ts` makes the guide alone.
- `scripts/export-arke-player.mts` runs the same export headless for publishing (`--guide-alone`,
  `--part`); CLAUDE.md's "Publishing a world to Arke Player" is the procedure.

Client `components/arke-player-export.tsx` is the Export sheet's Arke Player kind with Release, and
`screens/world-guide.tsx` with `world-guide-teasers.tsx` is the Guide page. Tests: contracts
`world-package.test.ts` and `arke-player-release.test.ts`; coordinator
`productions/arke-player-export.test.ts`, `arke-player-guide-export.test.ts` and `world-guide.test.ts`;
client `arke-player-export.test.tsx` and `world-guide.test.tsx`.
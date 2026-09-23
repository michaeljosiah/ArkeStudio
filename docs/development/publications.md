# Publication contracts and file services

The implemented foundation of SPEC-048 supplies the shared contract for a portable video
publication, declared-source capture and directory integrity verification. It does not yet
compile a production, build packages, open them in a player, or add an export command.
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
records and media. The future profile compiler must supply a complete dependency set, derived from
the same records as its resolved plan and settings. This service does not discover dependencies,
resolve a RenderPlan or validate the plan/settings hashes on its behalf.

Under `WorldStore.ownedWrite`, capture checks the declared record hashes, copies and hashes media
into a unique child of an existing host-owned scratch directory, then rechecks every source record
and media file. It rechecks disk ownership before returning the receipt, fingerprint, copied media
paths and an idempotent `dispose()` function. No returned host path belongs in a public manifest.
App writes wait for capture; subsequent source edits do not change the copies. External file edits
are detected by hashes and file identity/stat checks. As with world ownership, these checks are
not an atomic filesystem fence against a process actively swapping ancestors.

Caller cancellation and world close abort in-flight capture. Failure removes only its unique
scratch child; successful callers must dispose it after consuming the copies. Files are synced
before return, but this is temporary input storage, not a durable completion receipt or recovery
protocol. The optional `onCopied` progress callback runs inside the world gate: it must not await
another operation needing that gate, including `store.close()`.

`verifyPublicationDirectory(directory, options?)` in `src/publications/verify.ts` runs without a
world. It reads bounded UTF-8 JSON, negotiates compatibility, checks the directory's exact file
inventory and streams every asset through SHA-256 and length validation. Links/junctions,
non-portable names, case aliases and unlisted files are refused. Directory enumeration is streamed
and bounded by count and depth. Defaults cap the manifest at 1 MiB, each asset at 32 GiB, total
package bytes at 64 GiB and directory entries at four times the contract's asset-count limit.
Hosts can provide lower limits; actual reads/copies are also bounded by declared media lengths.

The verifier returns the parsed manifest, manifest digest, measured total bytes and canonical
directory path. `PublicationFileError.code` distinguishes compatibility, path, limit and integrity
refusals; ordinary filesystem errors retain their system codes. Verification grants point-in-time
integrity, not lasting trust in an externally editable folder. The future player must pin or
reverify inputs and validate codecs and captions before presenting them.

Run the focused tests from `packages/contracts`:

```powershell
node --import tsx --test test/publication.test.ts
```

Run the coordinator service regressions from `packages/coordinator`:

```powershell
node --import tsx --test test/publications/*.test.ts test/world/ownership.test.ts test/world/store.test.ts
```

Typecheck consumers after changes. Next work binds capture to the production's shared RenderPlan,
adds package writing/promotion and recovery, then wires an independent player and export action.

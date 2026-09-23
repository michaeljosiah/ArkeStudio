# Publication contracts

The first implementation slice of SPEC-048 supplies the shared contract for a portable video
publication. It does not yet build packages, open them in a player, or add an export command.
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

Successful parsing is **not package verification**. The future package reader must additionally
bound input/extraction sizes, reject duplicate ZIP entries and escaping symlinks, verify every
file's measured length and digest, check WebVTT timing and preflight codecs before presentation.
The schema cannot establish those facts from a JSON description alone.

## Dependency boundary

`PublicationCaptureSchema` describes a receipt from a future coherent capture operation. It holds
hashed source records and measured media, a resolved-plan hash, settings hash, compiler identity
and optional timeline revision. Record/media keys must be unique within their inventories.
The receipt remains internal; only its fingerprint is public build provenance.

`publicationCaptureText` produces canonical receipt JSON by using explicit field order and sorting
the record/media inventories by key. `fingerprintPublicationCapture` hashes those UTF-8 bytes with
Web Crypto SHA-256, usable from Node and the renderer. Callers must supply canonical full-plan and
settings hashes; this helper does not canonicalize arbitrary JSON or read the world.

Changing a selection, source bytes, resolved trim/order, settings or compiler identity must change
the receipt even when the timeline revision stays the same. The tests exercise this distinction.
The future coordinator capture service still has to freeze all dependencies under the world's
coordination boundary, revalidate the receipt, and pin source bytes before rendering. Possessing a
valid receipt does not prove that this operation took place.

Run the focused tests from `packages/contracts`:

```powershell
node --import tsx --test test/publication.test.ts
```

Typecheck consumers when changing this exported contract. The next slice should implement capture
and package verification before wiring an independent player or presenting a new export action.

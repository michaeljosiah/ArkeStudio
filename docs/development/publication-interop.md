# Book and audiobook interoperability spike

The developer fixture in `scripts/publication-interop/` exercises SPEC-048 §2.3 for
[issue #1228](https://github.com/michaeljosiah/ArkeStudio/issues/1228). It generates one
illustrated page, two captured text anchors with adjacent audio ranges, and a two-chapter
audiobook. The audio consists of synthetic tones; this checks synchronization plumbing,
not speech alignment or narration quality. No world, provider or production export path is used.
Books and audiobooks remain unsupported by the application's publication reader.

## Mapping exercised

The fixture uses EPUB for the book package, Readium Web Publication Manifest (RWPM) for the
reader-facing projection and audiobook package, and an explicit separate mapping for W3C
Audiobooks. Passing a W3C manifest directly to this Readium SDK's RWPM parser returns no
manifest. That is a parser boundary, not evidence that every Readium-based reader rejects W3C
books; Readium documents a [W3C audiobook import mapping](https://github.com/readium/architecture/blob/master/other/W3C/audiobooks.md).

| Content | Generated representation | Preserved by the exercised consumer |
|---|---|---|
| Illustrated book | EPUB 3: OPF reading order, XHTML, SVG, navigation and SMIL media overlay | EPUBCheck validates the package. The separate RWPM projection renders the illustration, alternative text and captured paragraphs in Readium EpubNavigator. |
| Two narration anchors | Integer ticks at timescale 1000 become SMIL seconds and Guided Navigation audio fragments `0,2` and `2,4` | Readium discovers and round-trips both anchors. An experimental host highlights each paragraph from AudioNavigator's actual playback clock. |
| Two audio chapters | RWPM ordered MP3 links with measured numeric durations; `manifest.json` in `.audiobook` | AudioNavigator preserves chapter titles/order, advances automatically and seeks within a chapter. |
| W3C audiobook | JSON-LD publication manifest with `url`, `encodingFormat`, ISO durations and contents document; `publication.json` in `.lpf` | Fixture checks prove matching identity/order/duration and complete packaged resources. No W3C reader playback or full conformance claim is made. |

These mappings follow [EPUB](https://www.w3.org/TR/epub-33/),
[RWPM](https://readium.org/webpub-manifest/), its
[audiobook profile](https://readium.org/webpub-manifest/profiles/audiobook.html),
[Guided Navigation](https://readium.org/guided-navigation/),
[W3C Audiobooks](https://www.w3.org/TR/audiobooks/) and
[Lightweight Packaging Format](https://www.w3.org/TR/lpf/).
The experiment supports keeping these explicit adapters: RWPM and W3C manifests are not
interchangeable JSON shapes. It does not establish a new supported application profile.

## Recorded evidence, 2026-09-24

The named external consumer is the [Readium TypeScript toolkit](https://github.com/readium/ts-toolkit):
`@readium/navigator` 2.10.3 and `@readium/shared` 2.5.1, running in a sandboxed Electron 43.2.0
renderer on Windows. It consumes unpacked RWPM resources served on loopback; it does not
exercise EPUB or audiobook ZIP import. The reader's external network requests are blocked.

- Three fixture/model tests pass. Both RWPM manifests pass pinned upstream JSON schemas;
  an invalid manifest is rejected as a negative control.
- EPUBCheck 5.4.0 reports zero fatal errors, errors, warnings or informational messages for
  `narrated.epub`. This is structural validation, not a visual EPUB consumer test.
- The reader renders the complete 640 × 640 page and alternative text, visits both text
  anchors during playback, advances to chapter two and seeks to 2.5 seconds in chapter one.
  The screenshot was inspected. Highlighting is a small host binding, not a claimed native
  Readium read-along feature. It uses the exact captured ranges, without inferred word timing.
- Both audio archives pass CRC checks and contain byte-identical copies of every declared
  reading-order/resource item. This is package-closure evidence, not a general LPF validator.
- Guided Navigation schema validation is **incomplete**: the pinned official document schema
  references a missing `object.schema.json`. The validator records that exact upstream 404;
  other download/schema errors fail the command. Successful SDK round-trip/playback does not
  substitute for the missing schema validation.

The [evidence receipt](../../scripts/publication-interop/evidence.json) records package hashes,
tool versions, consumer results and schema source hashes. Generated assets and screenshots stay
under `.dev/`; dependencies are locked in the spike's separate private npm package and are not
application dependencies. FFmpeg 8.1.1 generated the measured MP3 fixtures. Different encoders
may produce different bytes/durations; the receipt describes the recorded run.

## Reproduce

From the repository root, with Node 22.12+, FFmpeg/FFprobe on PATH and a desktop display session:

```powershell
npm ci
npm ci --prefix scripts/publication-interop
npm test --prefix scripts/publication-interop
$fixtureDir = node scripts/publication-interop/generate.mjs
node scripts/publication-interop/validate.mjs $fixtureDir
node scripts/publication-interop/smoke.mjs $fixtureDir
```

`ARKE_TEST_FFMPEG` and `ARKE_TEST_FFPROBE` can supply explicit executable paths.
Validation fetches schemas from pinned official GitHub commits and writes `schema-results.json`.
The smoke writes `reader-results.json` and `reader.png`; only the playback stage blocks external
network access. Linux hosts need a display server (for example an existing Xvfb session).

Install Java and [EPUBCheck 5.4.0](https://github.com/w3c/epubcheck/releases/tag/v5.4.0), then run:

```powershell
java -jar /path/to/epubcheck.jar "$fixtureDir/narrated.epub" -j "$fixtureDir/epubcheck.json"
```

For script edits, also run oxlint with the five explicit `.mjs` paths in this directory;
root `npm run lint` does not cover maintenance scripts. Root CI does not run this opt-in spike.

## What this leaves open

Production capture from manuscript order and selected kept takes, rights checks, accessibility
acceptance, package import, full W3C processing and the app's book/audio profiles remain work
under #1228. The fixtures do not implement those services. The result provides evidence for
the format choice before that work, while ordinary EPUB exports retain their existing scope.

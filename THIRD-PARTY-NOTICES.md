# Third-party notices

Arke Studio is MIT-licensed. The packaged application bundles the following third-party
components. Each entry records the licence verification SPEC-016 R-9 requires **before**
bundling; `scripts/verify-licenses.mjs` gates packaging on this file staying complete.

| Component | Licence | Obligations, as shipped |
|---|---|---|
| OpenCode (harness binary) | MIT | Attribution: licence text shipped here. Redistribution in a signed installer permitted. Invoked as a separate supervised process. |
| OpenCode 2 (harness binary, beta) | MIT | Attribution: licence text ships beside the binary as `resources/opencode2/LICENSE.opencode2.txt`, pinned to the upstream commit it was fetched from. Redistribution in a signed installer permitted (anomalyco/opencode). Invoked as a separate supervised process, never linked; exact build pinned in `apps/desktop/runtime-sources.json`. |
| Voxa (voice sidecar) | MIT | First-party sibling project; self-contained separate process. Voxa, .NET, ONNX Runtime, Whisper.net, NAudio, and all managed dependency licence/notice material ship inside `resources/voxa/THIRD-PARTY-NOTICES`. |
| Microsoft Visual C++ runtime | Microsoft redistributable licence | Matching-architecture runtime DLLs bundled with Voxa so native ONNX/Whisper libraries do not depend on machine-global installation. |
| espeak-ng (phonemizer) | GPL-3.0 | **Never linked** — invoked strictly as a separate executable (R-10), the same arrangement Voxa makes. Exact GPL text and the complete pinned 1.52.0 source archive ship beside the executable. |
| pcaudiolib (ARM64 espeak dependency) | GPL-3.0 | **Never linked to Arke** — loaded only by the separate ARM64 espeak-ng process. Exact GPL text and source package ship beside it. |
| LLVM libc++ (ARM64 espeak dependency) | Apache-2.0 WITH LLVM-exception | Loaded only by the separate ARM64 espeak-ng process. Licence text retained beside the runtime. |
| ffmpeg | GPL-2.0-or-later (GPL build, includes libx264) | **Never linked to Arke** — invoked as a separate subprocess, the same arrangement espeak-ng makes. The GPL build is chosen deliberately: libx264 is GPL-only, and the export presets are expressed as x264 `-crf` values that an LGPL build accepts and silently ignores, encoding every preset identically. Exact GPL text and FFmpeg's own source archive (commit `9b6c8969e0`) ship beside the binaries. The build also compiles **libx264** into avcodec, whose corresponding source the FFmpeg archive does not contain, so a **GPLv2 §3(b) written offer** valid three years ships alongside as `WRITTEN-OFFER.ffmpeg.txt` and covers every remaining GPL component, build script and patch. Requests: https://github.com/michaeljosiah/ArkeStudio/issues |
| better-sqlite3 (native index binding) | MIT | Attribution here. Compiled per target architecture. |
| SQLite | Public domain | None. |
| Electron | MIT | Attribution here; Chromium/Node notices ship inside Electron's own LICENSES file, included in the installer. |
| Geist / Geist Mono fonts | OFL-1.1 | Font files unmodified; OFL text retained. Not sold separately. |
| Kokoro TTS models | Apache-2.0 | **Not installer contents** (R-8) — downloaded on first use; notice recorded here for the downloaded artefact. |
| whisper.cpp models | MIT | **Not installer contents** — downloaded on first use. |

One component is **source we carry rather than a package we depend on**. Two renderer files are
derived from **LTX-Desktop** (https://github.com/Lightricks/LTX-Desktop, commit `7ec86f3`),
Copyright (c) Lightricks Ltd., **Apache-2.0**:

| Our file | Derived from | What was taken |
|---|---|---|
| `packages/client/src/lib/timeline-drag.ts` | `frontend/views/editor/video-editor-utils.ts`, `frontend/views/editor/useTimelineDrag.ts` | Timecode format/parse and the cut-point tolerance; the trim gesture — pointer capture, pixels-to-seconds, the snap threshold, and commit-once-on-release. |
| `packages/client/src/lib/playback-engine.ts` | `frontend/views/editor/usePlaybackEngine.ts`, `frontend/views/editor/usePlaybackAudioSync.ts` | The rAF transport, its 250ms state throttle and the layout-effect flush on stop; the media-element rules — activation seek tolerance, drift correction, throttled `play()` retry, the `readyState` gate and the intended-source guard. |

Apache-2.0 §4(a) is satisfied by `licenses/LICENSE.LTX-Desktop.txt`; §4(b) by the change list each
file carries in its own header, which records every departure from upstream. Upstream ships no
`NOTICE` file, so §4(d) does not arise. No LTX model weights, no LTX inference code and no part of
the LTX Desktop application are bundled; this is a source-level port of editor mechanics only.

Renderer/runtime npm dependencies (React, zod, ws, yaml, Tiptap/ProseMirror, and transitive) are
MIT/ISC/BSD; their licence texts are included in the application bundle by the build.

One renderer dependency is **Apache-2.0** rather than MIT and so carries its own obligations:
`@sanity/diff-match-patch`, the fuzzy patcher behind the bible editor's source-preserving save. It
is a pure-JavaScript library bundled into the renderer, not a separate process. Apache-2.0 §4
requires the licence text and any NOTICE to travel with it, both of which the build includes from
the package; the code is unmodified, so §4(b)'s change notices do not arise.

A component appearing in the installer without a row in this table fails
`npm run verify:licenses`, which runs before every `package` (D5: a licence question found here
is a task; found at packaging it is a shipping delay).

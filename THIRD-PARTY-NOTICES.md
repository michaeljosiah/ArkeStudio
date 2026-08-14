# Third-party notices

Arke Studio is MIT-licensed. The packaged application bundles the following third-party
components. Each entry records the licence verification SPEC-016 R-9 requires **before**
bundling; `scripts/verify-licenses.mjs` gates packaging on this file staying complete.

| Component | Licence | Obligations, as shipped |
|---|---|---|
| OpenCode (harness binary) | MIT | Attribution: licence text shipped here. Redistribution in a signed installer permitted. Invoked as a separate supervised process. |
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

Renderer/runtime npm dependencies (React, zod, ws, yaml, and transitive) are MIT/ISC/BSD;
their licence texts are included in the application bundle by the build.

A component appearing in the installer without a row in this table fails
`npm run verify:licenses`, which runs before every `package` (D5: a licence question found here
is a task; found at packaging it is a shipping delay).

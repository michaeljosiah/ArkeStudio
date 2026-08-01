# Third-party notices

Arke Studio is MIT-licensed. The packaged application bundles the following third-party
components. Each entry records the licence verification SPEC-016 R-9 requires **before**
bundling; `scripts/verify-licenses.mjs` gates packaging on this file staying complete.

| Component | Licence | Obligations, as shipped |
|---|---|---|
| OpenCode (harness binary) | MIT | Attribution: licence text shipped here. Redistribution in a signed installer permitted. Invoked as a separate supervised process. |
| Voxa (voice sidecar) | MIT | First-party sibling project; attribution here. Self-contained binary, separate process. |
| espeak-ng (phonemizer) | GPL-3.0 | **Never linked** — invoked strictly as a separate executable (R-10), the same arrangement Voxa makes. Source offer: https://github.com/espeak-ng/espeak-ng. Binary redistributed unmodified. |
| ffmpeg | LGPL-2.1 (LGPL build, no GPL components) | The LGPL build is chosen **deliberately** — no libx264/GPL flags. Invoked as a separate subprocess, never linked. Source offer: https://ffmpeg.org. |
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

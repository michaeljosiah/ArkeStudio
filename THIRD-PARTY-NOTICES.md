# Third-party notices

Arke Studio is licensed AGPL-3.0-only. The packaged application bundles the following third-party
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
| ffmpeg | GPL-3.0-or-later (GPL build, includes libx264) | **Never linked to Arke** — invoked as a separate subprocess, the same arrangement espeak-ng makes. The GPL build is chosen deliberately: libx264 is GPL-only, and the export presets are expressed as x264 `-crf` values that an LGPL build accepts and silently ignores, encoding every preset identically. Version **3**, not 2: the build carries `--enable-version3` alongside `--enable-gpl`, which FFmpeg's own `LICENSE.md` requires for the LGPLv3 (`gmp`, `libaribb24`) and Apache-2.0 (`libvmaf`) libraries it links, and the archive ships `COPYING.GPLv3` to match. Exact GPL text and FFmpeg's own source archive (commit `9b6c8969e0`) ship beside the binaries. The build also compiles **libx264** into avcodec, whose corresponding source the FFmpeg archive does not contain; Arke conveys the installer from a network server, so that source is covered by **GPLv3 §6(d) directions** rather than a §6(b) offer (6(a) and 6(b) are for object code in a physical product). `WRITTEN-OFFER.ffmpeg.txt` ships alongside and points at the tagged BtbN build tree, where every component's upstream repository and exact revision is pinned, and adds a standing three-year offer against that tree going away. Requests: https://github.com/michaeljosiah/ArkeStudio/issues |
| better-sqlite3 (native index binding) | MIT | Attribution here. Compiled per target architecture. |
| SQLite | Public domain | None. |
| Electron | MIT | Attribution here; Chromium/Node notices ship inside Electron's own LICENSES file, included in the installer. |
| Geist / Geist Mono fonts | OFL-1.1 | Font files unmodified; OFL text retained at `licenses/LICENSE.Geist.txt`. The desktop redistributes Geist Regular v1.7.2 as `resources/fonts/Geist-Regular.ttf` so ffmpeg slates never depend on host font discovery. Not sold separately. |
| Kokoro TTS models | Apache-2.0 | **Not installer contents** (R-8) — downloaded on first use; notice recorded here for the downloaded artefact. |
| whisper.cpp models | MIT | **Not installer contents** — downloaded on first use. |

The offline Krea 2 node installer carries unmodified source from
[ComfyUI-ConditioningKrea2Rebalance](https://github.com/nova452/ComfyUI-ConditioningKrea2Rebalance)
by nova452, commit `a0cd00681448ab63232463c83f12e0364456da59`, under Apache-2.0.
The three Python modules, full licence and file hashes are retained in
`vendor/comfyui/ComfyUI-ConditioningKrea2Rebalance/`. No upstream NOTICE file is present at
that revision. These files are installed explicitly into the user's ComfyUI; model weights
are downloaded separately from Comfy-Org under the Krea 2 Community License.

Another component is **source we carry rather than a package we depend on**. Two renderer files are
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

## Blockout: Stage camera conventions

The Stage's rig profiles, Super 35 lens gate and crop-to-aspect FOV, velocity-profile easing, and centripetal spline convention with 32 samples per leg were adopted from [Blockout](https://github.com/wassermanproductions/blockout) by **Sam Wasserman (wassermanproductions.com)**, licensed under Apache-2.0.

Upstream references verified at commit [`3f2d056`](https://github.com/wassermanproductions/blockout/tree/3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9):

| Arke source | Blockout source | Adopted material |
|---|---|---|
| `packages/contracts/src/staging.ts` | [`src/engine/rigs.ts`](https://github.com/wassermanproductions/blockout/blob/3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9/src/engine/rigs.ts) | All seven rig profiles: position/rotation amplitude, frequency and octave count. |
| `packages/contracts/src/staging.ts` | [`src/engine/camera.ts`](https://github.com/wassermanproductions/blockout/blob/3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9/src/engine/camera.ts) | The 24.89 × 18.66 mm Super 35 gate and crop-to-aspect vertical FOV convention. |
| `packages/contracts/src/staging.ts`, `packages/contracts/src/stage-camera.ts` | [`src/engine/easing.ts`](https://github.com/wassermanproductions/blockout/blob/3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9/src/engine/easing.ts), [`src/engine/path.ts`](https://github.com/wassermanproductions/blockout/blob/3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9/src/engine/path.ts) | Velocity-profile easing and centripetal, arc-length-mapped splines with 32 samples per leg. |

Arke adapts these conventions to its own shot keys and shared evaluator. Rig fields are renamed,
ease overlap is normalized to 1 rather than 0.98, and spline evaluation uses three.js instead
of Blockout's own Catmull–Rom implementation.

The upstream NOTICE and licence are reproduced below so the existing desktop resource
`resources/THIRD-PARTY-NOTICES.md` carries both with the attribution.

### Blockout NOTICE

```text
Blockout — a previs tool for AI-native filmmaking
Copyright 2026 Sam Wasserman
https://wassermanproductions.com · https://wasserman.ai

This product was created by Sam Wasserman. If you use, fork, or
redistribute this software or derivative works, you must retain this
NOTICE file and credit "Sam Wasserman (wassermanproductions.com)" in
your documentation and any about/credits surface, per Section 4(d) of
the Apache License 2.0.
```

### Blockout Apache-2.0 licence

```text

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2026 Sam Wasserman (wassermanproductions.com)

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

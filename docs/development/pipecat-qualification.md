# Pipecat replacement qualification (#2870 / #2879)

The managed target is Windows x64 CPU. Dictation remains an editable, unsent draft.
Live World Chat is a separately opened sending mode: recognized text and requested
world-source lookups use the selected OpenCode model; audio and Kokoro remain local.
A review build is not a public release. The candidate uses Pipecat on first launch on Windows x64; merging that rollout remains gated on the
installed-app and human checks below.

## Evidence and remaining acceptance

| Capability or failure path | Evidence | Status |
|---|---|---|
| Authenticated batch recognition and Kokoro | Private portable Python, real local models, bounded HTTP protocol tests | Passed |
| Acoustic word timing | Standalone original whisper.cpp DTW algorithm, seven measured words, validation and provenance checks | Passed on Windows x64 |
| Editable dictation and shared local read-aloud | Client draft regressions; installed host synthesis-to-dictation roundtrip on fresh and existing profiles, using the same VoiceService and Kokoro IDs | Packaged software checks passed; physical capture pending |
| Live conversation and authoritative history | Real private Python VAD/STT/TTS and real OpenCode adapter; exact streamed words retained, including interruptions | Passed |
| Foreground exchange during a background tool wait | Actual source MCP read held while a second spoken exchange completed; barge-in preserved the worker | Passed |
| Grounded completion and safe idle speech | One written outcome with actual source receipts/IDs, one durable spoken attempt, full playback back to listening | Passed |
| Targeted cancellation, failure and restart unknown | Real-journal regressions, cancellation-flush race, sibling isolation, late ownership refusal, no unknown replay | Passed |
| Conversation deletion while work runs | Host and client use the same named deletion guard until terminal outcome | Passed |
| Native tool confinement | Pinned OpenCode 2.2.5 exposes only captured MCP tools; filesystem and recursive-agent attempts denied; text before/after MCP call checked | Passed |
| Denied/regranted mic, worklet, End voice, device loss, focus loss, disconnect, late permission | Sandboxed Electron file-page smoke with a synthetic Chromium device | Passed |
| Fresh packaged install, existing-user upgrade, offline reuse and missing/corrupt models | Isolated NSIS review install; every managed runtime file hash checked; private Python with developer paths removed; existing settings bytes preserved; Kokoro stays ready when recognition is missing or corrupt | Software checks passed; final smoke-driver repack pending |
| Packaged shutdown/restart/reconnect/world switch | Actual retained process-handle exits; two owned worlds survive renderer reload and abrupt parent restart; graceful final shutdown | Passed on Windows x64 |
| Physical microphone, headset/speaker echo, changed device and natural pauses | Human test of the review build on the supported hardware | Pending |
| Final full repository gates and package/license audit | Windows typecheck/lint/build and workspace coverage pass after focused retakes; runtime/license audit and installed runtime hashes pass | Final smoke-driver installer verification pending |
| Default rollout and legacy dependency retirement | Only after qualification; explicit Voxa rollback during rollout | Pending |

No synthetic microphone test establishes physical capture, audible speaker latency,
echo cancellation or natural human turn-taking. The earlier audition preference
also does not establish those properties for the packaged integration.

## Recorded software boundaries

Real Copilot Haiku 4.5 ordinary conversation produced first text 3277/2699 ms and
first audio packets 7595/7712 ms after recognized text reached the host. The final
background proof produced 5759/2236 ms to first text and 9200/5116 ms to first audio;
the first turn includes tool admission and the second playback was deliberately
interrupted. These are functional measurements from this machine, excluding
capture/VAD/STT and hardware playback, not a latency guarantee or a hardware
comparison. Generated audio stayed in memory.

The final background run retained two foreground exchanges, one source-grounded
written outcome and one idle speech attempt. The standalone private-Python smoke
also completed ordinary and idle-result playback (163200/220800 PCM bytes).

## Packaged smoke without a developer environment

The installer must carry `resources/speech/python/python.exe`, the application
scripts, the small offline VAD/turn detector models, acoustic alignment helper,
replaceable native libraries and complete notices/sources. User Kokoro, converted
Whisper and GGML timing models remain separately verified downloads.

From the review install, run the private Python with `-E -s -B` and
`resources/speech/app/smoke.py`, passing explicit `--kokoro`, `--whisper`, `--espeak`,
`--decoder`, `--alignment` and `--alignment-model` paths. Run `smoke_live.py` with
those first four paths for local VAD/recognition, ordinary reply and complete idle
notification playback. Neither smoke requires system Python, a development checkout,
cloud credentials, a microphone or saved recordings. Human device checks follow.

`smoke_desktop.py` additionally launches the actual packaged executable. Supply
`--app`, a new `--root`, and explicit `--kokoro`, `--whisper`, `--alignment-model`
paths. Its default `--mode ready` checks the fresh Pipecat choice, both authenticated
provider rows, host synthesis-to-dictation roundtrip and actual child exits.
`--mode upgrade` seeds an existing settings file, checks the legacy backend and the
same roundtrip, then verifies its original bytes survived. `missing-whisper` and
`corrupt-whisper` alter only owned model copies and require independent Kokoro
readiness plus a named recognition remedy. The test-only debugging endpoint binds
loopback; the human review launcher does not enable it. No personal world is opened.

Use a fresh builder output directory for `--prepackaged` review installers. During
qualification, an existing NSIS archive was reused after a loose-resource edit.
Always compare the extracted runtime files with the candidate manifests.

The driver retains Windows process handles before shutdown. All retained handles
must signal exit; a recovery-ledger row may remain when a system identity probe
could not confirm cleanup. A PID checked after shutdown alone cannot distinguish
the original process from a recycled PID. The driver also covers recorded Windows
console hosts and decoder descendants.

Exact installed-file verification found four absent ARM-only pip/setuptools
bootstrap launchers. The x64 assembler now omits those unsupported files before
creating the manifest, while retaining x64 tooling and all original notices.
The package verifier rejects those foreign launchers rather than accepting an
installer whose extracted files disagree with its manifest.

Concurrent full repository tests exposed a cold decoder request reaching its
30-second bound. The candidate warms FFmpeg alongside model loading before
recognition readiness and allows two minutes for bounded runtime startup.
An installed run under that load still reached the startup bound: Pipecat's import
log appeared 103 seconds after process spawn. With the broad suite stopped, the
same installed runtime logged its import after 16 seconds and completed both
authenticated provider readiness and the host speech/dictation roundtrip.
The failed run remains recorded; the startup bound was not widened for the retake.
These observations concern startup, not conversational response latency.

The existing-profile retake kept the original settings bytes and legacy backend,
completed the same roundtrip and exited all retained child handles. Missing and
corrupt converted recognition copies each left Kokoro available with a named
recognition remedy. The recovery retake switched between two newly created worlds,
reloaded the renderer, killed only its owned parent, restarted into the same worlds
and confirmed the original speech/harness children had exited. These checks use
the isolated review identity and workspace, not the author's normal installation.

The exact installed private Python also passed offline Kokoro-to-Whisper recognition,
seven original DTW word boundaries, live VAD/recognition/reply speech and complete
idle-result playback. They require no system Python or cloud credentials and save
no audio. The final installer must include the reviewed smoke-driver retry and pass
its own installed-file verification before final package acceptance.

The full coordinator run covered 6,229 tests. Its 26 failed or cancelled cases were
isolated: 16 passed unchanged, two stale fixture expectations were corrected, and
eight native integration cases needed time for their real Windows inspections and
confirmed cleanup. Those cases now pass with their ownership, blocked-write and
protocol-refusal assertions intact. Production inspection and speech timeouts are
unchanged. The engine's external packed-consumer check also passed through its
required `npm test` entry point.

## Rollout and recovery

Fresh candidate profiles select Pipecat on Windows x64. Existing profiles preserve their previous backend byte for byte, including absent legacy backend fields; choose Pipecat explicitly in Settings → Providers → Local speech after its models are ready.
Existing explicit Voxa paths/arguments remain a legacy selection and are never
reinterpreted as Python launch arguments. Missing converted Whisper is a named
setup problem; the GGML model remains necessary for measured timing. End voice
releases capture/playback; a background lookup keeps its own named Cancel control.
Restarted uncertain work is shown as unknown and is not sent again automatically.

Native Windows ARM64 and x64 emulation on ARM are unqualified and must not be
advertised as qualified Pipecat targets. Preserve the legacy option until the
rollout can retire it without removing a supported configuration. Do not remove
historical word-timing provenance or world readers while retiring delivery code.

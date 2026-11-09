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
| Editable dictation and shared local read-aloud | Client/host settings and draft regressions; same VoiceService seam and Kokoro IDs | Functional tests passed; packaged check pending |
| Live conversation and authoritative history | Real private Python VAD/STT/TTS and real OpenCode adapter; exact streamed words retained, including interruptions | Passed |
| Foreground exchange during a background tool wait | Actual source MCP read held while a second spoken exchange completed; barge-in preserved the worker | Passed |
| Grounded completion and safe idle speech | One written outcome with actual source receipts/IDs, one durable spoken attempt, full playback back to listening | Passed |
| Targeted cancellation, failure and restart unknown | Real-journal regressions, cancellation-flush race, sibling isolation, late ownership refusal, no unknown replay | Passed |
| Conversation deletion while work runs | Host and client use the same named deletion guard until terminal outcome | Passed |
| Native tool confinement | Pinned OpenCode 2.2.5 exposes only captured MCP tools; filesystem and recursive-agent attempts denied; text before/after MCP call checked | Passed |
| Denied/regranted mic, worklet, End voice, device loss, focus loss, disconnect, late permission | Sandboxed Electron file-page smoke with a synthetic Chromium device | Passed |
| Fresh packaged install, existing-user upgrade, offline reuse and missing/corrupt models | Exact private resources and isolated app profiles | Pending |
| Packaged shutdown/restart/reconnect/world switch | Owned process ledger and captured-world/requester fences | Pending |
| Physical microphone, headset/speaker echo, changed device and natural pauses | Human test of the review build on the supported hardware | Pending |
| Final full repository gates and package/license audit | Exact final tree and packaged resources | Pending |
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

The driver retains Windows process handles before shutdown. All retained handles
must signal exit; a recovery-ledger row may remain when a system identity probe
could not confirm cleanup. A PID checked after shutdown alone cannot distinguish
the original process from a recycled PID. The driver also covers recorded Windows
console hosts and decoder descendants.

Concurrent full repository tests caused a cold pipeline import to exceed one
minute and a cold decoder request to hit its 30-second bound. Serial native
retakes completed the packaged host roundtrip. The candidate now warms FFmpeg
alongside model loading before recognition readiness and allows two minutes for
bounded runtime startup. These startup observations do not measure conversational
response latency. Exact final-artifact retakes remain part of acceptance above.

## Rollout and recovery

Fresh candidate profiles select Pipecat on Windows x64. Existing profiles preserve their previous backend byte for byte, including absent legacy backend fields; choose Pipecat explicitly in Settings → Engines → Local speech after its models are ready.
Existing explicit Voxa paths/arguments remain a legacy selection and are never
reinterpreted as Python launch arguments. Missing converted Whisper is a named
setup problem; the GGML model remains necessary for measured timing. End voice
releases capture/playback; a background lookup keeps its own named Cancel control.
Restarted uncertain work is shown as unknown and is not sent again automatically.

Native Windows ARM64 and x64 emulation on ARM are unqualified and must not be
advertised as qualified Pipecat targets. Preserve the legacy option until the
rollout can retire it without removing a supported configuration. Do not remove
historical word-timing provenance or world readers while retiring delivery code.

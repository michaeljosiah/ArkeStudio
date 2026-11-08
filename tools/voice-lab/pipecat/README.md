# Pipecat voice audition

A standalone Windows test page for the Pipecat-first half of a Voxa comparison.
It changes no Studio route, runtime selection, world, acceptance gate, or provider integration.

The path is browser microphone → local Whisper base.en → an OpenCode 2.2.5 cloud
agent → local Kokoro 82M → browser playback, over local SmallWebRTC. OpenCode owns
agent inference and its tool calls; Pipecat owns the audio pipeline and interruption.
This does **not** exercise Pipecat's `LLMWithBackend` abstraction or its native LLM
provider adapters. That distinction matters when comparing results.

This is an audition against SPEC-011 R-5/R-17 and SPEC-018's draft conversational
requirements, not implementation or acceptance of that draft. The test uses
VAD/Smart Turn-ended turns, automatically submits recognized text, and keeps a visible
transcript; it does not implement editable partial transcripts or spoken repair.

## Start

Prerequisites: Windows, Node 22.12+, Python with `python -m uv`, and Arke's installed
OpenCode 2.2.5, espeak-ng, Kokoro model, and voice assets. OpenCode must already have
a connected cloud account. The launcher creates its own Python environment and
downloads local Whisper base.en weights on first use. It does not require a GPU.

```powershell
pwsh -File ./start.ps1 -State D:/ArkeVoiceLab
```

Open **http://127.0.0.1:9075**. Use that exact address, not `localhost`, because the
host/origin check is intentionally narrow. Stop the launcher with Ctrl+C.

For a hidden background server that stays available after the launching command
ends, add `-Background`. Stop that instance with `pwsh -File ./stop.ps1`; the
authenticated shutdown route drains the owned agent sessions and speech work.
Its startup logs are `server-out.log` and `server-error.log` in the state folder.

The default cloud model is `github-copilot/claude-haiku-4.5`; select another model
on the page, or pass `-Model provider/model`. The catalogue is OpenCode's native
catalogue; listing a model does not prove that the connected account can use it.

For nonstandard asset locations run `app.py --help`, then launch directly:

```powershell
D:/ArkeVoiceLab/pipecat-venv/Scripts/python.exe app.py --state D:/ArkeVoiceLab --kokoro C:/path/to/kokoro-82m --espeak C:/path/to/espeak-ng.exe --opencode C:/path/to/opencode.exe
```

Kokoro requires `model_quantized.onnx` and `voices/*.bin`. espeak expects its data
under `share/espeak-ng-data` beside the executable. Existing Studio assets are read
only. ONNX graph optimization is disabled: the q8f16/default-optimization probe
stalled during session construction on the evaluated machine. The working path
is the quantized model on CPU; it is not a benchmark of stock `KokoroTTSService`.

## Try it

1. Preview the selected voice, start the conversation, and allow microphone access.
2. Say hello. Ask a short follow-up. Pause mid-thought and assess whether the
   650 ms VAD pause threshold plus Smart Turn ends a thought too early.
3. Ask for a longer answer and speak over it. Check whether playback stops and the
   next answer addresses your interruption.
4. Press **Try a reference lookup** or ask for work in the background. A genuine
   OpenCode MCP tool starts a second OpenCode cloud session and returns immediately.
   That worker calls `search_reference_library` to read the fictional notes under
   `reference-library/`, then answers from the returned source text. Try asking
   for Skyharbour's storm mooring code and the red-storm arrival procedure.
   Keep talking while the search is in progress, then listen for its result.
   The configurable minimum hold is inside the actual search tool call; it is
   artificial and explicitly displayed, not measured inference latency.
5. End the conversation. Reconnect and verify a fresh session. Export the test log
   if you want a record for the Voxa comparison.

Headphones are the initial reference condition. Speaker echo, device changes,
human interruption quality, and visual/browser interaction still need manual
qualification. Browser control was disabled in the development session.

The first-token measurement starts at OpenCode dispatch. The reply-start
measurement starts at Pipecat's VAD stop event and ends when output transport
reports speaking. It includes remaining STT/agent/TTS work, excludes the preceding
650 ms silence threshold, and is **not** a hardware measurement of sound leaving
the speaker. Cold and warm samples should be compared separately.

## Automated checks

```powershell
D:/ArkeVoiceLab/pipecat-venv/Scripts/python.exe -m pytest -q test_lab.py
npm ci --prefix web
npm run build --prefix web
```

The live smoke test uses an aiortc peer as a synthetic microphone and captures
received PCM without using the user's microphone or speakers. It makes real cloud
requests through the selected OpenCode account. Start the server first:

```powershell
D:/ArkeVoiceLab/pipecat-venv/Scripts/python.exe smoke.py --background --microphone D:/path/to/mono-pcm16-test.wav --output D:/ArkeVoiceLab/evidence
```

Without `--microphone` it tests typed input into the same pipeline. With
`--background` it asserts that a second conversation turn finishes while the
worker is awaiting its search tool, verifies the actual reference note and its
mooring code in the answer, then observes the result's return. It checks non-silent audio,
not merely receipt of WebRTC silence packets. Evidence is not checked into git.

## Scope and lifecycle

- The server binds to `127.0.0.1`; API requests require a SameSite/HttpOnly session
  cookie and reject other origins. No cloud credential or OpenCode server password
  is sent to the page. No public hosting, STUN, or TURN service is configured.
- The separate OpenCode server uses the user's existing native account connections
  and disposable sessions in the dedicated state folder's `sandbox`. It does not
  borrow Studio's running process or load any world. Session permissions deny all
  native tools except delegation/status for the conversational agent and the
  read-only sample-library search for the background worker. The worker cannot
  delegate recursively or access arbitrary file paths. Skills and plugins are denied.
- Speech inference stays local. Recognized/typed text and background task text go
  to the selected cloud model. OpenCode may retain native logs and account history.
  Exported logs contain the transcript; recordings are discarded unless the smoke
  test explicitly writes its synthetic output.
- Background jobs survive speech interruptions, but end with the test session.
  They are not durable Arke jobs. Stop all work before quitting; Ctrl+C drains the
  owned sessions and terminates the owned OpenCode child. No automatic prompt retry
  occurs after failure or an unknown outcome.
- Pipecat can cancel pending audio, but a CPU ONNX call runs to completion before
  releasing its inference lock. Its stale audio is discarded. Interrupting audio
  does not rewrite OpenCode's native history of the generated answer.
- A result waits for an active spoken turn's transcription/response before being
  injected. If a noise-only turn produces no transcript, delivery can remain held;
  speak or type a new turn. This is a known audition limit, not production recovery.

## Licenses

Pipecat and its client/transport packages are BSD-2-Clause. Their license files
remain with the installed packages. Kokoro weights have their own Apache-2.0
license; espeak-ng remains a separate GPL executable with its installed source and
notices. `kokoro-vocab.json` is the model vocabulary extracted from the MIT
`kokoro-onnx` 0.6.1 configuration; its notice is retained in `NOTICE.txt`.
The lab does not import `phonemizer`, load espeak as a shared library, or bundle
these runtimes for distribution. A production package still needs its complete
dependency/model notice and source-obligation review.

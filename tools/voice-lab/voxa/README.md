# Voxa voice audition

The second page in the Pipecat/Voxa comparison uses native Voxa for its
Silero → whisper.cpp → AgentLoopProcessor → SentenceAggregator → Kokoro →
WebSocket pipeline and the official Voxa browser client. The shared Python lab
still owns the identical OpenCode 2.2.5 bridge, cloud-model selection, prompts,
background jobs, read-only reference search, and event log.

The default voice is **bf_emma** and the default model is
**github-copilot/claude-haiku-4.5**. Kokoro reads the exact same
`model_quantized.onnx` and per-voice style file as the Pipecat page. espeak is a
separate executable; native Kokoro is configured for CPU with four ONNX threads
and graph optimization disabled, matching the Python audition's settings.

## Start and compare

Run from this folder on the development Windows machine:

```powershell
./start.ps1 -Background
```

The launcher needs .NET 10, the sibling Voxa source checkout, its existing NuGet
package cache, and the Python/frontend dependencies installed for the Pipecat
lab. `-VoxaSource`, `-Python`, `-Model`, and `-Port` override local defaults.
It copies seven source modules into ignored `.build/voxa-source`, records their
SHA-256 manifest, and puts every build output/package under `.build`. It never
builds into or modifies the sibling Voxa checkout. The restore is offline from
the existing local NuGet cache; it fails explicitly if a package is absent.

- Pipecat: **http://127.0.0.1:9075**
- Voxa: **http://127.0.0.1:9076**

Use the same voice, model, and tool hold on both pages, with one conversation
active at a time. Say the same short request, then try the reference lookup and
keep talking while it searches. Test interruptions over a longer reply. Export
each log; it names the engine, voice and cloud model. Stop the Voxa page with
`../pipecat/stop.ps1 -Port 9076`. To restart Pipecat use its own `start.ps1`.
Both pages share the built frontend; after rebuilding it with the Pipecat
launcher, run the Voxa launcher again to restore the native client asset.

## What differs

This is an application-level comparison, not a controlled framework benchmark:

| Component | Pipecat | Voxa |
|---|---|---|
| Browser transport | SmallWebRTC | WebSocket / PCM |
| Recognition | Faster Whisper base.en, CPU int8 | whisper.cpp base.en, CPU, four threads |
| Turn end | 650 ms VAD + local Smart Turn | 650 ms Silero silence detection |
| Local synthesis | Python ONNX adapter | Native Voxa KokoroTtsEngine |
| Agent loop | Pipecat LLMService adapter | Voxa AgentLoopProcessor / IAgentTurnDriver |
| Background execution/tools | Shared OpenCode worker + reference search | Same shared worker + search |

The .NET driver streams the exact same OpenCode bridge over a private loopback
HTTP connection. That adds a small bridge hop to Voxa. Typed and background
result turns are injected into Voxa's native pipeline; they do not bypass its
agent loop. Background jobs are shared lab orchestration, so this does not
qualify either framework's native background-worker abstraction.

First-token timings use the same OpenCode dispatch boundary. Voxa's reply-start
event observes the first PCM frame after synthesis, not its earlier
BotStartedSpeaking marker. This and Pipecat's output-speaking event are server
observations, not measurements of sound leaving the speakers. The official
Voxa client buffers audio and flushes on user speech as well as interruption.
Do not infer browser playback completion from native BotStoppedSpeaking events.

The Python process loads a Kokoro instance only for the page's voice preview;
live Voxa replies use the .NET engine. This duplicate preview instance means
process-memory totals should not be compared as framework memory benchmarks.
No world is opened. Cloud credentials and private native capabilities stay in
the server processes. Browser access requires the shared cookie/origin checks;
the .NET listener additionally requires a fresh private bearer capability.

## Verify

The same smoke script can drive both transports without a physical microphone:

```powershell
D:/ArkeVoiceLab/pipecat-venv/Scripts/python.exe ../pipecat/smoke.py --url http://127.0.0.1:9076 --background --microphone D:/ArkeVoiceLab/kokoro-smoke.wav --output .build/evidence
```

It makes real OpenCode cloud requests, verifies non-silent output, a foreground
reply while the background worker awaits its actual tool, the reference code
returned from that tool, and local speech recognition/interruption. Human voice,
speaker echo and browser interaction still need manual qualification.

On 2026-11-09 both full synthetic-microphone/background runs passed, along with
11 focused Python tests, the shared frontend build and the native .NET build.
The first Pipecat connection exceeded the original 30-second smoke timeout;
the next connection passed. The smoke now allows 60 seconds for readiness.
Startup consistency and cold-versus-warm behavior still need qualification.

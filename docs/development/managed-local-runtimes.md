# Managed local runtimes

Local setup queues Arke's managed ComfyUI and Ollama runtimes by default. Model weights remain
optional downloads. Discovery never adopts an existing engine. In Settings → Providers,
ComfyUI offers an explicitly selected install folder or URL; Ollama offers an explicitly
selected loopback HTTP URL. **Use Arke-managed** clears the override. Existing overrides remain
selected across upgrades; there is no silent migration of a personal model store.

Launch holds local AI setup until **both selected runtimes are installed, running and healthy**.
Coordinator seeds `setup.localAi` before detection or transport startup and republishes it on
installation and engine health changes. `running: false`, a finished transfer, Stop all, or a
failed/skipped component cannot complete this gate. Runtime Skip is refused by the service.
Pause/resume, retry, Downloads and Runtime settings remain reachable; explicit existing sources
must pass the same checks. The setup surface opens only after Continue. Once the runtime gate
passes, optional model downloads can continue in the background. Each launch rechecks health;
there is no saved completion flag that can mask an unhealthy service. Health loss revokes
readiness without ejecting an already open world. Managed engines and external ComfyUI retain
their health loops; selected external Ollama is also rechecked every 15 seconds. Overlapping
checks cannot publish an older result over a newer one, and disposal stops the polling timer.
Hosts that do not configure both engine services cannot report local AI setup as complete.
Shutdown refuses late installation activation and quiesces an admitted Ollama startup before
waiting for setup to drain. Healthy inference retains its owned child until normal job draining
and confirmed process cleanup; quiescing does not discard the child or its exit backstop.

Ollama is a pinned, SHA-256-verified portable tree, not a system installer or PATH command.
Arke owns its process, a private loopback port, `<appRoot>/models/ollama`, and
`<appRoot>/runtime-home/ollama`. Logs are `<appRoot>/logs/engines/ollama.log`.
An absent runtime does not fall back to port 11434. Explicit external services retain their
owner's lifecycle. Model listing, pulling and removal use the selected service's API.
OpenCode v2's owned profile receives only the selected endpoint; native OpenCode discovery
continues to own model inventory. Custom provider/model configuration is preserved.

Runtime updates remain explicit. Archives are verified before staging, the managed child
must confirm exit before replacement, and the old tree's models/custom nodes retain the
existing carry/rollback rules. A verified installation receipt records portable Ollama's
version; an unreceipted hand-copied tree is not labelled current. Runtime selection/restart
refuses active work on that engine and reserves the GPU lane during the change.

## Shared memory lifecycle

`local-ai/gpu.ts` serializes Ollama writing/direct jobs, local ComfyUI jobs and Ming batches.
Handover owns the lane while requesting other engines to unload. Ollama uses its loaded-model
API and `keep_alive: 0`; ComfyUI uses `/free`. These are engine-protocol acknowledgements,
not a measurement of every CUDA allocation or host-RAM page. Unrelated applications and work
submitted independently to an explicitly selected service are outside Arke's scheduler.

`local-ai/ming.ts` owns a separate Python process for each batch. A batch can load once and
read several chunks; its complete process exit releases that model's CUDA context and host
memory. Cancellation kills the owned tree and waits for close. If exit cannot be confirmed,
the GPU remains reserved and the next job is refused. A ledger and parent-lifetime leash
provide orphan cleanup. The worker gets runtime environment variables, offline flags and
private caches, without inherited provider credentials. It never installs into shared Python.
The worker's working directory and bounded `worker.log` stay inside its private cache root;
model diagnostics and source passages are not forwarded to the application log.

Desktop, dev and the standalone Node host wire this owner into Coordinator. `generateMingBatch` is a **host-only** API
accepting a qualified `MingBatchCommand`; paths and commands are never renderer-originated.
It reserves the same GPU lane before starting the process and drains it after exit. Shutdown
aborts active batches and disposes both process owners.
Failed process termination settles the batch with a cleanup error while retaining the process
and GPU reservation for retry; it cannot hold world/journal draining open indefinitely.
Confirmed supervisor shutdown includes tracked inference descendants. Desktop initialization
owns new runtimes until Coordinator construction succeeds and retries failed startup cleanup
before another initialization can start. Ollama routing changes are also fenced against cloud
writing turns; unchanged endpoint configuration does not restart the harness.
Failed-startup children remain owned until actual exit. An unhealthy ComfyUI worker must
confirm release even after its ready URL disappears; healthy sibling workers remain available.
Ollama model readiness is rechecked against the selected store, including models downloaded
earlier in the same session, and an old service's pull cannot mark a new service ready.

## Ming qualification and delivery boundary

The [managed-runtime qualification](../research/ming-managed-runtime-2026-10-25.md) proves
both variants can execute with the pinned managed GPU stack. The public audition script
accepts `--overlay`, `--shared-runtime-adapters`, and Tiny's `--python-sdk`, so this test can be
repeated without private scratch scripts. Pass `--worker` when the host owns process lifetime;
the host must create a fresh output directory and apply a whole-batch timeout signal.

Ming is an optional local reader in **Settings → AI models → Text-to-Speech**, under ComfyUI. Install
0.5B (about 3 GB of weights) or 7.9B (about 18 GB) to fetch the whole dependency closure.
Only Arke-managed Windows x64/NVIDIA ComfyUI is qualified; an explicitly selected personal
install or URL does not lend its Python to Ming. This is a separate batch worker sharing
Python/PyTorch/CUDA, rather than a ComfyUI recipe or custom node. Voxa remains the host for
Kokoro, transcription and interactive speech.

Clone a recording through the existing voice library, give permission, and enter its exact
spoken words in **Words spoken in the recording**. Existing library voices without these words
remain readable through their existing readers; re-clone the recording with its words to use
Ming. The same library voice offers each installed Ming model as a reader in casting and
narrator selection, and the normal Bench/production queue uses that selection. Missing consent,
words, recording or model files gives an unavailable reason. No voice is silently reassigned.
Ming starts unavailable until a successful runtime probe. Each model also requires its own
complete installation; a ready 0.5B reader cannot enable missing 7.9B weights.

`local-ai/ming-assets.json` pins source, checkpoint revisions, all dependency wheels and the
small Python SDK archive used by 7.9B's Triton compiler. Setup verifies every download. Inference
rechecks model/source/wheel hashes (using file-identity digest receipts), then extracts a private
overlay; it never runs pip or downloads anything. Reference bytes and words live only in that
private batch and the existing saved voice artifact/record. The queued identity hashes recording,
reference words and saved language, refusing changes before submission. Audiobook preparation
carries that language into each Ming part job. Hosted reader hashes stay unchanged.
Model repair/removal is fenced against admitted Ming reads. The packaged worker and upstream
MIT notice are loose resources, so external Python can read them outside Electron's archive.

Each request accepts at most 1,200 characters and splits at sentence boundaries into chunks
of at most 240 characters and 40 whitespace-delimited words. A batch loads once, conditions
every chunk on the original recording, keeps its direction separate from spoken text and joins
PCM audio with 80 ms gaps. Neutral cloning sends recording plus reference words; FREEFORM sends
the recording and instruction using upstream's speaker-only task. Direction is best effort:
accent, emotion and identical delivery across boundaries are listening decisions.
Queued reads combine cancellation with a 30-minute whole-batch deadline.

**7.9B is experimental.** The installation-path native test reproduced an accepted 32-word
passage (~8.16 s, ~246 s generation), while another passage stopped early even after reducing
chunk size. The 0.5B two-chunk test returned ~15.28 s in ~56 s. Both released their process and
GPU lane. Decode-ceiling failure, partial chunk completion, invalid audio and an obviously
short read (12+ words at over eight words/second) refuse the whole result. This last check is
an omission screen, not transcription or proof that every word was read. Review narration
before publishing. The retired IndexTTS recipe remains retired.
The post-integration inventory again matched all 57,017 shared-runtime file names, sizes and
modification times plus all 892 selected metadata/interpreter hashes. This is not a complete
hash of every binary or an image/video workflow test.

## Validation

From `packages/coordinator`:

```powershell
node --import tsx --test test/ollama-engine.test.ts test/ming-process.test.ts test/local-gpu.test.ts test/supervisor.test.ts test/supervisor-retry.test.ts test/harness-runtime-change.test.ts test/v2-launch.test.ts test/studio-server.test.ts test/setup/comfyui-setup.test.ts
```

Run client `test/engine-panes.test.tsx`, contracts `test/ollama.test.ts` and providers
`test/clients.test.ts`, plus desktop `test/startup-runtime-owners.test.ts`, from their package directories. Native Windows checks require normal
process, loopback and file-handle access. These regressions use native lightweight stand-ins;
real model qualification remains separate from CI. Finish with the repository's full gates
and Windows/Linux CI.

Ming product integration also uses coordinator `test/ming-speech.test.ts`, `test/voice/ming.test.ts`,
`test/queue/dispatcher.test.ts`, providers `test/ming.test.ts`, client `test/clone-voice.test.tsx` /
`test/local-models.test.tsx`, and desktop `test/packaged-runtimes.test.mjs`. Run
`python -B scripts/test-ming-worker.py` from the root for standard-library task mapping, short-read
and safe-archive tests. These tests require no model downloads; native real-model tests are
separate. CI shard 1 also runs the standard-library checks on Windows and Linux. Maintain the
lock with `node scripts/update-ming-assets.mjs` only after deliberate
pin/version edits and repeat native qualification; it fetches publisher metadata and archives.

The first-run gate also uses contracts `test/local-ai-setup.test.ts`, coordinator
`test/setup/local-ai-readiness.test.ts`, and client `test/launch-lifecycle.test.tsx` /
`test/downloads.test.tsx`. They cover missing detection, failed/paused/skipped installation,
one healthy engine, recovery, health loss, explicit existing services and optional downloads.
Desktop, browser development and standalone Node hosts own both engine services. Node hosts
use coordinator `comfyui/node-engine.ts`, with the shared digest cache, scoped loopback transport
and weight catalogue; desktop imports those utilities through its existing platform wrappers.
An explicitly selected external URL satisfies installation detection and must pass live health.

OpenCode support is v2 only, pinned to 2.0.26. Discovery can use `opencode2` or `opencode`, but
rejects every other version, including v1. There is no v1 adapter, generation preference,
`ARKE_OPENCODE_GENERATION` escape hatch or `ARKE_OPENCODE_CMD` launch path. The desktop binary
override is `ARKE_OPENCODE2_CMD`; Claude Code and Codex retain their separate explicit choices.

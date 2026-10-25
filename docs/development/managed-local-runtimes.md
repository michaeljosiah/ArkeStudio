# Managed local runtimes

Local setup queues Arke's managed ComfyUI and Ollama runtimes by default. Model weights remain
optional downloads. Discovery never adopts an existing engine. In Settings → Providers,
ComfyUI offers an explicitly selected install folder or URL; Ollama offers an explicitly
selected loopback HTTP URL. **Use Arke-managed** clears the override. Existing overrides remain
selected across upgrades; there is no silent migration of a personal model store.

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

## Ming qualification and delivery boundary

The [managed-runtime qualification](../research/ming-managed-runtime-2026-10-25.md) proves
both variants can execute with the pinned managed GPU stack. The public audition script
accepts `--overlay`, `--shared-runtime-adapters`, and Tiny's `--python-sdk`, so this test can be
repeated without private scratch scripts. Pass `--worker` when the host owns process lifetime;
the host must create a fresh output directory and apply a whole-batch timeout signal.

This change supplies the managed runtime policy and process/GPU backend. It does **not**
register Ming as a selectable narrator, download its weights/dependency overlay, or claim
long-read completeness. Shipping that optional reader still requires a pinned wheel/source/
checkpoint manifest, packaged worker, reference-transcript preparation and the voice-library
and narration-queue integration. There is no silent fallback to the retired IndexTTS recipe.

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

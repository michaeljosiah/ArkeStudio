import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ClientMessage,
  DomainEvent,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { BenchStore, sessionDir } from "../../src/bench/store.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { FakeProvider } from "../queue/fake-provider.js";
import type { EnqueueInput, JobQueue } from "../../src/queue/dispatcher.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { normalizeSpeechText, orderedShots, resolvePerformanceLine, ulid } from "@arke-studio/contracts";
import { audioHash } from "../../src/audio/qc.js";

const REQUEST = "01J8F3K2QW9VZX4N7M0RTYB6HD";

it("disabled Gemini models cannot be recommended, assigned or previewed through coordinator commands", async () => {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const model = "gemini-3.8-flash-tts";
  const google = new FakeProvider();
  let discoveries = 0;
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, cipher: devCipher(),
    dispatchClients: { google },
    credentialsFileName: "credentials.dev.dat", changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test", manifest: SHIPPED_MANIFEST,
    voice: { sidecar: null, localPresets: [], cloudSources: [{ provider: "google", list: async key => {
      discoveries++;
      return [{ provider: "google", model: key === "lite-only" ? "gemini-3.8-flash-lite-tts" : model, voiceId: "Charon", label: "Charon", attributes: [], local: false, canClone: false }]; } }] },
    observeEvent: event => events.push(event) });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  await coordinator.start(0);
  try {
    await send({ kind: "set-credential", provider: "google", key: "fixture-key" });
    await send({ kind: "set-model-enabled", modelId: model, enabled: false });
    const before = await readFile(join(worldDir, "characters", "maren-kest.md"), "utf8");
    await send({ kind: "voice-candidates", worldId: WORLD_ID, sheetId: "maren-kest" });
    const hidden = events.filter(e => e.type === "voice.candidates").at(-1)!;
    assert.deepEqual(hidden.ranked, []);
    await send({ kind: "assign-voice", requestId: REQUEST, worldId: WORLD_ID, path: "characters/maren-kest.md", voice: { provider: "google", model, voiceId: "Charon" } });
    const assignment = events.find(e => e.type === "voice.assignment-result")!;
    assert.equal(assignment.status, "refused");
    assert.match(assignment.reason!, /turned off/);
    assert.equal(await readFile(join(worldDir, "characters", "maren-kest.md"), "utf8"), before);
    await send({ kind: "voice-preview", requestId: REQUEST, worldId: WORLD_ID, sheetId: "maren-kest", provider: "google", model, voiceId: "Charon" });
    const preview = events.filter(e => e.type === "queue.enqueue-result").at(-1)!;
    assert.equal(preview.disposition, "rejected");
    assert.equal(events.some(e => e.type === "job.updated"), false);
    await send({ kind: "set-model-enabled", modelId: model, enabled: true });
    await send({ kind: "voice-candidates", worldId: WORLD_ID, sheetId: "maren-kest" });
    assert.equal(events.filter(e => e.type === "voice.candidates").at(-1)!.ranked[0]!.candidate.model, model);
    await send({ kind: "assign-voice", requestId: ulid(), worldId: WORLD_ID, path: "characters/maren-kest.md", voice: { provider: "google", model, voiceId: "Charon" } });
    const bundle = provider.openStore()!.getBundle();
    const hasLine = (scene: typeof bundle.productions[number]["scenes"][number]) => orderedShots(scene).some(shot => shot.audio?.speaker === "maren-kest" && shot.audio.line);
    const production = bundle.productions.find(p => p.scenes.some(hasLine))!;
    const scene = production.scenes.find(hasLine)!;
    const shot = orderedShots(scene).find(shot => shot.audio?.speaker === "maren-kest" && shot.audio.line)!;
    const line = resolvePerformanceLine(scene, shot.id); assert.ok(line.ok);
    const prepare = { kind: "prepare-performance-generation" as const, requestId: ulid(), worldId: WORLD_ID,
      productionId: production.meta.id, sceneId: scene.id, shotId: shot.id, expectedSceneVersion: scene.version, expectedVoiceId: "Charon", modelId: model,
      cadencePlan: { schemaVersion: 1 as const, sourceTextHash: audioHash(Buffer.from(normalizeSpeechText(line.text))), delivery: "warm" as const, speed: 1, cues: [] } };
    await send(prepare);
    const quote = events.filter(e => e.type === "performance.result").at(-1)!.quote;
    assert.ok(quote, "an enabled current reader can be quoted");
    await send({ kind: "set-model-enabled", modelId: model, enabled: false });
    await send({ ...prepare, requestId: ulid() });
    assert.equal(events.filter(e => e.type === "performance.result").at(-1)!.status, "refused");
    await send({ kind: "generate-performance", requestId: ulid(), worldId: WORLD_ID, operationId: quote.operationId, confirmedMicroUsd: quote.estimatedMicroUsd });
    assert.equal(events.filter(e => e.type === "queue.enqueue-result").at(-1)!.disposition, "rejected");
    await send({ kind: "set-model-enabled", modelId: model, enabled: true });
    await send({ kind: "set-credential", provider: "google", key: "lite-only" });
    await send({ kind: "voice-line", requestId: ulid(), worldId: WORLD_ID, productionId: production.meta.id, shotId: shot.id, confirmedSpeechMicroUsd: 1000000 });
    const unavailable = events.filter(e => e.type === "queue.enqueue-result").at(-1)!;
    assert.equal(unavailable.disposition, "rejected");
    assert.match(JSON.stringify(unavailable), /current Google key/);
    await send({ ...prepare, requestId: ulid() });
    assert.equal(events.filter(e => e.type === "performance.result").at(-1)!.status, "refused");
    await send({ kind: "generate-performance", requestId: ulid(), worldId: WORLD_ID, operationId: quote.operationId, confirmedMicroUsd: quote.estimatedMicroUsd });
    assert.equal(events.filter(e => e.type === "queue.enqueue-result").at(-1)!.disposition, "rejected");
    assert.equal(events.some(e => e.type === "job.updated"), false);
    const sessionId = "sess_01J8F3K2QW9VZX4N7M0RTYB6HD";
    const bench = new BenchStore(sessionDir(worldDir, sessionId));
    await bench.create(sessionId, "2026-09-27T12:00:00.000Z");
    const composer = { mode: "voice" as const, provider: "google", model,
      params: { kind: "voice" as const, count: 1, voiceId: "Charon", voiceProvider: "google", voiceModel: model, voiceLabel: "Charon" },
      brief: "A saved Bench line." };
    await bench.append({ type: "composer-set", ...composer });
    const requestId = ulid();
    await send({ kind: "bench-dispatch", worldId: WORLD_ID, sessionId, requestId, composer, confirmedSpeechMicroUsd: 1000000 });
    const refused = events.find(e => e.type === "queue.enqueue-result" && e.requestId === requestId);
    assert.ok(refused && refused.type === "queue.enqueue-result");
    assert.equal(refused.disposition, "rejected");
    assert.match(JSON.stringify(refused), /current Google key/);
    assert.equal((await readFile(bench.eventsPath, "utf8")).includes("takes-reserved"), false);
    const queue = (coordinator as unknown as { jobQueue: JobQueue }).jobQueue;
    await assert.rejects(queue.enqueue({ worldId: WORLD_ID, target: { kind: "voice-preview", id: "saved-flash" },
      capability: "voice-tts", provider: "google", model, params: { text: "A saved read.", voiceId: "Charon" }, estimatedMicroUsd: 1000 }), /current Google key/);
    assert.deepEqual(queue.listJobs(), []);
    assert.equal(events.some(e => e.type === "job.updated"), false);
    assert.equal(google.submitCount, 0);
    await send({ kind: "set-credential", provider: "google", key: "fixture-key" });
    (queue as unknown as { pauseLane(provider: string, kind: string, reason: string): void }).pauseLane("google", "fault", "Test keeps admitted jobs queued.");
    const admission = coordinator as unknown as { enqueueBatch(requestId: string, command: "voice-preview", inputs: readonly EnqueueInput[]): Promise<{ accepted: boolean; jobIds: string[] }> };
    const inputs: EnqueueInput[] = Array.from({ length: 50 }, (_, index) => ({ worldId: WORLD_ID, target: { kind: "voice-preview", id: `batch-${index}` },
      capability: "voice-tts", provider: "google", model, params: { text: `Line ${index}.`, voiceId: "Charon" }, estimatedMicroUsd: 1000000 }));
    discoveries = 0;
    const admitted = await admission.enqueueBatch(ulid(), "voice-preview", inputs);
    assert.equal(admitted.jobIds.length, 50);
    assert.equal(discoveries, 1, "one exact-reader discovery across 50 queued jobs");
    await send({ kind: "set-credential", provider: "google", key: "lite-only" });
    discoveries = 0;
    const stale = await admission.enqueueBatch(ulid(), "voice-preview", inputs);
    assert.equal(stale.accepted, false);
    assert.equal(stale.jobIds.length, 0);
    assert.equal(discoveries, 1, "a new batch discovers the changed key once, including a shared refusal");
    assert.equal(queue.listJobs().length, 50);
    assert.equal(google.submitCount, 0);
    const scoped = coordinator as unknown as { enqueueWithSpeechChecks(input: EnqueueInput, checks: Map<string, Promise<void>>): Promise<unknown> };
    const checks = new Map<string, Promise<void>>();
    await send({ kind: "set-credential", provider: "google", key: "fixture-key" });
    discoveries = 0;
    await scoped.enqueueWithSpeechChecks(inputs[0]!, checks);
    await send({ kind: "set-credential", provider: "google", key: "lite-only" });
    await assert.rejects(scoped.enqueueWithSpeechChecks(inputs[1]!, checks), /current Google key/);
    assert.equal(discoveries, 2, "key rotation invalidates even a live batch's successful validation");
    await send({ kind: "set-credential", provider: "google", key: "fixture-key" });
    await send({ kind: "set-model-enabled", modelId: model, enabled: false });
    await assert.rejects(scoped.enqueueWithSpeechChecks(inputs[2]!, checks), /turned off/);
    assert.equal(discoveries, 2, "disabled state is enforced before using any successful batch result");
  } finally { await coordinator.stop(); await provider.close(); }
});

it("retired local speech preserves the world and refuses selection, preview, production and Bench without a job or paid fallback", async t => {
  const { root, worldDir } = await makeTempRoot();
  const clip = Buffer.from("saved recording bytes are retained");
  await mkdir(join(worldDir, "voices"), { recursive: true });
  const libraryPath = join(worldDir, "voices", "voices.json");
  const library = JSON.stringify({ voices: [{ id: "harbour", name: "Harbour", clip: "voices/harbour.wav", description: "low", attributes: ["low"] }] });
  await writeFile(libraryPath, library);
  await writeFile(join(worldDir, "voices", "harbour.wav"), clip);
  const sheetPath = join(worldDir, "characters", "maren-kest.md");
  const original = await readFile(sheetPath, "utf8");
  const saved = original.replace(/voice:\r?\n(?:  .*\r?\n){4}/,
    "voice:\n  provider: comfyui\n  model: comfyui-cloned-voice\n  voiceId: harbour\n  label: Harbour\n  assignedAtVersion: 4\n");
  assert.notEqual(saved, original);
  await writeFile(sheetPath, saved);
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const comfyui = new FakeProvider();
  const mistral = new FakeProvider();
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat", changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test",
    manifest: SHIPPED_MANIFEST, dispatchClients: { comfyui, mistral },
    voice: { sidecar: null, localPresets: [], cloudSources: [] }, observeEvent: event => events.push(event) });
  await coordinator.start(0);
  t.after(async () => { await coordinator.stop(); await provider.close(); });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  const voice = { provider: "comfyui" as const, model: "comfyui-cloned-voice", voiceId: "harbour" };
  const bundle = provider.openStore()!.getBundle();
  assert.equal(bundle.clonedVoices[0]!.id, "harbour");
  assert.equal(bundle.sheets.find(sheet => sheet.id === "maren-kest")!.voice!.model, voice.model);
  // A connected paid reader still must not take over a saved local assignment.
  await send({ kind: "set-credential", provider: "mistral", key: "fixture-key" });
  await send({ kind: "voice-candidates", worldId: WORLD_ID, sheetId: "maren-kest" });
  const candidates = events.filter(event => event.type === "voice.candidates").at(-1)!;
  assert.ok(candidates.ranked.every(({ candidate }) => candidate.provider !== "comfyui"));
  await send({ kind: "assign-voice", requestId: ulid(), worldId: WORLD_ID, path: "characters/maren-kest.md", voice });
  assert.equal(events.filter(event => event.type === "voice.assignment-result").at(-1)!.status, "refused");
  await send({ kind: "voice-preview", requestId: ulid(), worldId: WORLD_ID, sheetId: "maren-kest", ...voice });
  assert.equal(events.filter(event => event.type === "queue.enqueue-result").at(-1)!.disposition, "rejected");
  const hasLine = (scene: typeof bundle.productions[number]["scenes"][number]) => orderedShots(scene).some(shot => shot.audio?.speaker === "maren-kest" && shot.audio.line);
  const production = bundle.productions.find(p => p.scenes.some(hasLine))!;
  const scene = production.scenes.find(hasLine)!;
  const shot = orderedShots(scene).find(s => s.audio?.speaker === "maren-kest" && s.audio.line)!;
  const requestId = ulid();
  await send({ kind: "voice-line", requestId, worldId: WORLD_ID, productionId: production.meta.id, shotId: shot.id });
  const refusedLine = events.find(event => event.type === "queue.enqueue-result" && event.requestId === requestId)!;
  assert.ok(refusedLine.type === "queue.enqueue-result");
  assert.equal(refusedLine.disposition, "rejected");
  assert.match(JSON.stringify(refusedLine), /no longer available|No comfyui voice model/);
  const line = resolvePerformanceLine(scene, shot.id); assert.ok(line.ok);
  await send({ kind: "prepare-performance-generation", requestId: ulid(), worldId: WORLD_ID,
    productionId: production.meta.id, sceneId: scene.id, shotId: shot.id, expectedSceneVersion: scene.version,
    expectedVoiceId: voice.voiceId, modelId: voice.model,
    cadencePlan: { schemaVersion: 1, sourceTextHash: audioHash(Buffer.from(normalizeSpeechText(line.text))), delivery: "warm", speed: 1, cues: [] } });
  assert.equal(events.filter(event => event.type === "performance.result").at(-1)!.status, "refused");
  const sessionId = "sess_01J8F3K2QW9VZX4N7M0RTYB6HD";
  const bench = new BenchStore(sessionDir(worldDir, sessionId));
  await bench.create(sessionId, "2026-09-29T12:00:00.000Z");
  const composer = { mode: "voice" as const, provider: voice.provider, model: voice.model,
    params: { kind: "voice" as const, count: 1, voiceId: voice.voiceId, voiceProvider: voice.provider, voiceModel: voice.model, voiceLabel: "Harbour" }, brief: "A saved local read." };
  await bench.append({ type: "composer-set", ...composer });
  const benchRequest = ulid();
  await send({ kind: "bench-dispatch", requestId: benchRequest, worldId: WORLD_ID, sessionId, composer });
  const refusedBench = events.find(event => event.type === "queue.enqueue-result" && event.requestId === benchRequest)!;
  assert.ok(refusedBench.type === "queue.enqueue-result");
  assert.equal(refusedBench.disposition, "rejected");
  assert.equal((await readFile(bench.eventsPath, "utf8")).includes("takes-reserved"), false);
  const queue = (coordinator as unknown as { jobQueue: JobQueue }).jobQueue;
  await assert.rejects(queue.enqueue({ worldId: WORLD_ID, target: { kind: "voice-preview", id: "old-local" },
    capability: "voice-tts", ...voice, params: { text: "A saved read.", voiceId: voice.voiceId }, estimatedMicroUsd: 0 }), /no longer supports speech|not.*manifest|not.*available/i);
  assert.deepEqual(queue.listJobs(), []);
  assert.equal(events.some(event => event.type === "voice.upload-confirmation-required" || event.type === "job.updated"), false);
  assert.equal(comfyui.submitCount, 0);
  assert.equal(mistral.submitCount, 0);
  assert.equal(await readFile(sheetPath, "utf8"), saved);
  assert.equal(await readFile(libraryPath, "utf8"), library);
  assert.deepEqual(await readFile(join(worldDir, "voices", "harbour.wav")), clip);
});

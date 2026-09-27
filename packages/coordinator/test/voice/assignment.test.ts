import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ClientMessage,
  DomainEvent,
  JobEngineIdentity,
  ManifestModel,
  RecipeIdentity,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { BenchStore, sessionDir } from "../../src/bench/store.js";
import type { ComfyUiEngineService } from "../../src/comfyui/engine.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { setProductionModel } from "../../src/productions/ops.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { FakeProvider } from "../queue/fake-provider.js";
import type { EnqueueInput, JobQueue } from "../../src/queue/dispatcher.js";
import { until } from "../wait.js";
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
const MODEL: ManifestModel = {
  id: "comfyui-cloned-voice",
  provider: "comfyui",
  capability: "voice-tts",
  displayName: "Local Cloned Voice",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 400, audioFormat: "flac" },
  pricing: { kind: "unmetered" },
};
const SIBLING_MODEL: ManifestModel = {
  ...MODEL,
  id: "comfyui-other-voice",
  displayName: "Other Local Voice",
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function wavBytes(): Uint8Array {
  const wav = Buffer.alloc(52);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(44, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24);
  wav.writeUInt32LE(16_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(8, 40);
  return wav;
}

function flacCrc8(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function flacCrc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function flacBytes(): Uint8Array {
  const streamInfo = new Uint8Array(34);
  const view = new DataView(streamInfo.buffer);
  view.setUint16(0, 16, false);
  view.setUint16(2, 16, false);
  const packed = (8_000n << 44n) | (7n << 36n) | 16n;
  view.setUint32(10, Number(packed >> 32n), false);
  view.setUint32(14, Number(packed & 0xffffffffn), false);
  const headerWithoutCrc = Uint8Array.from([0xff, 0xf8, 0x64, 0x02, 0, 15]);
  const header = concat(headerWithoutCrc, Uint8Array.of(flacCrc8(headerWithoutCrc)));
  const frameWithoutCrc = concat(header, Uint8Array.of(0, 0));
  const crc = flacCrc16(frameWithoutCrc);
  return concat(
    new TextEncoder().encode("fLaC"),
    Uint8Array.of(0x80, 0, 0, streamInfo.length),
    streamInfo,
    frameWithoutCrc,
    Uint8Array.of(crc >>> 8, crc & 0xff),
  );
}

function readyRemoteService(token: string): ComfyUiEngineService {
  const engine: JobEngineIdentity = { source: "user-url", instanceId: token, locality: "remote" };
  const recipe: RecipeIdentity = {
    id: MODEL.id,
    version: 1,
    templateDigest: "a".repeat(64),
    dependencyDigest: "b".repeat(64),
  };
  return {
    status: async () => ({
      engine: {
        source: "user-url",
        state: "ready",
        locality: "remote",
        location: "https://voice-box.example:8188",
        version: "0.3.45",
        instanceId: token,
        detail: null,
        detected: [],
      },
      recipes: [
        {
          recipeId: MODEL.id,
          recipeVersion: recipe.version,
          displayName: MODEL.displayName,
          capability: "voice-tts",
          state: "ready",
        },
      ],
      checkedAt: "2026-08-25T12:00:00.000Z",
    }),
    voiceUploadDestination: () => ({ token, label: "voice-box.example:8188" }),
    identityFor: (modelId: string) => (modelId === MODEL.id ? { recipe, engine } : null),
    instanceId: () => token,
    engineIdentity: () => engine,
    waitUntilReady: async () => true,
    modelsDir: () => null,
    baseUrl: () => "https://voice-box.example:8188",
    baseUrls: () => ["https://voice-box.example:8188"],
    applySettings: async () => {},
    subscribe: () => () => {},
    dispose: async () => {},
  } as unknown as ComfyUiEngineService;
}

async function harness(
  clip = "voices/harbour.wav",
  recipeState: "ready" | "disabled" = "ready",
  remoteDestination?: { token: string; label: string },
) {
  const { root, worldDir } = await makeTempRoot();
  await mkdir(join(worldDir, "voices"), { recursive: true });
  await writeFile(
    join(worldDir, "voices", "voices.json"),
    JSON.stringify({
      voices: [{ id: "harbour", name: "Harbour", clip, description: "low", attributes: ["low"] }],
    }),
  );
  if (clip === "voices/harbour.wav") {
    const wav = Buffer.alloc(52);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(44, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(8, 40);
    await writeFile(join(worldDir, clip), wav);
  }
  const provider = new FsWorldProvider(root, { clock: () => "2026-08-25T12:00:00.000Z" });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    manifest: { manifestVersion: 1, generated: "2026-08-25", models: [SIBLING_MODEL, MODEL] },
    voice: { sidecar: null, localPresets: [], cloudSources: [] },
    comfyui: {
      service: {
        status: async () => ({
          engine: { locality: remoteDestination ? "remote" : "local" },
          recipes: [
            {
              recipeId: MODEL.id,
              state: recipeState,
              ...(recipeState === "disabled"
                ? { reason: "Cloned voice setup is unavailable in this build." }
                : {}),
            },
          ],
        }),
        voiceUploadDestination: () => remoteDestination ?? null,
        identityFor: () => undefined,
      } as never,
    },
    observeEvent: (event) => events.push(event),
  });
  const send = (message: ClientMessage) =>
    (
      coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }
    ).handleClientMessage(message);
  return { provider, worldDir, events, send };
}

describe("cloned voice assignment", () => {
  it("validates against the open world's library, writes the concrete model, and terminates", async () => {
    const h = await harness();
    try {
      await h.send({
        kind: "assign-voice",
        requestId: REQUEST,
        worldId: WORLD_ID,
        path: "characters/maren-kest.md",
        voice: { provider: "comfyui", voiceId: "harbour", label: "Harbour" },
      });
      const result = h.events.find((event) => event.type === "voice.assignment-result");
      assert.ok(result && result.type === "voice.assignment-result");
      assert.equal(result.status, "assigned");
      const sheet = await readFile(join(h.worldDir, "characters", "maren-kest.md"), "utf8");
      assert.match(sheet, /model: comfyui-cloned-voice/);
    } finally {
      await h.provider.close();
    }
  });

  it("keeps the candidate's concrete model when the provider has two TTS models", async () => {
    const h = await harness();
    try {
      await h.send({
        kind: "assign-voice",
        requestId: REQUEST,
        worldId: WORLD_ID,
        path: "characters/maren-kest.md",
        voice: { provider: "comfyui", model: MODEL.id, voiceId: "harbour", label: "Harbour" },
      });
      const result = h.events.find((event) => event.type === "voice.assignment-result");
      assert.ok(result && result.type === "voice.assignment-result");
      assert.equal(result.status, "assigned");
      const sheet = await readFile(join(h.worldDir, "characters", "maren-kest.md"), "utf8");
      assert.match(sheet, /model: comfyui-cloned-voice/);
      assert.doesNotMatch(sheet, /model: comfyui-other-voice/);
    } finally {
      await h.provider.close();
    }
  });

  it("refuses an unsafe source clip and still emits a terminal result", async () => {
    const h = await harness("../outside.wav");
    try {
      await h.send({
        kind: "assign-voice",
        requestId: REQUEST,
        worldId: WORLD_ID,
        path: "characters/maren-kest.md",
        voice: { provider: "comfyui", model: MODEL.id, voiceId: "harbour", label: "Harbour" },
      });
      const result = h.events.find((event) => event.type === "voice.assignment-result");
      assert.ok(result && result.type === "voice.assignment-result");
      assert.equal(result.status, "refused");
      assert.match(result.reason ?? "", /no longer available|missing or unsafe/);
    } finally {
      await h.provider.close();
    }
  });

  it("refuses a hard-disabled clone with the readiness reason", async () => {
    const h = await harness("voices/harbour.wav", "disabled");
    try {
      await h.send({
        kind: "assign-voice",
        requestId: REQUEST,
        worldId: WORLD_ID,
        path: "characters/maren-kest.md",
        voice: { provider: "comfyui", model: MODEL.id, voiceId: "harbour", label: "Harbour" },
      });
      const result = h.events.find((event) => event.type === "voice.assignment-result");
      assert.ok(result && result.type === "voice.assignment-result");
      assert.equal(result.status, "refused");
      assert.equal(result.reason, "Cloned voice setup is unavailable in this build.");
    } finally {
      await h.provider.close();
    }
  });

  it("refuses production composition for an existing hard-disabled assignment", async () => {
    const h = await harness("voices/harbour.wav", "disabled");
    try {
      const path = join(h.worldDir, "characters", "maren-kest.md");
      const current = await readFile(path, "utf8");
      await writeFile(
        path,
        current.replace(
          /voice:\r?\n(?:  .*\r?\n){4}/,
          "voice:\n  provider: comfyui\n  model: comfyui-cloned-voice\n  voiceId: harbour\n  label: Harbour\n  assignedAtVersion: 4\n",
        ),
      );
      await h.provider.openStore()?.reload();
      await h.send({
        kind: "voice-line",
        requestId: REQUEST,
        worldId: WORLD_ID,
        productionId: "saltlight",
        shotId: "sh_12",
      });
      const result = h.events.find((event) => event.type === "queue.enqueue-result");
      assert.ok(result && result.type === "queue.enqueue-result");
      assert.equal(result.disposition, "rejected");
      assert.equal(result.failures[0]?.reason, "Cloned voice setup is unavailable in this build.");
      assert.equal(
        h.events.some((event) => event.type === "job.updated"),
        false,
      );
    } finally {
      await h.provider.close();
    }
  });

  it("refuses a production voice default that conflicts with the assigned voice", async () => {
    const h = await harness();
    try {
      const store = h.provider.openStore();
      assert.ok(store);
      await setProductionModel(store, "saltlight", "voice-tts", SIBLING_MODEL.id);
      const path = join(h.worldDir, "characters", "maren-kest.md");
      const current = await readFile(path, "utf8");
      await writeFile(
        path,
        current.replace(
          /voice:\r?\n(?:  .*\r?\n){4}/,
          "voice:\n  provider: comfyui\n  model: comfyui-cloned-voice\n  voiceId: harbour\n  label: Harbour\n  assignedAtVersion: 4\n",
        ),
      );
      await store.reload();
      await h.send({
        kind: "voice-line",
        requestId: REQUEST,
        worldId: WORLD_ID,
        productionId: "saltlight",
        shotId: "sh_12",
      });
      const conflict = h.events.find((event) => event.type === "queue.enqueue-result");
      assert.ok(conflict && conflict.type === "queue.enqueue-result");
      assert.equal(conflict.disposition, "rejected");
      assert.match(conflict.failures[0]?.reason ?? "", /Other Local Voice.*Local Cloned Voice/);
    } finally {
      await h.provider.close();
    }
  });

  it("requires remote confirmation before hard-disabled preview and production paths", async () => {
    const h = await harness("voices/harbour.wav", "disabled", {
      token: "remote-instance-1",
      label: "voice-box.example:8188",
    });
    try {
      const path = join(h.worldDir, "characters", "maren-kest.md");
      const current = await readFile(path, "utf8");
      await writeFile(
        path,
        current.replace(
          /voice:\r?\n(?:  .*\r?\n){4}/,
          "voice:\n  provider: comfyui\n  model: comfyui-cloned-voice\n  voiceId: harbour\n  label: Harbour\n  assignedAtVersion: 4\n",
        ),
      );
      await h.provider.openStore()?.reload();

      await h.send({
        kind: "voice-preview",
        requestId: REQUEST,
        worldId: WORLD_ID,
        sheetId: "maren-kest",
        provider: "comfyui",
        model: MODEL.id,
        voiceId: "harbour",
      });
      const previewConfirmation = h.events.find(
        (event) => event.type === "voice.upload-confirmation-required",
      );
      assert.ok(previewConfirmation && previewConfirmation.type === "voice.upload-confirmation-required");
      assert.equal(previewConfirmation.destinationLabel, "voice-box.example:8188");
      assert.equal(previewConfirmation.confirmationToken, "remote-instance-1");
      assert.equal(
        h.events.some((event) => event.type === "job.updated"),
        false,
      );

      h.events.length = 0;
      await h.send({
        kind: "voice-preview",
        requestId: REQUEST,
        worldId: WORLD_ID,
        sheetId: "maren-kest",
        provider: "comfyui",
        model: MODEL.id,
        voiceId: "harbour",
        voiceUploadConfirmedFor: "remote-instance-1",
      });
      const previewRefused = h.events.find((event) => event.type === "queue.enqueue-result");
      assert.ok(previewRefused && previewRefused.type === "queue.enqueue-result");
      assert.equal(previewRefused.failures[0]?.reason, "Cloned voice setup is unavailable in this build.");
      assert.equal(
        h.events.some((event) => event.type === "job.updated"),
        false,
      );

      h.events.length = 0;
      await h.send({
        kind: "voice-line",
        requestId: REQUEST,
        worldId: WORLD_ID,
        productionId: "saltlight",
        shotId: "sh_12",
        voiceUploadConfirmedFor: "wrong-instance",
      });
      assert.equal(h.events[0]?.type, "voice.upload-confirmation-required");
      assert.equal(
        h.events.some((event) => event.type === "queue.enqueue-result"),
        false,
      );

      h.events.length = 0;
      await h.send({
        kind: "voice-line",
        requestId: REQUEST,
        worldId: WORLD_ID,
        productionId: "saltlight",
        shotId: "sh_12",
        voiceUploadConfirmedFor: "remote-instance-1",
      });
      const refused = h.events.find((event) => event.type === "queue.enqueue-result");
      assert.ok(refused && refused.type === "queue.enqueue-result");
      assert.equal(refused.failures[0]?.reason, "Cloned voice setup is unavailable in this build.");
      assert.equal(
        h.events.some((event) => event.type === "job.updated"),
        false,
      );
    } finally {
      await h.provider.close();
    }
  });

  it("retries a remote cloned-voice preview only for the exact engine instance", async () => {
    const { root, worldDir } = await makeTempRoot();
    await mkdir(join(worldDir, "voices"), { recursive: true });
    await writeFile(
      join(worldDir, "voices", "voices.json"),
      JSON.stringify({
        voices: [
          {
            id: "harbour",
            name: "Harbour",
            clip: "voices/harbour.wav",
            description: "low",
            attributes: ["low"],
          },
        ],
      }),
    );
    const provider = new FsWorldProvider(root, { clock: () => "2026-08-25T12:00:00.000Z" });
    await provider.loadWorld(WORLD_ID);
    const events: DomainEvent[] = [];
    const remote = new FakeProvider();
    remote.artifacts = [{ name: "preview.flac", contentType: "audio/flac", data: flacBytes() }];
    const destinationToken = "remote-instance-1";
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      changeLogPath: join(root, "logs", "changes.jsonl"),
      appVersion: "test",
      appRoot: root,
      cipher: devCipher(),
      credentialsFileName: "credentials.dev.dat",
      manifest: { manifestVersion: 1, generated: "2026-08-25", models: [MODEL] },
      voice: { sidecar: null, localPresets: [], cloudSources: [] },
      comfyui: { service: readyRemoteService(destinationToken) },
      dispatchClients: { comfyui: remote },
      observeEvent: (event) => events.push(event),
    });
    const send = (voiceUploadConfirmedFor?: string) =>
      (
        coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }
      ).handleClientMessage({
        kind: "voice-preview",
        requestId: REQUEST,
        worldId: WORLD_ID,
        sheetId: "maren-kest",
        provider: "comfyui",
        model: MODEL.id,
        voiceId: "harbour",
        ...(voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor } : {}),
      });

    await coordinator.start(0);
    try {
      // The source recording is deliberately absent. Both refusals must happen before clip access
      // and before readiness/admission can create a durable job.
      await send();
      const first = events.find((event) => event.type === "voice.upload-confirmation-required");
      assert.ok(first && first.type === "voice.upload-confirmation-required");
      assert.equal(first.confirmationToken, destinationToken);
      assert.equal(events.some((event) => event.type === "queue.enqueue-result"), false);
      assert.equal(events.some((event) => event.type === "job.updated"), false);
      assert.equal(remote.submitCount, 0);

      events.length = 0;
      await send("read-aloud-paid-confirmation-token");
      const wrong = events.find((event) => event.type === "voice.upload-confirmation-required");
      assert.ok(wrong && wrong.type === "voice.upload-confirmation-required");
      assert.equal(wrong.confirmationToken, destinationToken);
      assert.equal(events.some((event) => event.type === "queue.enqueue-result"), false);
      assert.equal(events.some((event) => event.type === "job.updated"), false);
      assert.equal(remote.submitCount, 0);

      await writeFile(join(worldDir, "voices", "harbour.wav"), wavBytes());
      events.length = 0;
      await send(destinationToken);
      const accepted = events.find((event) => event.type === "queue.enqueue-result");
      assert.ok(accepted && accepted.type === "queue.enqueue-result");
      assert.equal(accepted.disposition, "accepted");
      await until(() => remote.submitCount === 1, "the confirmed job to be submitted");
      assert.ok(remote.submittedVoiceReference, "the provider received the confined source clip");
      await until(
        () =>
          events.some(
            (event) =>
              event.type === "voice.audio" && event.requestId === REQUEST && event.status === "ready",
          ),
        "the ready voice.audio event for the request",
      );
      const journal = await readFile(join(root, "queue", "jobs.jsonl"), "utf8");
      assert.match(journal, /"voiceUploadConfirmedFor":"remote-instance-1"/);
      assert.equal(journal.includes("read-aloud-paid-confirmation-token"), false);
      await access(join(worldDir, ".cache", "voice-previews"));
    } finally {
      await coordinator.stop();
    }
  });

  it("requires remote confirmation before a hard-disabled Bench clone without reserving a take", async () => {
    const h = await harness("voices/harbour.wav", "disabled", {
      token: "remote-instance-1",
      label: "voice-box.example:8188",
    });
    try {
      const sessionId = "sess_01J8F3K2QW9VZX4N7M0RTYB6HD";
      const open = (h.provider as unknown as { openStore(): { dir: string } | null }).openStore();
      assert.ok(open);
      const bench = new BenchStore(sessionDir(open!.dir, sessionId as never));
      await bench.create(sessionId as never, "2026-08-25T12:00:00.000Z");
      await bench.append({
        type: "composer-set",
        mode: "voice",
        provider: "comfyui",
        model: MODEL.id,
        params: {
          kind: "voice",
          count: 1,
          voiceId: "harbour",
          voiceProvider: "comfyui",
          voiceModel: MODEL.id,
          voiceLabel: "Harbour",
        },
        brief: "A line for the harbour.",
      });
      h.events.length = 0;
      await h.send({
        kind: "bench-dispatch",
        worldId: WORLD_ID,
        sessionId,
        requestId: REQUEST,
        composer: {
          mode: "voice",
          provider: "comfyui",
          model: MODEL.id,
          params: {
            kind: "voice",
            count: 1,
            voiceId: "harbour",
            voiceProvider: "comfyui",
            voiceModel: MODEL.id,
            voiceLabel: "Harbour",
          },
          brief: "A line for the harbour.",
        },
      });
      const confirmation = h.events.find((event) => event.type === "voice.upload-confirmation-required");
      assert.ok(confirmation && confirmation.type === "voice.upload-confirmation-required");
      assert.equal(confirmation.command, "bench-dispatch");
      const log = await readFile(bench.eventsPath, "utf8");
      assert.equal(log.includes("takes-reserved"), false);
      assert.equal(
        h.events.some((event) => event.type === "job.updated"),
        false,
      );

      h.events.length = 0;
      await h.send({
        kind: "bench-dispatch",
        worldId: WORLD_ID,
        sessionId,
        requestId: REQUEST,
        composer: {
          mode: "voice",
          provider: "comfyui",
          model: MODEL.id,
          params: {
            kind: "voice",
            count: 1,
            voiceId: "harbour",
            voiceProvider: "comfyui",
            voiceModel: MODEL.id,
            voiceLabel: "Harbour",
          },
          brief: "A line for the harbour.",
        },
        voiceUploadConfirmedFor: "remote-instance-1",
      });
      const refused = h.events.find((event) => event.type === "queue.enqueue-result");
      assert.ok(refused && refused.type === "queue.enqueue-result");
      assert.equal(refused.failures[0]?.reason, "Cloned voice setup is unavailable in this build.");
      assert.equal((await readFile(bench.eventsPath, "utf8")).includes("takes-reserved"), false);
      assert.equal(
        h.events.some((event) => event.type === "job.updated"),
        false,
      );
    } finally {
      await h.provider.close();
    }
  });
});

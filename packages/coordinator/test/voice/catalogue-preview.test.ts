import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { VOICE_PREVIEW_SCOPE, NARRATOR_PREVIEW_TEXT, type DomainEvent, type VoiceCandidate, type Job } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { CataloguePreviewService, approvedVoiceSample } from "../../src/voice/catalogue-preview.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { tempDir } from "../tmp.js";
import { JobQueue } from "../../src/queue/dispatcher.js";
import { FakeProvider } from "../queue/fake-provider.js";
import { until } from "../wait.js";
import type { LedgerEntry } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";

const voice: VoiceCandidate = { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "george", label: "George", attributes: [], local: false, canClone: true };
const request = (requestId: string, extra = {}) => ({ ...voice, requestId, maxMicroUsd: 100_000, ...extra });
const sample = "https://storage.googleapis.com/eleven-public-prod/sample.mp3";
const mp3 = Buffer.alloc(417); mp3.set([0xff, 0xfb, 0x90, 0xc0]);
const last = (events: DomainEvent[]) => events.at(-1) as Extract<DomainEvent, { type: "voice.catalogue-preview" }>;

it("fetches a public sample without credentials, serves only cache files, and replays without another request", async () => {
  const root = await tempDir("voice-browser-"); const events: DomainEvent[] = []; let calls = 0;
  const service = new CataloguePreviewService({ root, sidecar: null, manifest: SHIPPED_MANIFEST, emit: e => events.push(e),
    fetch: async (url, init) => { calls++; assert.equal(url, sample); assert.equal(init?.headers, undefined); assert.equal(init?.redirect, "error"); return new Response(mp3); } });
  assert.equal(service.catalogue([{ ...voice, previewUrl: sample }])[0]?.preview?.kind, "sample");
  await service.request(request("one")); assert.equal(last(events).status, "ready");
  const file = last(events).file!;
  assert.deepEqual(await readFile(join(root, "audio", file)), mp3);
  assert.equal((await service.serve(file))?.contentType, "audio/mpeg");
  assert.equal(await service.serve("../settings.json"), null);
  await service.request(request("two")); assert.equal(calls, 1);
  assert.equal(last(events).file, file);
});
it("refuses arbitrary destinations and invalid audio", async () => {
  for (const url of ["http://127.0.0.1/private", "https://storage.googleapis.com.evil.test/eleven-public-prod/x", "https://user:pass@storage.googleapis.com/eleven-public-prod/x", "https://storage.googleapis.com/private/x"]) assert.equal(approvedVoiceSample(url), false);
  const events: DomainEvent[] = [];
  const service = new CataloguePreviewService({ root: await tempDir("voice-browser-"), sidecar: null, manifest: undefined, emit: e => events.push(e), fetch: async () => new Response("not audio") });
  service.catalogue([{ ...voice, previewUrl: sample }]);
  await service.request(request("bad")); assert.equal(last(events).status, "failed");
  assert.match(last(events).error!, /valid audio/);
});
it("never spends above the displayed price and queues a world-independent, ledgered generation", async () => {
  const events: DomainEvent[] = []; const enqueued: EnqueueInput[] = [];
  const model = SHIPPED_MANIFEST.models.find(m => m.provider === voice.provider && m.capability === "voice-tts")!;
  const target = { ...voice, model: model.id };
  const service = new CataloguePreviewService({ root: await tempDir("voice-browser-"), sidecar: null, manifest: SHIPPED_MANIFEST, emit: e => events.push(e),
    enqueue: async input => { enqueued.push(input); return { ...input, id: "job", status: "queued" } as Job; } });
  const row = service.catalogue([target])[0]!;
  assert.equal(row.preview?.kind, "generate"); assert.ok(row.preview!.microUsd! > 0);
  await service.request(request("cheap", { model: model.id, maxMicroUsd: 0 }));
  assert.equal(enqueued.length, 0); assert.match(last(events).error!, /price changed/);
  await service.request(request("approved", { model: model.id, maxMicroUsd: row.preview!.microUsd }));
  assert.equal(last(events).status, "queued"); assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.worldId, VOICE_PREVIEW_SCOPE);
  assert.equal(enqueued[0]?.params["text"], NARRATOR_PREVIEW_TEXT);
  assert.equal(enqueued[0]?.idempotencyKey, "approved");
  service.terminal({ ...enqueued[0], id: "job", status: "succeeded" } as Job);
  assert.equal(last(events).status, "ready");
});
it("cancellation ignores a late sample response", async () => {
  const events: DomainEvent[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const service = new CataloguePreviewService({ root: await tempDir("voice-browser-"), sidecar: null, manifest: undefined, emit: e => events.push(e),
    fetch: async () => { await held; return new Response(mp3); } });
  service.catalogue([{ ...voice, previewUrl: sample }]);
  const running = service.request(request("cancelled"));
  await service.cancel("cancelled"); release(); await running;
  assert.equal(events.some(e => e.type === "voice.catalogue-preview" && e.status === "ready"), false);
});

it("replays the latest preview state on reconnect and reports uncertain spend without resubmitting", async () => {
  const events: DomainEvent[] = []; let calls = 0; let input!: EnqueueInput;
  const service = new CataloguePreviewService({ root: await tempDir("voice-browser-"), sidecar: null, manifest: SHIPPED_MANIFEST,
    emit: e => events.push(e), enqueue: async value => { calls++; input = value; return { ...value, id: "job", status: "queued" } as Job; } });
  const model = SHIPPED_MANIFEST.models.find(m => m.provider === "elevenlabs" && m.capability === "voice-tts")!;
  service.catalogue([{ ...voice, model: model.id }]);
  await service.request(request("uncertain", { model: model.id }));
  service.observeJob({ ...input, id: "job", status: "needs-reconciliation" } as Job);
  assert.equal(last(events).status, "failed"); assert.match(last(events).error!, /already have been charged/);
  assert.deepEqual(service.initialEvents(), [last(events)]); assert.equal(calls, 1);
});

it("a paid preview lands and replays with exactly one real queue ledger entry, without a world", async () => {
  const root = await tempDir("voice-browser-queue-"); const events: DomainEvent[] = []; const ledger: LedgerEntry[] = [];
  const fake = new FakeProvider({}); fake.inlineArtifacts = [{ name: "sample.mp3", contentType: "audio/mpeg", data: mp3 }];
  let service!: CataloguePreviewService;
  const queue = new JobQueue({ journalPath: join(root, "jobs.jsonl"), clients: { elevenlabs: fake }, getKey: async () => "test-key", emit: () => {},
    ledger: { readJobIds: async () => new Set(ledger.map(e => e.jobId)), has: async id => ledger.some(e => e.jobId === id), append: async e => { ledger.push(e); } },
    landInWorld: async (scope, fn) => { assert.equal(scope, VOICE_PREVIEW_SCOPE); await fn(root); return true; },
    onTerminal: job => service.terminal(job), pollIntervalMs: 5, baseIntervalMs: 1 });
  service = new CataloguePreviewService({ root, sidecar: null, manifest: SHIPPED_MANIFEST, enqueue: input => queue.enqueue(input), cancel: id => queue.cancel(id), emit: e => events.push(e) });
  const model = SHIPPED_MANIFEST.models.find(m => m.provider === "elevenlabs" && m.capability === "voice-tts")!;
  const row = service.catalogue([{ ...voice, model: model.id }])[0]!;
  await queue.start();
  try {
    await service.request(request("01J8F3K2QW9VZX4N7M0RTYB6P1", { model: model.id, maxMicroUsd: row.preview!.microUsd }));
    await until(() => last(events).status === "ready", "preview audio ready", 30_000);
    assert.equal(ledger.length, 1); assert.equal(ledger[0]?.worldId, VOICE_PREVIEW_SCOPE);
    await service.request(request("01J8F3K2QW9VZX4N7M0RTYB6P2", { model: model.id, maxMicroUsd: 0 }));
    assert.equal(last(events).status, "ready"); assert.equal(ledger.length, 1);
    assert.equal(queue.listJobs().length, 1);
  } finally { service.close(); queue.dispose(); }
});

it("Settings local previews work without an open world and their media requires session authentication", async () => {
  const root = await tempDir("voice-browser-coordinator-"); const events: DomainEvent[] = [];
  const bytes = Buffer.alloc(60); bytes.write("RIFF"); bytes.writeUInt32LE(52, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(16, 40);
  let syntheses = 0;
  const provider = new FsWorldProvider(root);
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "test", changeLogPath: join(root, "changes.jsonl"), observeEvent: e => events.push(e),
    voice: { localPresets: [], cloudSources: [], sidecar: { health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
      listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
      synthesize: async () => { syntheses++; return bytes; }, transcribe: async () => "" } } });
  const send = (message: unknown) => (coordinator as unknown as { handleClientMessage(message: unknown): Promise<void> }).handleClientMessage(message);
  try {
    const { port, token } = await coordinator.start();
    await send({ kind: "voice-catalogue" });
    await send({ kind: "catalogue-voice-preview", requestId: "01J8F3K2QW9VZX4N7M0RTYB6P1", provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", maxMicroUsd: 0 });
    const ready = events.findLast(e => e.type === "voice.catalogue-preview" && e.status === "ready") as Extract<DomainEvent, { type: "voice.catalogue-preview" }>;
    assert.ok(ready?.file); assert.equal(provider.openStore(), null);
    const url = `http://127.0.0.1:${port}/voice-preview-media/${ready.file}`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-3" } });
    assert.equal(response.status, 206); assert.equal(await response.text(), "RIFF");
    await send({ kind: "catalogue-voice-preview", requestId: "01J8F3K2QW9VZX4N7M0RTYB6P2", provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", maxMicroUsd: 0 });
    assert.equal(syntheses, 1);
  } finally { await coordinator.stop(); }
});

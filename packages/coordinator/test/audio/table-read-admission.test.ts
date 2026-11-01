import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { legacySceneView, type ClientMessage, type DomainEvent, type ProviderStatus } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import type { ReadModel } from "../../src/read-model.js";
import type { ChangeLog } from "../../src/change-log.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { WorldStore } from "../../src/world/store.js";
import { planTableRead } from "../../src/audio/table-read.js";
import { audioWorldPath } from "../../src/audio/storage.js";
import { SHIPPED_MANIFEST } from "../../../providers/src/manifest-data.js";
import { makeTempWorld } from "../world/helpers.js";
import { wav } from "./helpers.js";

for (const change of ["retired", "selected", "cached", "unchanged"] as const) it(`rechecks ${change} cloud work after local table-read synthesis (#1380)`, async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const bundle = structuredClone(store.getBundle()); store.getBundle = () => bundle;
  const production = bundle.productions.find(p => p.scenes.length)!;
  const scene = legacySceneView(production.scenes[0]!);
  const cloud = bundle.sheets.find(s => s.id === "maren-kest")!;
  const local = bundle.sheets.find(s => s.type === "character" && s.id !== cloud.id)!;
  cloud.voice = { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "cloud", assignedAtVersion: 1 };
  local.voice = { provider: "kokoro", model: "kokoro-82m", voiceId: "bf_emma", assignedAtVersion: 1 };
  scene.script = { blocks: [{ id: "local", kind: "dialogue", speaker: local.id, text: "Local first." },
    { id: "cloud", kind: "dialogue", speaker: cloud.id, text: "Cloud later." }] };
  scene.shots = [{ ...scene.shots[0]!, covers: ["local", "cloud"].map(blockId => ({ blockId, textDigest: "sha256:12345678" })) }];
  production.scenes = [scene];
  const providers: ProviderStatus[] = (["kokoro", "elevenlabs"] as const).map(id => ({ id, configured: true, validation: "valid", fault: null, probes: [{ capability: "voice-tts", available: true }] }));
  const before = await planTableRead(store, production.meta.id, scene.id, SHIPPED_MANIFEST, [], providers);
  assert.equal(before.local.length, 1); assert.equal(before.cloud.length, 1);
  const events: DomainEvent[] = [], admitted: EnqueueInput[] = [];
  const coordinator = new Coordinator({ adapter: null, manifest: SHIPPED_MANIFEST, appVersion: "test", changeLogPath: join(store.dir, "test-changes.jsonl"),
    provider: { openStore: () => store, listWorlds: async () => [], loadWorld: async () => bundle }, observeEvent: event => events.push(event) });
  const host = coordinator as unknown as {
    readModel: ReadModel; changeLog: ChangeLog;
    voiceService: { localSpeechConfigured: boolean; synthesizePerformance(): Promise<Uint8Array> };
    requireEnabledSpeechReader(): Promise<void>;
    enqueueBatch(requestId: string, command: string, inputs: readonly EnqueueInput[]): Promise<{ accepted: boolean }>;
    handleClientMessage(message: ClientMessage): Promise<void>;
  };
  t.after(() => host.changeLog.drain());
  host.readModel.seedAppConfig({ providers });
  host.requireEnabledSpeechReader = async () => {};
  host.enqueueBatch = async (_id, _command, inputs) => { admitted.push(...inputs); return { accepted: true }; };
  host.voiceService = { localSpeechConfigured: true, synthesizePerformance: async () => {
    if (change === "retired") cloud.retired = true;
    if (change === "selected") production.performanceReview.selections[before.cloud[0]!.target.id!] = { performanceId: "pf_" + "0".repeat(26) } as never;
    if (change === "cached") {
      const bytes = new Uint8Array(417 * 3);
      for (let offset = 0; offset < bytes.length; offset += 417) bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
      await store.ownedWrite(async () => writeFile(await audioWorldPath(store.dir, String(before.cloud[0]!.params.tableReadCacheFile), true), bytes));
    }
    return wav([1, 2, 3, 4]);
  } };
  await host.handleClientMessage({ kind: "prepare-table-read", requestId: "0".repeat(26), worldId: store.worldId,
    productionId: production.meta.id, sceneId: scene.id, confirmationToken: before.plan.confirmationToken, confirmedMicroUsd: before.plan.totalEstimatedMicroUsd });
  assert.equal(admitted.length, change === "unchanged" ? 1 : 0);
  const result = events.filter(event => event.type === "rehearsal.result").at(-1)!;
  assert.equal(result.status, "planned");
  if (change === "unchanged") assert.equal(admitted[0]!.idempotencyKey, before.cloud[0]!.idempotencyKey, "local progress retains the confirmed spend identity");
  else assert.match(result.reason, /Review the updated plan/);
});

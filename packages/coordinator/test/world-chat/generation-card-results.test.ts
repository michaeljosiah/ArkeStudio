import assert from "node:assert/strict";
import { it } from "node:test";
import { JobSchema, newId, ulid } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { BenchStore, sessionDir } from "../../src/bench/store.js";
import { generationCardResults } from "../../src/world-chat/generation-card-results.js";
import { makeTempWorld } from "../world/helpers.js";

const AT = "2026-10-04T19:00:00Z";
it("projects a finalized Bench result during other in-flight work, only for its recorded job", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const sessionId = newId("sess"), takeId = newId("tk"), jobId = newId("jb");
  const bench = new BenchStore(sessionDir(store.dir, sessionId)); await bench.create(sessionId, AT);
  await bench.append({ type: "takes-reserved", takes: [{ id: takeId, n: 1, requestId: "test", createdAt: AT,
    request: { mode: "music", brief: "A quiet score", provider: "fal", model: "test-music", references: [], keyframes: [], params: { kind: "music", lyrics: "", count: 1 } } }] }, { at: AT });
  await bench.append({ type: "take-job", takeId, jobId }, { at: AT });
  await bench.append({ type: "take-completed", takeId, media: { file: "score.wav", hash: `sha256:${"a".repeat(64)}` }, completedAt: AT }, { at: AT });
  const job = JobSchema.parse({ id: jobId, idempotencyKey: ulid(), worldId: store.worldId, target: { kind: "bench-take", id: `${sessionId}/${takeId}` }, capability: "music",
    provider: "fal", model: "test-music", params: {}, estimatedMicroUsd: 0, status: "succeeded", createdAt: AT, updatedAt: AT,
    finalization: { status: "complete", error: null, updatedAt: AT } });
  const result = generationCardResults(store, [job, { ...job, id: newId("jb"), status: "running" }]);
  assert.equal(result.length, 1); assert.equal(result[0]!.medium, "audio"); assert.equal(result[0]!.id, takeId);
  assert.match(result[0]!.mediaPath!, /score.wav$/);
  assert.deepEqual(generationCardResults(store, [{ ...job, id: newId("jb") }]), []);
  assert.deepEqual(generationCardResults(store, [{ ...job, worldId: ulid() }]), []);
  assert.deepEqual(generationCardResults(store, [{ ...job, finalization: { status: "pending", error: null, updatedAt: AT } }]), []);
  await bench.append({ type: "take-discarded", takeId }, { at: AT });
  assert.deepEqual(generationCardResults(store, [job]), []);
});
it("projects only the finalized cache address acknowledged by the job and refuses host addresses", async t => {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const file = ".cache/table-reads/line.wav";
  const job = JobSchema.parse({ id: newId("jb"), idempotencyKey: ulid(), worldId: store.worldId, productionId: store.getBundle().productions[0]!.meta.id,
    target: { kind: "table-read-cache", id: "line" }, capability: "voice-tts", provider: "google", model: "test-voice", params: { tableReadCacheFile: file },
    landedFiles: [file], estimatedMicroUsd: 0, status: "succeeded", createdAt: AT, updatedAt: AT });
  assert.equal(generationCardResults(store, [job])[0]?.description, "Scene rehearsal");
  assert.deepEqual(generationCardResults(store, [{ ...job, landedFiles: [] }]), []);
  for (const file of ["C:/secret.wav", "../secret.wav", "https://example.com/a.wav"]) {
    assert.deepEqual(generationCardResults(store, [{ ...job, params: { tableReadCacheFile: file }, landedFiles: [file] }]), []);
  }
});

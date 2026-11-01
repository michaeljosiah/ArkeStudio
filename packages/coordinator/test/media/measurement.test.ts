import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JobSchema, TakeMediaInfoRecordSchema } from "@arke-studio/contracts";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import { measureProductionMedia } from "../../src/media/measurement.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { sha256 } from "../../src/world/text-files.js";
const clock = () => "2026-11-01T12:00:00.000Z";
const info = { durationSec: 12, hasAudio: true, hasVideo: true };
async function fixture() {
  const dir = await makeTempWorld(), path = "productions/saltlight/incoming/measurement/clip.mp4";
  await mkdir(join(dir, "productions/saltlight/incoming/measurement"), { recursive: true });
  await writeFile(join(dir, path), "immutable paid media");
  const store = await WorldStore.open(dir, { clock }); closeOnCleanup(() => store.close());
  const job = JobSchema.parse({ id: "jb_01J8E0000000000000000000P1", worldId: WORLD_ID, idempotencyKey: WORLD_ID, productionId: "saltlight",
    target: { kind: "shot", id: "sh_12" }, provider: "fal", model: "video", capability: "video", params: {}, estimatedMicroUsd: 1, status: "succeeded",
    landedFiles: [path], landing: { dir: "productions/saltlight/incoming/measurement" }, createdAt: clock(), updatedAt: clock() });
  return { dir, store, job };
}
it("ordinary arrival records measured metadata beside an unchanged take", async () => {
  const { store, job } = await fixture(); let calls = 0;
  const probe = { durationSec: async () => 12, info: async () => { calls++; return info; } };
  const [take] = await recordTakesFromJob(store, job, null, { mediaProbe: probe }); assert.ok(take);
  const prefix = `productions/saltlight/takes/${take.id}`, raw = await readFile(join(store.dir, prefix, "take.json"), "utf8");
  const record = TakeMediaInfoRecordSchema.parse(JSON.parse(await readFile(join(store.dir, prefix, "media-info.json"), "utf8")));
  assert.deepEqual(record.mediaInfo, info); assert.equal(record.sourceHash, sha256("immutable paid media"));
  assert.deepEqual(store.getBundle().productions.find(p => p.meta.id === "saltlight")!.takeMediaInfo[take.id]?.mediaInfo, info);
  assert.deepEqual(await measureProductionMedia(store, "saltlight", { kind: "take", takeId: take.id }, probe, take.mediaHash), { status: "measured", info });
  assert.equal(calls, 1, "a current measurement is reused"); assert.equal(await readFile(join(store.dir, prefix, "take.json"), "utf8"), raw);
});
it("a failed probe preserves paid media and can be retried locally; repeated presses coalesce", async () => {
  const { store, job } = await fixture(), failures: string[] = [];
  const [take] = await recordTakesFromJob(store, job, null, { mediaProbe: { durationSec: async () => null, info: async () => null }, onMediaUnavailable: reason => failures.push(reason) });
  assert.ok(take); assert.deepEqual(failures, ["probe-failed"]);
  const prefix = `productions/saltlight/takes/${take.id}`, raw = await readFile(join(store.dir, prefix, "take.json"), "utf8");
  let calls = 0; const probe = { durationSec: async () => 12, info: async () => { calls++; return info; } };
  const a = measureProductionMedia(store, "saltlight", { kind: "take", takeId: take.id }, probe), b = measureProductionMedia(store, "saltlight", { kind: "take", takeId: take.id }, probe);
  assert.equal(a, b); assert.equal((await a).status, "measured"); assert.equal(calls, 1);
  assert.equal(await readFile(join(store.dir, prefix, "take.json"), "utf8"), raw);
  assert.equal(await readFile(join(store.dir, prefix, take.media!), "utf8"), "immutable paid media");
});
it("changed bytes during probing refuse the measurement without changing take history", async () => {
  const { store, job } = await fixture(), [take] = await recordTakesFromJob(store, job, null); assert.ok(take);
  const prefix = `productions/saltlight/takes/${take.id}`, raw = await readFile(join(store.dir, prefix, "take.json"), "utf8");
  const result = await measureProductionMedia(store, "saltlight", { kind: "take", takeId: take.id }, { durationSec: async () => 12,
    info: async () => { await writeFile(join(store.dir, prefix, take.media!), "changed bytes"); return info; } });
  assert.deepEqual(result, { status: "failed", reason: "source-changed" });
  await assert.rejects(readFile(join(store.dir, prefix, "media-info.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(store.dir, prefix, "take.json"), "utf8"), raw);
});
it("duration-only hosts cannot persist a false claim of silence", async () => {
  const { store, job } = await fixture(), [take] = await recordTakesFromJob(store, job, null); assert.ok(take);
  assert.deepEqual(await measureProductionMedia(store, "saltlight", { kind: "take", takeId: take.id }, { durationSec: async () => 12 }), { status: "failed", reason: "not-configured" });
  await assert.rejects(readFile(join(store.dir, `productions/saltlight/takes/${take.id}/media-info.json`)), { code: "ENOENT" });
});

it("segment retries measure the parent once and create no child media or metadata copies", async () => {
  const { store, job } = await fixture();
  job.target = { kind: "scene-pass", id: "sc_04", coversShots: ["sh_12", "sh_13"] };
  job.params.shotPlan = [{ shotId: "sh_12", number: 12, startSec: 0, endSec: 6 }, { shotId: "sh_13", number: 13, startSec: 6, endSec: 12 }];
  const [parent, child] = await recordTakesFromJob(store, job, null); assert.ok(parent && child);
  let calls = 0;
  assert.equal((await measureProductionMedia(store, "saltlight", { kind: "take", takeId: child.id }, { durationSec: async () => 12, info: async () => { calls++; return info; } })).status, "measured");
  assert.equal(calls, 1);
  assert.equal(store.getBundle().productions.find(p => p.meta.id === "saltlight")!.takeMediaInfo[parent.id]!.mediaInfo.durationSec, 12);
  await assert.rejects(readFile(join(store.dir, `productions/saltlight/takes/${child.id}/media-info.json`)), { code: "ENOENT" });
});

it("a filed artifact is measured in place without rewriting its media, hash or identity", async () => {
  const dir = await makeTempWorld(), file = "artifacts/harbour-bells.wav", sidecarPath = join(dir, `${file}.json`);
  const bytes = await readFile(join(dir, file)), sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  sidecar.hash = sha256(bytes); delete sidecar.mediaInfo;
  await writeFile(sidecarPath, JSON.stringify(sidecar));
  const store = await WorldStore.open(dir, { clock }); closeOnCleanup(() => store.close());
  const result = await measureProductionMedia(store, "saltlight", { kind: "artifact", artifactId: sidecar.id }, { durationSec: async () => 12, info: async () => ({ durationSec: 12, hasAudio: true, hasVideo: false }) }, sidecar.hash);
  assert.equal(result.status, "measured");
  const after = JSON.parse(await readFile(sidecarPath, "utf8"));
  assert.deepEqual(after, { ...sidecar, mediaInfo: { durationSec: 12, hasAudio: true, hasVideo: false } });
  assert.deepEqual(await readFile(join(dir, file)), bytes);
});

it("shutdown cancellation reaches the local probe and publishes no late metadata", async () => {
  const { store, job } = await fixture(), [take] = await recordTakesFromJob(store, job, null); assert.ok(take);
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const cancel = new AbortController();
  const pending = measureProductionMedia(store, "saltlight", { kind: "take", takeId: take.id }, { durationSec: async () => 12,
    info: async (_path, options) => { started(); return new Promise(resolve => options!.signal!.addEventListener("abort", () => resolve(null), { once: true })); } }, undefined, cancel.signal);
  await ready; cancel.abort();
  assert.deepEqual(await pending, { status: "failed", reason: "cancelled" });
  await assert.rejects(readFile(join(store.dir, `productions/saltlight/takes/${take.id}/media-info.json`)), { code: "ENOENT" });
});

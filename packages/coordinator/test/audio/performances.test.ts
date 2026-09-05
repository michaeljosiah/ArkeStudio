import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFile, readFile, rename, lstat } from "node:fs/promises";
import { join } from "node:path";
import { orderedShots, resolvePerformanceLine, ulid } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { purgePerformance } from "../../src/audio/performance-purge.js";
import { keepPerformanceRecording } from "../../src/audio/performances.js";
import { createAudioMediaTools } from "../../src/audio/media-tools.js";
import { makeTempWorld } from "../world/helpers.js";
import { wav } from "./helpers.js";

it("keeps one immutable scratch through retries and reopen without selecting picture or voice", async t => {
  const dir = await makeTempWorld();
  let store = await WorldStore.open(dir); t.after(() => store.close());
  const bundle = store.getBundle(), production = bundle.productions[0]!;
  const scene = production.scenes.find(scene => orderedShots(scene).some(s => resolvePerformanceLine(scene, s.id).ok))!;
  const shot = orderedShots(scene).find(s => resolvePerformanceLine(scene, s.id).ok)!;
  const originalSelections = structuredClone(production.selections), originalKits = structuredClone(bundle.referenceKits);
  const bytes = wav(Array.from({ length: 48000 }, (_, i) => Math.round(Math.sin(i / 10) * 3000)));
  const source = join(dir, "capture.webm"); await writeFile(source, bytes);
  let claims = 0;
  const spool = { async claim() { claims++; return { absolutePath: source, contentType: "audio/webm", sizeBytes: bytes.length }; }, async discard() {} };
  const tools = createAudioMediaTools({ async run(tool, args) {
    let stdout = "";
    if (tool === "ffprobe") stdout = JSON.stringify({ format: { duration: "1", format_name: "wav" }, streams: [{ codec_type: "audio",
      codec_name: "pcm_s16le", sample_fmt: "s16", sample_rate: "48000", channels: 1, bits_per_sample: 16 }] });
    else if (args[0] === "-version") stdout = "ffmpeg version test\n";
    else await writeFile(args.at(-1)!, bytes);
    return { code: 0, stdout: Buffer.from(stdout), stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false };
  } });
  const request = { kind: "keep-performance-recording" as const, requestId: ulid(), worldId: store.worldId, productionId: production.meta.id,
    sceneId: scene.id, shotId: shot.id, expectedSceneVersion: scene.version, spoolId: "00000000-0000-4000-8000-000000000000", captureBasis: "self" as const };
  const record = await keepPerformanceRecording(store, tools, spool, request);
  assert.equal(record.kind, "scratch"); assert.equal(record.transcript?.status, "unavailable");
  assert.deepEqual(await keepPerformanceRecording(store, tools, spool, request), record);
  assert.equal(claims, 1);
  await store.close(); store = await WorldStore.open(dir);
  const current = store.getBundle().productions.find(p => p.meta.id === production.meta.id)!;
  assert.deepEqual(current.performances, [record]);
  assert.deepEqual(current.selections, originalSelections);
  assert.deepEqual(store.getBundle().referenceKits, originalKits);
  assert.deepEqual(await readFile(join(dir, `productions/${production.meta.id}/performances/${record.id}/${record.file}`)), Buffer.from(bytes));
  await assert.rejects(keepPerformanceRecording(store, tools, spool, { ...request, requestId: ulid(), expectedSceneVersion: scene.version + 1 }), /scene changed/);
  assert.equal(claims, 1);
  await assert.rejects(purgePerformance(store, production.meta.id, record.id, [{ worldId: store.worldId, params: { sourcePerformanceId: record.id } }] as never), /referenced/);
  const performanceDir = join(dir, `productions/${production.meta.id}/performances/${record.id}`);
  await store.ownedWrite(() => rename(performanceDir, join(dir, `.staging/performance-purge/${record.id}`)));
  await store.close(); store = await WorldStore.open(dir);
  assert.equal(store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.performances.length, 1, "an unjournalled purge restores its manifest and bytes");
  await purgePerformance(store, production.meta.id, record.id, []);
  assert.equal(await lstat(performanceDir).catch(() => null), null);
  await store.close(); store = await WorldStore.open(dir);
  assert.equal(store.getBundle().productions.find(p => p.meta.id === production.meta.id)!.performances.length, 0);
  await assert.rejects(keepPerformanceRecording(store, tools, spool, request), /purged/);
  assert.equal(claims, 1, "a tombstone prevents stale Keep from claiming again");
});

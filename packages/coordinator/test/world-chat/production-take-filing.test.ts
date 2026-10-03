import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type WorldChatProductionTakeFileAction, type BenchRequestSnapshot } from "@arke-studio/contracts";
import { ProductionTakeFiling } from "../../src/world-chat/production-take-filing.js";
import { BenchStore, sessionDir, sessionMediaDir } from "../../src/bench/store.js";
import { WorldStore } from "../../src/world/store.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { clearShotFrame } from "../../src/takes/boundary.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";

const AT = "2026-10-03T12:00:00.000Z";
async function setup(mode: "image" | "video" = "image") {
  const dir = await makeTempWorld();
  const world = await WorldStore.open(dir, { clock: () => AT });
  closeOnCleanup(() => world.close());
  const sessionId = newId("sess");
  const takeId = newId("tk");
  const bench = new BenchStore(sessionDir(dir, sessionId));
  await bench.create(sessionId, AT);
  const request: BenchRequestSnapshot = { mode, brief: "A Bench exploration", provider: "fal", model: "test-model",
    references: [], keyframes: [], params: mode === "image" ? { kind: "image", count: 1, aspect: "16:9" } : { kind: "video", durationSec: 5, aspect: "16:9", sound: true } };
  await bench.append({ type: "takes-reserved", takes: [{ id: takeId, n: 1, requestId: "test", request, createdAt: AT }] }, { at: AT });
  const file = mode === "image" ? "frame.png" : "clip.mp4";
  const box = (name: string) => [0, 0, 0, 8, ...new TextEncoder().encode(name)];
  const bytes = mode === "image" ? encodePng(solidImage(4, 4, [20, 40, 60, 255])) : Uint8Array.from([...box("ftyp"), ...box("moov"), ...box("mdat")]);
  await mkdir(join(dir, sessionMediaDir(sessionId, takeId)), { recursive: true });
  await writeFile(join(dir, sessionMediaDir(sessionId, takeId), file), bytes);
  await bench.append({ type: "take-completed", takeId, media: { file, hash: "sha256:deadbeefdeadbeef", ...(mode === "video" ? { info: { durationSec: 5, hasAudio: true, hasVideo: true } } : {}) }, completedAt: AT }, { at: AT });
  const ports = { bench: async () => ({ session: (await bench.fold())!, store: bench }) };
  const service = () => new ProductionTakeFiling(world, ports);
  const action: WorldChatProductionTakeFileAction["action"] = { kind: "production-take-file", productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12",
    sessionId, takeId, checkReceiptIds: [newId("check")] };
  return { dir, world, bench, service, action, file, bytes };
}

describe("Production Chat Bench take filing (SPEC-051 R-7, R-13)", () => {
  for (const mode of ["image", "video"] as const) it(`reviews and files a loose ${mode} take through acceptance, preserving its source`, async () => {
    const h = await setup(mode);
    const id = newId("act");
    const before = structuredClone(h.world.getBundle().productions.find(p => p.meta.id === "saltlight")!);
    const sourceBefore = structuredClone((await h.bench.fold())!.takes[0]!.request);
    const card = await h.service().prepare(h.action, id);
    assert.equal(card.family, "take-review");
    assert.equal(card.mediaKind, mode);
    assert.ok(card.mediaPath?.includes(h.action.takeId));
    assert.deepEqual(h.world.getBundle().productions.find(p => p.meta.id === "saltlight")!.selections, before.selections);
    const filed = await h.service().file(h.action, id, () => null);
    await h.world.reload();
    const production = h.world.getBundle().productions.find(p => p.meta.id === "saltlight")!;
    assert.ok(filed.takes.every(t => t.coversShots.includes("sh_12")));
    assert.equal(filed.takes[0]!.prompt, sourceBefore.brief);
    assert.deepEqual(filed.takes[0]!.params, sourceBefore.params);
    assert.equal(filed.takes[0]!.provenance.canonRevision, 0, "filing cannot invent provenance for a loose Bench generation");
    assert.equal(production.scenes.find(s => s.id === "sc_04")!.version, before.scenes.find(s => s.id === "sc_04")!.version);
    if (mode === "image") assert.equal(production.selections.sh_12!.startFrameArtifactId, filed.artifactId);
    else assert.equal(production.selections.sh_12!.acceptedTakeId, filed.productionTakeIds.at(-1));
    assert.deepEqual((await h.bench.fold())!.takes[0]!.request, sourceBefore);
    assert.deepEqual(await readFile(join(h.dir, sessionMediaDir(h.action.sessionId, h.action.takeId), h.file)), Buffer.from(h.bytes));
    assert.deepEqual((await h.service().file(h.action, id, () => "Changed after completed filing")).productionTakeIds, filed.productionTakeIds);
    await rm(join(h.dir, sessionMediaDir(h.action.sessionId, h.action.takeId), h.file));
    assert.deepEqual((await h.service().reconcile(id))?.productionTakeIds, filed.productionTakeIds, "production metadata recovers completion even after source cleanup");
    if (mode === "image") {
      const selectedVideo = production.selections.sh_12!.acceptedTakeId;
      const count = production.takes.length;
      assert.equal((await clearShotFrame(h.world, "saltlight", "sh_12", { precondition: () => null })).ok, true);
      const after = h.world.getBundle().productions.find(p => p.meta.id === "saltlight")!;
      assert.equal(after.selections.sh_12!.startFrameArtifactId, null);
      assert.equal(after.selections.sh_12!.acceptedTakeId, selectedVideo);
      assert.equal(after.takes.length, count);
    }
  });
  it("refuses changed media and source settings and honors a destination fence inside the write gate", async () => {
    const h = await setup();
    const id = newId("act");
    await h.service().prepare(h.action, id);
    const path = join(h.dir, sessionMediaDir(h.action.sessionId, h.action.takeId), h.file);
    await writeFile(path, encodePng(solidImage(4, 4, [90, 80, 70, 255])));
    await assert.rejects(h.service().file(h.action, id, () => null), /changed/);
    await writeFile(path, h.bytes);
    const events = await readFile(h.bench.eventsPath, "utf8");
    await writeFile(h.bench.eventsPath, events.replace("A Bench exploration", "Changed source prompt"));
    await assert.rejects(h.service().file(h.action, id, () => null), /changed/);
    await writeFile(h.bench.eventsPath, events);
    await assert.rejects(h.service().file(h.action, id, () => "The selection changed"), /selection changed/);
    const fresh = newId("act");
    await h.service().prepare(h.action, fresh);
    await h.service().abandon(fresh);
    await assert.rejects(h.service().file(h.action, fresh, () => null), /unavailable/);
    assert.equal((await h.bench.fold())!.takes[0]!.filedTakeIds, undefined);
  });
});

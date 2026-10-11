import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultEffectClip, type ExportPlan } from "@arke-studio/contracts";
import { runEffectExport } from "../../src/productions/editor-effect-export.js";
import { WorldStore } from "../../src/world/store.js";
import type { EffectRasterHost } from "../../src/media/node-effect-renderer.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { tempDir } from "../tmp.js";

const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", seed: 42, startFrame: 0, durationFrames: 24 });
const plan = (): ExportPlan => ({ preset: "review-cut", frameRate: 24, totalSec: 1, items: [], overlays: [], audio: [], effectRender: {
  rendererVersion: "software-rgba-v1", width: 64, height: 64, frameRate: 24, startFrame: 0, endFrame: 24,
  effectLayers: [{ effect, trackId: "tr_fx", trackOrder: 0 }], issues: [], pictureLayers: [{ clipId: "cl_picture", trackId: "tr_picture", order: 0,
    kind: "media", label: "picture", path: "artifacts/effect-picture.png", still: true, sourceInSec: 0, startFrame: 0, endFrame: 24, fit: "contain", matte: "source-alpha" }] } });
async function world() { const store = await WorldStore.open(await makeTempWorld()); closeOnCleanup(() => store.close());
  await writeFile(join(store.dir, "artifacts/effect-picture.png"), "source-v1"); return store; }
const host: EffectRasterHost = { probePicture: async () => ({ width: 128, height: 64 }),
  renderAlpha: async request => { assert.equal(request.startFrame, 0); await writeFile(request.output, "alpha", { flag: "wx" }); } };
const runner: FfmpegRunner = { slateFont: "font.ttf", run: async args => { await writeFile(args.at(-1)!, "video"); } };

test("effect export freezes plan, measures source geometry, publishes under ownership and removes derived files", async () => {
  const store = await world(), authored = plan();
  authored.effectRender!.pictureLayers.push({ ...authored.effectRender!.pictureLayers[0]!, clipId: "outside", path: "artifacts/does-not-exist.png", startFrame: 24, endFrame: 48 });
  const before = JSON.stringify(authored);
  const handle = runEffectExport(store, authored, "effects.mp4", runner, host, () => {}, { name: "effects.srt", text: "subtitle" });
  assert.equal((await handle.done).status, "done");
  assert.equal(JSON.stringify(authored), before);
  assert.equal(await readFile(join(store.dir, "exports/effects.mp4"), "utf8"), "video");
  assert.equal(await readFile(join(store.dir, "exports/effects.srt"), "utf8"), "subtitle");
  assert.deepEqual(await readdir(join(store.dir, ".cache/exports")), []);
});

test("changed source bytes refuse publication and clean the video, sidecar, alpha and graph", async () => {
  const store = await world();
  const changed: FfmpegRunner = { ...runner, run: async args => { await runner.run(args, () => {}, new AbortController().signal);
    await writeFile(join(store.dir, "artifacts/effect-picture.png"), "source-v2"); } };
  const result = await runEffectExport(store, plan(), "changed.mp4", changed, host, () => {}, { name: "changed.srt", text: "subtitle" }).done;
  assert.equal(result.status, "failed"); if (result.status === "failed") assert.match(result.error, /source changed/);
  assert.deepEqual(await readdir(join(store.dir, ".cache/exports")), []);
  assert.ok(!(await readdir(join(store.dir, "exports"))).includes("changed.mp4"));
  assert.ok(!(await readdir(join(store.dir, "exports"))).includes("changed.srt"));
});

test("world close cancels a running effect encode before publication", async () => {
  const store = await world();
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const slow: FfmpegRunner = { ...runner, run: async (_args, _progress, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); started();
  }) };
  const job = runEffectExport(store, plan(), "closed.mp4", slow, host, () => {});
  await ready; await store.close();
  assert.equal((await job.done).status, "cancelled");
  assert.deepEqual(await readdir(join(store.dir, ".cache/exports")), []);
});

test("missing host and unready reaction have named refusals, with no ordinary-export fallback", async () => {
  const store = await world();
  const missing = await runEffectExport(store, plan(), "missing.mp4", runner, undefined, () => {}).done;
  assert.equal(missing.status, "failed"); if (missing.status === "failed") assert.match(missing.error, /no deterministic effect renderer/);
  const reactive = plan(); reactive.effectRender!.effectLayers[0]!.effect = { ...effect, reaction: { ...effect.reaction, enabled: true } };
  const unready = await runEffectExport(store, reactive, "unready.mp4", runner, host, () => {}).done;
  assert.equal(unready.status, "failed"); if (unready.status === "failed") assert.match(unready.error, /Audio reaction analysis is required/);
});

test("a redirected cache is refused without deleting the other directory's matching file", async () => {
  const store = await world(), outside = await tempDir("arke-effect-outside-");
  await mkdir(join(outside, "exports"));
  const id = "ex_01ARZ3NDEKTSV4RRFFQ69G5FAV", marker = join(outside, "exports", `${id}.mp4`);
  await writeFile(marker, "belongs-to-another-job");
  await symlink(outside, join(store.dir, ".cache"), process.platform === "win32" ? "junction" : "dir");
  const result = await runEffectExport(store, plan(), "refused.mp4", runner, host, () => {}, undefined, id).done;
  assert.equal(result.status, "failed");
  assert.equal(await readFile(marker, "utf8"), "belongs-to-another-job");
});


test("ready reaction freezes its manifest and fences muted descriptor sources omitted from the export sound graph", async () => {
  const { analysisFixture } = await import("../media/effect-analysis-fixture.js");
  const { hashMediaFile } = await import("../../src/media/node-media-host.js");
  const store = await world(), authored = plan(), source = "artifacts/muted-source.wav";
  await writeFile(join(store.dir, source), "audio-v1");
  const manifest = analysisFixture({ sources: [{ path: source, sha256: await hashMediaFile(join(store.dir, source), new AbortController().signal) }] });
  authored.effectRender!.effectLayers[0]!.effect = { ...effect, audioInput: { kind: "composition-mix" }, reaction: { ...effect.reaction, enabled: true } };
  let checked = false;
  const reactive: EffectRasterHost = { ...host, renderAlpha: async request => {
    assert.equal(request.manifestsByKey?.[manifest.manifestKey]?.features.energy[0], .7);
    checked = true; await host.renderAlpha(request);
  } };
  const job = runEffectExport(store, authored, "ready.mp4", runner, reactive, () => {}, undefined, undefined, new Map([[effect.id, manifest]]));
  manifest.features.energy[0] = 0;
  assert.equal((await job.done).status, "done"); assert.ok(checked);
  const ready = analysisFixture({ sources: [{ path: source, sha256: await hashMediaFile(join(store.dir, source), new AbortController().signal) }] });
  const changed: FfmpegRunner = { ...runner, run: async args => { await runner.run(args, () => {}, new AbortController().signal); await writeFile(join(store.dir, source), "audio-v2"); } };
  const refused = await runEffectExport(store, authored, "changed-audio.mp4", changed, host, () => {}, undefined, undefined, new Map([[effect.id, ready]])).done;
  assert.equal(refused.status, "failed"); if (refused.status === "failed") assert.match(refused.error, /source changed/);
  const stale = await runEffectExport(store, authored, "stale-audio.mp4", runner, host, () => {}, undefined, undefined, new Map([[effect.id, ready]])).done;
  assert.equal(stale.status, "failed"); if (stale.status === "failed") assert.match(stale.error, /source changed before export/);
  assert.deepEqual(await readdir(join(store.dir, ".cache/exports")), []);
});

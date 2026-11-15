import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CharacterAudioPlanSchema, JobSchema, masterAudioBinding, newId, orderedShots, planScene, seedSpinePictureTimeline, SPINE_SONG_SOURCE, ulid,
  type Job, type ManifestModel, type ModelManifest, type ProductionBundle, type ProductionSpine,
} from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot, makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { fakeJobQueue } from "../fake-job-queue.js";
import { wav } from "./helpers.js";
import { audioHash } from "../../src/audio/qc.js";
import { createAudioMediaTools } from "../../src/audio/media-tools.js";
import { readCharacterAudioInputs } from "../../src/audio/reference-inputs.js";
import { readAudioRights } from "../../src/audio/rights.js";
import { resolveSongSlices } from "../../src/audio/song-slices.js";
import { createDispatchPlan, listPlans } from "../../src/productions/plans.js";
import { Coordinator } from "../../src/coordinator.js";
import { productionBatchSource } from "../../src/world-chat/production-batch.js";
import { GenerationQuotes } from "../../src/world-chat/generation-quotes.js";
import type { EnqueueInput } from "../../src/queue/dispatcher.js";
import { LIP_SYNC_SCHEMA_VERSION } from "../../src/world/commit.js";
import { applySceneCommand } from "../../src/productions/scene-commands.js";
import { SHIPPED_MANIFEST } from "../../../providers/src/manifest-data.js";

/**
 * A singer's shot carries its slice of the song (issue 3186): in a production cut to a song, a
 * shot whose sound is the song sends the master's slice under it as a performance-sync reference,
 * from "Plan video" and from Arke's plans, on a model that can sync to it.
 */

const CLOCK = () => "2026-11-15T12:00:00.000Z";
const AT = CLOCK();
const RATE = 48000;
const SAMPLES = Array.from({ length: RATE * 20 }, (_, i) => Math.round(Math.sin(i / 11) * 3000));
const SEEDANCE = SHIPPED_MANIFEST.models.find((model) => model.id === "seedance-2.0-fast")!;
/** A model with a reference route and no audio: the song stays home and the plan says why. */
const SILENT: ManifestModel = { id: "silent-like", provider: "fal", capability: "video", displayName: "Silent-like",
  accepts: { referenceImages: 4, startFrame: false, endFrame: false }, limits: { maxDurationSec: 10, durations: { "5": "5", "10": "10" } },
  pricing: { kind: "perSecond", microUsdPerSecond: 20000 } };

/** ffmpeg and ffprobe as the master-slice test fakes them: the slice is the samples asked for. */
const tools = createAudioMediaTools({ async run(tool, args) {
  let stdout = "";
  if (tool === "ffprobe") stdout = JSON.stringify({ format: { duration: "20", format_name: "wav" }, streams: [{ codec_type: "audio",
    codec_name: "pcm_s16le", sample_fmt: "s16", sample_rate: "48000", channels: 1, bits_per_sample: 16 }] });
  else if (args[0] === "-version") stdout = "ffmpeg version test\n";
  else {
    const start = Math.round(Number(args[args.indexOf("-ss") + 1]) * RATE), count = Math.round(Number(args[args.indexOf("-t") + 1]) * RATE);
    await writeFile(args.at(-1)!, wav(SAMPLES.slice(start, start + count)));
  }
  return { code: 0, stdout: Buffer.from(stdout), stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false };
} });

/**
 * Saltlight cut to a song: the master is a 20 s file, shot 4 (Maren) sings to it, shot 7's sound
 * is the song but nobody in it sings, and every shot is pinned on the spine. No timeline is saved.
 */
async function songWorld() {
  const dir = await makeTempWorld();
  const { artifactId, sceneId } = await songWorldAt(dir);
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  const production = () => store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
  const sceneRecord = () => production().scenes.find((s) => s.id === sceneId)!;
  return { dir, store, artifactId, production, scene: sceneRecord };
}

/** The song world's files, written into a copy of the fixture before anything opens it. */
async function songWorldAt(dir: string) {
  const artifactId = newId("ar");
  const original = wav(SAMPLES);
  await writeFile(join(dir, "artifacts/master.wav"), original);
  await writeFile(join(dir, "artifacts/master.wav.json"), JSON.stringify({ id: artifactId, kind: "audio", file: "master.wav",
    hash: audioHash(original), origin: { by: "user" }, links: [], created: "2026-11-15T10:00:00Z" }));
  const scenePath = join(dir, "productions/saltlight/scenes/02-the-tables-say-neap.json");
  const scene = JSON.parse(await readFile(scenePath, "utf8"));
  for (const shot of scene.shots) {
    if (shot.id === "sh_04") shot.audio = { kind: "music", speaker: "maren-kest" };
    if (shot.id === "sh_07") shot.audio = { kind: "music", lipSync: false };
  }
  await writeFile(scenePath, JSON.stringify(scene, null, 2));
  const spine: ProductionSpine = { schemaVersion: 1, revision: 3, trackArtifactId: artifactId, markers: [], updatedAt: "2026-11-15T10:00:00.000Z",
    anchors: { sh_04: { startSec: 2, endSec: 7, clipAudio: { mode: "mute" } }, sh_05: { startSec: 7, endSec: 9.5, clipAudio: { mode: "mute" } },
      sh_06: { startSec: 9.5, endSec: 15.5, clipAudio: { mode: "mute" } }, sh_07: { startSec: 15.5, endSec: 19.5, clipAudio: { mode: "mute" } } } };
  await writeFile(join(dir, "productions/saltlight/spine.json"), JSON.stringify(spine, null, 2));
  return { artifactId, sceneId: scene.id as string, sceneSlug: scene.slug as string };
}

/** A coordinator over the song world, with the fake media tools, Seedance 2.0 Fast and a fake queue. */
async function songCoordinator() {
  const made = await makeTempRoot();
  const world = await songWorldAt(made.worldDir);
  const provider = new FsWorldProvider(made.root, { clock: () => AT });
  closeOnCleanup(() => provider.close());
  await provider.loadWorld(WORLD_ID);
  const manifest: ModelManifest = { manifestVersion: 1, generated: "2026-11-15", models: [SEEDANCE] };
  const coordinator = new Coordinator({ provider, manifest, adapter: null, appVersion: "test", changeLogPath: join(made.root, "changes.jsonl"), audioMediaTools: tools });
  closeOnCleanup(() => coordinator.stop());
  coordinator.emit({ type: "provider.status", at: AT, providers: [{ id: "fal", configured: true, validation: "valid", fault: null,
    probes: [{ capability: "video", available: true }] }] });
  const jobs: Job[] = [];
  const enqueue = async (input: EnqueueInput) => {
    const existing = jobs.find((job) => job.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const job = JobSchema.parse({ ...input, id: newId("jb"), status: "queued", createdAt: AT, updatedAt: AT });
    jobs.push(job); return job;
  };
  coordinator["jobQueue"] = { ...fakeJobQueue(() => jobs), enqueue, cancel: async () => {}, dispose: async () => {} } as never;
  return { coordinator, store: provider.openStore()!, world, jobs, enqueue };
}

function plan(world: Awaited<ReturnType<typeof songWorld>>, model: ManifestModel, songs: Awaited<ReturnType<typeof resolveSongSlices>>, requestId: string) {
  const bundle = world.store.getBundle(), production = world.production(), scene = world.scene();
  return createDispatchPlan(world.store, { worldId: WORLD_ID, productionId: "saltlight", scene, model, world: bundle, policy: "review-gated",
    requestId, clock: CLOCK, songNotSent: songs.notSent,
    plan: planScene({ world: bundle.meta, productionId: "saltlight", sheets: bundle.sheets, kits: bundle.referenceKits, scene, selections: {},
      model, timingProduction: production, masterReferences: songs.references }, "whole-scene") });
}

describe("a singer's shot carries its slice of the song (issue 3186)", () => {
  it("slices a saved Cut's song under the shot's Picture slot, from the song's own clock", () => {
    const production = { meta: { id: "saltlight", frameRate: 24 }, scenes: [{ id: "sc_02", number: 2, title: "Two", shots: [
      { id: "sh_04", number: 4, title: "Four", description: "" }] }] } as unknown as ProductionBundle;
    const spine: ProductionSpine = { schemaVersion: 1, revision: 1, trackArtifactId: "ar_01J8E0000000000000000000S1", markers: [], updatedAt: CLOCK(),
      anchors: { sh_04: { startSec: 2, endSec: 7, clipAudio: { mode: "mute" } } } };
    const timeline = seedSpinePictureTimeline(production, spine, 20);
    // The song placed a second in and trimmed half a second at its head: the slice is song time.
    const master = timeline.tracks[1]!.clips[0]!;
    timeline.tracks[1]!.clips[0] = { ...master, startFrame: 24, sourceInFrames: 12 };
    const cut = { ...production, spine, timeline: { status: "ready", hash: `sha256:${"a".repeat(64)}`, timeline } } as unknown as ProductionBundle;
    const binding = masterAudioBinding(cut, "sh_04");
    assert.deepEqual(binding.range, { inSec: 1.5, outSec: 6.5 });
    assert.equal(binding.sourceClipId, master.id);
    assert.throws(() => masterAudioBinding(cut, "sh_09"), /^Error: not on the Cut$/);
    const songless = { ...cut, timeline: { status: "ready", hash: `sha256:${"a".repeat(64)}`, timeline: { ...timeline, tracks: [timeline.tracks[0]!] } } } as unknown as ProductionBundle;
    assert.throws(() => masterAudioBinding(songless, "sh_04"), /^Error: song not on the Cut$/);
  });

  it("with no saved Cut, the singer's shot is a pass of its own and sends exactly its window on the spine", async () => {
    const world = await songWorld();
    const songs = await resolveSongSlices(world.store, tools, world.production(), world.scene(), SEEDANCE, ulid());
    assert.equal(songs.references.length, 1, "shot 7 opted out, and no other shot's sound is the song");
    assert.deepEqual(songs.notSent, []);
    const [slice] = songs.references;
    assert.equal(slice!.master.shotId, "sh_04");
    assert.equal(slice!.master.sourceClipId, SPINE_SONG_SOURCE, "with no saved Cut the window is the shot's place on the spine");
    assert.equal(slice!.master.artifactId, world.artifactId);
    assert.deepEqual(slice!.master.range, { inSec: 2, outSec: 7 });
    assert.equal(slice!.characterName, "Maren Kest");

    const made = await plan(world, SEEDANCE, songs, "01J8E0000000000000000000S2");
    const singing = made.passes.find((pass) => pass.compiled.target.coversShots.includes("sh_04"))!;
    assert.deepEqual(singing.compiled.target.coversShots, ["sh_04"], "the slice is the clip's length, so the shot is a pass of its own");
    assert.deepEqual(singing.carries?.song, { name: "Maren Kest", rides: true });
    const audio = CharacterAudioPlanSchema.parse(singing.compiled.params["audioReferences"]);
    assert.equal(audio.references[0]!.intent, "performance-sync");
    assert.equal(audio.effects?.generatedAudio, false, "the song stays the final soundtrack");
    assert.match(String(singing.compiled.params["prompt"]), /Use @Audio1 as the playback for Maren Kest/);
    const [bytes] = await readCharacterAudioInputs(world.store, { model: SEEDANCE.id, provider: SEEDANCE.provider, params: singing.compiled.params }, true);
    assert.deepEqual(Buffer.from(bytes!.data), Buffer.from(wav(SAMPLES.slice(2 * RATE, 7 * RATE))), "seconds 2 to 7 of the song, no more");
    for (const pass of made.passes.filter((candidate) => candidate !== singing)) assert.equal(pass.carries?.song, undefined);

    // Asked again, the same slice comes back from its receipt rather than being cut a second time.
    const again = await resolveSongSlices(world.store, tools, world.production(), world.scene(), SEEDANCE, ulid());
    assert.deepEqual(again.references[0]!.prepared, slice!.prepared);
  });

  it("a model that cannot sync to the song makes the clip without it and the plan says so", async () => {
    const world = await songWorld();
    const songs = await resolveSongSlices(world.store, tools, world.production(), world.scene(), SILENT, ulid());
    assert.deepEqual(songs.references, []);
    assert.deepEqual(songs.notSent, [{ shotId: "sh_04", number: 4, name: "Maren Kest", reason: "model takes no song" }]);
    const made = await plan(world, SILENT, songs, "01J8E0000000000000000000S3");
    const singing = made.passes.find((pass) => pass.compiled.target.coversShots.includes("sh_04"))!;
    assert.deepEqual(singing.carries?.song, { name: "Maren Kest", rides: false, reason: "model takes no song" });
  });

  it("from Plan video: the coordinator resolves the singer's slice itself, with its upload right, and the plan names it", async () => {
    const { coordinator, store, world, jobs } = await songCoordinator();
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const sceneId = production.scenes.find((s) => s.slug === world.sceneSlug)!.id;
    const requestId = ulid();
    await coordinator["handleClientMessage"]({ kind: "dispatch-scene-planned", worldId: WORLD_ID, productionId: "saltlight",
      sceneFile: production.sceneFiles[sceneId]!, mode: "whole-scene", modelId: SEEDANCE.id, policy: "review-gated", requestId }, false, false, false, store);
    const plan = (await listPlans(store, "saltlight")).find((candidate) => candidate.requestId === requestId);
    assert.ok(plan, "the plan was made");
    const singing = plan.passes.find((pass) => pass.compiled.target.coversShots.includes("sh_04"))!;
    const audio = CharacterAudioPlanSchema.parse(singing.compiled.params["audioReferences"]);
    assert.deepEqual(audio.references.map((ref) => "master" in ref ? ref.master.range : null), [{ inSec: 2, outSec: 7 }]);
    assert.deepEqual(singing.carries?.song, { name: "Maren Kest", rides: true });
    assert.ok((await readAudioRights(store)).some((event) => event.action === "acknowledge" && event.id === `master-reference/${requestId}/song-sh_04/0`));
    assert.ok(jobs.length >= 1, "the first pass was admitted");
  });

  it("from Arke's plan: the card prices the slice without an upload right, and approval writes it", async () => {
    const { store, world, jobs, enqueue, coordinator } = await songCoordinator();
    const ports = coordinator["productionBatchPorts"](store);
    ports.refresh = async () => {};
    const quotes = new GenerationQuotes(store, productionBatchSource(store, ports), { enqueue, jobs: () => jobs, actualCost: async () => 0 });
    const sceneId = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.scenes.find((s) => s.slug === world.sceneSlug)!.id;
    const action = { kind: "production-scene-dispatch" as const, productionId: "saltlight", sceneId, mode: "whole-scene" as const,
      policy: "review-gated" as const, modelId: SEEDANCE.id, checkReceiptIds: [newId("check")] };
    const id = newId("act");

    const body = await quotes.prepare(action, id, AT);
    assert.ok(body.options!.some((option) => option.label.endsWith(": song") && option.value === "Maren Kest · sings to the song"), "the card says who sings");
    const acknowledged = async () => (await readAudioRights(store)).filter((event) => event.action === "acknowledge" && event.id.startsWith(`master-reference/${id}/`));
    assert.deepEqual(await acknowledged(), [], "pricing the card writes no upload right");
    assert.equal(jobs.length, 0);

    await quotes.dispatch(action, id);
    assert.equal((await acknowledged()).length, 1, "approving it does, once");
    const plan = (await listPlans(store, "saltlight"))[0]!;
    const singing = plan.passes.find((pass) => pass.compiled.target.coversShots.includes("sh_04"))!;
    const audio = CharacterAudioPlanSchema.parse(singing.compiled.params["audioReferences"]);
    const slice = audio.references[0]!;
    assert.ok("master" in slice && slice.intent === "performance-sync");
    assert.deepEqual("master" in slice ? slice.master.range : null, { inSec: 2, outSec: 7 });
    assert.deepEqual(singing.carries?.song, { name: "Maren Kest", rides: true });
  });

  it("a shot that opts out is not a singer, and the opt-out raises the world past older builds", async () => {
    const world = await songWorld();
    const production = world.production(), scene = world.scene();
    await applySceneCommand(world.store, { productionId: production.meta.id, sceneId: scene.id, sceneFile: production.sceneFiles[scene.id]!,
      baseVersion: scene.version, command: { kind: "edit-shot", shotId: "sh_04", change: { audio: { kind: "music", speaker: "maren-kest", lipSync: false } } } });
    assert.equal(orderedShots(world.scene()).find((shot) => shot.id === "sh_04")!.audio?.lipSync, false);
    const songs = await resolveSongSlices(world.store, tools, world.production(), world.scene(), SEEDANCE, ulid());
    assert.deepEqual(songs, { references: [], notSent: [] });
    const meta = JSON.parse(await readFile(join(world.dir, "world.json"), "utf8")) as { schemaVersion: number };
    assert.ok(meta.schemaVersion >= LIP_SYNC_SCHEMA_VERSION);
  });
});

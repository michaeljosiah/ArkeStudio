import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientMessageSchema, ProductionSetupDraftSchema, ProductionSpineSchema, newId, ulid, type ConversationId, type ProductionSetupUpdate } from "@arke-studio/contracts";
import { createProductionFromPlan } from "../../src/productions/ops.js";
import { ProductionSetupService } from "../../src/productions/setup.js";
import { productionSetupBrief } from "../../src/productions/setup-brief.js";
import { planProductionSetup } from "../../src/productions/setup-plan.js";
import { SCENE_SONG_WINDOW_SCHEMA_VERSION, carriesSongWindow } from "../../src/productions/scene-record.js";
import { AudioSpineCommandRefused, applyProductionSpineCommand, previewAudioSpineCommand } from "../../src/productions/spine.js";
import { readWorldMeta, scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * A scene's place in the song (issue 3100; SPEC-012 R-VSETUP-19, SPEC-041 R-68). Setup fitted a
 * music video's scenes to the song's sections and could only write the times into titles. The
 * window is now a field: setup keeps it, creation carries it onto the scene record, and once the
 * song is the master the windows can mark its sections in one spine command.
 */
const CLOCK = "2026-11-15T09:00:00.000Z";
const BELLS = "ar_01J8G0000000000000000000R1";

async function open() {
  const dir = await makeTempWorld();
  // The fixture's song, measured: thirty seconds, which the spine authority holds markers to.
  const sidecar = join(dir, "artifacts", "harbour-bells.wav.json");
  const record = JSON.parse(await readFile(sidecar, "utf8")) as Record<string, unknown>;
  await writeFile(sidecar, `${JSON.stringify({ ...record, mediaInfo: { durationSec: 30, hasAudio: true } }, null, 2)}\n`);
  const store = await WorldStore.open(dir, { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

const OUTLINE: NonNullable<ProductionSetupUpdate["scenes"]> = [
  { key: "intro", title: "Intro", songWindow: { startSec: 0, endSec: 8 } },
  { key: "verse-1", title: "Verse 1: the phone", synopsis: "She reads the message.", songWindow: { startSec: 8, endSec: 20 } },
  { key: "bridge", title: "Bridge" },
  { key: "chorus", title: "Chorus", songWindow: { startSec: 20, endSec: 30 } },
];

/** A music video set up with Arke and created: three scenes with a place in the song, one without. */
async function musicVideo(store: WorldStore, scenes = OUTLINE) {
  const service = new ProductionSetupService(store);
  const conversation = `cv_${ulid()}` as ConversationId;
  const start = await service.start(conversation, { kind: "music-video", title: "Why you do me like that" });
  const placed = await service.update(conversation, { expectedRevision: start.draft.revision, scenes });
  const reviewed = await service.review(conversation, placed.draft.revision);
  const created = await service.create(conversation, reviewed.draft.revision, reviewed.review!.id);
  return { service, conversation, placed, productionId: created.productionId! };
}

describe("setup keeps a scene's place in the song (issue 3100)", () => {
  it("carries the window on the draft and fences the builds that cannot read it", async () => {
    const store = await open();
    const service = new ProductionSetupService(store);
    const conversation = `cv_${ulid()}` as ConversationId;
    const start = await service.start(conversation, { kind: "music-video" });
    const named = await service.update(conversation, { expectedRevision: start.draft.revision, scenes: [{ key: "intro", title: "Intro" }] });
    assert.ok((await readWorldMeta(store.dir)).schemaVersion < SCENE_SONG_WINDOW_SCHEMA_VERSION, "a draft with no window raises nothing");

    const placed = await service.update(conversation, { expectedRevision: named.draft.revision, scenes: [{ key: "intro", songWindow: { startSec: 0, endSec: 16 } }] });
    assert.deepEqual(placed.draft.scenes[0], { key: "intro", title: "Intro", songWindow: { startSec: 0, endSec: 16 } });
    assert.equal((await readWorldMeta(store.dir)).schemaVersion, SCENE_SONG_WINDOW_SCHEMA_VERSION);
    await assert.rejects(readWorldMeta(store.dir, { supports: SCENE_SONG_WINDOW_SCHEMA_VERSION - 1 }), /newer|version|schema/i);
    // What was saved is what a reopened setup reads.
    assert.deepEqual((await new ProductionSetupService(store).resume(conversation)).draft.scenes[0]!.songWindow, { startSec: 0, endSec: 16 });

    const cleared = await service.update(conversation, { expectedRevision: placed.draft.revision, scenes: [{ key: "intro", songWindow: null }] });
    assert.equal(cleared.draft.scenes[0]!.songWindow, undefined);
    await assert.rejects(service.update(conversation, { expectedRevision: cleared.draft.revision, scenes: [{ key: "intro", songWindow: { startSec: 16, endSec: 4 } }] }));
  });

  it("creates each scene with the window setup gave it, and none where it gave none", async () => {
    const store = await open();
    const { productionId } = await musicVideo(store);
    const scan = await scanWorld(store.dir);
    assert.deepEqual(scan.problems, []);
    assert.equal(scan.meta.schemaVersion, SCENE_SONG_WINDOW_SCHEMA_VERSION);
    const production = scan.bundle.productions.find((candidate) => candidate.meta.id === productionId)!;
    assert.deepEqual(production.scenes.map((scene) => [scene.title, scene.songWindow]), [
      ["Intro", { startSec: 0, endSec: 8 }],
      ["Verse 1: the phone", { startSec: 8, endSec: 20 }],
      ["Bridge", undefined],
      ["Chorus", { startSec: 20, endSec: 30 }],
    ]);
    const bridge = await readFile(join(store.dir, "productions", productionId, "scenes", "bridge.json"), "utf8");
    assert.equal(carriesSongWindow(bridge), false);
    assert.equal(carriesSongWindow(await readFile(join(store.dir, "productions", productionId, "scenes", "intro.json"), "utf8")), true);
  });

  it("fences the scene's own bytes, whatever wrote them", async () => {
    // A plan made outside the setup service raised nothing on the way: the commit that lands a
    // scene with a window is the boundary every write of one passes.
    const store = await open();
    const draft = ProductionSetupDraftSchema.parse({
      schemaVersion: 1, setupId: `cv_${ulid()}`, worldId: WORLD_ID, revision: 1, title: "Second single", kind: "music-video",
      aspect: "9:16", frameRate: 24, narrative: {}, arcs: [], references: [], openQuestions: [], episodes: [],
      scenes: [{ key: "intro", title: "Intro", songWindow: { startSec: 0, endSec: 8 } }],
    });
    const plan = planProductionSetup(store.getBundle(), draft, CLOCK);
    assert.ok((await readWorldMeta(store.dir)).schemaVersion < SCENE_SONG_WINDOW_SCHEMA_VERSION);
    await createProductionFromPlan(store, plan, { source: "test", requestId: ulid(), precondition: () => null });
    assert.equal((await readWorldMeta(store.dir)).schemaVersion, SCENE_SONG_WINDOW_SCHEMA_VERSION);
    await assert.rejects(readWorldMeta(store.dir, { supports: SCENE_SONG_WINDOW_SCHEMA_VERSION - 1 }), /newer|version|schema/i);
  });

  it("tells Arke to put a music video's times in the window, not in the words", async () => {
    const store = await open();
    const service = new ProductionSetupService(store);
    const read = async () => ({ result: {}, receipt: { id: newId("check"), runId: newId("run"), tool: "get-entry", status: "complete", consulted: [], at: CLOCK } }) as never;
    const video = (await service.start(`cv_${ulid()}` as ConversationId, { kind: "music-video" })).draft;
    const brief = await productionSetupBrief(store.getBundle(), video, read, 400_000);
    assert.match(brief, /songWindow\?:\{startSec,endSec\}/, "the update's shape names the field");
    assert.match(brief, /0:16–0:44 is \{startSec: 16, endSec: 44\}/);
    assert.match(brief, /keep times out of titles and synopses/);
    assert.doesNotMatch(brief, /Start each scene's synopsis with its place in the song/);
    const film = (await service.start(`cv_${ulid()}` as ConversationId, { kind: "film" })).draft;
    assert.doesNotMatch(await productionSetupBrief(store.getBundle(), film, read, 400_000), /Give each scene its place in the song/);
  });
});

describe("the song's sections from the scenes (issue 3100)", () => {
  const spineOf = (store: WorldStore, productionId: string) => store.getBundle().productions.find((candidate) => candidate.meta.id === productionId)?.spine ?? null;
  const send = (store: WorldStore, productionId: string, baseRevision: number | null, command: Parameters<typeof applyProductionSpineCommand>[1]["command"]) =>
    applyProductionSpineCommand(store, { productionId, baseRevision, command }, { source: "test", requestId: ulid() });

  it("is a command the Studio's own frame carries", () => {
    assert.equal(ClientMessageSchema.safeParse({ kind: "spine-command", worldId: WORLD_ID, productionId: "saltlight", requestId: ulid(),
      baseRevision: 1, command: { kind: "mark-sections-from-scenes" } }).success, true);
  });

  it("marks one section for each scene with a window, and is refused once the song has sections", async () => {
    const store = await open();
    const { productionId } = await musicVideo(store);
    await send(store, productionId, null, { kind: "create", trackArtifactId: BELLS });

    // The card Arke shows for it says how many, in the words the Cut's press uses.
    const preview = previewAudioSpineCommand(store.getBundle(), { productionId, baseRevision: 1, command: { kind: "mark-sections-from-scenes" } }, CLOCK);
    assert.equal(preview.title, "Mark 3 sections from the scenes");
    assert.deepEqual(preview.commands.map((command) => [command.label, command.detail]),
      [["Intro", "section at 0:00"], ["Verse 1: the phone", "section at 0:08"], ["Chorus", "section at 0:20"]]);

    const { spine } = await send(store, productionId, 1, { kind: "mark-sections-from-scenes" });
    assert.equal(spine!.revision, 2, "one press, one revision");
    assert.deepEqual(spine!.markers.map((marker) => marker.kind === "section" ? [marker.label, marker.atSec, marker.source] : null),
      [["Intro", 0, "manual"], ["Verse 1: the phone", 8, "manual"], ["Chorus", 20, "manual"]]);
    assert.equal(new Set(spine!.markers.map((marker) => marker.id)).size, 3);
    assert.deepEqual(spine!.anchors, {}, "no shot is pinned by it");
    const written = ProductionSpineSchema.parse(JSON.parse(await readFile(join(store.dir, "productions", productionId, "spine.json"), "utf8")));
    assert.deepEqual(written, spine);
    assert.deepEqual(spineOf(store, productionId), spine);

    await assert.rejects(send(store, productionId, 2, { kind: "mark-sections-from-scenes" }),
      (error) => error instanceof AudioSpineCommandRefused && /already has sections/.test(error.reason));
    assert.equal(spineOf(store, productionId)!.revision, 2, "the refusal wrote nothing");
  });

  it("keeps the song's lyrics, and is refused at a revision the spine has left", async () => {
    const store = await open();
    const { productionId } = await musicVideo(store);
    await send(store, productionId, null, { kind: "create", trackArtifactId: BELLS });
    await send(store, productionId, 1, { kind: "add-marker", marker: { kind: "lyric", id: newId("mk"), text: "Why you do me", atSec: 9, source: "manual" } });
    await assert.rejects(send(store, productionId, 1, { kind: "mark-sections-from-scenes" }), /moved from revision 1 to 2/);
    const { spine } = await send(store, productionId, 2, { kind: "mark-sections-from-scenes" });
    assert.deepEqual(spine!.markers.map((marker) => marker.kind === "section" ? marker.label : marker.text),
      ["Intro", "Verse 1: the phone", "Why you do me", "Chorus"]);
  });

  it("is refused where no scene has a place in the song, and where one starts past its end", async () => {
    const store = await open();
    // The fixture's own production: scenes, and none of them set up with a window.
    await send(store, "saltlight", null, { kind: "create", trackArtifactId: BELLS });
    await assert.rejects(send(store, "saltlight", 1, { kind: "mark-sections-from-scenes" }),
      (error) => error instanceof AudioSpineCommandRefused && /no scene has a place in the song/.test(error.reason));

    const { productionId } = await musicVideo(store, [...OUTLINE, { key: "outro", title: "Outro", songWindow: { startSec: 40, endSec: 52 } }]);
    await send(store, productionId, null, { kind: "create", trackArtifactId: BELLS });
    await assert.rejects(send(store, productionId, 1, { kind: "mark-sections-from-scenes" }),
      (error) => error instanceof AudioSpineCommandRefused && error.reason === "Outro starts at 0:40, past the song's 0:30");
    assert.deepEqual(spineOf(store, productionId)!.markers, []);
  });
});

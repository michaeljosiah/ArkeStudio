import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyTimelineCommands, buildFfmpegArgs, buildRenderPlan, ConversationActionCardSchema, episodeTimelineRange, ProductionCutExportModelActionSchema, ProductionTimelineSchema,
  seedStoryPictureTimeline, storyTimelineFingerprint, textPicturePath, transitionSourceKey, ulid, newId, TEXT_PICTURE_DIR, type DomainEvent, type ExportPreset, type ProductionBundle,
  type TextFrame, type TextLook, type TimelineClip, type TimelineCommand } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import type { EffectRasterHost } from "../../src/media/node-effect-renderer.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
import { applyHumanTimelineCommand } from "../../src/productions/timeline.js";
import { serveTextPicture, textPicturesForExport } from "../../src/productions/editor-text-cache.js";
import { decodePng } from "../../src/references/png.js";
import { EDITOR_TEXT_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { sha256 } from "../../src/world/text-files.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { receiptBinding } from "../world-chat/production-context-fixtures.js";

/**
 * A film with text, exported (SPEC-065 R-20, R-21, R-40). The export keeps every picture its plan
 * names before anything renders, at the size each picture's own layer says, whoever began it: the
 * Cut, a script with no window open, or Arke. A clip the painter cannot draw refuses the export by
 * its words, before the encoder is asked for anything. A film with no text never touches the folder.
 * FFmpeg and the effect host are stand-ins that record what they were handed; the pixels an export
 * makes from a kept picture are the native test's (`media/editor-effect-native.test.ts`).
 */

const PRODUCTION = "saltlight", CONVERSATION = "cv_01J8G0000000000000000000C1";
const LOOK: TextLook = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2,
  capitals: false, align: "center", x: 0.5, y: 0.5, room: 0.8, fill: { kind: "solid", color: "#ffffff" } };
const REVIEW: TextFrame = { width: 1280, height: 720 }, MASTER: TextFrame = { width: 1920, height: 1080 };
/** A character Geist does not draw, so the painter refuses it in its own words. */
const UNDRAWN = "漢", ALSO_UNDRAWN = "字";
const text = (id: `cl_${string}`, words: string, startFrame: number): TimelineClip =>
  ({ id, startFrame, durationFrames: 48, sourceInFrames: 0, source: { kind: "text", label: words, text: words, look: LOOK } });
/** The name and world-relative path the plan gives these words at a frame. */
function kept(words: string, frame: TextFrame) {
  const ref = textPicturePath({ text: words, look: LOOK }, frame);
  if (!ref.ok) throw new Error(ref.reason);
  return ref;
}
const KEPT_FILE = /[\\/]editor-text[\\/]([0-9a-f]{64})\.png$/;
type Progress = Extract<DomainEvent, { type: "export.progress" }>;

async function world() {
  const store = await WorldStore.open(await makeTempWorld()); closeOnCleanup(() => store.close());
  const production = () => store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
  const revision = () => { const timeline = production().timeline; return timeline?.status === "ready" ? timeline.timeline.revision : null; };
  const send = (commands: TimelineCommand[]) => applyHumanTimelineCommand(store, PRODUCTION,
    { kind: "commands", baseRevision: revision(), sourceFingerprint: storyTimelineFingerprint(production()), commands });
  const still = store.getBundle().artifacts.find(value => value.kind === "board")!;
  /** A still under the names, and the name ADE over it on a track of its own. */
  const cut: TimelineCommand[] = [
    { kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } },
    { kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" },
    { kind: "place", trackId: "tr_names", clip: text("cl_name", "ADE", 24) }];
  const folder = join(store.dir, TEXT_PICTURE_DIR);
  const files = async () => (await readdir(folder).catch(() => [] as string[])).sort();

  // What the effect host was asked to measure, and what it found there at that moment: a kept
  // picture is read as the PNG it is, so a missing or unfinished file fails here, not later.
  const probed: Array<{ name: string; width: number; height: number }> = [], runs: string[][] = [], graphs: string[] = [];
  let hold: (() => Promise<void>) | null = null;
  const host: EffectRasterHost = {
    probePicture: async path => {
      const waiting = hold; hold = null;
      if (waiting) await waiting();
      const name = KEPT_FILE.exec(path)?.[1];
      if (name === undefined) return { width: 1920, height: 1080 };
      const picture = decodePng(await readFile(path));
      probed.push({ name, width: picture.width, height: picture.height });
      return { width: picture.width, height: picture.height };
    },
    renderAlpha: async () => { throw new Error("no effect is placed in these films"); },
  };
  const runner: FfmpegRunner = { slateFont: "/font.ttf", graphFileOption: async () => "-/filter_complex",
    run: async (args, onProgress) => {
      runs.push(args);
      // The graph goes to the encoder as a file, which the export removes once it is done.
      const graph = args.indexOf("-/filter_complex");
      if (graph >= 0) graphs.push(await readFile(args[graph + 1]!, "utf8"));
      onProgress(50); await writeFile(args.at(-1)!, "encoded video");
    } };
  const events: DomainEvent[] = [];
  // Never started: no transport, no socket, no window. The export is the only thing that asks.
  const coordinator = new Coordinator({ provider: { listWorlds: async () => [], loadWorld: async () => store.getBundle(), openStore: () => store },
    adapter: null, appVersion: "test", changeLogPath: join(store.dir, ".cache/test-events.jsonl"), observeEvent: event => { events.push(event); },
    ffmpeg: runner, effectRasterHost: host });
  closeOnCleanup(() => coordinator["changeLog"].drain());
  const outcome = (from: number, exportId?: string) => events.slice(from).find((event): event is Progress => event.type === "export.progress"
    && (exportId === undefined || event.exportId === exportId) && (event.status === "done" || event.status === "failed" || event.status === "cancelled"));
  const settle = () => Promise.allSettled(coordinator["backgroundWork"]);
  /** An export begun as the Cut begins one: the same client command, awaited to its end. */
  const exportCut = async (preset: ExportPreset) => {
    const from = events.length;
    await coordinator.dispatch({ kind: "export-cut", worldId: WORLD_ID, productionId: PRODUCTION, preset, timelineRevision: revision() });
    await settle();
    return outcome(from);
  };
  /** Writes a timeline no command wrote, as a hand or an older install might have left it. */
  const adopt = async (change: (timeline: ReturnType<typeof ProductionTimelineSchema.parse>) => void) => {
    const file = join(store.dir, "productions", PRODUCTION, "timeline.json");
    const before = await readFile(file, "utf8"), timeline = ProductionTimelineSchema.parse(JSON.parse(before));
    change(timeline);
    await store.commit({ kind: "adopt-timeline", source: "test", files: [{ path: `productions/${PRODUCTION}/timeline.json`, action: "replace",
      content: `${JSON.stringify(timeline, null, 2)}\n`, baseHash: sha256(before) }] });
  };
  return { store, production, revision, send, cut, folder, files, probed, runs, graphs, events, coordinator, outcome, settle, exportCut, adopt,
    holdNextProbe: (wait: () => Promise<void>) => { hold = wait; } };
}

test("an export paints its text pictures before it renders", async () => {
  const w = await world();
  await w.send(w.cut);
  // The Viewer has drawn the review-size picture. The master export still keeps its own size.
  const review = kept("ADE", REVIEW), master = kept("ADE", MASTER);
  assert.ok(await serveTextPicture(w.store, w.store.getBundle().meta.slug, review.path));
  const done = await w.exportCut("master");
  assert.equal(done?.status, "done", done?.error ?? undefined);
  // Measured from the kept file, which was whole on disk before the effect host was asked.
  assert.deepEqual(w.probed, [{ name: master.name, ...MASTER }]);
  assert.deepEqual(await w.files(), [`${master.name}.png`, `${review.name}.png`].sort());
  assert.equal(w.runs.length, 1);
  assert.ok(w.runs[0]!.some(arg => arg.includes(master.name)), "the encoder reads the kept picture");
  assert.equal(w.runs[0]!.some(arg => arg.includes(review.name)), false, "and not the Viewer's");
});

test("an export begun with no window paints its own pictures", async () => {
  const w = await world();
  await w.send(w.cut);
  // Nothing has ever asked to see the words: no Viewer, no socket, no folder.
  await assert.rejects(stat(w.folder), { code: "ENOENT" });
  const done = await w.exportCut("review-cut");
  assert.equal(done?.status, "done", done?.error ?? undefined);
  const review = kept("ADE", REVIEW);
  assert.deepEqual(await w.files(), [`${review.name}.png`]);
  assert.deepEqual(w.probed, [{ name: review.name, ...REVIEW }]);

  // A deleted folder is painted again by the next export, under the same name (§3.2).
  await rm(w.folder, { recursive: true, force: true });
  const again = await w.exportCut("review-cut");
  assert.equal(again?.status, "done", again?.error ?? undefined);
  assert.deepEqual(await w.files(), [`${review.name}.png`]);
});

test("an export begun by Arke paints its own pictures", async () => {
  const w = await world();
  await w.send(w.cut);
  await assert.rejects(stat(w.folder), { code: "ENOENT" });
  const action = ProductionCutExportModelActionSchema.parse({ kind: "production-cut-export", productionId: PRODUCTION, scope: { kind: "production" },
    preset: "master", checkReceiptIds: [newId("check")] });
  const card = ConversationActionCardSchema.parse({ ...receiptBinding(CONVERSATION, WORLD_ID), actionKind: "world-chat-production-cut-export",
    authorityKind: "export", authority: { kind: "export", id: `ex_${ulid()}` }, cardFamily: "host-action", status: "running", availableDecisions: [] });
  const from = w.events.length;
  // The approved card's own start: it sends the same export command with the card's id as the export's.
  const started = await w.coordinator["startProductionExportForConversationAction"](w.store, action, card);
  assert.equal(started.status, "running", started.detail);
  await w.settle();
  const done = w.outcome(from, card.authority.id);
  assert.equal(done?.status, "done", done?.error ?? undefined);
  const master = kept("ADE", MASTER);
  assert.deepEqual(await w.files(), [`${master.name}.png`]);
  assert.deepEqual(w.probed, [{ name: master.name, ...MASTER }]);
});

test("an edit during an export does not change its pictures", async () => {
  const w = await world();
  await w.send(w.cut);
  let release!: () => void, reached = false;
  const released = new Promise<void>(resolve => { release = resolve; });
  w.holdNextProbe(async () => { reached = true; await released; });
  const from = w.events.length;
  await w.coordinator.dispatch({ kind: "export-cut", worldId: WORLD_ID, productionId: PRODUCTION, preset: "master", timelineRevision: w.revision() });
  // The export has kept its picture and frozen its plan; it is now measuring, and the words change
  // under it. An export that ends before it measures anything is a failure here, not a wait.
  while (!reached && w.outcome(from) === undefined) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(reached, `the export measured nothing: ${w.outcome(from)?.error}`);
  await w.send([{ kind: "text-set", clipIds: ["cl_name"], text: "IFE" }]);
  release();
  await w.settle();
  const done = w.outcome(from);
  assert.equal(done?.status, "done", done?.error ?? undefined);
  const before = kept("ADE", MASTER), after = kept("IFE", MASTER);
  assert.ok(w.runs[0]!.some(arg => arg.includes(before.name)), "the film is the words it began with");
  assert.equal(w.runs[0]!.some(arg => arg.includes(after.name)), false);
  // A command lays words out and keeps nothing: the new words wait for whatever next asks to see them.
  assert.deepEqual(await w.files(), [`${before.name}.png`]);
});

test("an export keeps each text picture at the size its own layer names", async () => {
  const w = await world();
  await w.send(w.cut);
  const timeline = w.production().timeline;
  assert.equal(timeline?.status, "ready");
  if (timeline?.status !== "ready") return;
  const projected = buildRenderPlan({ production: w.production(), artifacts: w.store.getBundle().artifacts, timeline, scope: { kind: "production" }, preset: "master" });
  assert.ok(projected.ok, projected.ok ? undefined : projected.reason);
  if (!projected.ok) return;
  const plan = projected.plan, layers = plan.effectRender!.pictureLayers;
  const layer = layers.find(value => value.clipId === "cl_name")!;
  assert.deepEqual(layer.sourceSize, MASTER);
  // A second picture of the same clip, larger than the frame, as a moving clip's is (R-17):
  // nothing asks what size the export is, so each is kept at its own.
  const larger: TextFrame = { width: 2560, height: 1440 }, big = kept("ADE", larger), master = kept("ADE", MASTER);
  layers.push({ ...layer, path: big.path, sourceSize: larger });
  assert.equal(await textPicturesForExport(w.store, timeline.timeline, plan), null);
  for (const [ref, frame] of [[master, MASTER], [big, larger]] as const) {
    const picture = decodePng(await readFile(join(w.store.dir, ref.path)));
    assert.deepEqual({ width: picture.width, height: picture.height }, frame, ref.name);
  }
  // A layer whose name its words do not make, or that says no size, is a plan this build does not
  // make; it refuses rather than renders, and keeps nothing for it.
  const missing = "timeline is not ready to export: a text picture is missing";
  const misnamed = structuredClone(plan); misnamed.effectRender!.pictureLayers.at(-1)!.path = kept("IFE", larger).path;
  assert.equal(await textPicturesForExport(w.store, timeline.timeline, misnamed), missing);
  const unsized = structuredClone(plan); delete unsized.effectRender!.pictureLayers.at(-1)!.sourceSize;
  assert.equal(await textPicturesForExport(w.store, timeline.timeline, unsized), missing);
  assert.deepEqual(await w.files(), [`${big.name}.png`, `${master.name}.png`].sort());
});

test("an export of a moving title paints and reads its doubled picture, and records no size", async () => {
  const w = await world();
  await w.send([...w.cut, { kind: "picture-motion", clipId: "cl_name", motion: { kind: "push-in", amount: .08 } }]);
  const done = await w.exportCut("master");
  assert.equal(done?.status, "done", done?.error ?? undefined);
  // Twice the master frame (R-17): the size zoompan reads a moving still at, so it is never enlarged.
  const doubled: TextFrame = { width: 3840, height: 2160 }, read = kept("ADE", doubled);
  assert.deepEqual(w.probed, [{ name: read.name, ...doubled }]);
  assert.deepEqual(await w.files(), [`${read.name}.png`]);
  assert.ok(w.runs[0]!.some(arg => arg.includes(read.name)), "the encoder reads the doubled picture");
  assert.equal(w.runs[0]!.some(arg => arg.includes(kept("ADE", MASTER).name)), false, "and not one at the frame");
  assert.match(w.graphs[0]!, /scale=3840:2160:flags=bicubic,setsar=1,zoompan=/);
  // The size follows from the frame and the move every time: the record holds no size, and no floor rises for it.
  assert.doesNotMatch(await readFile(join(w.store.dir, "productions", PRODUCTION, "timeline.json"), "utf8"), /sourceSize/);
  assert.equal((await readWorldMeta(w.store.dir)).schemaVersion, EDITOR_TEXT_SCHEMA_VERSION);
});

test("an export of two crossfading names and of a name crossfading from a still keeps every picture and hands the encoder the blend", async () => {
  const w = await world();
  await w.send([...w.cut, { kind: "place", trackId: "tr_names", clip: text("cl_next", "IFE", 72) },
    { kind: "place", trackId: "tr_picture", clip: text("cl_kemi", "KEMI", 96) },
    { kind: "transition-set", trackId: "tr_names", leftClipId: "cl_name", rightClipId: "cl_next", durationFrames: 12 },
    { kind: "transition-set", trackId: "tr_picture", leftClipId: "cl_still", rightClipId: "cl_kemi", durationFrames: 12 }]);
  const timeline = w.production().timeline;
  assert.ok(timeline?.status === "ready");
  const keyOf = (clipId: string) => transitionSourceKey(timeline.timeline.tracks.flatMap(track => track.clips).find(clip => clip.id === clipId)!);
  assert.deepEqual(timeline.timeline.transitions?.map(row => [row.leftClipId, row.rightClipId, row.leftSourceKey, row.rightSourceKey]),
    [["cl_name", "cl_next", keyOf("cl_name"), keyOf("cl_next")], ["cl_still", "cl_kemi", `artifact/${w.store.getBundle().artifacts.find(value => value.kind === "board")!.id}`, keyOf("cl_kemi")]]);
  const done = await w.exportCut("master");
  assert.equal(done?.status, "done", done?.error ?? undefined);
  const names = ["ADE", "IFE", "KEMI"].map(words => kept(words, MASTER).name).sort();
  assert.deepEqual(w.probed.map(row => row.name).sort(), names);
  assert.ok(w.probed.every(row => row.width === MASTER.width && row.height === MASTER.height), "a blend reads each picture at its frame");
  assert.deepEqual(await w.files(), names.map(name => `${name}.png`));
  // Each blend's pictures are weighted on their own track and summed, the path a still pair takes.
  const graph = w.graphs[0]!;
  assert.equal(graph.match(/fade=t=in:start_frame=\d+:nb_frames=12:alpha=1,/g)?.length, 2);
  assert.equal(graph.match(/fade=t=out:start_frame=\d+:nb_frames=12:alpha=1,/g)?.length, 2);
  assert.match(graph, /blend=all_mode=addition/);
});

test("an export with a text clip that cannot be drawn refuses before rendering", async () => {
  const w = await world();
  await w.send(w.cut);
  // Words no command would let in, as a hand-edited timeline holds them. On the base track, so the
  // saved history still replays (Undo of `add-track` would find Names holding a clip).
  await w.adopt(timeline => {
    timeline.tracks.find(track => track.id === "tr_picture")!.clips.push(text("cl_undrawn", UNDRAWN, 96), text("cl_also", ALSO_UNDRAWN, 144));
  });
  const done = await w.exportCut("master");
  assert.equal(done?.status, "failed");
  assert.equal(done?.error, `timeline is not ready to export: the text "${UNDRAWN}" cannot be drawn: Geist has no ${UNDRAWN} (and 1 more text clip)`);
  assert.deepEqual(w.probed, [], "nothing was measured");
  assert.deepEqual(w.runs, [], "and the encoder was never asked");
  assert.equal((await readdir(join(w.store.dir, "exports")).catch(() => [] as string[])).some(file => file.endsWith(".mp4")), false);
  // Never a slate and never a blank picture under the refused words' names.
  for (const words of [UNDRAWN, ALSO_UNDRAWN]) assert.equal((await w.files()).includes(`${kept(words, MASTER).name}.png`), false);
});

test("an episode export keeps, and is refused by, only the text inside the episode", async () => {
  const w = await world();
  // Two episodes cut from the story's own shots. The second holds words the painter cannot draw, as
  // a face file gone missing since they were set or a hand-edited timeline leaves them.
  const production: ProductionBundle = { ...w.production(), episodes: [
    { id: "ep_one", version: 1, order: 1, title: "One", scenes: ["sc_02"] },
    { id: "ep_two", version: 1, order: 2, title: "Two", scenes: ["sc_04", "sc_06"] }] };
  const seeded = seedStoryPictureTimeline(production), two = episodeTimelineRange(production, seeded, "ep_two");
  assert.ok(two.ok, two.ok ? undefined : two.reason);
  const timeline = applyTimelineCommands(seeded, [{ kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" },
    { kind: "place", trackId: "tr_names", clip: text("cl_name", "ADE", 0) },
    { kind: "place", trackId: "tr_names", clip: text("cl_undrawn", UNDRAWN, two.startFrame) },
    { kind: "place", trackId: "tr_names", clip: text("cl_later", "IFE", two.startFrame + 48) }]);
  const plan = (episodeId: string) => {
    const projected = buildRenderPlan({ production, artifacts: w.store.getBundle().artifacts, timeline: { status: "ready", timeline },
      scope: { kind: "episode", episodeId }, preset: "master" });
    assert.ok(projected.ok, projected.ok ? undefined : projected.reason);
    return projected.plan;
  };
  // The episode's plan still carries every clip's layer for the compositor to find its place by;
  // only the ones inside its window are painted, and only they can refuse it.
  assert.equal(await textPicturesForExport(w.store, timeline, plan("ep_one")), null);
  assert.deepEqual(await w.files(), [`${kept("ADE", MASTER).name}.png`], "episode two's words are not painted for episode one");
  assert.equal(await textPicturesForExport(w.store, timeline, plan("ep_two")),
    `timeline is not ready to export: the text "${UNDRAWN}" cannot be drawn: Geist has no ${UNDRAWN}`);
});

test("a timeline with no text exports as it did", async () => {
  const w = await world();
  await w.send([w.cut[0]!]);
  const done = await w.exportCut("review-cut");
  assert.equal(done?.status, "done", done?.error ?? undefined);
  // The encoder is handed exactly the planner's arguments, as before text existed (R-40).
  const timeline = w.production().timeline;
  const projected = buildRenderPlan({ production: w.production(), artifacts: w.store.getBundle().artifacts, timeline, scope: { kind: "production" }, preset: "review-cut" });
  assert.ok(projected.ok);
  if (!projected.ok) return;
  assert.equal(projected.plan.effectRender, undefined);
  assert.deepEqual(w.runs[0], buildFfmpegArgs(projected.plan, w.store.dir, w.runs[0]!.at(-1)!, "/font.ttf"));
  // A faded still goes through the compositor, and still nothing is kept or asked for.
  await w.send([{ kind: "picture-fade", clipId: "cl_still", inFrames: 12, outFrames: 12 }]);
  const faded = await w.exportCut("review-cut");
  assert.equal(faded?.status, "done", faded?.error ?? undefined);
  assert.equal(w.runs.length, 2);
  await assert.rejects(stat(w.folder), { code: "ENOENT" }, "a film with no text never touches the folder");
});

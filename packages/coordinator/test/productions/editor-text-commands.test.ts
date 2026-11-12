import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { orderedShots, ProductionTimelineSchema, storyTimelineFingerprint, transitionSourceKey, transitionVersionRef, TEXT_PICTURE_DIR,
  type ModelTransitionProposal, type TextLook, type TimelineClip, type TimelineCommand, type TransitionReviewOperation } from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { applyHumanTimelineCommand, refuseUnrenderablePlacements, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { decideEditorRequest, stageEditorRequests } from "../../src/productions/editor-requests.js";
import { EditorEffectAnalysisService } from "../../src/productions/editor-effect-analysis.js";
import { EditorEffectDependencies } from "../../src/productions/editor-effect-dependencies.js";
import { handleTransitionReview, stageTransitionProposal } from "../../src/productions/editor-transition-requests.js";
import { serveTextPicture, textPicturesNamed } from "../../src/productions/editor-text-cache.js";
import { EDITOR_TEXT_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { sha256 } from "../../src/world/text-files.js";

/**
 * Text through the coordinator's command path (SPEC-065 R-2, R-17, R-21): the painter is asked
 * about words a command brings in, by layout and before anything is written, and never about
 * what Undo or Redo restores; a move or a crossfade on text is taken wherever a command can come
 * from, as a still's is; and nothing a proposal records depends on a kept picture, which is a cache.
 */

const PRODUCTION = "saltlight", NOW = "2026-11-12T12:00:00.000Z";
const CONVERSATION = "cv_01J8G0000000000000000000C1";
const LOOK: TextLook = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2,
  capitals: false, align: "center", x: 0.5, y: 0.5, room: 0.8, fill: { kind: "solid", color: "#ffffff" } };
/** A character Geist does not draw: the painter's refusal is its own words, `Geist has no 漢`. */
const UNDRAWN = "漢";
const text = (id: `cl_${string}`, words: string, startFrame = 0, look: TextLook = LOOK): TimelineClip =>
  ({ id, startFrame, durationFrames: 48, sourceInFrames: 0, source: { kind: "text", label: words.split("\n").find(line => line.trim() !== "") ?? words, text: words, look } });

async function world() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => NOW }); closeOnCleanup(() => store.close());
  const production = () => store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
  const still = store.getBundle().artifacts.find(value => value.kind === "board")!;
  const timelineFile = join(store.dir, "productions", PRODUCTION, "timeline.json");
  const raw = () => readFile(timelineFile, "utf8");
  const read = async () => ProductionTimelineSchema.parse(JSON.parse(await raw()));
  const revision = async () => { try { return (await read()).revision; } catch { return null; } };
  const send = async (commands: TimelineCommand[]) => applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands",
    baseRevision: await revision(), sourceFingerprint: storyTimelineFingerprint(production()), commands });
  const history = async (kind: "undo" | "redo") => applyHumanTimelineCommand(store, PRODUCTION, { kind, baseRevision: (await read()).revision });
  const cache = async () => stat(join(store.dir, TEXT_PICTURE_DIR)).then(() => true, () => false);
  const placeStill = (id: `cl_${string}`, startFrame: number): TimelineCommand => ({ kind: "place", trackId: "tr_picture",
    clip: { id, startFrame, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } });
  /** Writes a timeline no command wrote, as a hand or an older install might have left it. */
  const adopt = async (change: (timeline: ReturnType<typeof ProductionTimelineSchema.parse>) => void) => {
    const before = await raw(), timeline = ProductionTimelineSchema.parse(JSON.parse(before));
    change(timeline);
    await store.commit({ kind: "adopt-timeline", source: "test", files: [{ path: `productions/${PRODUCTION}/timeline.json`, action: "replace",
      content: `${JSON.stringify(timeline, null, 2)}\n`, baseHash: sha256(before) }] });
  };
  return { store, production, still, raw, read, send, history, cache, placeStill, adopt };
}

test("text the painter would refuse is refused before anything is written", async () => {
  const { store, raw, read, send, cache, placeStill } = await world();
  await send([placeStill("cl_still", 0)]);
  const before = await raw(), version = (await readWorldMeta(store.dir)).schemaVersion;
  for (const [clip, reason] of [[text("cl_name", UNDRAWN), `Geist has no ${UNDRAWN}`], [text("cl_name", "ADE", 0, { ...LOOK, typeface: "bangers", weight: "bold" }), "Bangers has no bold"]] as const) {
    await assert.rejects(send([{ kind: "place", trackId: "tr_picture", clip: { ...clip, startFrame: 96 } }]),
      (error: unknown) => error instanceof TimelineCommandRefused && error.reason === reason, reason);
    assert.equal(await raw(), before, "no revision, no history");
  }
  assert.equal((await readWorldMeta(store.dir)).schemaVersion, version, "a refused place raises nothing");
  assert.equal(await cache(), false, "the painter was asked to lay out, not to keep");
  // The same words that draw are let in, and still nothing is painted until something asks to see them.
  await send([{ kind: "place", trackId: "tr_picture", clip: { ...text("cl_name", "ADE"), startFrame: 96 } }]);
  assert.equal((await read()).tracks[0]!.clips.some(clip => clip.id === "cl_name"), true);
  assert.equal(await cache(), false);
});

test("a batch that leaves an unpaintable clip refuses in the painter's words", async () => {
  const { raw, read, send, adopt, placeStill } = await world();
  await send([placeStill("cl_still", 0), { kind: "place", trackId: "tr_picture", clip: { ...text("cl_name", "ADE"), startFrame: 96 } }]);
  let before = await raw();
  await assert.rejects(send([{ kind: "text-set", clipIds: ["cl_name"], text: `ADE ${UNDRAWN}` }]),
    (error: unknown) => error instanceof TimelineCommandRefused && error.reason === `Geist has no ${UNDRAWN}`);
  await assert.rejects(send([{ kind: "text-set", clipIds: ["cl_name"], look: { typeface: "bangers", weight: "bold" } }]),
    (error: unknown) => error instanceof TimelineCommandRefused && error.reason === "Bangers has no bold");
  assert.equal(await raw(), before);

  // A clip that already cannot be drawn (its words came from outside any command) is not asked
  // about again: it still moves, splits and deletes, and can be retyped into words that draw.
  await adopt(timeline => { timeline.tracks[0]!.clips.push({ ...text("cl_undrawn", UNDRAWN), startFrame: 144 }); });
  before = await raw();
  await send([{ kind: "move-to-frame", clipId: "cl_undrawn", startFrame: 192 }]);
  await send([{ kind: "split", clipId: "cl_undrawn", atFrame: 216, newClipId: "cl_undrawn_tail" }]);
  await send([{ kind: "delete", clipId: "cl_undrawn_tail" }]);
  await send([{ kind: "text-set", clipIds: ["cl_undrawn"], text: "IFE" }]);
  const after = await read();
  assert.notEqual(await raw(), before);
  assert.deepEqual(after.tracks[0]!.clips.filter(clip => clip.source.kind === "text").map(clip => clip.source.kind === "text" ? clip.source.text : null), ["ADE", "IFE"]);
});

test("Undo of a text edit is never asked of the painter", async () => {
  const { read, send, history, adopt, placeStill } = await world();
  await send([placeStill("cl_still", 0)]);
  await adopt(timeline => { timeline.tracks[0]!.clips.push({ ...text("cl_undrawn", UNDRAWN), startFrame: 96 }); });
  await send([{ kind: "delete", clipId: "cl_undrawn" }]);
  assert.equal((await read()).tracks[0]!.clips.some(clip => clip.id === "cl_undrawn"), false);
  // Undo restores exactly what was there, words the painter would now refuse included.
  await history("undo");
  const restored = (await read()).tracks[0]!.clips.find(clip => clip.id === "cl_undrawn");
  assert.equal(restored?.source.kind === "text" ? restored.source.text : null, UNDRAWN);
  await history("redo");
  assert.equal((await read()).tracks[0]!.clips.some(clip => clip.id === "cl_undrawn"), false);
});

test("a request moves text as it moves a still: staged, and accepted as one revision", async () => {
  const { store, production, read, send, history, placeStill } = await world();
  await send([placeStill("cl_still", 0), { kind: "place", trackId: "tr_picture", clip: { ...text("cl_name", "ADE"), startFrame: 96 } }]);
  const timeline = await read(), push = { kind: "push-in", amount: .1 } as const;
  const check = (commands: TimelineCommand[]) => () => refuseUnrenderablePlacements(commands, timeline, production(), store.getBundle().artifacts);
  const refusedAs = (reason: string) => (error: unknown) => error instanceof TimelineCommandRefused && error.reason === reason;
  check([{ kind: "picture-motion", clipId: "cl_name", motion: push }])();
  check([{ kind: "place", trackId: "tr_picture", clip: { ...text("cl_more", "IFE"), startFrame: 200 } }, { kind: "picture-motion", clipId: "cl_more", motion: { kind: "drift-left", amount: .1 } }])();
  check([{ kind: "place", trackId: "tr_picture", clip: { ...text("cl_more", "IFE"), startFrame: 200, motion: push } }])();
  check([{ kind: "picture-motion", clipId: "cl_still", motion: push }])();
  // Only the track can be wrong for text; a picture that is not a still is refused as before.
  assert.throws(check([{ kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" }, { kind: "place", trackId: "tr_music", clip: text("cl_more", "IFE") }]),
    refusedAs("Text belongs on a Picture track"));
  const scene = production().scenes[0]!, shot = orderedShots(scene)[0]!;
  assert.throws(check([{ kind: "place", trackId: "tr_picture", clip: { id: "cl_shot", startFrame: 200, durationFrames: 48, sourceInFrames: 0,
    source: { kind: "shot", shotId: shot.id, sceneNumber: scene.number, shotNumber: 1, label: "Shot" } } }, { kind: "picture-motion", clipId: "cl_shot", motion: push }]),
  refusedAs("Motion needs a still image"));

  const before = timeline.revision;
  const [staged] = await stageEditorRequests(store, { conversationId: CONVERSATION, entryContext: { kind: "production", productionId: PRODUCTION },
    requests: [{ summary: "Move the name", commands: [{ kind: "picture-motion", clipId: "cl_name", motion: push }] }], now: NOW });
  assert.equal(staged?.status, "pending");
  await decideEditorRequest(store, { productionId: PRODUCTION, requestId: staged.id, decision: "accept", now: NOW });
  const moved = await read();
  assert.equal(moved.revision, before + 1);
  assert.deepEqual(moved.tracks[0]!.clips.find(clip => clip.id === "cl_name")?.motion, push);
  assert.equal(production().editorRequests.find(request => request.id === staged.id)?.status, "accepted");
  await history("undo");
  assert.equal((await read()).tracks[0]!.clips.find(clip => clip.id === "cl_name")?.motion, undefined);
});

test("accepting a request whose place carries text the painter refuses is refused in the painter's words and writes nothing", async () => {
  const { store, production, raw, send, placeStill } = await world();
  await send([placeStill("cl_still", 0)]);
  const before = await raw();
  const [staged] = await stageEditorRequests(store, { conversationId: CONVERSATION, entryContext: { kind: "production", productionId: PRODUCTION },
    requests: [{ summary: "Add a name", commands: [{ kind: "place", trackId: "tr_picture", clip: { ...text("cl_name", UNDRAWN), startFrame: 96 } }] }], now: NOW });
  assert.ok(staged);
  await assert.rejects(decideEditorRequest(store, { productionId: PRODUCTION, requestId: staged.id, decision: "accept", now: NOW }),
    (error: unknown) => error instanceof TimelineCommandRefused && error.reason === `Geist has no ${UNDRAWN}`);
  assert.equal(await raw(), before, "the timeline is as it was");
  assert.equal(production().editorRequests.find(request => request.id === staged.id)?.status, "pending", "the card is still there to reject");
});

test("staging that request is not refused, and raises the floor", async () => {
  const { store, production, raw, send, placeStill } = await world();
  await send([placeStill("cl_still", 0)]);
  const before = await raw();
  assert.ok((await readWorldMeta(store.dir)).schemaVersion < EDITOR_TEXT_SCHEMA_VERSION);
  // Typed with blank lines around it: the card names the picture its stored words would make.
  const [staged] = await stageEditorRequests(store, { conversationId: CONVERSATION, entryContext: { kind: "production", productionId: PRODUCTION },
    requests: [{ summary: "Add a name", commands: [{ kind: "place", trackId: "tr_picture", clip: { ...text("cl_name", `\n${UNDRAWN}\n`), startFrame: 96 } }] }], now: NOW });
  assert.equal(staged?.status, "pending");
  assert.equal(await raw(), before);
  assert.equal((await readWorldMeta(store.dir)).schemaVersion, EDITOR_TEXT_SCHEMA_VERSION);
  assert.equal(production().editorRequests.length, 1);
  // The route would ask to paint it and be told why not; it is a name the world holds all the same.
  assert.equal(textPicturesNamed([production()]).size, 3, "one name at each delivery size");
});

test("a transition proposal on a cut with a text clip captures no dependency on the kept picture, and still applies after .cache/editor-text is deleted", async () => {
  const { store, production, read, send, placeStill } = await world();
  await send([placeStill("cl_first", 0), placeStill("cl_second", 96),
    { kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" },
    { kind: "place", trackId: "tr_names", clip: { ...text("cl_name", "ADE"), startFrame: 24, durationFrames: 112, fade: { inFrames: 24, outFrames: 30 } } }]);
  // The picture the plan names is on disk before the proposal is made, as it is once the Viewer has drawn it.
  const named = [...textPicturesNamed([production()]).keys()];
  for (const name of named) assert.ok(await serveTextPicture(store, store.getBundle().meta.slug, `${TEXT_PICTURE_DIR}/${name}.png`), name);
  const analysis = new EditorEffectAnalysisService(undefined, () => {}); closeOnCleanup(() => analysis.stop());
  const deps = new EditorEffectDependencies(analysis);
  const pair = { trackId: "tr_picture", leftClipId: "cl_first", rightClipId: "cl_second" };
  const model: ModelTransitionProposal = { summary: "Crossfade the stills", commands: [{ kind: "transition-set", ...pair, durationFrames: 24 }] };
  const staged = await stageTransitionProposal(store, { productionId: PRODUCTION, conversationId: CONVERSATION, proposal: model, actionId: "act_01J8G0000000000000000000A1" }, deps);
  const { sources, issues } = staged.version.dependencies;
  assert.deepEqual(issues, [], "no media is reported unavailable");
  assert.ok(sources.length > 0, "the stills are still a dependency");
  assert.equal(sources.some(source => source.path.startsWith(`${TEXT_PICTURE_DIR}/`)), false, "the kept picture is not");

  await rm(join(store.dir, TEXT_PICTURE_DIR), { recursive: true, force: true });
  let action = 0;
  const operate = async (operation: TransitionReviewOperation) => (await handleTransitionReview(store, { kind: "editor-transition-proposal", worldId: store.worldId,
    productionId: PRODUCTION, requestId: `human-${++action}`, operation }, deps)).result;
  const ref = transitionVersionRef(staged.family.id, staged.version);
  const reviewed = await operate({ kind: "review", ref }); assert.equal(reviewed.outcome, "reviewed", reviewed.reason);
  const applied = await operate({ kind: "apply", ref, reviewId: reviewed.reviewId! }); assert.equal(applied.outcome, "applied", applied.reason);
  assert.equal((await read()).transitions?.length, 1);
});

test("a transition proposal crossfades two names, and still applies after .cache/editor-text is deleted", async () => {
  const { store, production, read, send, placeStill } = await world();
  await send([placeStill("cl_first", 0),
    { kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" },
    { kind: "place", trackId: "tr_names", clip: { ...text("cl_name", "ADE"), startFrame: 24 } },
    { kind: "place", trackId: "tr_names", clip: { ...text("cl_next", "IFE"), startFrame: 72 } }]);
  for (const name of textPicturesNamed([production()]).keys()) assert.ok(await serveTextPicture(store, store.getBundle().meta.slug, `${TEXT_PICTURE_DIR}/${name}.png`), name);
  const analysis = new EditorEffectAnalysisService(undefined, () => {}); closeOnCleanup(() => analysis.stop());
  const deps = new EditorEffectDependencies(analysis);
  const pair = { trackId: "tr_names", leftClipId: "cl_name", rightClipId: "cl_next" };
  const model: ModelTransitionProposal = { summary: "Crossfade the names", commands: [{ kind: "transition-set", ...pair, durationFrames: 12 }] };
  const staged = await stageTransitionProposal(store, { productionId: PRODUCTION, conversationId: CONVERSATION, proposal: model, actionId: "act_01J8G0000000000000000000A2" }, deps);
  assert.deepEqual(staged.version.conflicts, [], "two names are a pair of stills (R-17)");
  assert.equal(staged.version.dependencies.sources.some(source => source.path.startsWith(`${TEXT_PICTURE_DIR}/`)), false, "the kept pictures are not a dependency");

  await rm(join(store.dir, TEXT_PICTURE_DIR), { recursive: true, force: true });
  let action = 0;
  const operate = async (operation: TransitionReviewOperation) => (await handleTransitionReview(store, { kind: "editor-transition-proposal", worldId: store.worldId,
    productionId: PRODUCTION, requestId: `human-${++action}`, operation }, deps)).result;
  const ref = transitionVersionRef(staged.family.id, staged.version);
  const reviewed = await operate({ kind: "review", ref }); assert.equal(reviewed.outcome, "reviewed", reviewed.reason);
  const applied = await operate({ kind: "apply", ref, reviewId: reviewed.reviewId! }); assert.equal(applied.outcome, "applied", applied.reason);
  // Each side is keyed by its title's words and look, so a title placed later under either id is not this pair (SPEC-054 R-10).
  const record = await read(), keyOf = (clipId: string) => transitionSourceKey(record.tracks.flatMap(track => track.clips).find(clip => clip.id === clipId)!);
  assert.notEqual(keyOf("cl_name"), keyOf("cl_next"));
  assert.deepEqual(record.transitions?.map(row => ({ ...pair, leftSourceKey: row.leftSourceKey, rightSourceKey: row.rightSourceKey, durationFrames: row.durationFrames })),
    [{ ...pair, leftSourceKey: keyOf("cl_name"), rightSourceKey: keyOf("cl_next"), durationFrames: 12 }]);
});

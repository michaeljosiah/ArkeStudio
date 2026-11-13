import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EditorRequestSchema, ModelEditorRequestSchema, PRESETS, ProductionTimelineSchema, TEXT_PICTURE_DIR, TEXT_TYPEFACES, TEXT_TYPEFACE_IDS,
  TEXT_TYPEFACE_STYLES, TIMELINE_EDITOR_COMMAND_GUIDE, defaultEffectClip, defaultExportPreset, editorTextChanges,
  previewEditorRequest, storyTimelineFingerprint, textPictureFrame, textPicturePath, transitionInactiveReason, transitionSourceKey,
  type ModelEditorRequest, type ProductionTimeline, type TextFrame, type TextLook, type TimelineClip, type TimelineCommand,
} from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup, tempDir } from "../tmp.js";
import { applyHumanTimelineCommand, TimelineCommandRefused } from "../../src/productions/timeline.js";
import { EditorRequestRefused, decideEditorRequest, previewProductionEditorRequest, requestBase, stageEditorRequests, validateEditorRequest } from "../../src/productions/editor-requests.js";
import { readRequestFile, requestFileInput } from "../../src/productions/editor-request-file.js";
import { serveTextPicture, sweepTextPictures, textPictureSizes, textPicturesNamed } from "../../src/productions/editor-text-cache.js";
import { textPictureRefusal } from "../../src/productions/editor-text-pictures.js";
import { carriesEditorText } from "../../src/productions/timeline-record.js";
import { loadTextFace } from "../../src/media/text-typefaces.js";
import { decodePng } from "../../src/references/png.js";
import { EDITOR_TEXT_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";

/**
 * Arke's requests that hold text (SPEC-065 R-35 – R-37, SPEC-039 R-26 – R-36): a request is asked
 * of the painter when it is staged, by the function and at the size Accept asks it, so a card the
 * person could never accept is refused back to the model in Accept's own words and never shown.
 * One that is staged lands as one revision and one Undo, and only on the person's Accept; a
 * pending `text-set` names the picture its card draws, so the Viewer is served it and the sweep
 * keeps it until the request is decided; and a request holding text raises the floor only when
 * its file is written.
 */

const PRODUCTION = "saltlight", NOW = "2026-11-12T12:00:00.000Z";
const CONVERSATION = "cv_01J8G0000000000000000000C1";
const ENTRY = { kind: "production", productionId: PRODUCTION } as const;
const REQUESTS = `productions/${PRODUCTION}/editor-requests.json`;
/** The promo's name look (SPEC-065 §2.5.1): EB Garamond, the one face of the six that draws ẹ, ọ and ṣ. */
const PROMO: TextLook = { typeface: "eb-garamond", weight: "regular", italic: false, size: 0.071, tracking: 0, leading: 1.2, capitals: false, align: "center",
  x: 0.5, y: 0.75, room: 0.815,
  fill: { kind: "gradient", stops: [{ at: 0, color: "#f6da94" }, { at: 0.38, color: "#e9c069" }, { at: 0.7, color: "#c9973d" }, { at: 1, color: "#9c6a1e" }] },
  edge: { color: "#1a1208", width: 0.022 }, shadow: { color: "#000000", opacity: 0.85, blur: 0.25, dx: 0, dy: 0.03 },
  rule: { length: 0.178, weight: 0.022, gap: 0.42, soft: true }, backing: { kind: "shade", color: "#060402", opacity: 0.9 } };
const GEIST: TextLook = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false, align: "center",
  x: 0.5, y: 0.5, room: 0.8, fill: { kind: "solid", color: "#ffffff" } };
/** A character Geist does not draw: the painter's refusal is its own words, `Geist has no 漢`. */
const UNDRAWN = "漢";
const NAMES = [["cl_ade", "Ade\nthe healer", 24], ["cl_ife", "Ifẹ", 160], ["cl_kemi", "Kemi", 296], ["cl_tunde", "Tunde", 432]] as const;
const IDS = NAMES.map(([id]) => id);
const PUSH = { kind: "push-in", amount: 0.08 } as const;

const text = (id: `cl_${string}`, words: string, startFrame: number, look: TextLook = PROMO): TimelineClip =>
  ({ id, startFrame, durationFrames: 112, sourceInFrames: 0, fade: { inFrames: 24, outFrames: 30 },
    source: { kind: "text", label: words.split("\n")[0]!, text: words, look } });
const ADD_NAMES: TimelineCommand = { kind: "add-track", trackId: "tr_names", trackKind: "picture", name: "Names" };
const PLACE_NAMES: TimelineCommand[] = NAMES.map(([id, words, startFrame]) => ({ kind: "place", trackId: "tr_names", clip: text(id, words, startFrame) }));
/** A request as the turn's parse hands it on: held to the record's schema first. */
const ask = (summary: string, commands: readonly TimelineCommand[]): ModelEditorRequest => ModelEditorRequestSchema.parse({ summary, commands });

async function world() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => NOW }); closeOnCleanup(() => store.close());
  const production = () => store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!;
  const still = store.getBundle().artifacts.find(value => value.kind === "board")!;
  const raw = () => readFile(join(store.dir, "productions", PRODUCTION, "timeline.json"), "utf8");
  const read = async () => ProductionTimelineSchema.parse(JSON.parse(await raw()));
  const revision = async () => { try { return (await read()).revision; } catch { return null; } };
  const send = async (commands: TimelineCommand[]) => applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands",
    baseRevision: await revision(), sourceFingerprint: storyTimelineFingerprint(production()), commands });
  const history = async (kind: "undo" | "redo") => applyHumanTimelineCommand(store, PRODUCTION, { kind, baseRevision: (await read()).revision });
  const cache = async () => stat(join(store.dir, TEXT_PICTURE_DIR)).then(() => true, () => false);
  const placeStill = (id: `cl_${string}`, startFrame: number): TimelineCommand => ({ kind: "place", trackId: "tr_picture",
    clip: { id, startFrame, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } });
  const stage = (requests: readonly ModelEditorRequest[], more: { dryRun?: boolean; textFrom?: string } = {}) =>
    stageEditorRequests(store, { conversationId: CONVERSATION, entryContext: ENTRY, requests, now: NOW, ...more });
  const accept = (requestId: string) => decideEditorRequest(store, { productionId: PRODUCTION, requestId, decision: "accept", now: NOW });
  const record = (requestId: string) => production().editorRequests.find(request => request.id === requestId);
  /**
   * Writes a pending request against the current revision as staging wrote one before it asked
   * the painter (slice 2): the only way such a request reaches Accept now, and Accept is its fence.
   */
  const adoptRequest = async (request: ModelEditorRequest, id: `req_${string}`) => {
    const { raw: before, file } = await readRequestFile(store, PRODUCTION);
    const pending = EditorRequestSchema.parse({ id, productionId: PRODUCTION, conversationId: CONVERSATION, baseRevision: await revision(),
      sourceFingerprint: storyTimelineFingerprint(production()), commands: request.commands, summary: request.summary, createdAt: NOW, status: "pending" });
    await store.commit({ kind: "adopt-editor-requests", source: "test", files: [requestFileInput(PRODUCTION, before, { ...file, requests: [...file.requests, pending] })] });
    return pending;
  };
  /** Everything a refused request must leave as it was: the requests, the cut, the floor and the change journal. */
  const snapshot = async () => ({
    requests: await readFile(join(store.dir, REQUESTS), "utf8").catch(() => null),
    timeline: await raw(),
    version: (await readWorldMeta(store.dir)).schemaVersion,
    changes: await readFile(join(store.dir, "changes.jsonl"), "utf8"),
  });
  return { store, production, raw, read, send, history, cache, placeStill, stage, accept, record, adoptRequest, snapshot };
}

const sourceOf = (timeline: { tracks: readonly { clips: readonly TimelineClip[] }[] }, id: string) => {
  const source = timeline.tracks.flatMap(track => track.clips).find(clip => clip.id === id)?.source;
  if (source?.kind !== "text") throw new Error(`${id} is not text`);
  return source;
};
const refusedAs = (reason: string, kind: typeof EditorRequestRefused | typeof TimelineCommandRefused = EditorRequestRefused) =>
  (error: unknown) => error instanceof kind && error.reason === reason;
const pictureOf = (words: string, frame: TextFrame, look: TextLook = PROMO) => {
  const ref = textPicturePath({ text: words, look }, frame);
  if (!ref.ok) throw new Error(ref.reason);
  return ref;
};

test("Arke's four names land as one revision and one Undo, and nothing is drawn or written before Accept (R-35, SPEC-039 R-30)", async () => {
  const { production, raw, read, send, history, cache, placeStill, stage, accept, record } = await world();
  await send([placeStill("cl_still", 0)]);
  const before = await raw(), base = await read();
  const [staged] = await stage([ask("Name the four", [ADD_NAMES, ...PLACE_NAMES])]);
  assert.equal(staged?.status, "pending");
  assert.equal(await raw(), before, "staging writes no revision");
  assert.equal(await cache(), false, "staging lays out and paints nothing");

  await accept(staged.id);
  const after = await read(), entry = after.history.undo.at(-1);
  assert.equal(after.revision, base.revision + 1, "one revision");
  assert.equal(after.history.undo.length, base.history.undo.length + 1, "one Undo entry");
  assert.equal(entry?.kind, "change");
  if (entry?.kind !== "change") return;
  assert.equal(entry.requestId, staged.id);
  assert.equal(entry.clips.length, 4);
  assert.equal(entry.tracks.length, 1);
  const names = after.tracks.find(track => track.id === "tr_names")!;
  assert.equal(names.name, "Names");
  assert.deepEqual(names.clips.map(clip => clip.source.kind === "text" ? clip.source.text : null), NAMES.map(([, words]) => words));
  assert.deepEqual([record(staged.id)?.status, record(staged.id)?.resultRevision], ["accepted", base.revision + 1]);
  assert.equal(await cache(), false, "Accept paints nothing either; the Viewer asks for its pictures");

  // The person's Undo takes back the whole request as one step, and the record says so (R-36).
  await history("undo");
  assert.deepEqual((await read()).tracks, base.tracks);
  assert.equal(record(staged.id)?.status, "accepted");
  assert.equal(record(staged.id)?.undoneAt, NOW);
  await history("redo");
  assert.deepEqual((await read()).tracks.find(track => track.id === "tr_names")?.clips.map(clip => clip.id), IDS);
  assert.equal(production().editorRequests.length, 1);
});

test("a text-set request states before and after, lands as one revision, and Undo restores the words and look exactly (R-25, R-28, R-36)", async () => {
  const { store, read, send, history, placeStill, stage, accept } = await world();
  await send([placeStill("cl_still", 0), ADD_NAMES, ...PLACE_NAMES]);
  const base = await read();
  const restyle = ask("Larger names, no edge", [{ kind: "text-set", clipIds: [...IDS], look: { size: 0.09, edge: null } }]);
  const preview = previewProductionEditorRequest(store, PRODUCTION, restyle, NOW);
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.deepEqual(preview.digest.text.map(change => [change.change, change.clipId, change.values.map(value => value.label)]),
    IDS.map(id => ["change", id, ["Size", "Edge"]]));

  const [staged] = await stage([restyle]);
  await accept(staged!.id);
  const after = await read();
  assert.equal(after.revision, base.revision + 1);
  for (const id of IDS) {
    const source = sourceOf(after, id);
    assert.equal(source.look.size, 0.09);
    assert.equal("edge" in source.look, false, "null removes the part");
  }
  await history("undo");
  const undone = await read();
  for (const id of IDS) assert.deepEqual(sourceOf(undone, id), sourceOf(base, id), `${id} as it was`);

  const [rename] = await stage([ask("Say what Tunde does", [{ kind: "text-set", clipIds: ["cl_tunde"], text: "Tunde\nthe drummer" }])]);
  await accept(rename!.id);
  const renamed = sourceOf(await read(), "cl_tunde");
  assert.deepEqual([renamed.text, renamed.label], ["Tunde\nthe drummer", "Tunde"]);
});

test("a request the painter would refuse is refused before staging, in the words Accept gives, and writes nothing (R-37)", async () => {
  const { send, placeStill, stage, accept, record, adoptRequest, snapshot } = await world();
  await send([placeStill("cl_still", 0), ADD_NAMES, ...PLACE_NAMES, { kind: "place", trackId: "tr_picture", clip: text("cl_plain", "Kemi", 600, GEIST) }]);
  const rows: [ModelEditorRequest, string][] = [
    [ask("Add a title", [{ kind: "place", trackId: "tr_picture", clip: text("cl_title", "ADE", 800, { ...GEIST, typeface: "bangers", weight: "bold" }) }]), "Bangers has no bold"],
    [ask("Add a title", [{ kind: "place", trackId: "tr_picture", clip: text("cl_title", UNDRAWN, 800, GEIST) }]), `Geist has no ${UNDRAWN}`],
    [ask("Retype Kemi", [{ kind: "text-set", clipIds: ["cl_plain"], text: `Kemi ${UNDRAWN}` }]), `Geist has no ${UNDRAWN}`],
    // All or nothing (R-25): three of the four draw in Jost, and the one that does not refuses them all.
    [ask("Set the names in Jost", [{ kind: "text-set", clipIds: [...IDS], look: { typeface: "jost" } }]), "Jost has no ẹ"],
  ];
  for (const [index, [request, reason]] of rows.entries()) {
    const before = await snapshot();
    for (const dryRun of [true, false]) {
      await assert.rejects(stage([request], { dryRun }), refusedAs(`"${request.summary}" cannot apply: ${reason}`), `${reason}, dry run ${dryRun}`);
    }
    assert.deepEqual(await snapshot(), before, "no card, no revision, no floor and no change line");
    // The same commands reaching Accept by another road are refused there with the same characters.
    const pending = await adoptRequest(request, `req_01J8G0000000000000000000R${index}`);
    await assert.rejects(accept(pending.id), refusedAs(reason, TimelineCommandRefused), reason);
    assert.equal(record(pending.id)?.status, "pending", "the card is still there to reject");
  }
});

test("on a cut with an effect, a request is refused before staging in the words Accept gives there too (R-37)", async () => {
  const { send, placeStill, stage, accept, record, adoptRequest, snapshot } = await world();
  await send([placeStill("cl_still", 0), { kind: "add-track", trackId: "tr_fx", trackKind: "effect", name: "Effects" },
    { kind: "effect-create", trackId: "tr_fx", effect: defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", startFrame: 0, durationFrames: 96, seed: 42 }) }]);
  const title = (words: string, look: TextLook) => ask("Add a title", [{ kind: "place", trackId: "tr_picture", clip: text("cl_title", words, 200, look) }]);
  // An effect has Accept build the whole film's plan before it asks the painter, and the plan
  // refuses a face that lacks the weight or slant by the clip's words and track. It does not ask
  // about characters, so the painter still has the last word on those.
  const rows: [ModelEditorRequest, string][] = [
    [title("ADE", { ...GEIST, typeface: "bangers", weight: "bold" }), "ADE on Picture: Bangers has no bold"],
    [title("ADE", { ...GEIST, italic: true }), "ADE on Picture: Geist has no italic"],
    [title(UNDRAWN, GEIST), `Geist has no ${UNDRAWN}`],
  ];
  for (const [index, [request, reason]] of rows.entries()) {
    const before = await snapshot();
    await assert.rejects(stage([request]), refusedAs(`"${request.summary}" cannot apply: ${reason}`), reason);
    assert.deepEqual(await snapshot(), before, "no card, no revision, no floor and no change line");
    const pending = await adoptRequest(request, `req_01J8G0000000000000000000E${index}`);
    await assert.rejects(accept(pending.id), refusedAs(reason, TimelineCommandRefused), reason);
    assert.equal(record(pending.id)?.status, "pending");
  }
  // A face that has them is staged on the same cut.
  assert.equal((await stage([title("ADE", { ...GEIST, weight: "bold" })]))[0]?.status, "pending");
});

test("a typeface file that is missing or not the one shipped refuses a request by name before staging (R-21, R-37)", async () => {
  const { production, send, placeStill, stage, snapshot } = await world();
  await send([placeStill("cl_still", 0)]);
  const { file } = TEXT_TYPEFACES.geist.files.regular;
  /** `dist/main.cjs` with `dist/fonts` beside it, as the packaged app is laid out, holding `bytes` as Geist — or no fonts at all. */
  const bundle = async (bytes?: Uint8Array): Promise<string> => {
    const dist = join(await tempDir("arke-text-request-"), "dist");
    if (bytes) {
      await mkdir(join(dist, "fonts"), { recursive: true });
      await writeFile(join(dist, "fonts", file), bytes);
    }
    return pathToFileURL(join(dist, "main.cjs")).href;
  };
  const request = ask("Add a title", [{ kind: "place", trackId: "tr_picture", clip: text("cl_title", "ADE", 96, GEIST) }]);
  const frame = PRESETS[defaultExportPreset(production().meta)];
  const before = await snapshot();
  for (const [from, reason] of [[await bundle(), `${file} is missing`], [await bundle(new Uint8Array([1, 2, 3])), `${file} is not the file this app shipped with`]] as const) {
    assert.equal(textPictureRefusal({ text: "ADE", look: GEIST, width: frame.width, height: frame.height }, from), reason, "the painter's own answer");
    await assert.rejects(stage([request], { textFrom: from }), refusedAs(`"Add a title" cannot apply: ${reason}`), reason);
  }
  assert.deepEqual(await snapshot(), before);
  // The same request with the shipped files is staged.
  assert.equal((await stage([request]))[0]?.status, "pending");
});

test("a stale text request is refused at Accept and never rebased (SPEC-039 R-32)", async () => {
  const { store, read, send, placeStill, stage, accept, record } = await world();
  await send([placeStill("cl_still", 0), ADD_NAMES, ...PLACE_NAMES]);
  const command: TimelineCommand = { kind: "text-set", clipIds: ["cl_tunde"], text: "Tunde\nthe drummer" };
  const [staged] = await stage([ask("Say what Tunde does", [command])]);
  const base = (await read()).revision;
  // The person moves Kemi while the card waits.
  await send([{ kind: "move-to-frame", clipId: "cl_kemi", startFrame: 300 }]);
  const moved = `the timeline moved to revision ${base + 1}`;
  assert.deepEqual(await validateEditorRequest(store, PRODUCTION, staged!.id),
    { ok: false, stale: true, detail: `The timeline changed after this request was prepared: ${moved}` });
  await assert.rejects(accept(staged!.id), (error: unknown) => error instanceof EditorRequestRefused
    && error.reason === `the request is stale: ${moved}; ask Arke for a new one against the current timeline`);
  const stale = record(staged!.id);
  assert.deepEqual([stale?.status, stale?.reason, stale?.baseRevision, stale?.commands], ["stale", moved, base, [command]], "marked, never rebased");
  const after = await read();
  assert.equal(after.revision, base + 1);
  assert.equal(sourceOf(after, "cl_tunde").text, "Tunde");
  await assert.rejects(accept(staged!.id), refusedAs(`request ${staged!.id} is already stale`));
});

test("a pending text-set's picture is named, served and kept by the sweep until the request is decided (R-20, R-37)", async () => {
  const { store, production, send, placeStill, stage, record } = await world();
  await send([placeStill("cl_still", 0), ADD_NAMES, ...PLACE_NAMES]);
  const slug = store.getBundle().meta.slug, frame = PRESETS[defaultExportPreset(production().meta)];
  const pathOf = (words: string) => {
    const ref = textPicturePath({ text: words, look: PROMO }, frame);
    if (!ref.ok) throw new Error(ref.reason);
    return ref;
  };
  const namesOf = (words: string) => textPictureSizes({ text: words, look: PROMO, label: words }).map(size => {
    const ref = textPicturePath({ text: words, look: PROMO }, size);
    if (!ref.ok) throw new Error(ref.reason);
    return ref.name;
  });
  const named = () => textPicturesNamed(store.getBundle().productions);
  const onDisk = (path: string) => stat(join(store.dir, path)).then(() => true, () => false);
  // The timeline's own picture of Tunde, served once, is kept through everything below.
  const own = pathOf("Tunde");
  assert.ok(await serveTextPicture(store, slug, own.path));

  for (const [words, decide] of [["Tunde\nthe drummer", "edit"], ["Tunde\nthe singer", "reject"]] as const) {
    const [staged] = await stage([ask(`Tunde, ${words.split("\n")[1]}`, [{ kind: "text-set", clipIds: ["cl_tunde"], text: words }])]);
    for (const name of namesOf(words)) assert.ok(named().has(name), "named at every size it may be painted at");
    const ghost = pathOf(words);
    const served = await serveTextPicture(store, slug, ghost.path);
    assert.ok(served, "the Viewer is served the card's ghost picture");
    assert.equal(await onDisk(ghost.path), true);
    assert.deepEqual(await sweepTextPictures(store), { removed: 0, skipped: false });
    assert.equal(await onDisk(ghost.path), true, "the sweep keeps it while the request waits");

    if (decide === "edit") {
      // The base moves under the request: it is stale, its card draws no ghost, and its picture goes.
      await send([{ kind: "move-to-frame", clipId: "cl_kemi", startFrame: 300 }]);
      assert.equal(record(staged!.id)?.status, "pending");
    } else {
      await decideEditorRequest(store, { productionId: PRODUCTION, requestId: staged!.id, decision: "reject", now: NOW });
      assert.equal(record(staged!.id)?.status, "rejected");
    }
    for (const name of namesOf(words)) assert.equal(named().has(name), false, `${decide}: no longer named`);
    assert.deepEqual(await sweepTextPictures(store), { removed: 1, skipped: false });
    assert.equal(await onDisk(ghost.path), false);
    assert.equal(await onDisk(own.path), true, "the timeline's own picture stays");
  }
});

test("a retyped title duplicated before its first is deleted keeps its new words' picture named (Codex on PR 3047)", async () => {
  const { store, production, send, placeStill, stage } = await world();
  await send([placeStill("cl_still", 0), ADD_NAMES, ...PLACE_NAMES]);
  const slug = store.getBundle().meta.slug, frame = PRESETS[defaultExportPreset(production().meta)], words = "Tunde\nthe drummer";
  await stage([ask("Say what Tunde does, on a copy", [{ kind: "text-set", clipIds: ["cl_tunde"], text: words },
    { kind: "duplicate", clipId: "cl_tunde", newClipId: "cl_tunde2" }, { kind: "delete", clipId: "cl_tunde" }])]);
  // The new words now sit only on a clip no text-set names.
  const named = textPicturesNamed(store.getBundle().productions);
  for (const size of textPictureSizes({ text: words, look: PROMO, label: words })) {
    const ref = textPicturePath({ text: words, look: PROMO }, size);
    assert.ok(ref.ok && named.has(ref.name), `named at ${size.width}x${size.height}`);
  }
  const ghost = textPicturePath({ text: words, look: PROMO }, frame);
  assert.ok(ghost.ok);
  assert.ok(await serveTextPicture(store, slug, ghost.path), "the Viewer is served the copy's picture");
  assert.deepEqual(await sweepTextPictures(store), { removed: 0, skipped: false }, "the sweep keeps it while the request waits");
});

test("a pending place and a pending text-set in one request both name their pictures", async () => {
  const { store, send, placeStill, stage } = await world();
  await send([placeStill("cl_still", 0), ADD_NAMES, ...PLACE_NAMES]);
  await stage([ask("Add Bisi, then say what she does", [{ kind: "place", trackId: "tr_names", clip: text("cl_bisi", "Bisi", 600) },
    { kind: "text-set", clipIds: ["cl_bisi"], text: "Bisi\nthe singer" }])]);
  const named = textPicturesNamed(store.getBundle().productions);
  for (const words of ["Bisi", "Bisi\nthe singer"]) {
    for (const size of textPictureSizes({ text: words, look: PROMO, label: words })) {
      const ref = textPicturePath({ text: words, look: PROMO }, size);
      assert.ok(ref.ok && named.has(ref.name), `${words} at ${size.width}x${size.height}`);
    }
  }
});

test("before timeline.json is written, a pending text-set names the picture its ghost draws on the first assembly (R-37, SPEC-039 R-33)", async () => {
  const { store, production, stage } = await world();
  assert.equal(production().timeline?.status ?? "absent", "absent", "no timeline.json yet");
  const [staged] = await stage([
    ask("Add Bisi, then say what she does", [{ kind: "place", trackId: "tr_picture", clip: text("cl_bisi", "Bisi", 200, GEIST) },
      { kind: "text-set", clipIds: ["cl_bisi"], text: "Bisi\nthe singer" }]),
    // A copy carries its clip's words, and is set on its own.
    ask("Add Kemi twice, the second singing", [{ kind: "place", trackId: "tr_picture", clip: text("cl_kemi", "Kemi", 400, GEIST) },
      { kind: "duplicate", clipId: "cl_kemi", newClipId: "cl_kemi_too" }, { kind: "split", clipId: "cl_kemi_too", atFrame: 560, newClipId: "cl_kemi_tail" },
      { kind: "text-set", clipIds: ["cl_kemi_tail"], text: "Kemi\nthe singer" }, { kind: "text-set", clipIds: ["cl_kemi"], look: { size: 0.1 } }]),
  ]);
  assert.equal(staged?.baseRevision, null, "prepared against the first assembly");
  // The ghosts the Cut draws: each request on the first assembly, as staging prepared it.
  const ghosts = production().editorRequests.flatMap(request => {
    const ghost = previewEditorRequest(requestBase(store, production()).timeline, request.commands);
    if (!ghost.ok) throw new Error(ghost.reason);
    return editorTextChanges({ tracks: [] }, ghost.timeline).map(change => ({ text: change.words, look: sourceOf(ghost.timeline, change.clipId).look }));
  });
  assert.deepEqual(ghosts.map(({ text }) => text), ["Bisi\nthe singer", "Kemi", "Kemi", "Kemi\nthe singer"], "what the ghosts hold");
  const slug = store.getBundle().meta.slug, frame = PRESETS[defaultExportPreset(production().meta)];
  const named = textPicturesNamed(store.getBundle().productions);
  for (const source of ghosts) {
    for (const size of textPictureSizes({ ...source, label: source.text })) {
      const ref = textPicturePath(source, size);
      assert.ok(ref.ok && named.has(ref.name), `${source.text} at ${size.width}x${size.height}`);
    }
    const ref = textPicturePath(source, frame);
    assert.ok(ref.ok && await serveTextPicture(store, slug, ref.path), `the Viewer is served ${source.text}`);
  }
  assert.deepEqual(await sweepTextPictures(store), { removed: 0, skipped: false }, "the sweep keeps them while the requests wait");
  assert.deepEqual(editorTextChanges({ tracks: [] }, requestBase(store, production()).timeline), [], "the first assembly holds no text");
});

test("a pending text-set on a moving title names, serves and keeps its doubled picture until the request is decided (R-17, R-37)", async () => {
  const { store, production, read, send, placeStill, stage, record } = await world();
  await send([placeStill("cl_still", 0), ADD_NAMES, ...PLACE_NAMES, { kind: "picture-motion", clipId: "cl_tunde", motion: PUSH }]);
  const slug = store.getBundle().meta.slug, doubled = textPictureFrame(PRESETS[defaultExportPreset(production().meta)], true);
  const named = () => textPicturesNamed(store.getBundle().productions);
  const onDisk = (path: string) => stat(join(store.dir, path)).then(() => true, () => false);

  for (const [words, decision] of [["Tunde\nthe singer", "reject"], ["Tunde\nthe drummer", "accept"]] as const) {
    const [staged] = await stage([ask(`Tunde, ${words.split("\n")[1]}`, [{ kind: "text-set", clipIds: ["cl_tunde"], text: words }])]);
    // The request leaves Tunde moving, so the new words are named at twice each delivery size as well.
    const sizes = textPictureSizes({ text: words, look: PROMO, label: "Tunde", moving: true });
    assert.equal(sizes.length, 6);
    for (const size of sizes) assert.ok(named().has(pictureOf(words, size).name), `${decision}: ${size.width}x${size.height}`);
    const ghost = pictureOf(words, doubled), served = await serveTextPicture(store, slug, ghost.path);
    assert.ok(served, "the media route serves the doubled picture");
    const { width, height } = decodePng(await readFile(served.path));
    assert.deepEqual({ width, height }, doubled, "painted at twice the frame, not enlarged to it");
    assert.deepEqual(await sweepTextPictures(store), { removed: 0, skipped: false });
    assert.equal(await onDisk(ghost.path), true, "the sweep keeps it while the request waits");

    await decideEditorRequest(store, { productionId: PRODUCTION, requestId: staged!.id, decision, now: NOW });
    assert.equal(record(staged!.id)?.status, `${decision}ed`);
    if (decision === "reject") {
      for (const size of sizes) assert.equal(named().has(pictureOf(words, size).name), false, `rejected: ${size.width}x${size.height}`);
      assert.deepEqual(await sweepTextPictures(store), { removed: 1, skipped: false });
      assert.equal(await onDisk(ghost.path), false);
    } else {
      // Accepted, the timeline holds the words moving and names the same picture itself.
      const tunde = (await read()).tracks.flatMap(track => track.clips).find(clip => clip.id === "cl_tunde");
      assert.deepEqual([tunde?.motion, sourceOf(await read(), "cl_tunde").text], [PUSH, words]);
      assert.ok(named().has(ghost.name));
      assert.deepEqual(await sweepTextPictures(store), { removed: 0, skipped: false });
      assert.equal(await onDisk(ghost.path), true);
    }
  }
});

test("a request that moves the title it retypes names the doubled picture, on a saved timeline and on the first assembly (R-17, R-37)", async () => {
  const saved = await world();
  await saved.send([saved.placeStill("cl_still", 0), ADD_NAMES, ...PLACE_NAMES]);
  await saved.stage([ask("Push in on Tunde the drummer", [{ kind: "picture-motion", clipId: "cl_tunde", motion: PUSH },
    { kind: "text-set", clipIds: ["cl_tunde"], text: "Tunde\nthe drummer" }])]);

  const first = await world();
  assert.equal(first.production().timeline?.status ?? "absent", "absent", "no timeline.json yet");
  await first.stage([ask("Add Bisi, push in, then say what she does", [{ kind: "place", trackId: "tr_picture", clip: text("cl_bisi", "Bisi", 200, GEIST) },
    { kind: "picture-motion", clipId: "cl_bisi", motion: PUSH }, { kind: "text-set", clipIds: ["cl_bisi"], text: "Bisi\nthe singer" }])]);

  for (const [{ store, production }, clipId, words, look] of [[saved, "cl_tunde", "Tunde\nthe drummer", PROMO], [first, "cl_bisi", "Bisi\nthe singer", GEIST]] as const) {
    // The ghost the Cut draws holds the retyped title moving: the request's own result.
    const [request] = production().editorRequests;
    const ghost = previewEditorRequest(requestBase(store, production()).timeline, request!.commands);
    if (!ghost.ok) throw new Error(ghost.reason);
    const clip = ghost.timeline.tracks.flatMap(track => track.clips).find(row => row.id === clipId);
    assert.deepEqual([clip?.motion, sourceOf(ghost.timeline, clipId).text], [PUSH, words]);
    const named = textPicturesNamed(store.getBundle().productions);
    for (const size of textPictureSizes({ text: words, look, label: words, moving: true })) {
      assert.ok(named.has(pictureOf(words, size, look).name), `${clipId} at ${size.width}x${size.height}`);
    }
  }
});

test("under a protected crossfade a request retypes a title and the join stays protected and live; one that puts another title in its place is refused at staging in Accept's words (SPEC-054 R-9, R-10, R-37)", async () => {
  const { read, send, history, placeStill, stage, accept, record, adoptRequest, snapshot } = await world();
  const pair = { trackId: "tr_names", leftClipId: "cl_ade", rightClipId: "cl_kemi" } as const;
  const kemi = (words: string): TimelineCommand => ({ kind: "place", trackId: "tr_names", clip: text("cl_kemi", words, 136) });
  // Ade into Kemi on Names, touching; a person crossfades them and protects the join and its length.
  await send([placeStill("cl_still", 0), ADD_NAMES, { kind: "place", trackId: "tr_names", clip: text("cl_ade", "Ade\nthe healer", 24) }, kemi("Kemi")]);
  await send([{ kind: "transition-set", ...pair, durationFrames: 12 }, { kind: "transition-protect", ...pair, setting: "join" },
    { kind: "transition-protect", ...pair, setting: "duration" }]);
  /** The blend as SPEC-054 reads it: live, both protections, its length, and keyed to the title Kemi's clip holds now. */
  const blend = (timeline: ProductionTimeline) => {
    const value = timeline.transitions?.[0];
    if (value === undefined) throw new Error("no crossfade");
    const right = timeline.tracks.flatMap(track => track.clips).find(clip => clip.id === "cl_kemi")!;
    return { inactive: transitionInactiveReason(timeline.tracks, timeline.transitions!, value), protectJoin: value.protectJoin,
      protectDuration: value.protectDuration, durationFrames: value.durationFrames, keyed: value.rightSourceKey === transitionSourceKey(right) };
  };
  const held = { inactive: null, protectJoin: true, protectDuration: true, durationFrames: 12, keyed: true };
  const base = await read();
  assert.deepEqual(blend(base), held);

  // Another title under Kemi's id is new media (SPEC-054 R-10), retyped or not: a suggestion cannot
  // pass the protection to it, so no card is staged, and Accept refuses the same commands in the same words.
  const replaced = "The protected transition's original images cannot be replaced";
  const swaps = [
    ask("Tobi in Kemi's place", [{ kind: "delete", clipId: "cl_kemi" }, kemi("Tobi")]),
    ask("Tobi the drummer in Kemi's place", [{ kind: "delete", clipId: "cl_kemi" }, kemi("Tobi"), { kind: "text-set", clipIds: ["cl_kemi"], text: "Tobi\nthe drummer" }]),
  ];
  for (const [index, request] of swaps.entries()) {
    const before = await snapshot();
    for (const dryRun of [true, false]) {
      await assert.rejects(stage([request], { dryRun }), refusedAs(`"${request.summary}" cannot apply: ${replaced}`), `${request.summary}, dry run ${dryRun}`);
    }
    assert.deepEqual(await snapshot(), before, "no card, no revision, no floor and no change line");
    const pending = await adoptRequest(request, `req_01J8G0000000000000000000J${index}`);
    await assert.rejects(accept(pending.id), refusedAs(replaced, TimelineCommandRefused), request.summary);
    assert.equal(record(pending.id)?.status, "pending");
  }
  assert.deepEqual(blend(await read()), held);

  // Retyping and restyling Kemi herself is an edit (SPEC-065 R-25): staged, accepted as one revision,
  // and the blend follows her new words with both protections in place.
  const [staged] = await stage([ask("Say what Kemi does", [{ kind: "text-set", clipIds: ["cl_kemi"], text: "Kemi\nthe singer", look: { size: 0.09 } }])]);
  assert.equal(staged?.status, "pending");
  await accept(staged!.id);
  const after = await read();
  assert.equal(after.revision, base.revision + 1);
  assert.deepEqual([sourceOf(after, "cl_kemi").text, sourceOf(after, "cl_kemi").look.size], ["Kemi\nthe singer", 0.09]);
  assert.deepEqual(blend(after), held);
  assert.notEqual(after.transitions?.[0]?.rightSourceKey, base.transitions?.[0]?.rightSourceKey, "the key moved with her");
  // The person's Undo gives back Kemi and the key the blend was set on.
  await history("undo");
  const undone = await read();
  assert.deepEqual(undone.transitions, base.transitions);
  assert.deepEqual(blend(undone), held);
});

test("a request holding text raises the floor only when its file is written (R-27)", async () => {
  const { store, production, send, placeStill, stage, accept } = await world();
  await send([placeStill("cl_still", 0)]);
  const version = async () => (await readWorldMeta(store.dir)).schemaVersion;
  const requestsFile = () => readFile(join(store.dir, REQUESTS), "utf8").catch(() => null);
  const below = await version();
  assert.ok(below < EDITOR_TEXT_SCHEMA_VERSION);
  const place = ask("Add a title", [{ kind: "place", trackId: "tr_picture", clip: text("cl_title", "ADE", 96, GEIST) }]);

  // A dry run writes nothing, and a refused request writes nothing: neither raises anything.
  assert.deepEqual(await stage([place], { dryRun: true }), []);
  await assert.rejects(stage([ask("Add a title", [{ kind: "place", trackId: "tr_picture", clip: text("cl_title", UNDRAWN, 96, GEIST) }])]), EditorRequestRefused);
  assert.deepEqual([await version(), await requestsFile()], [below, null]);

  // The stage that writes the file raises the world in that same commit.
  const [staged] = await stage([place]);
  assert.equal(await version(), EDITOR_TEXT_SCHEMA_VERSION);
  const lines = (await readFile(join(store.dir, "changes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { entity?: string; path?: string; commitId?: string; toVersion?: number });
  const raised = lines.find(line => line.entity === "world" && line.toVersion === EDITOR_TEXT_SCHEMA_VERSION);
  assert.ok(raised);
  assert.equal(lines.filter(line => line.path === REQUESTS).at(-1)?.commitId, raised.commitId, "the request file and the floor land together");

  // A text-set can name only text a timeline holds, so its world is raised already. The walker
  // reads one all the same: the file keeps the accepted place's text, so it is asked of a file that
  // holds the pending text-set alone.
  await accept(staged!.id);
  await stage([ask("Retitle", [{ kind: "text-set", clipIds: ["cl_title"], text: "ADE OKAFOR" }])]);
  assert.equal(await version(), EDITOR_TEXT_SCHEMA_VERSION);
  const file = JSON.parse((await requestsFile())!) as { requests: { status: string; commands: { kind: string }[] }[] };
  const alone = file.requests.filter(request => request.status === "pending");
  assert.deepEqual(alone.map(request => request.commands.map(command => command.kind)), [["text-set"]]);
  assert.equal(carriesEditorText(JSON.stringify({ ...file, requests: alone })), true);
  assert.equal(production().editorRequests.filter(request => request.status === "pending").length, 1);
});

test("of the six faces only EB Garamond draws ẹ, ọ and ṣ, as Arke's guide says, and none draws a card's line break", () => {
  const yoruba = [0x1EB9, 0x1ECD, 0x1E63];
  const drawn = TEXT_TYPEFACE_IDS.filter(id => {
    const face = loadTextFace(id, "regular", false);
    if (!face.ok) throw new Error(face.reason);
    return yoruba.every(codePoint => face.face.has(codePoint));
  });
  assert.deepEqual(drawn, ["eb-garamond"]);
  assert.ok(TIMELINE_EDITOR_COMMAND_GUIDE.includes("only eb-garamond draws ẹ, ọ and ṣ"));

  // A card writes a line break as ⏎ (R-36). No face in any style draws it, so the painter refuses
  // it in typed words and a stored title can never read on a card as one with a break.
  for (const id of TEXT_TYPEFACE_IDS) for (const style of TEXT_TYPEFACE_STYLES) {
    if (TEXT_TYPEFACES[id].files[style] === undefined) continue;
    const face = loadTextFace(id, style.startsWith("bold") ? "bold" : "regular", style.endsWith("italic"));
    if (!face.ok) throw new Error(face.reason);
    assert.equal(face.face.has(0x23CE), false, `${id} ${style}`);
  }
});

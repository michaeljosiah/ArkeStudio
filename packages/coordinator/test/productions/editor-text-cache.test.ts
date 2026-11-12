import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EditorRequestSchema, PRESETS, ProductionTimelineSchema, buildRenderPlan, TEXT_PICTURE_DIR, TEXT_TYPEFACES, TextLookSchema, applyTimelineCommands, textLabel, textPicturePath,
  undoTimelineHistory, type EditorRequest, type ExportOverlay, type ProductionBundle, type ProductionTimeline, type RenderPictureLayer, type TextLook,
  type TimelineClip, type TimelineClipCommand,
} from "@arke-studio/contracts";
import {
  keepTextPicture, refuseUnpaintableText, serveTextPicture, sweepTextPictures, textPictureSizes, textPicturesForExport, textPicturesNamed, textSourcesNamed,
} from "../../src/productions/editor-text-cache.js";
import { paintTextPicture, textPictureRefusal } from "../../src/productions/editor-text-pictures.js";
import { carriesEditorText } from "../../src/productions/timeline-record.js";
import { decodePng } from "../../src/references/png.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup, tempDir } from "../tmp.js";

// Keeping a text clip's picture (SPEC-065 R-20, R-21, §2.3, §3.2 bullets 4 and 10): painted the
// first time it is asked for, kept under its name and never rewritten, painted again when the
// folder is gone, swept when nothing names it, and refused by name before anything is written or
// rendered. Pictures are compared by their pixels, never by their PNG bytes: two builds of zlib
// may pack the same pixels differently.

const PRODUCTION = "saltlight", OTHER = "the-ledger-of-nights";
const LOOK: TextLook = TextLookSchema.parse({ typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2,
  capitals: false, align: "center", x: 0.5, y: 0.5, room: 0.8, fill: { kind: "solid", color: "#ffffff" } });
const SMALL = { width: 320, height: 180 }, REVIEW = { width: PRESETS["review-cut"].width, height: PRESETS["review-cut"].height };
const { file: GEIST_FILE } = TEXT_TYPEFACES.geist.files.regular;
const fonts = fileURLToPath(new URL("../../src/publications/fonts/", import.meta.url));

const textClip = (id: `cl_${string}`, startFrame: number, text: string, look: TextLook = LOOK): TimelineClip =>
  ({ id, startFrame, durationFrames: 48, sourceInFrames: 0, source: { kind: "text", label: textLabel(text), text, look } });
/** A Picture track to stand on and a Names track above it, holding `names`. */
const timeline = (names: TimelineClip[]): ProductionTimeline => ProductionTimelineSchema.parse({ schemaVersion: 1, revision: 0, frameRate: 24, tracks: [
  { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [] },
  { id: "tr_names", kind: "picture", name: "Names", order: 1, muted: false, clips: names },
], history: { undo: [], redo: [] } });
const apply = (base: ProductionTimeline, commands: TimelineClipCommand[]) => applyTimelineCommands(base, commands, { effectAuthority: "human" });

/** "Now" on the Names track, "Old" in Undo and "Next" in Redo, each made by the reducer itself. */
function stepped(): ProductionTimeline {
  const now = apply(timeline([textClip("cl_name", 0, "Old")]), [{ kind: "text-set", clipIds: ["cl_name"], text: "Now" }]);
  return undoTimelineHistory(apply(now, [{ kind: "text-set", clipIds: ["cl_name"], text: "Next" }]));
}
/** A pending request to place words as Arke typed them: a blank line round them, Windows line ends, a label of its own. */
const request = (status: EditorRequest["status"] = "pending", typed = "\r\nPending\r\n"): EditorRequest => EditorRequestSchema.parse({
  id: "req_01J8G0000000000000000000R1", productionId: PRODUCTION, conversationId: "cv_01J8G0000000000000000000C1", baseRevision: 1,
  sourceFingerprint: "story-picture-v1:0123456789abcdef", summary: "Put a name up", createdAt: "2026-11-12T10:00:00.000Z", status,
  commands: [{ kind: "place", trackId: "tr_names", clip: { ...textClip("cl_pending", 200, "Pending"), source: { kind: "text", label: "Arke's label", text: typed, look: LOOK } } }] });

const named = (text: string, frame = REVIEW, look = LOOK) => { const ref = textPicturePath({ text, look }, frame); assert.ok(ref.ok, text); return ref; };
const relative = (text: string, frame = REVIEW) => named(text, frame).path;
const pixels = (bytes: Uint8Array) => { const picture = decodePng(bytes); return { width: picture.width, height: picture.height, rgba: createHash("sha256").update(picture.pixels).digest("hex") }; };
const folder = (store: WorldStore) => join(store.dir, ...TEXT_PICTURE_DIR.split("/"));
const listed = async (store: WorldStore) => (await readdir(folder(store)).catch(() => [] as string[])).sort();
const absent = async (path: string) => assert.equal(await stat(path).then(() => "there", () => "absent"), "absent", path);

/** The fixture world with `stepped()` and the pending request in one production, opened. */
async function open(more: (dir: string) => Promise<void> = async () => {}): Promise<WorldStore> {
  const dir = await makeTempWorld();
  await writeFile(join(dir, "productions", PRODUCTION, "timeline.json"), `${JSON.stringify(stepped(), null, 2)}\n`, "utf8");
  await writeFile(join(dir, "productions", PRODUCTION, "editor-requests.json"), `${JSON.stringify({ schemaVersion: 1, requests: [request()] }, null, 2)}\n`, "utf8");
  await more(dir);
  const store = await WorldStore.open(dir);
  closeOnCleanup(() => store.close());
  const production = store.getBundle().productions.find(row => row.meta.id === PRODUCTION);
  assert.equal(production?.timeline?.status, "ready", "the fixture's timeline reads");
  assert.equal(production?.editorRequests.length, 1, "and so does its request");
  return store;
}

/** `dist/main.cjs` with `dist/fonts` beside it, as the packaged app is laid out, holding `bytes` as Geist — or no fonts at all. */
async function bundle(bytes?: Uint8Array): Promise<string> {
  const dist = join(await tempDir("arke-text-cache-"), "dist");
  if (bytes) {
    await mkdir(join(dist, "fonts"), { recursive: true });
    await writeFile(join(dist, "fonts", GEIST_FILE), bytes);
  }
  return pathToFileURL(join(dist, "main.cjs")).href;
}

it("names the pictures a clip, Undo, Redo and a pending request hold, at every delivery size, and nothing else", () => {
  assert.deepEqual(textPictureSizes({ text: "Now", look: LOOK, label: "Now" }), [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 1080, height: 1920 }]);
  const production = { timeline: { status: "ready" as const, timeline: stepped() }, editorRequests: [request(), request("accepted", "Accepted"), request("rejected", "Rejected")] };
  const sources = textSourcesNamed(production);
  assert.deepEqual(sources.map(source => [source.text, source.label, source.clipId]).sort(),
    [["Next", "Next", "cl_name"], ["Now", "Now", "cl_name"], ["Now", "Now", "cl_name"], ["Now", "Now", "cl_name"], ["Old", "Old", "cl_name"], ["Pending", "Pending", "cl_pending"]].sort(),
    "the clip; each side of Undo and of Redo; the pending request as a write would store it; no decided request");
  const names = textPicturesNamed([production]);
  assert.equal(names.size, 4 * 3, "four sources at three sizes, each named once");
  for (const text of ["Now", "Old", "Next", "Pending"]) for (const frame of textPictureSizes(sources[0]!)) {
    assert.deepEqual(names.get(named(text, frame).name), { text, look: LOOK, ...frame }, `${text} at ${frame.width}x${frame.height}`);
  }
  // A weight the face lacks names no picture: the plan refuses that clip, so no path points at it.
  const bold = { timeline: { status: "ready" as const, timeline: timeline([textClip("cl_bold", 0, "Bold", { ...LOOK, weight: "bold" })]) }, editorRequests: [] };
  assert.equal(textPicturesNamed([bold]).size, 0);
  assert.equal(textPicturesNamed([{ timeline: { status: "invalid", message: "timeline.json is invalid" }, editorRequests: [] }, { timeline: { status: "absent" }, editorRequests: [] }]).size, 0);
});

it("the names the cache finds are the ones the floor finds", () => {
  const blank = timeline([]);
  const placed = apply(blank, [{ kind: "place", trackId: "tr_names", clip: textClip("cl_ade", 0, "Ade") }]);
  const fixtures: Array<[what: string, record: ProductionTimeline, requests: EditorRequest[]]> = [
    ["no text anywhere", blank, []],
    ["text on a clip", placed, []],
    ["text only in Undo", apply(placed, [{ kind: "delete", clipId: "cl_ade" }]), []],
    ["text only in Redo", undoTimelineHistory(placed), []],
    ["text only in a pending request", blank, [request()]],
  ];
  for (const [what, record, requests] of fixtures) {
    const floor = carriesEditorText(JSON.stringify(record)) || carriesEditorText(JSON.stringify({ schemaVersion: 1, requests }));
    const cache = textSourcesNamed({ timeline: { status: "ready", timeline: record }, editorRequests: requests }).length > 0;
    assert.equal(cache, floor, what);
    assert.equal(cache, what !== "no text anywhere", what);
  }
});

it("a text clip's picture is painted once and never rewritten", async () => {
  const store = await open(), ask = { text: "Ade", look: LOOK, ...SMALL };
  await absent(folder(store));
  const first = await keepTextPicture(store, ask);
  assert.ok(first.ok);
  assert.equal(first.path, join(store.dir, ...relative("Ade", SMALL).split("/")));
  const painted = paintTextPicture(ask);
  assert.ok(painted.ok);
  const bytes = await readFile(first.path), { mtimeMs } = await stat(first.path);
  assert.deepEqual(pixels(bytes), { ...SMALL, rgba: createHash("sha256").update(painted.rgba).digest("hex") }, "the file holds the painter's pixels");

  const again = await keepTextPicture(store, ask);
  assert.deepEqual(again, first);
  assert.equal((await stat(first.path)).mtimeMs, mtimeMs, "a kept picture is not written again");
  assert.ok((await readFile(first.path)).equals(bytes));

  // Whatever is under a name stays under it: the name is the picture, so there is nothing to refresh.
  const other = join(store.dir, ...relative("Ife", SMALL).split("/"));
  await writeFile(other, "not a picture");
  const kept = await keepTextPicture(store, { ...ask, text: "Ife" });
  assert.deepEqual(kept, { ok: true, name: named("Ife", SMALL).name, path: other });
  assert.equal(await readFile(other, "utf8"), "not a picture");
  // An empty file is not a picture, and is painted over.
  await writeFile(other, "");
  assert.ok((await keepTextPicture(store, { ...ask, text: "Ife" })).ok);
  assert.equal(pixels(await readFile(other)).width, SMALL.width);
  assert.deepEqual((await listed(store)).filter(entry => entry.startsWith(".tmp-")), [], "no stage file is left");
});

it("deleting the folder draws the same pictures again", async () => {
  const store = await open(), slug = store.getBundle().meta.slug;
  const texts = ["Now", "Old", "Next", "Pending"];
  const serve = async () => {
    const seen: Array<ReturnType<typeof pixels>> = [];
    for (const text of texts) {
      const served = await serveTextPicture(store, slug, relative(text));
      assert.ok(served, text);
      assert.equal(served.contentType, "image/png");
      seen.push(pixels(await readFile(served.path)));
    }
    return seen;
  };
  const before = await serve();
  assert.deepEqual(before.map(({ width, height }) => ({ width, height })), texts.map(() => REVIEW));
  assert.equal(new Set(before.map(picture => picture.rgba)).size, texts.length, "four different pictures");
  assert.deepEqual(await listed(store), texts.map(text => `${named(text).name}.png`).sort());
  await rm(join(store.dir, ".cache"), { recursive: true, force: true });
  assert.deepEqual(await serve(), before);
  assert.deepEqual(await listed(store), texts.map(text => `${named(text).name}.png`).sort());
});

it("the media route paints only what the open world names, and only under the folder's own names", async () => {
  const store = await open(), slug = store.getBundle().meta.slug, now = relative("Now");
  const refusals: string[] = [];
  const refused = (reason: string) => { refusals.push(reason); };
  for (const path of [relative("Typed by nobody"), now.toUpperCase(), now.replace(".png", ".PNG"), `${now}.tmp`, now.replace(/\/[0-9a-f]/, "/"),
    `${TEXT_PICTURE_DIR}/x/${named("Now").name}.png`, `${TEXT_PICTURE_DIR}/../${named("Now").name}.png`, `.cache/editor-effects/analysis/${named("Now").name}.json`]) {
    assert.equal(await serveTextPicture(store, slug, path, undefined, refused), null, path);
  }
  assert.equal(await serveTextPicture(store, "another-world", now), null, "another world's slug");
  assert.equal(await serveTextPicture(null, slug, now), null, "no world open");
  await absent(folder(store));
  // The words Arke typed are not the words a write stores: only the stored words name a picture.
  assert.equal(await serveTextPicture(store, slug, relative("\r\nPending\r\n")), null);
  assert.ok(await serveTextPicture(store, slug, relative("Pending")));
  assert.deepEqual(refusals, []);
});

it("two asks for one name write one file", async () => {
  const store = await open(), slug = store.getBundle().meta.slug, file = join(store.dir, ...relative("Now").split("/"));
  // The world's queue is held until both asks have found no picture, painted, and are waiting in
  // it, so the second must find the first one's file from inside the queue. A write replaces the
  // file by a rename, which gives it a new file id on NTFS and a new inode on Linux; an ask that
  // finds the picture already there leaves the id as it was.
  const queued = store.derivedWrite.bind(store), id = () => stat(file).then(info => info.ino, () => null);
  let release = () => {}, waiting = 0, writes = 0;
  const both = new Promise<void>(resolve => { release = resolve; });
  const held = queued(() => both);
  // An ask that never reached the queue fails the count below rather than holding the world shut.
  const giveUp = setTimeout(() => release(), 20_000);
  store.derivedWrite = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queued(async () => {
      const before = await id(), result = await fn();
      if (await id() !== before) writes += 1;
      return result;
    });
    if (++waiting === 2) release();
    return run;
  };
  const [first, second] = await Promise.all([serveTextPicture(store, slug, relative("Now")), serveTextPicture(store, slug, relative("Now"))]);
  await held;
  clearTimeout(giveUp);
  assert.ok(first && second);
  assert.equal(first.path, second.path);
  assert.deepEqual({ waiting, writes }, { waiting: 2, writes: 1 }, "both asks reached the queue, and one wrote");
  assert.deepEqual(await listed(store), [`${named("Now").name}.png`], "one file and no stage file");
  assert.equal(pixels(await readFile(first.path)).width, REVIEW.width);
});

it("the sweep keeps what a clip, Undo, Redo or a pending request names", async () => {
  const store = await open();
  const keep = ["Now", "Old", "Next", "Pending"].flatMap(text => [`${named(text).name}.png`, `${named(text, { width: 1080, height: 1920 }).name}.png`]);
  const orphan = `${named("Gone").name}.png`, stage = `.tmp-${"0".repeat(25)}A`;
  await mkdir(join(folder(store), "kept by hand"), { recursive: true });
  for (const entry of [...keep, orphan, stage, "notes.txt", `${named("Now").name}.png.tmp`]) await writeFile(join(folder(store), entry), "a picture");
  assert.deepEqual(await sweepTextPictures(store), { removed: 2, skipped: false });
  assert.deepEqual(await listed(store), [...keep, "kept by hand", "notes.txt", `${named("Now").name}.png.tmp`].sort(),
    "the orphan and the stage file go; every named picture, and anything this module did not write, stays");
  assert.deepEqual(await sweepTextPictures(store), { removed: 0, skipped: false });
  await rm(join(store.dir, ".cache"), { recursive: true, force: true });
  assert.deepEqual(await sweepTextPictures(store), { removed: 0, skipped: false }, "no folder, nothing to sweep");
  await absent(folder(store));
});

it("a pending request's text is kept by the sweep under the name its stored words give", async () => {
  const store = await open(), slug = store.getBundle().meta.slug;
  const typed = `${named("\r\nPending\r\n").name}.png`, stored = `${named("Pending").name}.png`;
  assert.notEqual(typed, stored);
  await mkdir(folder(store), { recursive: true });
  await writeFile(join(folder(store), typed), "typed");
  assert.ok(await serveTextPicture(store, slug, relative("Pending")));
  assert.deepEqual(await sweepTextPictures(store), { removed: 1, skipped: false });
  assert.deepEqual(await listed(store), [stored]);
});

it("the sweep does nothing when a timeline cannot be read", async () => {
  const store = await open(dir => writeFile(join(dir, "productions", OTHER, "timeline.json"), "{ not a timeline", "utf8"));
  assert.equal(store.getBundle().productions.find(row => row.meta.id === OTHER)?.timeline?.status, "invalid");
  const orphan = `${named("Gone").name}.png`;
  await mkdir(folder(store), { recursive: true });
  await writeFile(join(folder(store), orphan), "a picture");
  assert.deepEqual(await sweepTextPictures(store), { removed: 0, skipped: true });
  assert.deepEqual(await listed(store), [orphan]);
});

it("a world with external edits answers null for a picture it has not kept, serves one it has, and does not throw", async () => {
  const first = await open(), dir = first.dir, slug = first.getBundle().meta.slug;
  const kept = await serveTextPicture(first, slug, relative("Now"));
  assert.ok(kept);
  await first.close();
  // Hand-edited while closed: the next open holds the edit for reconciliation and writes nothing until then.
  const sheet = join(dir, "characters", "bray-half-hitch.md");
  await writeFile(sheet, (await readFile(sheet, "utf8")).replace("three belts", "four belts"), "utf8");
  const store = await WorldStore.open(dir);
  closeOnCleanup(() => store.close());
  assert.equal(store.getBundle().externalEdits.length, 1);
  assert.equal(store.canWrite(), false);

  const refusals: string[] = [];
  assert.deepEqual(await serveTextPicture(store, slug, relative("Now"), undefined, reason => refusals.push(reason)), kept, "a kept picture still serves");
  assert.equal(await serveTextPicture(store, slug, relative("Old"), undefined, reason => refusals.push(reason)), null);
  assert.deepEqual(refusals, ["Text picture not kept: world has external edits awaiting reconciliation"], "the reason goes to the log, not the page");
  assert.deepEqual(await keepTextPicture(store, { text: "Old", look: LOOK, ...REVIEW }), { ok: false, reason: refusals[0] });
  assert.deepEqual(await sweepTextPictures(store), { removed: 0, skipped: true });
  assert.deepEqual(await listed(store), [`${named("Now").name}.png`], "nothing was written");
});

it("the layout refuses exactly what the painter refuses, and nothing is kept for it", async () => {
  const store = await open(), ask = { text: "Ade", look: LOOK, ...SMALL };
  const geist = readFileSync(join(fonts, GEIST_FILE)), altered = Uint8Array.from(geist);
  altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  const none = await bundle(), wrong = await bundle(altered);
  const refused: Array<[what: string, ask: typeof ask, reason: string, from?: string]> = [
    ["a character the face lacks", { ...ask, text: "Oṣun" }, "Geist has no ṣ"],
    ["a weight the face lacks", { ...ask, look: { ...LOOK, weight: "bold" } }, "Geist has no bold"],
    ["a missing file", { ...ask, text: "Missing" }, `${GEIST_FILE} is missing`, none],
    ["a file that is not the one shipped", { ...ask, text: "Wrong" }, `${GEIST_FILE} is not the file this app shipped with`, wrong],
  ];
  for (const [what, tried, reason, from] of refused) {
    const painted = paintTextPicture(tried, from);
    assert.deepEqual(painted, { ok: false, reason }, `${what}: the painter`);
    assert.equal(textPictureRefusal(tried, from), reason, `${what}: the layout`);
    assert.deepEqual(await keepTextPicture(store, tried, from), { ok: false, reason }, `${what}: the keep`);
  }
  await absent(folder(store));
  assert.equal(textPictureRefusal(ask), null);
});

it("a batch that leaves an unpaintable clip refuses in the painter's words", async () => {
  const frame = PRESETS["vertical-master"], none = await bundle();
  const held = timeline([textClip("cl_ade", 0, "Ade"), textClip("cl_osun", 100, "Oṣun")]);
  const refuses = (next: ProductionTimeline, reason: string, from?: string) =>
    assert.throws(() => refuseUnpaintableText(held, next, frame, from), { name: "TimelineOperationRefused", message: reason });

  refuses(timeline([textClip("cl_ade", 0, "Ade"), textClip("cl_osun", 100, "Oṣun"), textClip("cl_new", 200, "Iṣọ")]), "Geist has no ṣ");
  refuses(apply(held, [{ kind: "text-set", clipIds: ["cl_ade"], look: { weight: "bold" } }]), "Geist has no bold");
  // Words the timeline already held are not asked again: a clip that cannot be drawn can still be
  // moved, copied, split, deleted, or retyped into words that can.
  const kept: TimelineClipCommand[][] = [
    [{ kind: "move-to-frame", clipId: "cl_osun", startFrame: 300 }],
    [{ kind: "duplicate", clipId: "cl_osun", newClipId: "cl_osun2" }],
    [{ kind: "split", clipId: "cl_osun", atFrame: 120, newClipId: "cl_osun2" }],
    [{ kind: "delete", clipId: "cl_ade" }],
    [{ kind: "text-set", clipIds: ["cl_osun"], text: "Osun" }],
  ];
  for (const commands of kept) assert.doesNotThrow(() => refuseUnpaintableText(held, apply(held, commands), frame), JSON.stringify(commands));
  // A face file gone since the words were set stops only new words, and says which file.
  const retyped = apply(held, [{ kind: "text-set", clipIds: ["cl_ade"], text: "Ife" }]);
  refuses(retyped, `${GEIST_FILE} is missing`, none);
  assert.doesNotThrow(() => refuseUnpaintableText(held, retyped, frame));

  // Fifty clips changed together are fifty layouts in one pass, with no picture painted or kept.
  const fifty = timeline(Array.from({ length: 50 }, (_, index) => textClip(`cl_n${index}`, index * 50, `Name ${index}`)));
  const renamed = apply(fifty, [{ kind: "text-set", clipIds: fifty.tracks[1]!.clips.map(clip => clip.id), look: { size: 0.1 } }]);
  assert.doesNotThrow(() => refuseUnpaintableText(fifty, renamed, frame));
});

it("an export keeps each picture at the size its own layer names, and refuses by clip in the painter's words", async () => {
  const store = await open();
  const record = timeline([textClip("cl_ade", 0, "Ade"), textClip("cl_ife", 100, "Ife"), textClip("cl_osun", 200, "Oṣun"), textClip("cl_so", 300, "Ṣọ"),
    textClip("cl_sango", 400, "Ṣàngó")]);
  const source = (id: string) => { const found = record.tracks[1]!.clips.find(clip => clip.id === id)!.source; assert.equal(found.kind, "text"); return found; };
  const layer = (clipId: string, size: { width: number; height: number } | undefined, path = textPicturePath(source(clipId), size ?? SMALL)): RenderPictureLayer => {
    assert.ok(path.ok);
    return { clipId, trackId: "tr_names", order: 1, kind: "media", label: source(clipId).label, path: path.path, still: true, startFrame: 0, endFrame: 48,
      sourceInSec: 0, fit: "contain", matte: "source-alpha", ...(size ? { sourceSize: size } : {}) };
  };
  const overlay = (path: string): ExportOverlay => ({ path, startSec: 0, endSec: 2, still: true });
  const plan = (layers: RenderPictureLayer[], overlays = layers.map(row => overlay(row.path!))) => ({ overlays, effectRender: { pictureLayers: layers } });

  // A film with no text does no work here and touches no file (R-40).
  assert.equal(await textPicturesForExport(store, record, { overlays: [overlay("artifacts/still.png")] }), null);
  assert.equal(await textPicturesForExport(store, record, plan([{ ...layer("cl_ade", SMALL), path: "artifacts/still.png" }])), null);
  await absent(join(store.dir, ".cache"));

  // Two sizes in one export: each picture is kept at the size its layer says, not at one size for the film.
  const wide = { width: 640, height: 360 };
  assert.equal(await textPicturesForExport(store, record, plan([layer("cl_ade", SMALL), layer("cl_ife", wide)])), null);
  for (const [text, size] of [["Ade", SMALL], ["Ife", wide]] as const) {
    const { width, height } = pixels(await readFile(join(store.dir, ...relative(text, size).split("/"))));
    assert.deepEqual({ width, height }, size, text);
  }

  assert.equal(await textPicturesForExport(store, record, plan([layer("cl_ade", SMALL), layer("cl_osun", SMALL)])),
    "timeline is not ready to export: the text \"Oṣun\" cannot be drawn: Geist has no ṣ");
  assert.equal(await textPicturesForExport(store, record, plan([layer("cl_osun", SMALL), layer("cl_so", SMALL)])),
    "timeline is not ready to export: the text \"Oṣun\" cannot be drawn: Geist has no ṣ (and 1 more text clip)");
  assert.equal(await textPicturesForExport(store, record, plan([layer("cl_osun", SMALL), layer("cl_so", SMALL), layer("cl_sango", SMALL)])),
    "timeline is not ready to export: the text \"Oṣun\" cannot be drawn: Geist has no ṣ (and 2 more text clips)");
  const none = await bundle();
  assert.equal(await textPicturesForExport(store, record, plan([layer("cl_ife", wide), layer("cl_ade", { width: 400, height: 400 })]), none),
    `timeline is not ready to export: the text "Ade" cannot be drawn: ${GEIST_FILE} is missing`, "a kept picture needs no face; a new one does");
  assert.deepEqual((await listed(store)).length, 2, "nothing is kept for a clip that cannot be drawn");

  // A plan and a timeline that disagree refuse rather than render a film with a hole in it.
  const missing = "timeline is not ready to export: a text picture is missing";
  assert.equal(await textPicturesForExport(store, record, plan([layer("cl_ade", undefined)])), missing, "a layer with no size");
  assert.equal(await textPicturesForExport(store, record, plan([layer("cl_ade", wide, textPicturePath(source("cl_ade"), SMALL))])), missing, "a name for another size");
  assert.equal(await textPicturesForExport(store, record, plan([{ ...layer("cl_ade", SMALL), clipId: "cl_gone" }])), missing, "a clip the timeline lacks");
  assert.equal(await textPicturesForExport(store, record, { overlays: [overlay(relative("Ade", SMALL))] }), missing, "text with no compositor");
});

it("an export keeps exactly the pictures the render plan names, lowest track and upper, at the preset's frame", async () => {
  const store = await open(), meta = store.getBundle().productions.find(row => row.meta.id === PRODUCTION)!.meta;
  const production: ProductionBundle = {
    rehearsals: [], performances: [], performanceReview: { reviews: [], selections: {}, reviewHash: null, selectionHash: null },
    meta: { ...meta, aspect: "9:16", frameRate: 24 }, story: null, season: null, routing: null, treatment: null, chapters: [], scenes: [], sceneFiles: {},
    episodes: [], episodeFiles: {}, takes: [], reviews: [], selections: {}, spine: null, cut: { audio: [], overlays: [] }, editorRequests: [], takeMediaInfo: {},
  };
  const record = ProductionTimelineSchema.parse({ ...timeline([textClip("cl_ife", 0, "Ife")]), tracks: [
    { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, clips: [textClip("cl_ade", 0, "Ade")] },
    { id: "tr_names", kind: "picture", name: "Names", order: 1, muted: false, clips: [textClip("cl_ife", 0, "Ife")] },
  ] });
  const built = buildRenderPlan({ production, artifacts: [], timeline: { status: "ready", timeline: record }, scope: { kind: "production" }, preset: "vertical-master" });
  assert.ok(built.ok, built.ok ? "" : built.reason);
  const frame = { width: 1080, height: 1920 };
  assert.deepEqual(built.plan.effectRender?.pictureLayers.map(row => [row.clipId, row.path, row.sourceSize]).sort(),
    [["cl_ade", relative("Ade", frame), frame], ["cl_ife", relative("Ife", frame), frame]]);
  assert.equal(await textPicturesForExport(store, record, built.plan), null);
  assert.deepEqual(await listed(store), [`${named("Ade", frame).name}.png`, `${named("Ife", frame).name}.png`].sort());
  for (const text of ["Ade", "Ife"]) {
    const { width, height } = pixels(await readFile(join(store.dir, ...relative(text, frame).split("/"))));
    assert.deepEqual({ width, height }, frame, text);
  }
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compileStoryDocument, readStory, readWorldManifest, storyRoutes, type ClientMessage, type DomainEvent, type Routing } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { clipFit, readMp4Info, readMp4Moov } from "../../src/media/mp4-info.js";
import { listArkePlayerPackages } from "../../src/productions/arke-player-export.js";
import { exportStoryPlayer, packagedAsset, readStoryExport, replayEveryRoute } from "../../src/productions/story-export.js";
import { checkWorldPackageZip } from "../../src/productions/world-package.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup, tempDir } from "../tmp.js";
import { CLOCK, LOW_WATER, LOW_WATER_SCENES, mp4, PHONE_CLIP, walkEveryChoice, writeStoryProduction } from "./story-fixture.js";

/**
 * Export → Arke Player for an interactive movie or a visual novel (design turn 245, SPEC-058 R-79,
 * R-80, R-89): the story package, schema 6 and alone, its routing compiled by contracts, its clips
 * shipped as made or re-encoded, read back with every route replayed, and blocked by name.
 */

/** An encoder that makes every output and remembers what it was asked: a clip becomes a phone's MP4. */
function recordingFfmpeg(calls: string[][], during?: () => Promise<void>): FfmpegRunner {
  return {
    slateFont: "",
    run: async (args) => {
      calls.push(args);
      await during?.();
      const out = args[args.length - 1]!;
      await writeFile(out, out.endsWith(".mp4") ? PHONE_CLIP() : out.endsWith(".m4a") ? mp4({ durationMs: 1800, audio: { objectType: 0x40 } }) : `made by ${out.split(/[\\/]/).pop()}`);
    },
  } as FfmpegRunner;
}

const EXPORT_ID = (n: number) => `ap_01J8G${String(n).padStart(21, "0")}`;
const options = (calls: string[][], n = 1, extra: Partial<Parameters<typeof exportStoryPlayer>[2]> = {}) => ({
  clock: CLOCK,
  ffmpeg: recordingFfmpeg(calls),
  exportId: EXPORT_ID(n),
  include: { book: false, motion: false },
  studioVersion: "test",
  ...extra,
});

async function openStore(dir: string) {
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

/** Low Water with a 4K HEVC clip under the pier, which only a re-encode makes a phone's. */
async function lowWater(scenes = LOW_WATER_SCENES, routing: Routing = LOW_WATER) {
  const dir = await makeTempWorld();
  await writeStoryProduction(dir, { id: "low-water", title: "Low Water", kind: "movie", scenes: scenes.map((scene) => (scene.id === "sc_pier" && scene.clip === undefined ? { ...scene, clip: mp4({ durationMs: 6000, video: { codec: "hvc1", width: 3840, height: 2160 } }) } : scene)), routing });
  await walkEveryChoice(dir, "low-water", routing);
  return { dir, store: await openStore(dir) };
}

describe("an MP4 read from its own boxes (SPEC-058 R-79)", () => {
  it("reads the brand, the length, the picture's codec and size, and whether the sound is AAC", async () => {
    const dir = await tempDir("mp4-");
    await writeFile(join(dir, "a.mp4"), PHONE_CLIP());
    assert.deepEqual(await readMp4Info(join(dir, "a.mp4")), { brand: "isom", durationMs: 5000, video: { codec: "avc1", width: 1920, height: 1080 }, audio: [{ codec: "mp4a", aac: true }] });
    await writeFile(join(dir, "b.mp4"), mp4({ durationMs: 2500, video: { codec: "avc1", width: 1080, height: 1920 }, moovLast: true }));
    assert.equal((await readMp4Info(join(dir, "b.mp4")))?.durationMs, 2500, "a movie box after the frames is found");
    await writeFile(join(dir, "c.webm"), Buffer.from("\x1aE\xdf\xa3 not an mp4", "latin1"));
    assert.equal(await readMp4Info(join(dir, "c.webm")), null);
  });

  it("inventories a staged clip by streaming it, never by holding it whole (codex on PR 2205)", async () => {
    const dir = await tempDir("mp4-");
    // Larger than one stream chunk, so the digest is folded over several reads.
    const bytes = Buffer.concat([PHONE_CLIP(), Buffer.alloc(300_000, 7)]);
    await writeFile(join(dir, "c001.mp4"), bytes);
    const { readFile: readWhole } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    assert.deepEqual(await packagedAsset(join(dir, "c001.mp4"), "clips/c001.mp4", "video/mp4"), {
      path: "clips/c001.mp4",
      mediaType: "video/mp4",
      byteLength: bytes.length,
      sha256: createHash("sha256").update(await readWhole(join(dir, "c001.mp4"))).digest("hex"),
    });
  });

  it("ships a clip as made only when it is H.264 and AAC in MP4, at most 1080 on its short side", () => {
    const fit = (options: Parameters<typeof mp4>[0]) => {
      const bytes = mp4(options);
      // The movie box's content: past its type, to the end its size gives.
      const type = bytes.indexOf("moov");
      const end = type - 4 + bytes.readUInt32BE(type - 4);
      return clipFit(readMp4Moov(options.brand ?? "isom", bytes.subarray(type + 4, end)));
    };
    assert.equal(fit({ durationMs: 1, video: { codec: "avc1", width: 1920, height: 1080 }, audio: { objectType: 0x40 } }), "as-made");
    assert.equal(fit({ durationMs: 1, video: { codec: "avc1", width: 1080, height: 1920 } }), "as-made", "a 9:16 clip with no sound");
    assert.equal(fit({ durationMs: 1, video: { codec: "avc1", width: 2560, height: 1440 } }), "encode", "larger than 1080 on its short side");
    assert.equal(fit({ durationMs: 1, video: { codec: "hvc1", width: 1920, height: 1080 } }), "encode", "HEVC");
    assert.equal(fit({ durationMs: 1, video: { codec: "avc1", width: 1920, height: 1080 }, audio: { objectType: 0x6b } }), "remux", "MP3 sound in an MP4 is made AAC, the picture copied");
    assert.equal(fit({ durationMs: 1, video: { codec: "avc1", width: 1920, height: 1080 }, brand: "qt  " }), "remux", "a QuickTime movie is copied into an MP4");
    assert.equal(clipFit(null), "encode");
  });
});

describe("the read-back's route replay (SPEC-058 R-81, R-89)", () => {
  // A loop a listener may take as often as they like: the routes never all end.
  const looping = () => {
    const compiled = compileStoryDocument({
      routing: { start: "sc_quay", choices: [{ id: "ch_wait", from: "sc_quay", to: "sc_tide", label: "Wait" }, { id: "ch_again", from: "sc_tide", to: "sc_quay", label: "Again" }, { id: "ch_go", from: "sc_tide", to: "sc_home", label: "Go home" }], endings: [{ sceneId: "sc_home", title: "Home" }] } as unknown as Routing,
      kind: "movie",
      shape: "16:9",
      scenes: { sc_quay: { title: "The quay", clips: [{ asset: "c001", from: 0, to: 1000 }] }, sc_tide: { title: "The tide", clips: [{ asset: "c002", from: 0, to: 1000 }] }, sc_home: { title: "Home", clips: [{ asset: "c003", from: 0, to: 1000 }] } },
    });
    assert.ok(compiled.ok, compiled.ok ? "" : compiled.problems.map((problem) => problem.detail).join("; "));
    return compiled.document;
  };

  it("walks as storyRoutes does, to its bound, and agrees route by route with the package's own document", async () => {
    const document = looping();
    const replayed = await replayEveryRoute(document, structuredClone(document), new AbortController().signal, { choices: 9, routes: 1000 });
    const walked = storyRoutes(document, { choices: 9, routes: 1000 });
    assert.deepEqual(replayed, { routes: walked.routes.length, agree: walked.routes.length, complete: walked.complete });
    assert.equal(replayed.complete, false, "a loop stops at the bound");
    // A package whose document sends one choice elsewhere parts from the compiled one on every route
    // through that choice; only the route that never takes it still agrees.
    const tampered = structuredClone(document);
    tampered.choices.find((choice) => choice.id === "ch_again")!.to = "sc_home";
    const parted = await replayEveryRoute(document, tampered, new AbortController().signal, { choices: 9, routes: 1000 });
    assert.deepEqual([parted.routes, parted.agree], [replayed.routes, 1]);
  });

  it("gives the event loop back as it walks, and stops on the export's signal (codex on PR 2205)", async () => {
    const document = looping();
    const control = new AbortController();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
      if (ticks === 2) control.abort();
    }, 1);
    try {
      await assert.rejects(replayEveryRoute(document, document, control.signal, { choices: 4000, routes: 1_000_000 }), { name: "AbortError" });
    } finally {
      clearInterval(timer);
    }
    assert.ok(ticks >= 2, "timers ran while the walk was under way");
  });
});

describe("Export → Arke Player for an interactive movie (turn 245a, 245d)", () => {
  it("does not reuse a published edition's name after its local files are removed (#2238)", async () => {
    const { dir, store } = await lowWater();
    const first = await exportStoryPlayer(store, "low-water", options([], 1));
    assert.ok(first.ok);
    await unlink(join(dir, first.file));
    await unlink(join(dir, first.file + ".json"));
    const second = await exportStoryPlayer(store, "low-water", options([], 2));
    assert.ok(second.ok);
    assert.notEqual(second.file, first.file, "same day and empty local folder still produce a new name");
    const checked = await checkWorldPackageZip(join(dir, second.file));
    assert.ok(checked.ok);
    assert.equal(checked.manifest.edition, `2026-10-28-${EXPORT_ID(2)}`);
    const repeated = await exportStoryPlayer(store, "low-water", options([], 2));
    assert.ok(repeated.ok);
    assert.notEqual(repeated.file, second.file, "an existing local export is also preserved");
  });

  it("reads what the package would hold before anything is made: a closed choice without a reason is counted and hidden, never a blocker", async () => {
    const { store } = await lowWater();
    const state = await readStoryExport(store, "low-water", { ffmpeg: true });
    assert.deepEqual(state.blockers, [], "nothing stands in the way, though The back way has no reason");
    assert.equal(state.kind, "movie");
    assert.equal(state.shape, "16:9");
    assert.deepEqual([state.scenes, state.choices, state.facts, state.endings], [4, 5, 1, 2]);
    assert.deepEqual(state.closed, { count: 2, reasoned: 1 }, "Use the tenth key closed with its reason; The back way closed and hidden");
    assert.deepEqual(state.clips, { count: 4, of: 4, ms: 20_000, width: 3840, height: 2160, reencoded: 1 });
    assert.ok(state.bytes > 0 && state.seconds > 0);
  });

  it("makes a schema 6 package alone: each clip as made or re-encoded, the routing compiled, read back with every route replayed", async () => {
    const { dir, store } = await lowWater();
    const calls: string[][] = [];
    const steps: string[] = [];
    const result = await exportStoryPlayer(store, "low-water", options(calls, 1, { onStep: (step) => steps.push(step) }));
    assert.ok(result.ok, result.ok ? "" : result.blockers.join("; "));
    assert.equal(result.file, `exports/low-water-story-2026-10-28-${EXPORT_ID(1)}.zip`);
    assert.deepEqual(result.story, { kind: "movie", scenes: 4, routes: 4, complete: true, endings: 2 });
    assert.ok(steps.includes("Replaying every route"));

    // Only the 4K HEVC clip is encoded: H.264 at most 1080 on its short side, with AAC.
    const encodes = calls.filter((args) => args.includes("libx264"));
    assert.equal(encodes.length, 1);
    assert.match(encodes[0]!.join(" "), /min\(1080,ih\)/);
    assert.ok(encodes[0]!.includes("aac"));

    const checked = await checkWorldPackageZip(join(dir, result.file));
    assert.ok(checked.ok, checked.ok ? "" : checked.problems.join("; "));
    const manifest = checked.manifest;
    assert.equal(manifest.schemaVersion, 6);
    assert.equal(manifest.alone, true);
    assert.equal(manifest.keyArt, undefined, "a story package carries no key art");
    assert.equal(manifest.guide, undefined);
    const [production] = manifest.productions;
    assert.equal(production!.story, "story");
    assert.equal(production!.picture, "cover", "the key art stands in for the wide cover");
    const document = checked.stories["low-water"]!;
    assert.equal(document.kind, "movie");
    assert.deepEqual(document.facts, [{ id: "key", type: "enum", values: ["held", "left"], default: "held" }], "no fact label rides");
    assert.deepEqual(document.scenes.map((scene) => scene.id), ["sc_harbour", "sc_bell", "sc_vault", "sc_pier"]);
    assert.deepEqual(document.scenes[0]!.clips, [{ asset: "c001", from: 0, to: 5000 }]);
    assert.deepEqual(document.choices.find((choice) => choice.id === "ch_vault")!.unavailable, { reason: "Left at the weigh house" });
    assert.equal(document.choices.find((choice) => choice.id === "ch_back")!.unavailable, undefined, "hidden, not given a reason");
    assert.equal(storyRoutes(document).routes.length, 4);
    for (const [assetId, asset] of Object.entries(manifest.assets).filter(([id]) => /^c\d+$/.test(id))) assert.equal(asset.mediaType, "video/mp4", assetId);

    // The record beside it, as Publications lists it (233e), with what the read-back found.
    const listed = await listArkePlayerPackages(store);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0]!.story, { kind: "movie", scenes: 4, routes: 4, complete: true, endings: 2 });
    assert.equal(listed[0]!.holds, "4 scenes · 4 routes · 2 endings");
    assert.equal(listed[0]!.title, "The Undersong · Low Water");
    assert.deepEqual(await readdir(join(dir, ".staging", "arke-player-export")).catch(() => []), [], "nothing staged is left");
  });

  it("is blocked by a reachable scene with no clip, by name with Go to, and leaves nothing named in exports/", async () => {
    const { dir, store } = await lowWater(LOW_WATER_SCENES.map((scene) => (scene.id === "sc_pier" ? { ...scene, clip: null } : scene)));
    const state = await readStoryExport(store, "low-water", { ffmpeg: true });
    assert.deepEqual(state.blockers, [{ detail: "Under the pier · no clip", row: "media", sceneId: "sc_pier" }]);
    assert.deepEqual(state.clips && [state.clips.count, state.clips.of], [3, 4], "Clips · 3 of 4");
    const result = await exportStoryPlayer(store, "low-water", options([]));
    assert.ok(!result.ok);
    assert.deepEqual(result.blockers, ["Under the pier · no clip"]);
    assert.deepEqual(result.problems, [{ detail: "Under the pier · no clip", row: "media", sceneId: "sc_pier" }]);
    assert.deepEqual((await readdir(join(dir, "exports")).catch(() => [] as string[])).filter((name) => name.includes("story")), []);
    // Ahead of the story's own findings, as 245c lists them: unwalked, every choice is one to clear.
    await writeFile(join(dir, "productions", "low-water", "routing-evidence.jsonl"), "");
    const unwalked = await readStoryExport(store, "low-water", { ffmpeg: true });
    assert.equal(unwalked.blockers[0]!.detail, "Under the pier · no clip");
    assert.ok(unwalked.blockers.length > 1 && unwalked.blockers.slice(1).every((blocker) => blocker.row === "story" && blocker.detail.includes("not walked") && blocker.route !== undefined), JSON.stringify(unwalked.blockers));
  });

  it("is blocked by a dead end that a remembered value causes, with Show and the route that reaches it", async () => {
    // Without the pier, a key left at the harbour leaves the bell no open choice.
    const routing = { ...LOW_WATER, choices: LOW_WATER.choices.filter((choice) => choice.id !== "ch_pier" && choice.id !== "ch_back") } as Routing;
    const { store } = await lowWater(LOW_WATER_SCENES, routing);
    const state = await readStoryExport(store, "low-water", { ffmpeg: true });
    const dead = state.blockers.find((blocker) => blocker.detail.startsWith("The bell · a dead end"));
    assert.deepEqual(dead, { detail: "The bell · a dead end when Key is Left", row: "story", sceneId: "sc_bell", route: ["ch_leave"] });
    assert.equal(state.blockers.filter((blocker) => blocker.sceneId === "sc_bell" && JSON.stringify(blocker.route) === '["ch_leave"]').length, 1, "a dead end is not also said as a state with no ending");  });

  it("says Needs ffmpeg before anything is made, and refuses a shape the Player does not play", async () => {
    const dir = await makeTempWorld();
    await writeStoryProduction(dir, { id: "low-water", title: "Low Water", kind: "movie", aspect: "1:1", scenes: LOW_WATER_SCENES, routing: LOW_WATER });
    await walkEveryChoice(dir, "low-water", LOW_WATER);
    const state = await readStoryExport(await openStore(dir), "low-water", { ffmpeg: false });
    assert.deepEqual(state.blockers.map((blocker) => blocker.detail), ["Needs ffmpeg", "Shape · 1:1 · Arke Player plays 16:9 or 9:16"]);
  });

  it("refuses a package whose branch map was redrawn while it was made, and names nothing", async () => {
    const { dir, store } = await lowWater();
    let once = false;
    const during = async () => {
      if (once) return;
      once = true;
      await store.ownedWrite(async () => {
        const file = join(dir, "productions", "low-water", "routing.json");
        const routing = JSON.parse(await readFile(file, "utf8")) as Routing;
        await writeFile(file, JSON.stringify({ ...routing, choices: routing.choices.map((choice) => (choice.id === "ch_pier" ? { ...choice, label: "Run to the pier" } : choice)) }));
      });
    };
    const result = await exportStoryPlayer(store, "low-water", { ...options([]), ffmpeg: recordingFfmpeg([], during) });
    assert.ok(!result.ok);
    assert.deepEqual(result.blockers, ["the story changed while the package was made · make it again"]);
    assert.deepEqual((await readdir(join(dir, "exports")).catch(() => [] as string[])).filter((name) => name.includes("story")), []);
  });
});

describe("Export → Arke Player for a visual novel (turn 245b)", () => {
  const ROAD: Routing = {
    version: 1,
    start: "sc_gate",
    choices: [
      { id: "ch_road", from: "sc_gate", to: "sc_inn", label: "Take the lantern road" },
      { id: "ch_field", from: "sc_gate", to: "sc_field", label: "Cut across the field" },
    ],
    endings: [{ sceneId: "sc_inn", title: "The inn" }, { sceneId: "sc_field", title: "The field" }],
    excluded: [],
    groups: [],
  };
  async function lanternRoad(options: { withoutPictures?: boolean } = {}) {
    const dir = await makeTempWorld();
    await writeStoryProduction(dir, {
      id: "the-lantern-road",
      title: "The Lantern Road",
      kind: "novel",
      aspect: "9:16",
      routing: ROAD,
      scenes: [
        { id: "sc_gate", title: "The gate", lines: [{ id: "blk_dusk", text: "Dusk came down the road." }, { id: "blk_ask", text: "Which way?", speaker: "maren-kest" }] },
        { id: "sc_inn", title: "The inn", lines: [{ id: "blk_inn", text: "The inn kept a light." }] },
        { id: "sc_field", title: "The field", lines: [{ id: "blk_field", text: "Wet grass to the knee." }] },
      ],
    });
    await walkEveryChoice(dir, "the-lantern-road", ROAD);
    if (options.withoutPictures === true) await writeFile(join(dir, "productions", "the-lantern-road", "selections.json"), "{}");
    await mkdir(join(dir, ".cache", "voice-previews"), { recursive: true });
    await writeFile(join(dir, ".cache", "voice-previews", "dusk.mp3"), Buffer.from("the narrator reads"));
    const store = await openStore(dir);
    const voices = { plan: async (sceneId: string) => ({ sceneVersion: 1, files: new Map(sceneId === "sc_gate" ? [["sc_gate/sh_gate/blk_dusk", ".cache/voice-previews/dusk.mp3"]] : []) }), narrator: async () => null };
    return { dir, store, voices };
  }

  it("counts its beats' pictures and voiced lines, and makes the beats a story document at the shape it was made", async () => {
    const { dir, store, voices } = await lanternRoad();
    const state = await readStoryExport(store, "the-lantern-road", { ffmpeg: true, voices, pictureSize: "1280" });
    assert.deepEqual(state.blockers, []);
    assert.equal(state.kind, "novel");
    assert.equal(state.shape, "9:16");
    assert.deepEqual(state.pictures, { beats: 4, wide: 4, tall: 0, files: 3 });
    assert.deepEqual(state.voices, { lines: 4, voiced: 1 });
    assert.deepEqual(state.closed, { count: 0, reasoned: 0 });

    const calls: string[][] = [];
    const result = await exportStoryPlayer(store, "the-lantern-road", options(calls, 2, { voices, pictureSize: "1280" }));
    assert.ok(result.ok, result.ok ? "" : result.blockers.join("; "));
    assert.equal(result.file, `exports/the-lantern-road-story-2026-10-28-${EXPORT_ID(2)}.zip`);
    assert.deepEqual(result.story, { kind: "novel", scenes: 3, routes: 2, complete: true, endings: 2 });
    // Each beat's picture at the Size chosen; the cover stays full, as the world's card shows it larger.
    const fits = calls.filter((args) => args.some((arg) => arg.startsWith("scale='min(")));
    assert.equal(fits.filter((args) => args.some((arg) => arg.includes("min(1280,iw)"))).length, 3);
    assert.equal(fits.filter((args) => args.some((arg) => arg.includes("min(2048,iw)"))).length, 1);
    assert.ok(calls.some((args) => args.includes("-vn") && args[args.length - 1]!.endsWith(".m4a")), "the voice is made M4A");

    const zip = join(dir, result.file);
    const checked = await checkWorldPackageZip(zip);
    assert.ok(checked.ok, checked.ok ? "" : checked.problems.join("; "));
    const document = checked.stories["the-lantern-road"]!;
    assert.equal(document.kind, "novel");
    assert.equal(document.shape, "9:16");
    const gate = document.scenes[0]!.beats!;
    assert.deepEqual(gate.map((beat) => [beat.picture, beat.line ?? null, beat.speaker ?? null, beat.voice ?? null]), [
      ["p001", "Dusk came down the road.", null, "v001"],
      ["p001", "Which way?", "Maren Kest", null],
    ]);
    assert.equal(checked.manifest.assets["v001"]!.mediaType, "audio/mp4");
    const manifest = readWorldManifest(JSON.stringify({ ...checked.manifest, format: "arke-world-package" }));
    assert.ok(manifest.ok);
    assert.ok(readStory(JSON.stringify(document), checked.manifest.assets).ok, "the reader takes it");
  });

  it("is blocked by a beat with no picture, by its scene", async () => {
    const { store, voices } = await lanternRoad({ withoutPictures: true });
    const state = await readStoryExport(store, "the-lantern-road", { ffmpeg: true, voices });
    assert.deepEqual(state.blockers.map((blocker) => [blocker.detail, blocker.sceneId]), [
      ["The gate · beat 1 · no picture", "sc_gate"],
      ["The gate · beat 2 · no picture", "sc_gate"],
      ["The inn · beat 1 · no picture", "sc_inn"],
      ["The field · beat 1 · no picture", "sc_field"],
    ]);
  });
});

describe("Export → Arke Player through the coordinator (245c, 245d)", () => {
  it("answers the sheet's read and the press, and lists the story among the world's releases", async () => {
    const { root, worldDir } = await makeTempRoot();
    await writeStoryProduction(worldDir, { id: "low-water", title: "Low Water", kind: "movie", scenes: LOW_WATER_SCENES, routing: LOW_WATER });
    await walkEveryChoice(worldDir, "low-water", LOW_WATER);
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    await provider.loadWorld(WORLD_ID);
    const events: DomainEvent[] = [];
    const calls: string[][] = [];
    const coordinator = new Coordinator({ provider, adapter: null, changeLogPath: join(root, "logs", "changes.jsonl"), appVersion: "test", appRoot: root, observeEvent: (event) => events.push(event), ffmpeg: recordingFfmpeg(calls) });
    const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
    coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
    try {
      await send({ kind: "read-story-export", worldId: WORLD_ID, productionId: "low-water", requestId: "01J00000000000000000000002" });
      const read = events.find((event): event is Extract<DomainEvent, { type: "story.export-state" }> => event.type === "story.export-state");
      assert.ok(read?.state, read?.refused);
      assert.deepEqual(read.state.blockers, []);
      assert.equal(read.state.clips?.count, 4);

      await send({ kind: "export-arke-player", worldId: WORLD_ID, productionId: "low-water", requestId: "01J00000000000000000000003", exportId: EXPORT_ID(3), options: { book: false, motion: false } });
      const exported = events.find((event): event is Extract<DomainEvent, { type: "arke-player.exported" }> => event.type === "arke-player.exported");
      assert.ok(exported?.result.ok, exported?.result.ok === false ? exported.result.blockers.join("; ") : "");
      assert.deepEqual(exported.result.story, { kind: "movie", scenes: 4, routes: 4, complete: true, endings: 2 });
      const progress = events.filter((event): event is Extract<DomainEvent, { type: "export.progress" }> => event.type === "export.progress");
      assert.equal(progress[0]!.label, "Arke Player · story · Low Water");
      assert.equal(progress.at(-1)!.status, "done");

      await send({ kind: "list-web-packages", worldId: WORLD_ID, requestId: "01J00000000000000000000004" });
      const listed = events.find((event): event is Extract<DomainEvent, { type: "web-packages.listed" }> => event.type === "web-packages.listed");
      const story = listed?.packages.find((entry) => entry.kind === "arke-player" && entry.story !== undefined);
      // The export is named for the day it is made, which the coordinator reads from the real clock:
      // a date written here failed the run the day after it was written.
      const file = exported.result.ok ? exported.result.file : "";
      assert.match(file, /^exports\/low-water-story-\d{4}-\d{2}-\d{2}-ap_[0-9A-HJKMNP-TV-Z]{26}\.zip$/);
      assert.equal(story?.file, file);
      assert.deepEqual(story?.story, { kind: "movie", scenes: 4, routes: 4, complete: true, endings: 2 });
      assert.deepEqual(listed?.running, [], "nothing is still being made, so a window that lost an answer knows it ended");
      // A paired phone downloads it through the media route (233f), as it does the world's edition (codex on PR 2205).
      assert.equal((await provider.serveMedia("the-undersong", file))?.contentType, "application/zip");
      assert.equal(await provider.serveMedia("the-undersong", `${file}.json`), null, "its record is not served");
    } finally {
      await provider.close();
    }
  });
});

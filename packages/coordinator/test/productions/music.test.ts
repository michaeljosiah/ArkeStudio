import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openPromise } from "yauzl";
import { MusicRecordSchema, readMusic, readWorldManifest, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import type { FfmpegRunner } from "../../src/takes/export.js";
import type { MediaProbe } from "../../src/media/probe.js";
import { listArkePlayerPackages } from "../../src/productions/arke-player-export.js";
import { musicDocumentSections } from "../../src/productions/music-export.js";
import { musicRenderPlan } from "../../src/productions/music-render.js";
import { checkWorldPackageZip } from "../../src/productions/world-package.js";
import { createProductionFromPlan, planProductionCreation } from "../../src/productions/ops.js";
import { MUSIC_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import type { WorldStore } from "../../src/world/store.js";
import { tempDir } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Music productions (design turn 238, SPEC-060 task 2): the medium and its record, the album's
 * track writes, Heard in read from the world's placements, and Export → Arke Player's production
 * package, read back by the shared reader.
 */
const BELLS = "ar_01J8G0000000000000000000R1";
const BOARD = "ar_01J8G0000000000000000000B2";
const CUE = "ar_01J9M00000000000000000C001";
const SONG = "ar_01J9M00000000000000000S001";

/** One second of a quiet stereo tone, 48 kHz, as the decode step writes it. */
function toneWav(seconds = 1): Buffer {
  const frames = 48_000 * seconds;
  const out = Buffer.alloc(44 + frames * 4);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(48_000, 24);
  out.writeUInt32LE(192_000, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / 48_000) * 3000);
    out.writeInt16LE(sample, 44 + frame * 4);
    out.writeInt16LE(sample, 44 + frame * 4 + 2);
  }
  return out;
}

/** An encoder that writes a real WAV for a decode and a few bytes for anything else. */
function fakeFfmpeg(calls: string[][]): FfmpegRunner {
  return {
    slateFont: "",
    run: async (args) => {
      calls.push(args);
      const output = args[args.length - 1]!;
      await writeFile(output, output.endsWith(".wav") ? toneWav() : `made by ${output.split(/[\\/]/).pop()}`);
    },
  } as FfmpegRunner;
}

type Created = Extract<DomainEvent, { type: "production.create-result" }>;
type Exported = Extract<DomainEvent, { type: "arke-player.exported" }>;
type Heard = Extract<DomainEvent, { type: "music.heard-in" }>;
type Enqueued = Extract<DomainEvent, { type: "queue.enqueue-result" }>;
type Failed = Extract<DomainEvent, { type: "command.failed" }>;

interface Harness {
  worldDir: string;
  events: DomainEvent[];
  send: (message: ClientMessage) => Promise<void>;
  store: () => WorldStore;
  provider: FsWorldProvider;
}

async function withHarness(run: (h: Harness) => Promise<void>, options: { ffmpeg?: FfmpegRunner; probe?: MediaProbe; prepare?: (worldDir: string) => Promise<void> } = {}): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  // A picture on the shelf for the cover, beside the fixture's own board.
  await writeFile(join(worldDir, "artifacts", "cover.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await writeFile(join(worldDir, "artifacts", "cover.png.json"), JSON.stringify({ id: BOARD, kind: "image", file: "cover.png", hash: "sha256:1111111111111111", origin: { by: "user" }, links: [], created: "2026-10-24T10:00:00Z" }));
  // An audio drama's music cue, filed as Saltlight's own (SPEC-057 R-40): the world's music still.
  await writeFile(join(worldDir, "artifacts", "harbour-reel.wav"), toneWav());
  await writeFile(join(worldDir, "artifacts", "harbour-reel.wav.json"), JSON.stringify({
    id: CUE, kind: "audio", file: "harbour-reel.wav", hash: "sha256:2222222222222222", origin: { by: "system", producedBy: "sound" }, links: [], production: "saltlight", created: "2026-10-24T10:00:00Z",
    generation: { source: "sound", productionId: "saltlight", name: "Harbour reel", cue: "music", heard: "a reel on the quay", prompt: "a harbour reel", provider: "elevenlabs", model: "sound", outputFormat: "wav", estimatedMicroUsd: 0, costMicroUsd: null },
  }));
  // A song kept from Bench's music mode, with the words it was sung from.
  await writeFile(join(worldDir, "artifacts", "bell-rope-chant.wav"), toneWav());
  await writeFile(join(worldDir, "artifacts", "bell-rope-chant.wav.json"), JSON.stringify({
    id: SONG, kind: "audio", file: "bell-rope-chant.wav", hash: "sha256:3333333333333333", origin: { by: "system", producedBy: "bench" }, links: [], created: "2026-10-23T10:00:00Z",
    generation: { source: "bench", sessionId: "sess_01J9M000000000000000000001", takeId: "tk_01J9M000000000000000000001", takeNumber: 1, brief: "Bell rope chant, slow", references: [], keyframes: [], provider: "elevenlabs", model: "music_v1", params: { kind: "music", lyrics: "[verse]\nHaul on the ropes", count: 1 }, costMicroUsd: 280_000 },
  }));
  await options.prepare?.(worldDir);
  const provider = new FsWorldProvider(root, { clock: () => "2026-10-25T09:00:00.000Z" });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    cipher: devCipher(),
    credentialsFileName: "credentials.dev.dat",
    manifest: { manifestVersion: 1, generated: "2026-10-25", models: [] },
    observeEvent: (event) => events.push(event),
    mediaProbe: options.probe ?? { durationSec: async () => 3, info: async () => ({ durationSec: 3, hasAudio: true }) },
    ...(options.ffmpeg !== undefined ? { ffmpeg: options.ffmpeg } : {}),
  });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ worldDir, events, send, store: () => provider.openStore!()!, provider });
  } finally {
    await provider.close();
  }
}

let requests = 0;
const requestId = () => `01J9M${String(++requests).padStart(21, "0")}`;

async function createMusic(h: Harness, title: string, kind: "album" | "single" | "soundtrack", soundtrackFor?: string): Promise<Created> {
  const id = requestId();
  await h.send({ kind: "create-production", worldId: WORLD_ID, requestId: id, title, medium: "music", productionKind: kind, ...(soundtrackFor !== undefined ? { soundtrackFor } : {}) });
  const answer = h.events.find((event): event is Created => event.type === "production.create-result" && event.requestId === id);
  assert.ok(answer, "the creation is answered");
  return answer;
}

const recordOf = async (worldDir: string, slug: string) => MusicRecordSchema.parse(JSON.parse(await readFile(join(worldDir, "productions", slug, "music.json"), "utf8")));
const failures = (h: Harness) => h.events.filter((event): event is Failed => event.type === "command.failed").map((event) => event.reason);

async function entry(file: string, name: string): Promise<string> {
  const zip = await openPromise(file, { autoClose: false });
  try {
    for await (const item of zip.eachEntry()) {
      if (item.fileName !== name) continue;
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(item)) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    }
    throw new Error(`${name} is not in the package`);
  } finally {
    await new Promise<void>((resolve) => { zip.once("close", resolve); zip.close(); });
  }
}

describe("a music production (turn 238, SPEC-060 R-1 – R-4)", () => {
  it("is made with its record, an empty album, and raises the world's schema", () =>
    withHarness(async (h) => {
      const created = await createMusic(h, "Songs of the Drowned Quarter", "album");
      assert.equal(created.disposition, "created");
      const slug = created.slug!;
      assert.deepEqual(await recordOf(h.worldDir, slug), { version: 1, loudness: -14, tracks: [] });
      const meta = JSON.parse(await readFile(join(h.worldDir, "productions", slug, "production.json"), "utf8")) as { medium?: string; kind?: string };
      assert.equal(meta.medium, "music");
      assert.equal(meta.kind, "album");
      const production = h.store().getBundle().productions.find((entry) => entry.meta.id === slug);
      assert.deepEqual(production?.music?.tracks, []);
    }));

  it("raises the world's schema however it is made: World Chat's prepared create too (codex on PR 2189)", () =>
    withHarness(async (h) => {
      const store = h.store();
      const plan = planProductionCreation(store.getBundle(), { title: "Saltmouth Bells", medium: "music", productionKind: "single" }, "2026-10-25T09:00:00.000Z");
      await createProductionFromPlan(store, plan, { source: "test", requestId: requestId(), precondition: () => null });
      assert.ok((await readWorldMeta(store.dir)).schemaVersion >= MUSIC_SCHEMA_VERSION, "an older build refuses the world rather than dropping its music");
    }));

  it("names the production a soundtrack is for, and refuses one that names none", () =>
    withHarness(async (h) => {
      const without = await createMusic(h, "The Bell Watch", "soundtrack");
      assert.equal(without.disposition, "failed");
      const made = await createMusic(h, "Saltlight — Soundtrack", "soundtrack", "saltlight");
      assert.equal(made.disposition, "created");
      assert.equal((await recordOf(h.worldDir, made.slug!)).for, "saltlight");
    }));
});

describe("the album's tracks (238c – 238e, R-5 – R-7)", () => {
  it("adds a kept take, retitles it, keeps its lyrics, reorders and removes, never touching the take", () =>
    withHarness(async (h) => {
      const slug = (await createMusic(h, "Songs of the Drowned Quarter", "album")).slug!;
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: BELLS });
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: BELLS });
      let record = await recordOf(h.worldDir, slug);
      assert.deepEqual(record.tracks.map((track) => track.id), ["harbour-bells", "harbour-bells-2"]);
      assert.deepEqual(record.tracks[0]!.source, { artifactId: BELLS });
      await h.send({ kind: "music-track-update", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", title: "Saltmouth Bells", lyrics: "[verse]\nRing them low" });
      await h.send({ kind: "music-tracks-reorder", worldId: WORLD_ID, productionId: slug, order: ["harbour-bells-2", "harbour-bells"] });
      record = await recordOf(h.worldDir, slug);
      assert.deepEqual(record.tracks.map((track) => [track.id, track.title, track.lyrics]), [["harbour-bells-2", "Harbour bells", undefined], ["harbour-bells", "Saltmouth Bells", "[verse]\nRing them low"]]);
      await h.send({ kind: "music-track-update", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", lyrics: "" });
      await h.send({ kind: "music-track-remove", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells-2" });
      record = await recordOf(h.worldDir, slug);
      assert.deepEqual(record.tracks.map((track) => [track.id, track.lyrics]), [["harbour-bells", undefined]]);
      assert.ok(h.store().getBundle().artifacts.some((artifact) => artifact.id === BELLS && artifact.retiredAt === undefined), "the take stays on the shelf");
      // A reorder that does not name every track is the album having changed, and refused.
      await h.send({ kind: "music-tracks-reorder", worldId: WORLD_ID, productionId: slug, order: ["harbour-bells", "gone"] });
      assert.ok(failures(h).some((reason) => /the album changed/.test(reason)));
    }));

  it("holds one track on a Single, and makes it an Album to add a second (R-3)", () =>
    withHarness(async (h) => {
      const slug = (await createMusic(h, "Saltmouth Bells", "single")).slug!;
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: BELLS });
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: BELLS });
      assert.ok(failures(h).some((reason) => /a single holds one track/.test(reason)));
      assert.equal((await recordOf(h.worldDir, slug)).tracks.length, 1);
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: BELLS, makeAlbum: true });
      assert.equal((await recordOf(h.worldDir, slug)).tracks.length, 2);
      const meta = JSON.parse(await readFile(join(h.worldDir, "productions", slug, "production.json"), "utf8")) as { kind?: string };
      assert.equal(meta.kind, "album");
    }));

  it("names a Bench song by its brief and starts its lyrics from the words it was sung from", () =>
    withHarness(async (h) => {
      const slug = (await createMusic(h, "Songs", "album")).slug!;
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: SONG });
      assert.deepEqual((await recordOf(h.worldDir, slug)).tracks.map((track) => [track.id, track.title, track.lyrics]), [["bell-rope-chant", "Bell rope chant", "[verse]\nHaul on the ropes"]]);
    }));

  it("takes music another production made, as an audio drama's cue (codex on PR 2189)", () =>
    withHarness(async (h) => {
      const slug = (await createMusic(h, "Songs", "album")).slug!;
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: CUE });
      assert.deepEqual((await recordOf(h.worldDir, slug)).tracks.map((track) => [track.id, track.title]), [["harbour-reel", "Harbour reel"]]);
      assert.deepEqual(failures(h), []);
    }));

  it("adds a file imported into another album already, leaving it that album's (codex on PR 2189)", async () => {
    const dir = await tempDir("arke-music-import-");
    const song = join(dir, "tide-caller.wav");
    await writeFile(song, toneWav());
    await withHarness(async (h) => {
      const first = (await createMusic(h, "Songs", "album")).slug!;
      const second = (await createMusic(h, "More Songs", "album")).slug!;
      for (const slug of [first, second]) {
        const id = requestId();
        await h.send({ kind: "upload-artifacts", worldId: WORLD_ID, requestId: id, sourcePaths: [song], music: { productionId: slug } });
        assert.deepEqual(h.events.find((event): event is Enqueued => event.type === "queue.enqueue-result" && event.requestId === id)?.failures, []);
      }
      const [a, b] = [await recordOf(h.worldDir, first), await recordOf(h.worldDir, second)];
      assert.deepEqual(a.tracks.map((track) => track.source), b.tracks.map((track) => track.source), "one file, on both albums");
      const filed = h.store().getBundle().artifacts.find((artifact) => "artifactId" in a.tracks[0]!.source && artifact.id === a.tracks[0]!.source.artifactId);
      assert.equal(filed?.production, first, "its owner is the album that imported it first");
    });
  });

  it("takes a picture as its cover and refuses a sound (R-5)", () =>
    withHarness(async (h) => {
      const slug = (await createMusic(h, "Songs", "album")).slug!;
      await h.send({ kind: "music-set-cover", worldId: WORLD_ID, productionId: slug, artifactId: BELLS });
      assert.ok(failures(h).some((reason) => /a cover is a picture/.test(reason)));
      await h.send({ kind: "music-set-cover", worldId: WORLD_ID, productionId: slug, artifactId: BOARD });
      assert.equal((await recordOf(h.worldDir, slug)).cover, BOARD);
    }));

  it("imports a file as a track, and refuses one that is not music or that the probe hears nothing in (R-6)", async () => {
    const dir = await tempDir("arke-music-import-");
    const song = join(dir, "tide-caller.flac");
    const notes = join(dir, "notes.txt");
    await writeFile(song, toneWav());
    await writeFile(notes, "not a song");
    await withHarness(async (h) => {
      const slug = (await createMusic(h, "Songs", "album")).slug!;
      const id = requestId();
      await h.send({ kind: "upload-artifacts", worldId: WORLD_ID, requestId: id, sourcePaths: [song, notes], music: { productionId: slug } });
      const answer = h.events.find((event): event is Enqueued => event.type === "queue.enqueue-result" && event.requestId === id);
      assert.deepEqual(answer?.failures, [{ index: 1, reason: "notes.txt: a track is WAV, MP3, M4A or FLAC" }]);
      const record = await recordOf(h.worldDir, slug);
      assert.deepEqual(record.tracks.map((track) => track.title), ["Tide caller"]);
      const filed = h.store().getBundle().artifacts.find((artifact) => "artifactId" in record.tracks[0]!.source && artifact.id === record.tracks[0]!.source.artifactId);
      assert.equal(filed?.production, slug, "kept as the production's own");
      assert.equal(filed?.mediaInfo?.hasAudio, true, "probed as it was filed");
    });
    await withHarness(async (h) => {
      const slug = (await createMusic(h, "Songs", "album")).slug!;
      const id = requestId();
      await h.send({ kind: "upload-artifacts", worldId: WORLD_ID, requestId: id, sourcePaths: [song], music: { productionId: slug } });
      const answer = h.events.find((event): event is Enqueued => event.type === "queue.enqueue-result" && event.requestId === id);
      assert.deepEqual(answer?.failures, [{ index: 0, reason: "tide-caller.flac: no sound could be read from it" }]);
      assert.equal((await recordOf(h.worldDir, slug)).tracks.length, 0);
    }, { probe: { durationSec: async () => 3, info: async () => ({ durationSec: 3, hasAudio: false }) } });
  });
});

describe("Heard in (R-14)", () => {
  it("finds a track where another production places its take, read and never kept", () =>
    withHarness(async (h) => {
      const slug = (await createMusic(h, "Songs", "album")).slug!;
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: BELLS });
      const id = requestId();
      await h.send({ kind: "read-music-heard-in", worldId: WORLD_ID, productionId: slug, requestId: id });
      const answer = h.events.find((event): event is Heard => event.type === "music.heard-in" && event.requestId === id);
      assert.deepEqual(answer?.tracks, { "harbour-bells": [{ production: "saltlight", productionTitle: "Saltlight", chapter: "cut", label: "Cut", at: 12_500, open: "/p/saltlight/cut" }] });
      assert.equal(JSON.stringify(await recordOf(h.worldDir, slug)).includes("heard"), false, "nothing of it is kept in the record");
    }, {
      prepare: async (worldDir) => {
        await writeFile(join(worldDir, "productions", "saltlight", "cut.json"), JSON.stringify({ audio: [{ kind: "score", label: "Score", entries: [{ artifactId: BELLS, offsetSec: 12.5 }] }], overlays: [] }));
      },
    }));
});

describe("Heard in once the timeline holds the cut (codex on PR 2189)", () => {
  it("reports where the timeline places a take, never the frozen cut.json it was made from", () =>
    withHarness(async (h) => {
      const slug = (await createMusic(h, "Songs", "album")).slug!;
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: BELLS });
      const id = requestId();
      await h.send({ kind: "read-music-heard-in", worldId: WORLD_ID, productionId: slug, requestId: id });
      const answer = h.events.find((event): event is Heard => event.type === "music.heard-in" && event.requestId === id);
      assert.deepEqual(answer?.tracks["harbour-bells"]?.map((row) => row.at), [10_000], "the moved clip, at 0:10, and not the bed's 0:12.5");
    }, {
      prepare: async (worldDir) => {
        await writeFile(join(worldDir, "productions", "saltlight", "cut.json"), JSON.stringify({ audio: [{ kind: "score", label: "Score", entries: [{ artifactId: BELLS, offsetSec: 12.5 }] }], overlays: [] }));
        await writeFile(join(worldDir, "productions", "saltlight", "timeline.json"), JSON.stringify({
          schemaVersion: 1, revision: 3, frameRate: 24, history: { undo: [], redo: [] }, migratedCut: true,
          tracks: [
            { id: "tr_picture", kind: "picture", name: "Picture", order: 0, muted: false, endFrame: 480, clips: [] },
            { id: "tr_score", kind: "audio", name: "Score", order: 1, muted: false, clips: [{ id: "cl_bells", startFrame: 240, durationFrames: 48, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "Bells" } }] },
          ],
        }));
      },
    }));
});

describe("the render and Export → Arke Player (238h, R-8, R-15 – R-17)", () => {
  it("renders each track with its edges: the sequence's gap after it, a crossfade as two fades", () => {
    const record = MusicRecordSchema.parse({
      version: 1,
      tracks: [
        { id: "one", title: "One", source: { artifactId: BELLS }, next: { crossfadeMs: 3000 }, fadeInMs: 500 },
        { id: "two", title: "Two", source: { artifactId: BELLS }, next: { gapMs: 2000 }, trim: { startMs: 1000, endMs: 9000 } },
        { id: "three", title: "Three", source: { artifactId: BELLS }, next: { gapMs: 2000 } },
      ],
    });
    const plan = musicRenderPlan(record, [{ id: BELLS, kind: "audio", file: "harbour-bells.wav", hash: "sha256:6a1e02b9c44d7f31", origin: { by: "user" }, links: [], created: "2026-06-11T10:00:00Z" }] as never);
    assert.ok(plan.ok);
    assert.deepEqual(plan.tracks.map((track) => [track.fadeInMs, track.fadeOutMs, track.gapMs, track.startMs, track.endMs]), [[500, 3000, 0, 0, null], [3000, 0, 2000, 1000, 9000], [0, 0, 0, 0, null]]);
    assert.deepEqual(musicDocumentSections({ ...record.tracks[1]!, sections: [{ label: "Chorus", atMs: 5000 }, { label: "Intro", atMs: 500 }, { label: "Verse", atMs: 2000 }, { label: "Outro", atMs: 9500 }] }, 8000), [{ label: "Verse", at: 1000 }, { label: "Chorus", at: 4000 }]);
  });

  it("makes a production package of the album alone, read back by the shared reader and listed", () => {
    const calls: string[][] = [];
    return withHarness(async (h) => {
      const slug = (await createMusic(h, "Songs of the Drowned Quarter", "album")).slug!;
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: BELLS });
      await h.send({ kind: "music-track-update", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", title: "Saltmouth Bells", lyrics: "Ring them low" });
      await h.send({ kind: "music-set-cover", worldId: WORLD_ID, productionId: slug, artifactId: BOARD });
      const exportId = "ap_01J9M000000000000000000001";
      await h.send({ kind: "export-arke-player", worldId: WORLD_ID, productionId: slug, requestId: requestId(), exportId, options: { book: false, motion: false } });
      const answer = h.events.find((event): event is Exported => event.type === "arke-player.exported" && event.exportId === exportId);
      assert.ok(answer?.result.ok, JSON.stringify(answer?.result));
      assert.equal(answer.result.file, `exports/the-undersong-${slug}-2026-10-25.zip`);
      assert.equal(answer.result.tracks, 1);
      const zip = join(h.worldDir, answer.result.file);
      assert.ok((await checkWorldPackageZip(zip)).ok);
      const manifest = readWorldManifest(await entry(zip, "world.json"));
      assert.ok(manifest.ok);
      assert.equal(manifest.manifest.schemaVersion, 5);
      assert.equal(manifest.manifest.alone, true);
      assert.deepEqual(manifest.manifest.productions, [{ id: slug, title: "Songs of the Drowned Quarter", picture: "cover", music: "music" }]);
      const music = readMusic(await entry(zip, "music.json"), manifest.manifest.assets);
      assert.ok(music.ok);
      assert.deepEqual(music.document.tracks, [{ id: "harbour-bells", title: "Saltmouth Bells", audio: "t01", duration: 1000, lyrics: { text: "Ring them low" } }]);
      assert.equal(manifest.manifest.assets["t01"]!.mediaType, "audio/mp4");
      // The render is AAC at 256 kbps, loudness-matched, and the cover square at 1024.
      const encode = calls.find((args) => args.includes("aac"));
      assert.ok(encode?.includes("256k"));
      assert.ok(encode?.some((arg) => /volume=-?\d+\.\d+dB/.test(arg)));
      assert.ok(calls.some((args) => args.some((arg) => arg.startsWith("crop='min(iw,ih)'") && arg.includes("min(1024,iw)"))));
      const listed = await listArkePlayerPackages(h.store());
      assert.deepEqual(listed.map((entry) => [entry.productionId, entry.tracks, entry.holds]), [[slug, 1, "1 track · the cover · 1 with lyrics"]]);
      // Play all is the same render, cached: nothing is encoded again.
      const before = calls.length;
      const playId = requestId();
      await h.send({ kind: "render-music", worldId: WORLD_ID, productionId: slug, requestId: playId });
      const played = h.events.find((event): event is Extract<DomainEvent, { type: "music.rendered" }> => event.type === "music.rendered" && event.requestId === playId);
      assert.ok(played?.result.ok);
      assert.equal(played.result.durationMs, 1000);
      assert.equal(calls.length, before);
      // What Play all answers is something the media route will serve, as audio (codex on PR 2189).
      const served = await h.provider.serveMedia("the-undersong", played.result.file);
      assert.equal(served?.contentType, "audio/mp4");
    }, { ffmpeg: fakeFfmpeg(calls) });
  });

  it("still exports a track and a cover retired from the shelf since (codex on PR 2189)", () =>
    withHarness(async (h) => {
      const slug = (await createMusic(h, "Songs", "album")).slug!;
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: BELLS });
      await h.send({ kind: "music-set-cover", worldId: WORLD_ID, productionId: slug, artifactId: BOARD });
      await h.send({ kind: "retire-artifact", worldId: WORLD_ID, artifactId: BELLS });
      await h.send({ kind: "retire-artifact", worldId: WORLD_ID, artifactId: BOARD });
      assert.ok(h.store().getBundle().artifacts.filter((artifact) => artifact.id === BELLS || artifact.id === BOARD).every((artifact) => artifact.retiredAt !== undefined));
      const exportId = "ap_01J9M000000000000000000003";
      await h.send({ kind: "export-arke-player", worldId: WORLD_ID, productionId: slug, requestId: requestId(), exportId, options: { book: false, motion: false } });
      const answer = h.events.find((event): event is Exported => event.type === "arke-player.exported" && event.exportId === exportId);
      assert.ok(answer?.result.ok, JSON.stringify(answer?.result));
      assert.equal(answer.result.pictures, 1, "the cover went with it");
      // A new choice of a retired take is still refused.
      const before = failures(h).length;
      await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId: BELLS });
      assert.equal(failures(h).length, before + 1);
    }, { ffmpeg: fakeFfmpeg([]) }));

  it("refuses an album with no tracks, and needs ffmpeg", () =>
    withHarness(async (h) => {
      const slug = (await createMusic(h, "Songs", "album")).slug!;
      const exportId = "ap_01J9M000000000000000000002";
      await h.send({ kind: "export-arke-player", worldId: WORLD_ID, productionId: slug, requestId: requestId(), exportId, options: { book: false, motion: false } });
      const answer = h.events.find((event): event is Exported => event.type === "arke-player.exported" && event.exportId === exportId);
      assert.deepEqual(answer?.result, { ok: false, blockers: ["Add a track first"] });
    }, { ffmpeg: fakeFfmpeg([]) }));
});


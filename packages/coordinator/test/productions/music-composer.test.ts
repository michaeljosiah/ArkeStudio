import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MusicRecordSchema, musicTotalMs, ulid, type ClientMessage, type DomainEvent, type ManifestModel, type SessionId } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { devCipher } from "../../src/credentials/dev-cipher.js";
import { BenchStore, sessionDir, sessionMediaDir } from "../../src/bench/store.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { musicRenderPlan } from "../../src/productions/music-render.js";
import type { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * A track's composer and takes, the track editor and the album's sequence (design turn 238i –
 * 238k, SPEC-060 R-9 – R-13): takes made by the Bench's own dispatch in the album's session and
 * tagged to their track, a take chosen and kept, the editor's Save, the sequence, and a waveform.
 */
const BELLS = "ar_01J8G0000000000000000000R1";
// A one-second file whose length the shelf knows, for what adds lengths up.
const TIDE = "ar_01J9M00000000000000000T001";

// Eleven Music as the manifest declares it, and a route that keeps neither a length nor an instrumental.
const ELEVEN: ManifestModel = {
  id: "music_v1", provider: "elevenlabs", capability: "music", displayName: "Eleven Music",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
  limits: { maxDurationSec: 300, audioFormat: "mp3", maxPromptChars: 2000, musicLength: "exact", musicInstrumental: true },
  pricing: { kind: "perSecond", microUsdPerSecond: 2500 },
};
const CEILING: ManifestModel = { ...ELEVEN, id: "test-music", provider: "fal", displayName: "Test Music", limits: { maxDurationSec: 300 } };

/** One second of a quiet stereo tone, 48 kHz. */
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

type Enqueued = Extract<DomainEvent, { type: "queue.enqueue-result" }>;
type Takes = Extract<DomainEvent, { type: "music.takes" }>;
type Failed = Extract<DomainEvent, { type: "command.failed" }>;

interface Harness {
  worldDir: string;
  events: DomainEvent[];
  send: (message: ClientMessage) => Promise<void>;
  store: () => WorldStore;
}

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const { root, worldDir } = await makeTempRoot();
  await writeFile(join(worldDir, "artifacts", "tide-caller.wav"), toneWav());
  await writeFile(join(worldDir, "artifacts", "tide-caller.wav.json"), JSON.stringify({ id: TIDE, kind: "audio", file: "tide-caller.wav", hash: "sha256:4444444444444444", origin: { by: "user" }, links: [], created: "2026-10-24T10:00:00Z", mediaInfo: { durationSec: 1, hasAudio: true } }));
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
    manifest: { manifestVersion: 1, generated: "2026-10-25", models: [ELEVEN, CEILING] },
    observeEvent: (event) => events.push(event),
    mediaProbe: { durationSec: async () => 3, info: async () => ({ durationSec: 3, hasAudio: true }) },
  });
  const send = (message: ClientMessage) => (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  coordinator.serverApplication.attachTransport({ broadcast() {}, broadcastSnapshot() {} });
  try {
    await run({ worldDir, events, send, store: () => provider.openStore!()! });
  } finally {
    await provider.close();
  }
}

async function album(h: Harness, tracks = 1, artifactId = BELLS): Promise<string> {
  const requestId = ulid();
  await h.send({ kind: "create-production", worldId: WORLD_ID, requestId, title: "Songs of the Drowned Quarter", medium: "music", productionKind: "album" });
  const created = h.events.find((event): event is Extract<DomainEvent, { type: "production.create-result" }> => event.type === "production.create-result" && event.requestId === requestId);
  const slug = created!.slug!;
  for (let index = 0; index < tracks; index++) await h.send({ kind: "music-track-add", worldId: WORLD_ID, productionId: slug, artifactId });
  return slug;
}

const recordOf = async (worldDir: string, slug: string) => MusicRecordSchema.parse(JSON.parse(await readFile(join(worldDir, "productions", slug, "music.json"), "utf8")));
const failures = (h: Harness) => h.events.filter((event): event is Failed => event.type === "command.failed").map((event) => event.reason);
const make = (h: Harness, slug: string, params: Record<string, unknown>, model = ELEVEN) => {
  const requestId = ulid();
  return h.send({ kind: "music-track-make", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", requestId,
    composer: { provider: model.provider, model: model.id, params: { kind: "music", lyrics: "[verse]\nRing them low", count: 2, ...params } as never, brief: "Slow sea shanty, low strings" } }).then(() => requestId);
};
const answerTo = (h: Harness, requestId: string) => h.events.find((event): event is Enqueued => event.type === "queue.enqueue-result" && event.requestId === requestId);

/** A take landed in the album's session, as a finished job leaves one. */
async function landTake(h: Harness, session: SessionId): Promise<string> {
  const bench = new BenchStore(sessionDir(h.worldDir, session));
  const takeId = `tk_${ulid()}`;
  const bytes = toneWav(3);
  await bench.append({ type: "takes-reserved", takes: [{ id: takeId as never, n: 9, requestId: `landed-${takeId}`, createdAt: "2026-10-25T09:00:00.000Z",
    request: { mode: "music", brief: "Slow sea shanty", references: [], keyframes: [], provider: "elevenlabs", model: "music_v1", params: { kind: "music", lyrics: "[verse]\nRing them low", count: 1 } } }] });
  await bench.append({ type: "take-completed", takeId: takeId as never, media: { file: "take.wav", hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }, completedAt: "2026-10-25T09:00:00.000Z" });
  await mkdir(join(h.worldDir, sessionMediaDir(session, takeId)), { recursive: true });
  await writeFile(join(h.worldDir, sessionMediaDir(session, takeId), "take.wav"), bytes);
  return takeId;
}

describe("a track's composer and takes (238i, R-9, R-10)", () => {
  it("makes takes by the Bench's own dispatch in the album's one session, each tagged to its track", () =>
    withHarness(async (h) => {
      const slug = await album(h);
      const first = await make(h, slug, { lengthSec: 180 });
      const answer = answerTo(h, first);
      assert.ok(answer, "the composer's press is answered as a Bench dispatch");
      assert.equal(answer.command, "bench-dispatch");
      const record = await recordOf(h.worldDir, slug);
      assert.ok(record.session, "the album keeps its session");
      const session = await new BenchStore(sessionDir(h.worldDir, record.session)).fold();
      assert.deepEqual(session!.subject, { kind: "production", productionId: slug, productionTitle: "Songs of the Drowned Quarter", role: "music" });
      assert.deepEqual(session!.takes.map((take) => [take.requestId, take.request.mode, take.request.brief]), [[`${first}/0`, "music", "Slow sea shanty, low strings"], [`${first}/1`, "music", "Slow sea shanty, low strings"]]);
      assert.deepEqual(session!.takes.map((take) => take.request.params.kind === "music" ? take.request.params.lengthSec : null), [180, 180]);
      assert.deepEqual(record.tracks[0]!.takes, session!.takes.map((take) => ({ sessionId: record.session, takeId: take.id })));
      const pushed = h.events.filter((event): event is Takes => event.type === "music.takes" && event.requestId === first).at(-1);
      assert.deepEqual(pushed?.takes.map((take) => take.trackId), ["harbour-bells", "harbour-bells"]);

      // A second press uses the same session, and its takes follow the first.
      await make(h, slug, {});
      const again = await recordOf(h.worldDir, slug);
      assert.equal(again.session, record.session);
      assert.equal(again.tracks[0]!.takes.length, 4);
    }));

  it("refuses words beside an instrumental, and a length a route treats as a ceiling", () =>
    withHarness(async (h) => {
      const slug = await album(h);
      const instrumental = await make(h, slug, { instrumental: true });
      assert.deepEqual(answerTo(h, instrumental)?.failures.map((failure) => failure.reason), ["An instrumental is sent without lyrics"]);
      const ceiling = await make(h, slug, { lengthSec: 120 }, CEILING);
      assert.deepEqual(answerTo(h, ceiling)?.failures.map((failure) => failure.reason), ["Test Music takes no length"]);
      const wordless = await make(h, slug, { lyrics: "", instrumental: true }, CEILING);
      assert.deepEqual(answerTo(h, wordless)?.failures.map((failure) => failure.reason), ["Test Music needs lyrics"]);
      assert.deepEqual((await recordOf(h.worldDir, slug)).tracks[0]!.takes, [], "nothing refused is a track's take");
    }));

  it("chooses a finished take: kept to the shelf, the track's source, its trim clipped and its sections kept", () =>
    withHarness(async (h) => {
      const slug = await album(h);
      await make(h, slug, {});
      await h.send({ kind: "music-track-edit", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", trim: { startMs: 1000, endMs: 9000 }, fadeInMs: 0, fadeOutMs: 0, sections: [{ label: "Verse", atMs: 2000 }] });
      const session = (await recordOf(h.worldDir, slug)).session!;
      const takeId = await landTake(h, session);
      await h.send({ kind: "music-track-choose", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", sessionId: session, takeId, requestId: ulid() });
      assert.deepEqual(failures(h), []);
      const record = await recordOf(h.worldDir, slug);
      const track = record.tracks[0]!;
      const kept = h.store().getBundle().artifacts.find((artifact) => "artifactId" in track.source && artifact.id === track.source.artifactId);
      assert.ok(kept, "the take is on the shelf");
      assert.equal(kept.production, slug);
      assert.equal(kept.generation?.source === "bench" && "takeId" in kept.generation ? kept.generation.takeId : null, takeId);
      assert.ok(track.takes.some((take) => take.takeId === takeId));
      assert.deepEqual(track.trim, { startMs: 1000, endMs: 3000 }, "clipped to the 3 s take");
      assert.deepEqual(track.sections, [{ label: "Verse", atMs: 2000 }]);
      const session2 = await new BenchStore(sessionDir(h.worldDir, session)).fold();
      assert.equal(session2!.takes.find((take) => take.id === takeId)?.keptArtifactId, kept.id);
    }));

  it("refuses a take of another session, and one still being made", () =>
    withHarness(async (h) => {
      const slug = await album(h);
      await make(h, slug, {});
      const record = await recordOf(h.worldDir, slug);
      await h.send({ kind: "music-track-choose", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", sessionId: `sess_${ulid()}` as never, takeId: record.tracks[0]!.takes[0]!.takeId, requestId: ulid() });
      await h.send({ kind: "music-track-choose", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", sessionId: record.session!, takeId: record.tracks[0]!.takes[0]!.takeId, requestId: ulid() });
      assert.deepEqual(failures(h), ["that take is not this album's", "that take has not finished"]);
      assert.deepEqual((await recordOf(h.worldDir, slug)).tracks[0]!.source, { artifactId: BELLS });
    }));
});

describe("the track editor and the sequence (238j, 238k, R-11 – R-13)", () => {
  it("saves a trim, fades and sections in order, never the take, and refuses one that leaves nothing", () =>
    withHarness(async (h) => {
      const slug = await album(h);
      await h.send({ kind: "music-track-edit", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", trim: { startMs: 500, endMs: 2500 }, fadeInMs: 200, fadeOutMs: 300, sections: [{ label: "Chorus", atMs: 1500 }, { label: "Verse", atMs: 500 }] });
      let track = (await recordOf(h.worldDir, slug)).tracks[0]!;
      assert.deepEqual([track.trim, track.fadeInMs, track.fadeOutMs, track.sections], [{ startMs: 500, endMs: 2500 }, 200, 300, [{ label: "Verse", atMs: 500 }, { label: "Chorus", atMs: 1500 }]]);
      assert.deepEqual(track.source, { artifactId: BELLS }, "the take is untouched");
      await h.send({ kind: "music-track-edit", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", trim: { startMs: 2000, endMs: 1000 }, fadeInMs: 0, fadeOutMs: 0, sections: [] });
      await h.send({ kind: "music-track-edit", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", trim: { startMs: 0, endMs: 1000 }, fadeInMs: 800, fadeOutMs: 800, sections: [] });
      assert.deepEqual(failures(h), ["the trim leaves nothing to play", "the fades are longer than what plays"]);
      // A whole take, no fades and no sections clear what was set.
      await h.send({ kind: "music-track-edit", worldId: WORLD_ID, productionId: slug, trackId: "harbour-bells", trim: null, fadeInMs: 0, fadeOutMs: 0, sections: [] });
      track = (await recordOf(h.worldDir, slug)).tracks[0]!;
      assert.deepEqual([track.trim, track.fadeInMs, track.fadeOutMs, track.sections], [undefined, undefined, undefined, undefined]);
    }));

  it("sets each join and the loudness, the last track joining nothing, and the total follows the gaps", () =>
    withHarness(async (h) => {
      const slug = await album(h, 3, TIDE);
      const ids = (await recordOf(h.worldDir, slug)).tracks.map((track) => track.id);
      await h.send({ kind: "music-sequence-set", worldId: WORLD_ID, productionId: slug, loudness: -16, joins: [
        { trackId: ids[0]!, next: { gapMs: 2000 } }, { trackId: ids[1]!, next: { crossfadeMs: 3000 } }, { trackId: ids[2]!, next: { gapMs: 5000 } },
      ] });
      const record = await recordOf(h.worldDir, slug);
      assert.deepEqual([record.loudness, ...record.tracks.map((track) => track.next)], [-16, { gapMs: 2000 }, { crossfadeMs: 3000 }, undefined]);
      const artifacts = h.store().getBundle().artifacts;
      const one = musicTotalMs({ tracks: [record.tracks[0]!] }, artifacts)!;
      assert.equal(musicTotalMs(record, artifacts), one * 3 + 2000, "a crossfade adds no time");
      // The render reads the sequence: the gap after the first, the crossfade as two fades.
      const plan = musicRenderPlan(record, artifacts);
      assert.ok(plan.ok);
      assert.deepEqual(plan.tracks.map((track) => [track.fadeInMs, track.fadeOutMs, track.gapMs]), [[0, 0, 2000], [0, 3000, 0], [3000, 0, 0]]);
      await h.send({ kind: "music-sequence-set", worldId: WORLD_ID, productionId: slug, loudness: -14, joins: [{ trackId: "gone", next: null }] });
      assert.ok(failures(h).some((reason) => /the album changed/.test(reason)));
    }));

  it("reads a file's waveform once, from the cache after", () =>
    withHarness(async (h) => {
      const ask = async () => {
        const requestId = ulid();
        await h.send({ kind: "read-music-waveform", worldId: WORLD_ID, file: "artifacts/tide-caller.wav", requestId });
        return h.events.find((event): event is Extract<DomainEvent, { type: "music.waveform" }> => event.type === "music.waveform" && event.requestId === requestId);
      };
      const first = await ask();
      assert.equal(first?.waveform?.durationMs, 1000);
      assert.equal(first?.waveform?.peaks.length, 600);
      assert.ok(first!.waveform!.peaks.every((peak) => peak > 0 && peak < 0.2), "a quiet tone throughout");
      const cached = (await readdir(join(h.worldDir, ".cache", "music"))).filter((name) => name.startsWith("peaks-"));
      assert.equal(cached.length, 1);
      assert.deepEqual((await ask())?.waveform, first!.waveform);
      const outside = await (async () => {
        const requestId = ulid();
        await h.send({ kind: "read-music-waveform", worldId: WORLD_ID, file: "../elsewhere.wav", requestId });
        return h.events.find((event): event is Extract<DomainEvent, { type: "music.waveform" }> => event.type === "music.waveform" && event.requestId === requestId);
      })();
      assert.equal(outside?.waveform, null, "only a file in this world");
    }));
});

describe("Make cover (238c, R-5)", () => {
  it("opens a fresh image session at the cover's square, with the album's words", () =>
    withHarness(async (h) => {
      await h.send({ kind: "bench-new-session", worldId: WORLD_ID, image: { aspect: "1:1", brief: "Cover for Songs of the Drowned Quarter" } });
      const sessions = await readdir(join(h.worldDir, ".sessions"));
      const folded = await Promise.all(sessions.filter((name) => name.startsWith("sess_")).map((name) => new BenchStore(sessionDir(h.worldDir, name as SessionId)).fold()));
      const cover = folded.find((session) => session?.composer.brief === "Cover for Songs of the Drowned Quarter");
      assert.ok(cover, "the session starts with the album's words");
      assert.deepEqual([cover.composer.mode, cover.composer.params.kind === "image" ? cover.composer.params.aspect : null], ["image", "1:1"]);
    }));
});

import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientMessageSchema, EFFECT_ANALYSIS_PROFILE, newId, ulid,
  type ClientMessage, type DomainEvent, type EffectAudioNativeDescriptor, type SongSectionsResult, type SpineMarker,
} from "@arke-studio/contracts";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { productionCommands } from "../../src/commands/productions.js";
import { CommandRouter } from "../../src/commands/router.js";
import type { CommandContext } from "../../src/commands/context.js";
import { createNodeEffectAudioAnalysisHost, type EffectAudioAnalysisHost } from "../../src/media/node-effect-audio.js";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-host.js";
import { applyProductionSpineCommand } from "../../src/productions/spine.js";
import { SongSectionsService, measureSong } from "../../src/productions/song-sections.js";
import { QueryLeaseRegistry } from "../../src/world-chat/lease.js";
import { WorldChatTargetReads, spineFence } from "../../src/world-chat/target-reads.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";

/**
 * A song's sections, proposed (issue 3099). Arke asked the author where each verse and chorus
 * starts because nothing in the Studio measured a song. The coordinator now measures the master
 * track through the effects' own decode and analysis, the Cut asks for it, and Arke reads it
 * beside the spine. Nothing is marked on the spine until a person sends it.
 *
 * The songs are made here: a kick on every beat at 120 with a quiet half and a loud half, so the
 * change is where the test put it.
 */
const PRODUCTION = "saltlight";
const RATE = EFFECT_ANALYSIS_PROFILE.sampleRate;
const SECONDS = 40;

/** Forty seconds at 120: quiet, then loud from twenty. */
function songPcm(): Float32Array {
  const samples = new Float32Array(SECONDS * RATE * 2);
  const beat = RATE / 2;
  for (let sample = 0; sample < SECONDS * RATE; sample++) {
    const loud = sample >= 20 * RATE;
    const sinceBeat = (sample % beat) / RATE;
    const value = (loud ? 0.6 : 0.08) * Math.sin(2 * Math.PI * 60 * sinceBeat) * Math.exp(-sinceBeat / 0.08)
      + (loud ? 0.2 : 0.03) * Math.sin(2 * Math.PI * 440 * sample / RATE);
    samples[sample * 2] = value; samples[sample * 2 + 1] = value;
  }
  return samples;
}

const descriptor: EffectAudioNativeDescriptor = {
  profileId: "audible-pcm-v1", decoder: { versionConfigHash: "a".repeat(64), executableHash: "b".repeat(64) },
  canonical: { sampleRate: 48000, channels: 2, channelLayout: "stereo", sampleFormat: "dbl", limiterDelaySamples: 239,
    limiter: { attackMs: 5, releaseMs: 50, level: false, asc: false, latency: false, levelIn: 1, levelOut: 1, ceiling: 0.891251 } },
  analysis: { sampleRate: 48000, channels: 2, sampleFormat: "f32le", monoPolicy: "duplicate-unity", resamplerProfile: "swr-v1" },
};

/** The effects' analysis host with the decoder left out: it hands over the PCM it was given, in chunks. */
function decoded(pcm: Float32Array, options: { failOnce?: Error } = {}) {
  const calls = { renders: 0 };
  let fail = options.failOnce;
  const host: EffectAudioAnalysisHost = {
    async describe() { return descriptor; },
    async renderAudiblePcm(request) {
      calls.renders++;
      if (fail) { const error = fail; fail = undefined; throw error; }
      // The song alone, as a one-sound film on the analyzer's whole frames.
      assert.equal(request.plan.audio.length, 1);
      assert.equal(request.selectedClipIds, null);
      assert.equal(request.plan.audio[0]!.endSec, request.plan.totalSec);
      const frames = Math.round(request.plan.totalSec * RATE);
      for (let offset = 0; offset < frames * 2; offset += 65536) await request.onPcm(pcm.subarray(offset, Math.min(frames * 2, offset + 65536)));
      return { descriptor, pcmHash: "c".repeat(64), sampleFrames: frames };
    },
  };
  return { host, calls };
}

/** A world with a sound file filed and measured at `durationSec`, and optionally made the song. */
async function songWorld(t: TestContext, options: { durationSec?: number; spine?: boolean } = {}) {
  const store = await WorldStore.open(await makeTempWorld()); t.after(() => store.close());
  const source = join(store.dir, "the-song.mp3"); await writeFile(source, "song fixture");
  // A length that is not a whole number of frames, as a real file's is.
  const durationSec = options.durationSec ?? SECONDS + 0.02;
  const filed = await fileArtifact(store, { sourcePath: source, production: PRODUCTION,
    mediaProbe: { async durationSec() { return durationSec; }, async info() { return { durationSec, hasAudio: true }; } } });
  assert.ok(filed.outcome === "filed");
  if (options.spine !== false) {
    await applyProductionSpineCommand(store, { productionId: PRODUCTION, baseRevision: null, command: { kind: "create", trackArtifactId: filed.artifact.id } }, { source: "test" });
  }
  return { store, song: filed.artifact };
}

const never = new AbortController().signal;
const measuredSong = (result: SongSectionsResult) => { assert.ok(result.status === "measured", JSON.stringify(result)); return result.song; };
const reason = (result: SongSectionsResult) => { assert.ok(result.status === "unavailable", JSON.stringify(result)); return result.reason; };

describe("a song measured for its sections (issue 3099)", () => {
  it("finds the tempo and where the song changes, once per file", async (t) => {
    const { store, song } = await songWorld(t);
    const { host, calls } = decoded(songPcm());
    const service = new SongSectionsService(host, never);
    // Asked twice at once, as the Cut and Arke's read may: one decode answers both.
    const [first, second] = await Promise.all([service.read(store, PRODUCTION), service.read(store, PRODUCTION)]);
    const measured = measuredSong(first);
    assert.deepEqual(second, first);
    assert.equal(measured.trackArtifactId, song.id);
    assert.equal(measured.durationSec, SECONDS + 0.02);
    assert.equal(measured.tempoBpm, 120);
    assert.equal(measured.startsSec.length, 2, `sections at ${measured.startsSec.join(", ")}`);
    assert.equal(measured.startsSec[0], 0);
    assert.ok(Math.abs(measured.startsSec[1]! - 20) <= 1, `the change at 20s, found ${measured.startsSec[1]}`);
    assert.deepEqual(await service.read(store, PRODUCTION), first);
    assert.equal(calls.renders, 1, "kept while the Studio runs");
    // A measure is a proposal: the spine is as it was.
    assert.deepEqual(store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!.spine!.markers, []);
  });

  it("says in plain words why a song is not measured", async (t) => {
    const { store } = await songWorld(t, { spine: false });
    const { host } = decoded(songPcm());
    assert.match(reason(await new SongSectionsService(host, never).read(store, PRODUCTION)), /no song yet/);
    assert.match(reason(await new SongSectionsService(host, never).read(store, "no-such-production")), /not in this world/);

    const withSong = await songWorld(t);
    assert.match(reason(await new SongSectionsService(undefined, never).read(withSong.store, PRODUCTION)), /unavailable on this host/);

    const long = await songWorld(t, { durationSec: EFFECT_ANALYSIS_PROFILE.maxSeconds + 1 });
    assert.match(reason(await new SongSectionsService(host, never).read(long.store, PRODUCTION)), /longer than the 30 minutes/);

    // The file replaced under its sidecar: what the Library names is not what would be measured.
    await writeFile(join(withSong.store.dir, "artifacts", withSong.song.file), "another recording");
    assert.match(reason(await new SongSectionsService(host, never).read(withSong.store, PRODUCTION)), /changed on disk/);
  });

  it("keeps the decoder's own words to itself, and measures on the next ask", async (t) => {
    const { store } = await songWorld(t);
    const { host, calls } = decoded(songPcm(), { failOnce: new Error("C:\\Users\\someone\\world\\artifacts\\the-song.mp3: Invalid data found") });
    const service = new SongSectionsService(host, never);
    assert.equal(reason(await service.read(store, PRODUCTION)), "The song could not be measured.");
    assert.equal(measuredSong(await service.read(store, PRODUCTION)).tempoBpm, 120, "a failure is not kept");
    assert.equal(calls.renders, 2);
  });

  it("stops with the world", async (t) => {
    const { store } = await songWorld(t);
    const { host } = decoded(songPcm());
    const stopping = new AbortController();
    const service = new SongSectionsService(host, stopping.signal);
    stopping.abort();
    assert.match(reason(await service.read(store, PRODUCTION)), /closed before the song was measured/);
    await service.stop();
  });
});

describe("song-sections, the Cut's ask (issue 3099)", () => {
  async function harness(t: TestContext) {
    const world = await songWorld(t);
    const service = new SongSectionsService(decoded(songPcm()).host, never);
    const events: DomainEvent[] = [];
    const failures: string[] = [];
    const ctx: CommandContext = {
      stopping: () => false, openStore: () => world.store, emit: (event) => { events.push(event); }, nowIso: () => "2026-11-15T09:00:00.000Z",
      refreshWorldSnapshot: async () => {}, fail: (command) => { failures.push(command); },
    };
    const module = productionCommands(ctx, {
      mediaProbe: null, runtimeStop: never, backgroundWork: new Set(), shownWorldId: () => WORLD_ID,
      scheduleProductionSpend: async () => {}, broadcastSnapshot: () => {}, worldOpensSettled: async () => {},
      worldChatRunner: () => { throw new Error("no World Chat here"); }, refreshConversations: async () => {},
      openWorldChat: async () => {}, stillOpen: () => true, worldChat: () => null, setWorldChat: () => {},
      songSections: (store, productionId) => service.read(store, productionId),
    });
    const router = new CommandRouter(ctx, [module]);
    const ask = async (worldId: string) => {
      const message: ClientMessage = { kind: "song-sections", worldId, productionId: PRODUCTION, requestId: ulid() };
      assert.equal(await router.dispatch(ClientMessageSchema.parse(message)), true);
      const answer = events.find((event) => event.type === "song.sections" && event.requestId === message.requestId);
      assert.ok(answer?.type === "song.sections", "answered under its request");
      return answer;
    };
    return { ...world, ask, failures };
  }

  it("answers with the song's tempo and proposed section starts, and writes nothing", async (t) => {
    const h = await harness(t);
    const answer = await h.ask(WORLD_ID);
    assert.equal(answer.productionId, PRODUCTION);
    const measured = measuredSong(answer.result);
    assert.equal(measured.tempoBpm, 120);
    assert.equal(measured.startsSec.length, 2);
    assert.equal(h.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!.spine!.revision, 1, "the spine has not moved");
    assert.deepEqual(h.failures, []);
  });

  it("answers a world that is not open rather than leaving the window waiting", async (t) => {
    const h = await harness(t);
    assert.match(reason((await h.ask(ulid())).result), /no longer open/);
    assert.deepEqual(h.failures, [], "its own answer, not a refusal on the toaster");
  });
});

describe("Arke reads the song beside the spine (issue 3099)", () => {
  const lease = () => new QueryLeaseRegistry(() => WORLD_ID).mint({ worldId: WORLD_ID, conversationId: newId("cv"), runId: newId("run") });
  type SongRow = { kind: string; trackArtifactId: string; durationSec: number | null; tempoBpm: number | null;
    sections: { status: string; count?: number; reason?: string; starts?: Array<{ label: string; atSec: number }> } };
  async function songRow(reads: WorldChatTargetReads, store: WorldStore) {
    const page = await reads.call(lease(), store.getBundle(), "get_spine", { productionId: PRODUCTION, limit: 20 });
    const rows = page.result.items as Array<{ kind: string }>;
    return { page, row: rows.find((row) => row.kind === "spine-song") as SongRow | undefined };
  }

  it("gives the length, the tempo and the proposed starts, said to be proposals and without names", async (t) => {
    const { store, song } = await songWorld(t);
    const service = new SongSectionsService(decoded(songPcm()).host, never);
    const reads = new WorldChatTargetReads({ getSongSections: (productionId) => service.read(store, productionId) });
    const { page, row } = await songRow(reads, store);
    assert.ok(row);
    assert.equal(row.trackArtifactId, song.id);
    assert.equal(row.durationSec, SECONDS + 0.02);
    assert.equal(row.tempoBpm, 120);
    assert.equal(row.sections.status, "proposed");
    assert.deepEqual(row.sections.starts!.map((start) => start.label), ["Section 1", "Section 2"]);
    assert.equal(row.sections.starts![0]!.atSec, 0);
    assert.doesNotMatch(JSON.stringify(row), /verse|chorus|bridge/i);
    // The measure is the read's, never the fence's: a card prepared before it arrived still applies.
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION);
    assert.equal(page.result.observedRevisionOrDigest, spineFence(production, store.getBundle().artifacts));
    const unmeasured = await songRow(new WorldChatTargetReads(), store);
    assert.equal(unmeasured.page.result.observedRevisionOrDigest, page.result.observedRevisionOrDigest);
  });

  it("points at the spine's own markers once sections are marked", async (t) => {
    const { store } = await songWorld(t);
    const service = new SongSectionsService(decoded(songPcm()).host, never);
    const markers: SpineMarker[] = ["Intro", "Verse 1"].map((label, index) => ({ kind: "section", id: `mk_${ulid()}`, label, atSec: index * 16, source: "json" }));
    await applyProductionSpineCommand(store, { productionId: PRODUCTION, baseRevision: 1, command: { kind: "import-markers", format: "json", markers } }, { source: "test" });
    const { row } = await songRow(new WorldChatTargetReads({ getSongSections: (productionId) => service.read(store, productionId) }), store);
    assert.deepEqual(row?.sections, { status: "marked", count: 2 });
    assert.equal(row?.tempoBpm, 120, "the tempo is still the song's");
  });

  it("still gives the song's length where it cannot be measured, and no song row without a song", async (t) => {
    const { store } = await songWorld(t);
    const { row } = await songRow(new WorldChatTargetReads({ getSongSections: async () => ({ status: "unavailable", reason: "Audio analysis is unavailable on this host." }) }), store);
    assert.equal(row?.durationSec, SECONDS + 0.02);
    assert.equal(row?.tempoBpm, null);
    assert.deepEqual(row?.sections, { status: "not-measured", reason: "Audio analysis is unavailable on this host." });

    const bare = await songWorld(t, { spine: false });
    let asked = 0;
    const none = await songRow(new WorldChatTargetReads({ getSongSections: async () => { asked++; return { status: "unavailable", reason: "x" }; } }), bare.store);
    assert.equal(none.row, undefined);
    assert.equal(asked, 0, "nothing is measured for a production with no song");
  });
});

/*
 * The real decoder, where one is installed: the song alone as a one-sound film is this file's
 * own use of the effects' host, so it is run once through FFmpeg and not only through a stand-in.
 */
const ffmpeg = process.env["ARKE_FFMPEG"] ?? "ffmpeg";
const media = createNodeMediaProcessRunner({ ffmpeg, ffprobe: process.env["ARKE_FFPROBE"] ?? "ffprobe" });
const version = await media.run("ffmpeg", ["-version"], { signal: never, timeoutMs: 10000, maxStdoutBytes: 65536, maxStderrBytes: 16384 });

it("measures a sound file through the installed decoder", { skip: version.code !== 0 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "arke-song-sections-"));
  try {
    const path = join(dir, "song.wav");
    // A kick every half second over a held tone, quiet for twenty seconds and loud for twenty.
    const made = await media.run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      "aevalsrc=(0.08+0.52*gte(t\\,20))*sin(2*PI*60*mod(t\\,0.5))*exp(-12*mod(t\\,0.5))+(0.03+0.17*gte(t\\,20))*sin(2*PI*440*t):s=44100:d=40",
      "-c:a", "pcm_s16le", path], { signal: never, timeoutMs: 30000, maxStdoutBytes: 1024, maxStderrBytes: 16384 });
    assert.equal(made.code, 0, made.stderr);
    const found = await measureSong(createNodeEffectAudioAnalysisHost({ ffmpeg }), { absolutePath: path, durationSec: 40, signal: never });
    assert.equal(found.tempoBpm, 120);
    assert.equal(found.startsSec.length, 2, `sections at ${found.startsSec.join(", ")}`);
    assert.ok(Math.abs(found.startsSec[1]! - 20) <= 1, `the change at 20s, found ${found.startsSec[1]}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

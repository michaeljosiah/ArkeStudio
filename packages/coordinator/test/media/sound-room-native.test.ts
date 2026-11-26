import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCanonicalAudioGraph, buildRenderPlan, DEFAULT_MIX, newId, ProductionTimelineSchema, ROOM, storyTimelineFingerprint,
  type ExportPlan, type RenderAudioItem, type TimelineCommand } from "@arke-studio/contracts";
import { createAgentMediaTools } from "../../src/media/agent-media-tools.js";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-host.js";
import { applyHumanTimelineCommand } from "../../src/productions/timeline.js";
import { measureTimelineSound } from "../../src/productions/timeline-sound.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup, tempDir } from "../tmp.js";

/**
 * A room laid from real sound, heard in the export (SPEC-038 R-61..R-63). Three beds of the same
 * kind of noise at three different levels, one of them in a single channel: measured by the real
 * decoder, laid by the reducer, planned, and mixed by the export's graph. What comes out has to
 * be one room: at the loudness asked for, and at one level from its first join to its last,
 * whichever bed is playing.
 */

const ffmpeg = process.env["ARKE_FFMPEG"] ?? "ffmpeg";
const media = createNodeMediaProcessRunner({ ffmpeg, ffprobe: process.env["ARKE_FFPROBE"] ?? "ffprobe" }), tools = createAgentMediaTools(media);
const signal = () => new AbortController().signal;
const version = await media.run("ffmpeg", ["-version"], { signal: signal(), timeoutMs: 10000, maxStdoutBytes: 65536, maxStderrBytes: 16384 });
const available = version.code === 0;

async function run(args: string[]): Promise<Uint8Array> {
  const result = await media.run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], {
    signal: signal(), timeoutMs: 60000, maxStdoutBytes: 32 * 1024 * 1024, maxStderrBytes: 16384,
  });
  assert.equal(result.code, 0, result.stderr); return result.stdout;
}

const RATE = 48000, PRODUCTION = "saltlight", AT = "2026-11-26T12:00:00.000Z";
type Mix = Pick<ExportPlan, "audio" | "mix" | "speech" | "totalSec">;

test("a room laid from three beds plays at the loudness asked for and at one level through every join, on one layer and on two", { skip: !available }, async () => {
  const dir = await tempDir("arke-sound-room-");
  // The same kind of noise at three levels, 14 dB apart end to end, and the middle one in one channel.
  const beds = [{ name: "crowd", amplitude: 0.08, seed: 1, seconds: 20, channels: 2 }, { name: "bar", amplitude: 0.4, seed: 2, seconds: 14, channels: 1 }, { name: "hall", amplitude: 0.18, seed: 3, seconds: 25, channels: 2 }]
    .map(bed => ({ ...bed, id: newId("ar"), path: join(dir, `${bed.name}.wav`) }));
  for (const bed of beds) await run(["-y", "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=${bed.amplitude}:seed=${bed.seed}:r=${RATE}:d=${bed.seconds}`, "-ac", String(bed.channels), "-c:a", "pcm_s16le", bed.path]);
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => AT }); closeOnCleanup(() => store.close());
  const files = [];
  for (const bed of beds) {
    const bytes = await readFile(bed.path);
    files.push({ path: `artifacts/${bed.name}.wav`, action: "create" as const, baseHash: null, encoding: "base64" as const, content: bytes.toString("base64") },
      { path: `artifacts/${bed.name}.json`, action: "create" as const, baseHash: null, content: JSON.stringify({ id: bed.id, kind: "audio", file: `${bed.name}.wav`,
        hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, links: [], origin: { by: "user" }, created: AT }) });
  }
  await store.commit({ kind: "media-fixture", source: "test", files });
  const production = () => store.getBundle().productions.find(value => value.meta.id === PRODUCTION)!, still = store.getBundle().artifacts.find(value => value.kind === "board")!;
  const read = async () => ProductionTimelineSchema.parse(JSON.parse(await readFile(join(store.dir, "productions", PRODUCTION, "timeline.json"), "utf8")));
  const send = async (commands: TimelineCommand[], first = false) => applyHumanTimelineCommand(store, PRODUCTION, { kind: "commands", baseRevision: first ? null : (await read()).revision,
    sourceFingerprint: storyTimelineFingerprint(production()), commands });
  await send([{ kind: "place", trackId: "tr_picture", clip: { id: "cl_still", startFrame: 0, durationFrames: 2400, sourceInFrames: 0, source: { kind: "artifact", artifactId: still.id, label: "Still" } } }], true);
  const rate = (await read()).frameRate, sources = beds.map(bed => ({ artifactId: bed.id, label: bed.name }));

  // Two rooms on the one film: one layer from 2 s for 36 s, then two layers from 44 s for 36 s, each asked for at -30 LUFS.
  const rooms = [{ clipId: "cl_one", trackIds: ["tr_a1", "tr_a2"], startSec: 2 }, { clipId: "cl_two", trackIds: ["tr_b1", "tr_b2", "tr_b3", "tr_b4"], startSec: 44 }] as const;
  for (const [index, room] of rooms.entries()) {
    const measured = await measureTimelineSound(store, PRODUCTION, [{ kind: "lay-room", clipId: room.clipId, trackIds: [...room.trackIds], sources,
      startFrame: room.startSec * rate, durationFrames: 36 * rate, lufs: -30, seed: 20261126 + index } as TimelineCommand], tools, signal());
    const laid = measured[0]!.kind === "lay-room" ? measured[0]! : assert.fail("a room");
    // The one-channel bed is measured as a film plays it: 3 LU over what its own file reads.
    const bar = laid.sources.find(source => source.label === "bar")!, file = await tools.probe(beds[1]!.path, signal());
    const own = (await tools.loudness!(beds[1]!.path, file.streams[0]!, 0, 14, signal())).integratedLufs!;
    assert.ok(Math.abs(bar.measuredLufs! - own - 3) <= 0.15, `the one-channel bed measures ${bar.measuredLufs} LUFS for the film, ${own} in its own file`);
    assert.deepEqual(laid.sources.map(source => source.outSec), [20, 14, 25]);
    await send(measured);
  }

  const planned = buildRenderPlan({ production: production(), artifacts: store.getBundle().artifacts, timeline: { status: "ready", timeline: await read() }, scope: { kind: "production" }, preset: "review-cut" });
  if (!planned.ok) assert.fail(planned.reason);
  const mix = { ...DEFAULT_MIX }, total = planned.plan.totalSec;
  for (const room of rooms) {
    const audio: RenderAudioItem[] = planned.plan.audio.filter(item => item.clipId?.startsWith(`${room.clipId}-`)), layers = room.trackIds.length / 2;
    assert.ok(audio.length >= 4 * layers, `${audio.length} pieces`);
    assert.ok(audio.every(item => item.ducks === false && item.fadeIn?.power === true && item.fadeOut?.power === true));
    const plan: Mix = { audio, totalSec: total, mix, speech: [] }, graph = buildCanonicalAudioGraph(plan, audio.map(item => join(store.dir, item.path)));
    graph.filters[graph.filters.length - 1] = `${graph.preLimiter}[aout]`;
    const out = join(dir, `${room.clipId}.wav`);
    await run(["-y", ...graph.args, "-filter_complex", graph.filters.join(";"), "-map", "[aout]", "-ar", String(RATE), "-c:a", "pcm_s16le", out]);
    // Past the room's own fade in (and the second layer's, which comes in later), to before its fade out.
    const from = room.startSec + (layers === 2 ? ROOM.secondLayerOffsetSec : 0) + ROOM.crossSec + 0.3, to = room.startSec + 36 - ROOM.crossSec - 0.3;
    const stream = (await tools.probe(out, signal())).streams.find(value => value.kind === "audio")!;
    const loud = (await tools.loudness!(out, stream, from, to, signal())).integratedLufs!;
    assert.ok(Math.abs(loud + 30) <= 1, `the room on ${layers} layer(s) plays at ${loud} LUFS, asked for -30`);
    // One level throughout: a second at a time, the loudest second and the quietest are within 3 dB, whichever bed and whichever join.
    const bytes = await run(["-i", out, "-ac", "1", "-ar", String(RATE), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]);
    const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), levels: number[] = [];
    for (let sec = from; sec + 1 <= to; sec += 0.5) {
      let sum = 0;
      for (let i = Math.round(sec * RATE); i < Math.round((sec + 1) * RATE); i++) sum += samples[i]! * samples[i]!;
      levels.push(10 * Math.log10(sum / RATE));
    }
    const spread = Math.max(...levels) - Math.min(...levels);
    assert.ok(spread <= 3, `the room on ${layers} layer(s) moves ${spread.toFixed(2)} dB between its loudest second and its quietest`);
    // And it is silent before it starts and after it ends: nothing was laid outside what was asked.
    const edge = (sec: number) => { let sum = 0; for (let i = Math.round(sec * RATE); i < Math.round((sec + 0.5) * RATE); i++) sum += samples[i]! * samples[i]!; return sum; };
    assert.equal(edge(room.startSec - 0.6), 0); assert.equal(edge(room.startSec + 36 + 0.1), 0);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioLevelAt, buildCanonicalAudioGraph, DEFAULT_MIX, type ExportPlan, type RenderAudioItem } from "@arke-studio/contracts";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-host.js";

/**
 * The export's graph plays a held track and an even-power fade at the level the plan states
 * (SPEC-038 R-53, R-54, R-42). As `sound-fade-native.test.ts` does for a straight fade, this runs
 * the graph: steady tones through `buildCanonicalAudioGraph`, measured in short windows and
 * compared with `audioLevelAt`, the function the browser sets its gain to. And it measures the
 * thing the shape is for: two sounds crossing keep one loudness, where two straight lines dip.
 */

const ffmpeg = process.env["ARKE_FFMPEG"] ?? "ffmpeg";
const media = createNodeMediaProcessRunner({ ffmpeg, ffprobe: process.env["ARKE_FFPROBE"] ?? "ffprobe" });
const signal = () => new AbortController().signal;
const version = await media.run("ffmpeg", ["-version"], { signal: signal(), timeoutMs: 10000, maxStdoutBytes: 65536, maxStderrBytes: 16384 });
const available = version.code === 0;

async function run(args: string[]): Promise<Uint8Array> {
  const result = await media.run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], {
    signal: signal(), timeoutMs: 30000, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 16384,
  });
  assert.equal(result.code, 0, result.stderr); return result.stdout;
}

const RATE = 48000, TONE = 0.5, HEARD = TONE / Math.SQRT2;
type Mix = Pick<ExportPlan, "audio" | "mix" | "speech" | "totalSec">;

/** The mix's left channel, read before the limiter, which is transparent here and delays what it passes. */
async function heard(plan: Mix): Promise<Float32Array> {
  const graph = buildCanonicalAudioGraph(plan, plan.audio.map(clip => clip.path));
  graph.filters[graph.filters.length - 1] = `${graph.preLimiter}[aout]`;
  const bytes = await run([...graph.args, "-filter_complex", graph.filters.join(";"), "-map", "[aout]", "-ar", String(RATE), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]);
  const both = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return both.filter((_, index) => index % 2 === 0);
}

/** A fiftieth of a second around `sec`: whole cycles of the 400 Hz and the 600 Hz tone, so a steady level measures exactly and the two add as powers. */
function rms(samples: Float32Array, sec: number): number {
  const from = Math.round(sec * RATE) - 480, window = samples.slice(Math.max(0, from), from + 960);
  return Math.sqrt(window.reduce((sum, value) => sum + value * value, 0) / 960);
}

test("the export holds a track under speech, draws an even-power fade at the plan's level, and two sounds crossing keep one loudness", { skip: !available }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "arke-sound-levels-"));
  try {
    const low = join(dir, "low.wav"), high = join(dir, "high.wav");
    await run(["-y", "-f", "lavfi", "-i", `aevalsrc=${TONE}*sin(2*PI*400*t):s=${RATE}:d=6`, "-c:a", "pcm_f32le", low]);
    await run(["-y", "-f", "lavfi", "-i", `aevalsrc=${TONE}*sin(2*PI*600*t):s=${RATE}:d=6`, "-c:a", "pcm_f32le", high]);
    const mix = { ...DEFAULT_MIX }, speech = [{ startSec: 1, endSec: 2 }];

    // The room's music on a track that holds, and score on one that does not, under the same line.
    const held: RenderAudioItem = { path: low, clipId: "cl_room", startSec: 0, endSec: 4, gainDb: -6, role: "music", ducks: false, sourceInSec: 0 };
    const score: RenderAudioItem = { path: low, clipId: "cl_score", startSec: 0, endSec: 4, gainDb: -6, role: "music", sourceInSec: 0 };
    const room = await heard({ audio: [held], totalSec: 4, mix, speech }), scored = await heard({ audio: [score], totalSec: 4, mix, speech });
    for (const sec of [0.5, 1.5, 2.2, 3.5]) {
      const want = HEARD * audioLevelAt({ mix, speech }, held, sec), got = rms(room, sec);
      assert.ok(Math.abs(got - want) <= want * 0.02, `the held track at ${sec}s plays ${got.toFixed(5)}, the plan says ${want.toFixed(5)}`);
    }
    assert.ok(Math.abs(rms(room, 1.5) / HEARD - Math.pow(10, -6 / 20)) < 0.01, "under the line it is at its own gain");
    assert.ok(Math.abs(rms(scored, 1.5) / HEARD - Math.pow(10, -15 / 20)) < 0.01, "and score beside it is 9 dB down");

    // An even-power fade, measured through its curve.
    const faded: RenderAudioItem = { path: low, clipId: "cl_bed", startSec: 0.5, endSec: 3.5, gainDb: 0, role: "unspecified", sourceInSec: 0,
      fadeIn: { startSec: 0.5, durationSec: 1, power: true }, fadeOut: { startSec: 2.3, durationSec: 1.2, power: true } };
    const film = await heard({ audio: [faded], totalSec: 4, mix, speech: [] });
    assert.equal(film.length, 4 * RATE, "the shape changes no length");
    for (const sec of [0.6, 0.75, 1, 1.25, 2, 2.5, 2.9, 3.3, 3.45]) {
      const want = HEARD * audioLevelAt({ mix, speech: [] }, faded, sec), got = rms(film, sec);
      assert.ok(Math.abs(got - want) <= want * 0.025 + 0.0005, `at ${sec}s the export plays ${got.toFixed(5)}, the plan says ${want.toFixed(5)}`);
    }
    assert.ok(Math.abs(rms(film, 1) / HEARD - Math.SQRT1_2) < 0.01, "halfway up, an even-power fade is at 0.707 of its level, not at half");

    // Two pieces of a room crossing over 1.2 s: one going out, another coming in under it.
    const crossing = (power: boolean): RenderAudioItem[] => [
      { path: low, clipId: "cl_a", startSec: 0, endSec: 3.2, gainDb: 0, role: "ambience", ducks: false, sourceInSec: 0, fadeOut: { startSec: 2, durationSec: 1.2, ...(power ? { power: true as const } : {}) } },
      { path: high, clipId: "cl_b", startSec: 2, endSec: 5, gainDb: 0, role: "ambience", ducks: false, sourceInSec: 0, fadeIn: { startSec: 2, durationSec: 1.2, ...(power ? { power: true as const } : {}) } },
    ];
    const even = await heard({ audio: crossing(true), totalSec: 5, mix, speech: [] }), straight = await heard({ audio: crossing(false), totalSec: 5, mix, speech: [] });
    for (const sec of [1, 2.2, 2.4, 2.6, 2.8, 3, 4]) {
      assert.ok(Math.abs(20 * Math.log10(rms(even, sec) / HEARD)) < 0.2, `an even-power crossing is ${(20 * Math.log10(rms(even, sec) / HEARD)).toFixed(2)} dB from the room's level at ${sec}s`);
    }
    const dip = 20 * Math.log10(rms(straight, 2.6) / HEARD);
    assert.ok(dip < -2.8 && dip > -3.2, `two straight lines dip ${dip.toFixed(2)} dB at the middle`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioLevelAt, buildCanonicalAudioGraph, DEFAULT_MIX, type ExportPlan, type RenderAudioItem } from "@arke-studio/contracts";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-host.js";

/**
 * The export's graph plays a fade at the level the plan states (SPEC-038 R-37, R-38, R-42).
 *
 * The contracts tests hold the graph's text and the plan's function to each other on paper. This
 * runs the graph: a steady tone through `buildCanonicalAudioGraph`, measured in short windows and
 * compared with `audioLevelAt`, the function the browser sets its gain to. It is how a filter
 * FFmpeg does not accept, or a slope a frame late, would show before a film did.
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

/** The mix as mono samples. Levels are read before the limiter, which is transparent here and delays what it passes. */
async function heard(plan: Mix, limited = false): Promise<Float32Array> {
  const graph = buildCanonicalAudioGraph(plan, plan.audio.map(clip => clip.path));
  if (!limited) graph.filters[graph.filters.length - 1] = `${graph.preLimiter}[aout]`;
  const bytes = await run([...graph.args, "-filter_complex", graph.filters.join(";"), "-map", "[aout]", "-ac", "1", "-ar", String(RATE), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Eight whole cycles of the 400 Hz tone around `sec`, so a steady level measures exactly. */
function rms(samples: Float32Array, sec: number): number {
  const from = Math.round(sec * RATE) - 480, window = samples.slice(Math.max(0, from), from + 960);
  return Math.sqrt(window.reduce((sum, value) => sum + value * value, 0) / 960);
}

test("the export plays a fade at the plan's level, with gain and ducking on top, in the whole film and in a part of it", { skip: !available }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "arke-sound-fade-"));
  try {
    const path = join(dir, "tone.wav");
    // Mono, so nothing between the graph and the measurement remixes channels and rescales the level.
    await run(["-y", "-f", "lavfi", "-i", `aevalsrc=${TONE}*sin(2*PI*400*t):s=${RATE}:d=4`, "-c:a", "pcm_f32le", path]);
    // A bed from 0.5s to 3.5s at -6 dB: a second up, a second and a half down, a line spoken over the end of the fade in.
    const bed: RenderAudioItem = { path, clipId: "cl_bed", startSec: 0.5, endSec: 3.5, gainDb: -6, role: "music", sourceInSec: 0,
      fadeIn: { startSec: 0.5, durationSec: 1 }, fadeOut: { startSec: 2, durationSec: 1.5 } };
    const whole = { audio: [bed], totalSec: 4, mix: { ...DEFAULT_MIX }, speech: [{ startSec: 1.2, endSec: 1.7 }] };
    const film = await heard(whole);
    // The film is as long as it was, through the limiter and beside an unfaded clip too. A graph
    // that regrouped a faded clip's samples twice came out 3.54 seconds long here.
    assert.equal(film.length, 4 * RATE, "a fade changes no length");
    assert.equal((await heard(whole, true)).length, 4 * RATE, "nor does the limiter after it");
    const line: RenderAudioItem = { path, clipId: "cl_line", startSec: 1.2, endSec: 1.7, gainDb: 0, role: "dialogue", sourceInSec: 0 };
    assert.equal((await heard({ ...whole, audio: [bed, line, { ...bed, clipId: "cl_bed2", startSec: 0, endSec: 1, fadeIn: undefined, fadeOut: { startSec: 0.5, durationSec: 0.5 } }] }, true)).length, 4 * RATE, "nor a mix of faded and unfaded clips");
    const expected = (sec: number) => (sec >= bed.startSec && sec < bed.endSec ? HEARD * audioLevelAt(whole, bed, sec) : 0);
    const moments = [0.25, 0.6, 0.75, 1, 1.4, 1.6, 2.4, 2.75, 3.2, 3.45, 3.75];
    for (const sec of moments) {
      const want = expected(sec), got = rms(film, sec);
      assert.ok(Math.abs(got - want) <= want * 0.02 + 0.0005, `at ${sec}s the export plays ${got.toFixed(5)}, the plan says ${want.toFixed(5)}`);
    }
    assert.ok(rms(film, 0.75) < rms(film, 1) && rms(film, 2.75) > rms(film, 3.2), "the level moves through each fade");
    assert.ok(Math.abs(rms(film, 1.4) / HEARD - Math.pow(10, -15 / 20) * 0.9) < 0.01, "ducked 9 dB and nine tenths up the fade at once");

    // An episode that opens a second in: the same clip, cut at the window and moved onto its clock.
    const cut: RenderAudioItem = { ...bed, startSec: 0, endSec: 2.5, sourceInSec: 0.5, fadeIn: { startSec: -0.5, durationSec: 1 }, fadeOut: { startSec: 1, durationSec: 1.5 } };
    const part = await heard({ audio: [cut], totalSec: 3, mix: whole.mix, speech: [{ startSec: 0.2, endSec: 0.7 }] });
    for (const sec of [0.1, 0.4, 0.6, 1.4, 1.75, 2.2, 2.45]) {
      const want = rms(film, sec + 1), got = rms(part, sec);
      assert.ok(Math.abs(got - want) <= want * 0.02 + 0.0005, `${sec}s into the part plays ${got.toFixed(5)}; the whole film plays ${want.toFixed(5)} there`);
    }
    assert.ok(rms(part, 0.1) > HEARD * 0.1, "the part opens partway up the fade, not at silence");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { buildCanonicalAudioGraph, DEFAULT_MIX, type ExportPlan, type RenderAudioItem } from "@arke-studio/contracts";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-host.js";
import { tempDir } from "../tmp.js";

/**
 * The export plays a clip's sound where the cut puts it (SPEC-038 R-19), whatever file it is cut
 * from. This runs the graph on the one kind of source that broke it: a take's own file, picture
 * and sound together, with the clip starting partway in. Its first sound reaches the chain late,
 * `adelay` answered for it with silence that carried no timestamps, and the film's closing trim
 * dropped that silence. A film whose only sound was one such clip played it from the first frame
 * and ended early; a film with two of them and nothing at its start came out a second long and
 * silent. Sounds cut from a sound-only file were never moved, and are held to the sample here.
 */

const ffmpeg = process.env["ARKE_FFMPEG"] ?? "ffmpeg";
const media = createNodeMediaProcessRunner({ ffmpeg, ffprobe: process.env["ARKE_FFPROBE"] ?? "ffprobe" });
const signal = () => new AbortController().signal;
const version = await media.run("ffmpeg", ["-version"], { signal: signal(), timeoutMs: 10000, maxStdoutBytes: 65536, maxStderrBytes: 16384 });
const available = version.code === 0;

async function run(args: string[]): Promise<Uint8Array> {
  const result = await media.run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], {
    signal: signal(), timeoutMs: 60000, maxStdoutBytes: 16 * 1024 * 1024, maxStderrBytes: 16384,
  });
  assert.equal(result.code, 0, result.stderr); return result.stdout;
}

const RATE = 48000;
type Mix = Pick<ExportPlan, "audio" | "mix" | "speech" | "totalSec">;

/** The film's sound as the export makes it, left channel. `limited: false` reads it before the limiter, which delays what it passes by its attack. */
async function film(plan: Mix, limited = true): Promise<Float32Array> {
  const graph = buildCanonicalAudioGraph(plan, plan.audio.map(clip => clip.path));
  if (!limited) graph.filters[graph.filters.length - 1] = `${graph.preLimiter}[aout]`;
  const bytes = await run([...graph.args, "-filter_complex", graph.filters.join(";"), "-map", "[aout]", "-ar", String(RATE), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]);
  const both = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return both.filter((_, index) => index % 2 === 0);
}

/** Where the film is not silent, as [from, to] seconds, read a hundredth of a second at a time. */
function heard(samples: Float32Array): Array<[number, number]> {
  const step = RATE / 100, out: Array<[number, number]> = [];
  for (let s = 0; s * step < samples.length; s++) {
    let sum = 0;
    for (let i = s * step; i < Math.min(samples.length, (s + 1) * step); i++) sum += samples[i]! * samples[i]!;
    if (Math.sqrt(sum / step) < 0.003) continue;
    const last = out[out.length - 1];
    if (last && s - last[1] * 100 <= 1) last[1] = (s + 1) / 100; else out.push([s / 100, (s + 1) / 100]);
  }
  return out;
}

const clip = (path: string, id: string, startSec: number, endSec: number, sourceInSec: number): RenderAudioItem =>
  ({ path, clipId: `cl_${id}`, startSec, endSec, gainDb: -6, role: "dialogue", sourceInSec });

test("the export plays a clip cut from partway into a take's own file where the cut puts it, alone or with others, and the film keeps its length", { skip: !available }, async () => {
  const dir = await tempDir("arke-sound-placement-"), take = join(dir, "take.mp4");
  // A take as a generator delivers one: picture and a tone, twelve seconds, in one file.
  await run(["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=12",
    "-c:v", "mpeg4", "-q:v", "5", "-g", "60", "-c:a", "aac", "-b:a", "128k", take]);
  const mix = { ...DEFAULT_MIX };
  const films: Array<[string, RenderAudioItem[], Array<[number, number]>]> = [
    ["one clip, from 3 s in, at 2 s", [clip(take, "a", 2, 3.5, 3)], [[2, 3.5]]],
    ["one clip, from the take's start, at 2 s", [clip(take, "a", 2, 3.5, 0)], [[2, 3.5]]],
    ["two clips, from 3 s and 6 s in, at 1 s and 4 s", [clip(take, "a", 1, 2, 3), clip(take, "b", 4, 5, 6)], [[1, 2], [4, 5]]],
    ["three clips, the first at the film's start", [clip(take, "a", 0, 1, 1), clip(take, "b", 2.5, 3.5, 4), clip(take, "c", 6, 7, 8)], [[0, 1], [2.5, 3.5], [6, 7]]],
    ["two clips that overlap", [clip(take, "a", 1, 3, 2), clip(take, "b", 1.5, 2.5, 5)], [[1, 3]]],
  ];
  for (const [name, audio, planned] of films) {
    const totalSec = Math.max(...audio.map(item => item.endSec)) + 1.5, sound = await film({ audio, totalSec, mix, speech: [] }), spans = heard(sound);
    assert.equal(sound.length, Math.round(totalSec * RATE), `${name}: the film's sound is the film's length`);
    assert.equal(spans.length, planned.length, `${name}: heard at ${JSON.stringify(spans)}, placed at ${JSON.stringify(planned)}`);
    for (const [index, [from, to]] of planned.entries()) {
      assert.ok(Math.abs(spans[index]![0] - from) <= 0.03 && Math.abs(spans[index]![1] - to) <= 0.03, `${name}: heard at ${JSON.stringify(spans)}, placed at ${JSON.stringify(planned)}`);
    }
  }
});

test("a sound cut from a sound-only file starts on the sample the cut names, as it always did", { skip: !available }, async () => {
  const dir = await tempDir("arke-sound-placement-"), tone = join(dir, "tone.wav");
  await run(["-y", "-f", "lavfi", "-i", `aevalsrc=0.5*cos(2*PI*400*t):s=${RATE}:d=8`, "-c:a", "pcm_f32le", tone]);
  const mix = { ...DEFAULT_MIX }, first = (samples: Float32Array) => samples.findIndex(value => Math.abs(value) > 0.01);
  // From the file's start and from two seconds into it, each placed 2.5 s into a film, alone and together.
  for (const [name, audio] of [["from its start", [clip(tone, "a", 2.5, 4, 0)]], ["from 2 s in", [clip(tone, "a", 2.5, 4, 2)]],
    ["two of them", [clip(tone, "a", 2.5, 4, 2), clip(tone, "b", 5, 6, 3)]]] as Array<[string, RenderAudioItem[]]>) {
    const totalSec = 7.5, sound = await film({ audio, totalSec, mix, speech: [] }, false);
    assert.equal(sound.length, totalSec * RATE, name);
    assert.equal(first(sound), 2.5 * RATE, `${name}: the first sample that sounds is the one at 2.5 s`);
    assert.ok(Math.abs(sound[4 * RATE - 1]!) > 0.01 && Math.abs(sound[4 * RATE + 1]!) < 1e-6, `${name}: and it stops on the sample at 4 s`);
  }
});

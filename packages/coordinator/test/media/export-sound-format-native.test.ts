import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCanonicalAudioGraph, DEFAULT_MIX, type RenderAudioItem } from "@arke-studio/contracts";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-host.js";

/**
 * A film is mixed at 48 kHz in two channels whatever its first sound is (SPEC-038 R-51).
 *
 * The film this was found on had a voice take first on its first sound track: 24 kHz, one channel.
 * FFmpeg's mixer took that as the format of the whole mix, and the music came out with nothing
 * above 12 kHz and no stereo. The contracts test holds the graph's text; this runs it, with a
 * voice like that first and a bed whose only content a 24 kHz mono mix cannot hold: a tone at
 * 15 kHz, on the left alone.
 */

const ffmpeg = process.env["ARKE_FFMPEG"] ?? "ffmpeg";
const media = createNodeMediaProcessRunner({ ffmpeg, ffprobe: process.env["ARKE_FFPROBE"] ?? "ffprobe" });
const signal = () => new AbortController().signal;
const version = await media.run("ffmpeg", ["-version"], { signal: signal(), timeoutMs: 10000, maxStdoutBytes: 65536, maxStderrBytes: 16384 });
const available = version.code === 0;

async function run(tool: "ffmpeg" | "ffprobe", args: string[]): Promise<Uint8Array> {
  const result = await media.run(tool, tool === "ffmpeg" ? ["-hide_banner", "-nostdin", "-loglevel", "error", ...args] : args, {
    signal: signal(), timeoutMs: 30000, maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 16384,
  });
  assert.equal(result.code, 0, result.stderr); return result.stdout;
}

/** How much of one frequency a run of samples holds, as the amplitude of a sine at it. */
function amplitudeAt(samples: Float32Array, hz: number, rate: number): number {
  let re = 0, im = 0;
  for (let n = 0; n < samples.length; n++) { const phase = 2 * Math.PI * hz * n / rate; re += samples[n]! * Math.cos(phase); im += samples[n]! * Math.sin(phase); }
  return 2 * Math.hypot(re, im) / samples.length;
}

test("a film whose first sound is a 24 kHz voice in one channel is mixed at 48 kHz in two", { skip: !available }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "arke-sound-format-"));
  try {
    const voice = join(dir, "voice.wav"), bed = join(dir, "bed.wav"), film = join(dir, "film.wav");
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*300*t):s=24000:d=2", "-c:a", "pcm_s16le", voice]);
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*15000*t)|0:s=48000:d=2", "-c:a", "pcm_s16le", bed]);
    // The voice is first, as it was on the film: the order of the inputs is what decided the mix.
    const audio: RenderAudioItem[] = [
      { path: voice, clipId: "cl_voice", startSec: 0, endSec: 2, gainDb: 0, role: "dialogue", sourceInSec: 0 },
      { path: bed, clipId: "cl_bed", startSec: 0, endSec: 2, gainDb: 0, role: "music", sourceInSec: 0 },
    ];
    const graph = buildCanonicalAudioGraph({ audio, totalSec: 2, mix: { ...DEFAULT_MIX, speechFirst: false }, speech: [] }, audio.map(clip => clip.path));
    // No rate and no channel count asked of the output: the file holds what the graph made, as an export's does.
    await run("ffmpeg", ["-y", ...graph.args, "-filter_complex", graph.filters.join(";"), "-map", "[aout]", "-c:a", "pcm_f32le", film]);
    const format = new TextDecoder().decode(await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", film])).trim();
    assert.equal(format, "48000,2", "the film's sound is 48 kHz in two channels");

    const bytes = await run("ffmpeg", ["-i", film, "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"]);
    const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    // The middle second, clear of the limiter's first moments.
    const left = new Float32Array(48000), right = new Float32Array(48000);
    for (let n = 0; n < 48000; n++) { left[n] = samples[(24000 + n) * 2]!; right[n] = samples[(24000 + n) * 2 + 1]!; }
    const high = amplitudeAt(left, 15000, 48000);
    assert.ok(high > 0.2, `the bed's 15 kHz tone is still in the film: ${high.toFixed(4)} of 0.25`);
    assert.ok(amplitudeAt(right, 15000, 48000) < high * 0.02, "and still on the left alone");
    // The one-channel voice is in both channels at the level it was recorded at, as the Viewer plays it;
    // a plain conversion to stereo would put it 3 dB down in each (0.177).
    const voiceLeft = amplitudeAt(left, 300, 48000), voiceRight = amplitudeAt(right, 300, 48000);
    assert.ok(Math.abs(voiceLeft - 0.25) < 0.005 && Math.abs(voiceRight - 0.25) < 0.005, `the voice is whole in both channels: ${voiceLeft.toFixed(4)} left, ${voiceRight.toFixed(4)} right`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

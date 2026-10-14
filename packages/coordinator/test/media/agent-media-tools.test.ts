import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createAgentMediaTools, parseAgentMediaProbe } from "../../src/media/agent-media-tools.js";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-process.js";
import { decodePng } from "../../src/references/png.js";
import { tempDir } from "../tmp.js";
import { readSpeechWav } from "../../src/audio/speech-wav.js";
import { decodeWav } from "@arke-studio/voice";
const signal = () => new AbortController().signal;
const runner = createNodeMediaProcessRunner({ ffmpeg: process.env["ARKE_FFMPEG"] ?? "ffmpeg", ffprobe: process.env["ARKE_FFPROBE"] ?? "ffprobe" });
const version = await runner.run("ffmpeg", ["-version"], { signal: signal(), timeoutMs: 10000, maxStdoutBytes: 65536, maxStderrBytes: 16384 });
const available = version.code === 0;
if (process.env["ARKE_AGENT_MEDIA_NATIVE_REQUIRED"] === "1") assert.ok(available, "Agent media acceptance requires FFmpeg");
const tools = createAgentMediaTools(runner);
async function generate(args: string[]) {
  const result = await runner.run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], { signal: signal(), timeoutMs: 20000, maxStdoutBytes: 65536, maxStderrBytes: 65536 });
  assert.equal(result.code, 0, result.stderr);
}
test("probe output is a whitelist with no tags, path or title and refuses excessive streams", () => {
  const probe = { format: { duration: "2.5", filename: "PRIVATE", tags: { title: "PRIVATE" } }, streams: [{ index: 3, codec_type: "audio", codec_name: "pcm_f32le", channels: 2, sample_rate: "32000", tags: { secret: "PRIVATE" } }] };
  const result = parseAgentMediaProbe(Buffer.from(JSON.stringify(probe)));
  assert.equal(result.streams[0]!.sampleRate, 32000); assert.equal(result.durationSec, 2.5); assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.throws(() => parseAgentMediaProbe(Buffer.from(JSON.stringify({ streams: Array(17).fill(probe.streams[0]) }))));
});

test("native speech extraction selects the named stream and exact window into a separate canonical derivative", { skip: !available }, async () => {
  const folder = await tempDir("arke-speech-native-"), wav = join(folder, "two-tracks.mkv");
  await generate(["-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,1)\\,0.1\\,0.5)|0:s=48000:d=2",
    "-f", "lavfi", "-i", "aevalsrc=0:s=32000:d=2", "-map", "0:a", "-map", "1:a", "-c:a", "pcm_f32le", wav]);
  const inventory = await tools.probe(wav, signal()), first = inventory.streams[0]!, second = inventory.streams[1]!;
  const speech = await tools.speechAudio!(wav, first, 1, 2, signal()), decoded = decodeWav(speech.bytes)!;
  assert.equal(decoded.rate, 16000); assert.equal(decoded.channels, 1); assert.equal(decoded.encoding, "pcm16");
  assert.equal(speech.durationSec, 1); assert.equal(decoded.mono.length, 16000);
  assert.ok(readSpeechWav(speech.bytes).samples[8000]! > .1, "the requested second, rather than the first, was decoded");
  const silent = await tools.speechAudio!(wav, second, 1, 2, signal());
  assert.ok(readSpeechWav(silent.bytes).samples.every(value => value === 0), "the explicitly selected silent track stays silent");
  assert.equal(first.sampleRate, 48000); assert.equal(first.channels, 2);
  await assert.rejects(tools.speechAudio!(wav, first, 0, 61, signal()));
});
test("decoder bounds, aborts and raw diagnostics fail without leaking their contents", async () => {
  const fail = createAgentMediaTools({ run: async () => ({ code: 1, stdout: Buffer.from("PRIVATE"), stderr: "PRIVATE_PATH", timedOut: false, cancelled: false, outputLimitExceeded: false }) });
  await assert.rejects(fail.probe("private", signal()), error => error instanceof Error && !error.message.includes("PRIVATE"));
  const stop = new AbortController(); stop.abort(); await assert.rejects(tools.version(stop.signal));
});
test("separately configured decoder and probe versions remain distinct", async () => {
  const versions = createAgentMediaTools({ run: async tool => ({ code: 0, stdout: Buffer.from(`${tool} version ${tool === "ffmpeg" ? "8-fixture" : "7-fixture"}\n`), stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false }) });
  assert.equal(await versions.version(signal()), "ffmpeg version 8-fixture"); assert.equal(await versions.probeVersion(signal()), "ffprobe version 7-fixture");
});
test("native original-rate stereo stays distinct, including a silent channel and full-scale samples", { skip: !available }, async () => {
  const folder = await tempDir("arke-media-native-"), raw = join(folder, "source.f32"), wav = join(folder, "stereo.wav");
  const rate = 32000, bytes = Buffer.alloc(rate * 2 * 4);
  for (let i = 0; i < rate; i++) { bytes.writeFloatLE(i < rate / 2 ? 0 : 1, i * 8); bytes.writeFloatLE(.25, i * 8 + 4); }
  await writeFile(raw, bytes);
  await generate(["-f", "f32le", "-ar", String(rate), "-ac", "2", "-i", raw, "-c:a", "pcm_f32le", wav]);
  const inventory = await tools.probe(wav, signal()), stream = inventory.streams[0]!;
  assert.equal(stream.sampleRate, rate); assert.equal(stream.channels, 2);
  const measured = await tools.audio(wav, stream, 0, 1, signal());
  assert.equal(measured.sampleRate, rate); assert.equal(measured.sampleFrames, rate);
  assert.equal(measured.channels[0]!.samplesAtOrAboveFullScale, rate / 2); assert.equal(measured.channels[0]!.leadingSilenceSec, .5);
  assert.ok(Math.abs(measured.channels[1]!.samplePeakDbfs! + 12.0412) < .001);
  const silence = await tools.audio(wav, stream, 0, .25, signal()); assert.equal(silence.channels[0]!.samplePeakDbfs, null);
  assert.equal(silence.channels[1]!.silentSamples, 0);
});
test("native VFR frames carry actual decoded source times after seeking, distinct from requested times", { skip: !available }, async () => {
  const folder = await tempDir("arke-frame-native-"), video = join(folder, "vfr.mkv");
  await generate(["-f", "lavfi", "-i", "testsrc2=size=80x48:rate=10:duration=2", "-vf", "select=eq(mod(n\\,3)\\,0)", "-fps_mode", "vfr", "-c:v", "ffv1", video]);
  const inventory = await tools.probe(video, signal()); assert.equal(inventory.streams[0]!.kind, "video");
  const frame = await tools.frame(video, 0, .55, 1.5, signal());
  assert.ok(Math.abs(frame.sourceTimeSec - .6) < .000001, String(frame.sourceTimeSec));
  assert.notEqual(frame.sourceTimeSec, .55); assert.equal(decodePng(frame.bytes).width, 1024);
  await assert.rejects(tools.frame(video, 0, .55, .59, signal()), /inside the requested interval/);
});
test("native high-entropy RGBA footage fits the 1024px frame profile before rendition downsizing", { skip: !available }, async () => {
  const folder = await tempDir("arke-noisy-frame-"), raw = join(folder, "noise.rgba"), video = join(folder, "noise.mov");
  await writeFile(raw, randomBytes(1024 * 1024 * 4));
  await generate(["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "1024x1024", "-framerate", "1", "-i", raw, "-frames:v", "1", "-pix_fmt", "rgba", "-c:v", "png", video]);
  const frame = await tools.frame(video, 0, 0, 1, signal());
  assert.ok(frame.bytes.length > 3_000_000); assert.ok(frame.bytes.length <= 5 * 1024 * 1024); assert.equal(decodePng(frame.bytes).width, 1024);
});
test("native GIF artifacts expose their metadata and decoded frame timestamps", { skip: !available }, async () => {
  const folder = await tempDir("arke-gif-frame-"), gif = join(folder, "animated.gif");
  await generate(["-f", "lavfi", "-i", "testsrc2=size=80x48:rate=5:duration=1", gif]);
  const inventory = await tools.probe(gif, signal()); assert.equal(inventory.streams[0]!.codec, "gif");
  const frame = await tools.frame(gif, 0, .3, 1, signal()); assert.ok(frame.sourceTimeSec >= .3 && frame.sourceTimeSec < 1);
  assert.equal(decodePng(frame.bytes).width, 1024);
});

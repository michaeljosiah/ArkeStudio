import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRetailAudioTools, masterRetailFile, retailProblems, verifyRetailMp3, type RetailMeasurements } from "../../src/audio/retail.js";
import { writeSpeechWav } from "../../src/audio/speech-wav.js";
import { createNodeMediaProcessRunner } from "../../src/media/node-media-process.js";
import { retailParts } from "../../src/productions/audiobook-chapters.js";
import { tempDir } from "../tmp.js";

const good: RetailMeasurements = { seconds: 10, channels: 1, sampleRate: 44100, codec: "mp3", bitrate: 192000,
  rmsDb: -20.5, peakDb: -4, truePeakDb: -3.8, noiseFloorDb: -70, headSeconds: 1.1, tailSeconds: 2.1 };

describe("retail delivery checks", () => {
  it("checks encoding, RMS, decoded peaks, quiet windows, spacing and duration independently", () => {
    assert.deepEqual(retailProblems(good), []);
    for (const change of [{ codec: "aac" }, { bitrate: 128000 }, { sampleRate: 48000 }, { rmsDb: -24 }, { rmsDb: -17 },
      { truePeakDb: -2.9 }, { peakDb: -2 }, { noiseFloorDb: -59 }, { headSeconds: 0.9 }, { tailSeconds: 5.1 }, { seconds: 7200.1 }, { rmsDb: -Infinity }, { truePeakDb: NaN }]) {
      assert.ok(retailProblems({ ...good, ...change }).length, JSON.stringify(change));
    }
    assert.deepEqual(retailProblems({ ...good, noiseFloorDb: -Infinity }), [], "digital silence is quieter than the floor");
  });
  it("splits long chapters at passage boundaries without cutting an overlapping voice", () => {
    const blocks = [0, 3500, 7000, 10500].map(at => ({ at, seconds: 3000 }));
    assert.deepEqual(retailParts({ seconds: 14000, blocks }), [{ from: 0, to: 7000 }, { from: 7000, to: 14000 }]);
    assert.throws(() => retailParts({ seconds: 8000, blocks: [] }), /split.*shorter passages/);
    assert.throws(() => retailParts({ seconds: 8000, blocks: [{ at: 0, seconds: 7100 }, { at: 7000, seconds: 1000 }] }), /overlapping/);
    assert.deepEqual(retailParts({ seconds: 8000, blocks: [{ at: 0, seconds: 2000 }, { at: 3500, seconds: 3600 }, { at: 7000, seconds: 1000 }] }),
      [{ from: 0, to: 3500 }, { from: 3500, to: 8000 }], "an earlier safe boundary is preferred to cutting an overlapping voice");
  });
  it("walks every frame, refusing VBR, wrong rate, truncated audio and mixed channels", async () => {
    const dir = await tempDir("arke-retail-frames-");
    const frame = Buffer.alloc(Math.floor(144 * 192000 / 44100)); frame.set([255, 251, 176, 192]);
    const file = join(dir, "delivery.mp3"), signal = new AbortController().signal;
    const valid = Buffer.concat([frame, frame, frame]);
    await writeFile(file, valid); await verifyRetailMp3(file, 1, signal);
    for (const [offset, value] of [[frame.length + 2, 144], [2, 180], [frame.length + 3, 0]]) {
      const bytes = Buffer.from(valid); bytes[offset!] = value!; await writeFile(file, bytes);
      await assert.rejects(verifyRetailMp3(file, 1, signal), /not 192 kbps CBR/);
    }
    await writeFile(file, valid.subarray(0, valid.length - 1)); await assert.rejects(verifyRetailMp3(file, 1, signal), /incomplete/);
    const declaredVbr = Buffer.from(valid); declaredVbr.write("Xing", 21); await writeFile(file, declaredVbr);
    await assert.rejects(verifyRetailMp3(file, 1, signal), /variable bitrate/);
  });
});

const ffmpeg = process.env.ARKE_FFMPEG;
describe("native retail encoding", { skip: !ffmpeg }, () => {
  for (const channels of [1, 2]) it(`measures and validates the actual ${channels}-channel MP3 after mastering`, async () => {
    const dir = await tempDir("arke-retail-native-"), input = join(dir, "source.wav"), output = join(dir, "chapter.mp3");
    const signal = new AbortController().signal;
    const tools = createRetailAudioTools(createNodeMediaProcessRunner({ ffmpeg: ffmpeg!, ffprobe: process.env.ARKE_FFPROBE ?? join(dirname(ffmpeg!), process.platform === "win32" ? "ffprobe.exe" : "ffprobe") }));
    const samples = new Float32Array(24000 * 12);
    for (let index = 0; index < samples.length; index++) if (index % 48000 < 36000) samples[index] = Math.sin(2 * Math.PI * 440 * index / 24000) * 0.02;
    samples.fill(0.8, 24000 * 6, 24000 * 6 + 240); // Loud transient must engage the limiter.
    await writeFile(input, writeSpeechWav({ rate: 24000, samples }));
    const source = await tools.inspect(input, signal);
    assert.ok(source.peakDb > -3);
    assert.ok(source.noiseFloorDb <= -60, JSON.stringify(source));
    await masterRetailFile(tools, input, output, { from: 0, to: 11.5, channels, sourceRmsDb: source.rmsDb }, signal);
    await verifyRetailMp3(output, channels, signal);
    const measured = await tools.inspect(output, signal);
    assert.deepEqual(retailProblems(measured), [], JSON.stringify(measured));
    assert.equal(measured.channels, channels);
    assert.equal(measured.sampleRate, 44100);
    assert.ok(measured.seconds > 14.6 && measured.seconds < 14.9);
  });
});

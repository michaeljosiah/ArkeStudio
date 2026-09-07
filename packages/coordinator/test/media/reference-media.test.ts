import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Job, ManifestModel } from "@arke-studio/contracts";
import { prepareReferenceVideo } from "../../src/media/reference-media.js";
import { prepareReferences } from "../../src/media/prepare-references.js";
import { readContainedAudioReferences } from "../../src/world/reference-files.js";
import type { WorldStore } from "../../src/world/store.js";
import { tempDir } from "../tmp.js";
import { createHash } from "node:crypto";

test("video preparation uses 24 fps, preserves sound, and removes its private files", async () => {
  for (const hasAudio of [true, false]) {
    let args: string[] = [], path = "";
    const prepared = await prepareReferenceVideo({ contentType: "video/mp4", data: Uint8Array.from([1, 2]) }, {
      probe: { durationSec: async () => 2, info: async file => ({ durationSec: 2, hasAudio: file.endsWith("reference.mp4") || hasAudio }) },
      ffmpeg: { slateFont: "", run: async command => { args = command; path = command.at(-1)!; await writeFile(path, Uint8Array.from([7, 8])); } },
    }, new AbortController().signal);
    assert.equal(prepared.referenceVideo24fps, true);
    assert.equal(prepared.durationSec, 2);
    assert.ok(args.includes("fps=24,scale=864:480:force_original_aspect_ratio=decrease:force_divisible_by=32"));
    assert.equal(args.includes("anullsrc=r=32000:cl=stereo"), !hasAudio);
    await assert.rejects(access(dirname(path)));
  }
});

test("unknown and overlong reference videos refuse without encoding", async () => {
  for (const duration of [null, 1, 16]) {
    let called = false;
    await assert.rejects(prepareReferenceVideo({ contentType: "video/mp4", data: Uint8Array.from([1]) }, {
      probe: { durationSec: async () => duration, info: async () => duration === null ? null : { durationSec: duration, hasAudio: false } },
      ffmpeg: { slateFont: "", run: async () => { called = true; } },
    }, new AbortController().signal));
    assert.equal(called, false);
  }
});

test("standalone audio uses world containment and its reviewed hash", async () => {
  const dir = await tempDir("arke-h3-audio-test-");
  const data = Uint8Array.from([1, 2, 3]);
  await writeFile(join(dir, "tone.wav"), data);
  await assert.rejects(readContainedAudioReferences(dir, ["../tone.wav"]));
  const model = { limits: { referenceSyntax: "minimax-h3" } } as ManifestModel;
  const job = { params: { referenceMedia: [{ kind: "audio", file: "tone.wav", hash: `sha256:${createHash("sha256").update(data).digest("hex")}`, durationSec: 2 }] } } as unknown as Job;
  const store = { dir } as WorldStore;
  const tools = { probe: { durationSec: async () => 2, info: async () => ({ durationSec: 2, hasAudio: true }) } };
  const result = await prepareReferences(store, job, model, [], tools, new AbortController().signal);
  assert.deepEqual(result.audio[0]!.data, data);
  assert.equal(result.audio[0]!.durationSec, 2);
  await writeFile(join(dir, "tone.wav"), Uint8Array.from([9]));
  await assert.rejects(prepareReferences(store, job, model, [], tools, new AbortController().signal), /changed since review/);
});

test("real 30 fps silent input becomes a 24 fps reference with an audio slot", { skip: !process.env.ARKE_TEST_FFMPEG || !process.env.ARKE_TEST_FFPROBE }, async () => {
  const dir = await tempDir("arke-h3-fps-test-");
  const execute = promisify(execFile), ffmpeg = process.env.ARKE_TEST_FFMPEG!, ffprobe = process.env.ARKE_TEST_FFPROBE!;
  const source = join(dir, "source.mp4");
  await execute(ffmpeg, ["-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=s=256x256:r=30:d=2", "-c:v", "libx264", source], { windowsHide: true });
  const probe = async (file: string) => JSON.parse((await execute(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { windowsHide: true })).stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; r_frame_rate?: string }> };
  const result = await prepareReferenceVideo({ contentType: "video/mp4", data: await readFile(source) }, {
    probe: { durationSec: async file => Number((await probe(file)).format.duration), info: async file => { const value = await probe(file); return { durationSec: Number(value.format.duration), hasAudio: value.streams.some(stream => stream.codec_type === "audio") }; } },
    ffmpeg: { slateFont: "", run: async (args, _progress, signal) => { await execute(ffmpeg, args, { windowsHide: true, signal }); } },
  }, new AbortController().signal);
  const target = join(dir, "result.mp4");
  await writeFile(target, result.data);
  const measured = await probe(target);
  assert.equal(measured.streams.find(stream => stream.codec_type === "video")!.r_frame_rate, "24/1");
  assert.equal(measured.streams.some(stream => stream.codec_type === "audio"), true);
  assert.ok(Math.abs(Number(measured.format.duration) - 2) < 0.15);
});

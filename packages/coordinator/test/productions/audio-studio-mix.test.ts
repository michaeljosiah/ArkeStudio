import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initialAudioArrangement, editAudioArrangement, newAudioClip, resolveAudioArrangement, type AudioArrangementState } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { readStereoWav, stereoWavHeader, writeStereoWav } from "../../src/audio/stereo-wav.js";
import { integratedLoudness } from "../../src/audio/speech-wav.js";
import { StereoLoudness } from "../../src/audio/stereo-loudness.js";
import { readAudioStudioSource } from "../../src/productions/audio-studio-source.js";
import { audioStudioMixWindow, mixAudioStudioChunk, renderAudioStudioMix } from "../../src/productions/audio-studio-mix.js";

const script = { hash: "script", passages: [] };
function state(): AudioArrangementState { return { manuscriptHash: "script", passages: [], tracks: [{ id: "fx", name: "Effects", gainDb: 0, muted: false }], clips: [], omissions: [], master: { targetLufs: -18, ceilingDb: -1.5 } }; }
async function fixture() {
  const dir = await tempDir("arke-studio-mix-"); await mkdir(join(dir, "artifacts"));
  const left = new Float32Array(48000), right = new Float32Array(48000);
  for (let i = 0; i < left.length; i++) { left[i] = Math.sin(2 * Math.PI * 440 * i / 48000) * 0.1; right[i] = Math.sin(2 * Math.PI * 660 * i / 48000) * 0.05; }
  const file = "artifacts/stereo.wav"; await writeFile(join(dir, file), writeStereoWav({ rate: 48000, channels: 2, left, right }));
  const { source, pcm } = await readAudioStudioSource(dir, file);
  const arranged = state(); arranged.clips.push(newAudioClip("tone", "fx", source, source.samples));
  return { dir, arranged, pcm, source };
}
describe("Audio Studio canonical stereo rendering", () => {
  it("reserves float scratch space before creating a long render", async () => {
    const { dir, arranged } = await fixture();
    const clip = arranged.clips[0]!; clip.loop = true; clip.loopDuration = 800_000_000;
    // The 3.2 GB output fits, but output plus 6.4 GB scratch exceeds the 8 GiB budget.
    await assert.rejects(renderAudioStudioMix(dir, arranged, script), /scratch space budget/);
    assert.deepEqual(await readdir(join(dir, ".cache/audio-studio/mix")), []);
    clip.loop = false; delete clip.loopDuration;
    const mix = await renderAudioStudioMix(dir, arranged, script);
    assert.equal(mix.seconds, 1, "a rejected render releases its reservation");
    assert.ok((await readdir(join(dir, ".cache/audio-studio/mix"))).every(file => /^[a-f0-9]{64}\.(wav|json)$/.test(file)), "scratch files are removed after rendering");
  });
  it("decodes each layered source once across output chunks and repeated placements", async () => {
    const dir = await tempDir("arke-layered-decodes-"); await mkdir(join(dir, "artifacts"));
    const arranged = state(), samples = 48000 * (process.env.ARKE_AUDIO_MEMORY_SMOKE === "1" ? 360 : 2);
    for (const name of ["a", "b"]) {
      const bytes = Buffer.from(`encoded-${name}`), file = `artifacts/${name}.mp3`;
      await writeFile(join(dir, file), bytes);
      const source = { file, label: name, hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, samples, rate: 48000, channels: 2 as const };
      const clip = newAudioClip(name, "fx", source, samples); clip.sourceOut = 4800; clip.loop = true; clip.loopDuration = 3 * 48000;
      arranged.clips.push(clip, { ...clip, id: `${name}-repeat`, placement: { kind: "fixed", at: 48000 } });
    }
    let decodes = 0;
    const mix = await renderAudioStudioMix(dir, arranged, script, { ffmpeg: { slateFont: "", run: async args => {
      decodes++;
      const output = await open(args.at(-1)!, "w");
      try { await output.writeFile(stereoWavHeader(samples)); await output.truncate(44 + samples * 4); } finally { await output.close(); }
    } } });
    assert.equal(mix.seconds, 4); assert.equal(decodes, 2);
    assert.equal(readStereoWav(await readFile(join(dir, mix.file))).left.length, 4 * 48000);
  });
  it("splits looped source windows without resetting phase or altering the audible samples", async () => {
    const { arranged, pcm, source } = await fixture();
    const clip = arranged.clips[0]!; clip.loop = true; clip.loopFade = 1200; clip.loopDuration = 130007;
    const before = mixAudioStudioChunk(resolveAudioArrangement(arranged, script).clips, new Map([[source.file, pcm]]), 0, 130007, []);
    const split = editAudioArrangement(initialAudioArrangement(arranged, "{}"), { kind: "commands", label: "Split bed", commands: [{ kind: "split-clip", id: clip.id, nextId: "tail", at: 47001 }] });
    const plan = resolveAudioArrangement(split.current, script);
    assert.equal(plan.samples, 130007); assert.equal(plan.clips[1]!.clip.loopOffset, 47001);
    const after = mixAudioStudioChunk(plan.clips, new Map([[source.file, pcm]]), 0, 130007, []);
    assert.deepEqual(after, before);
    assert.deepEqual(editAudioArrangement(split, { kind: "undo" }).current, arranged);
  });
  it("reuses only a verified mix cache and rebuilds damaged cached output", async () => {
    const { dir, arranged } = await fixture();
    const first = await renderAudioStudioMix(dir, arranged, script), expected = await readFile(join(dir, first.file));
    const cached = await renderAudioStudioMix(dir, arranged, script);
    assert.equal(cached.file, first.file); assert.equal(cached.gainDb, first.gainDb);
    await writeFile(join(dir, first.file), "broken cache");
    const restored = await renderAudioStudioMix(dir, arranged, script);
    assert.deepEqual(await readFile(join(dir, restored.file)), expected);
  });
  it("crops loop auditions on sample boundaries without applying the master again", async () => {
    const { dir, arranged } = await fixture();
    const mix = await renderAudioStudioMix(dir, arranged, script);
    const window = await audioStudioMixWindow(dir, mix, 12001, 36007, new AbortController().signal);
    const full = readStereoWav(await readFile(join(dir, mix.file))), cropped = readStereoWav(await readFile(join(dir, window.file)));
    assert.equal(window.from, 12001 / 48000); assert.equal(window.seconds, 24006 / 48000);
    assert.deepEqual(cropped.left, full.left.subarray(12001, 36007)); assert.deepEqual(cropped.right, full.right.subarray(12001, 36007));
    await assert.rejects(audioStudioMixWindow(dir, mix, 0, 48001, new AbortController().signal), /within the chapter/);
  });
  it("streaming stereo loudness matches the mono reference plus channel energy across chunk boundaries", () => {
    const samples = Float32Array.from({ length: 123456 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 1000 * i / 48000));
    const meter = new StereoLoudness();
    for (let i = 0; i < samples.length; i += 1379) meter.add(samples.subarray(i, i + 1379), samples.subarray(i, i + 1379));
    const mono = integratedLoudness({ rate: 48000, samples })!;
    assert.ok(Math.abs(meter.measure().lufs! - mono - 10 * Math.log10(2)) < 0.00001);
  });
  it("keeps stereo, exact trim placement and tails, and applies the master only once", async () => {
    const { dir, arranged, pcm } = await fixture();
    const clip = arranged.clips[0]!; clip.sourceIn = 12001; clip.sourceOut = 36001; clip.placement = { kind: "fixed", at: 60001 };
    const mix = await renderAudioStudioMix(dir, arranged, script, { final: true });
    const output = readStereoWav(await readFile(join(dir, mix.file)));
    assert.equal(output.rate, 48000); assert.equal(output.channels, 2); assert.equal(output.left.length, 84001);
    assert.ok(output.left.subarray(0, 60001).every(value => value === 0));
    const gain = 10 ** (mix.gainDb / 20);
    assert.ok(Math.abs(output.left[60001]! - pcm.left[12001]! * gain) < 1 / 32768);
    assert.ok(Math.abs(output.right[60001]! - pcm.right[12001]! * gain) < 1 / 32768);
    assert.notDeepEqual(output.left, output.right);
  });
  it("drafts retain missing-source gaps while final delivery refuses, even after an earlier render", async () => {
    const { dir, arranged, source } = await fixture();
    await renderAudioStudioMix(dir, arranged, script, { final: true });
    await writeFile(join(dir, source.file), "changed");
    await assert.rejects(renderAudioStudioMix(dir, arranged, script, { final: true }), /needs attention/);
    const draft = await renderAudioStudioMix(dir, arranged, script);
    assert.equal(draft.issues[0]?.kind, "source");
    assert.equal(draft.seconds, 1);
    const silent = readStereoWav(await readFile(join(dir, draft.file)));
    assert.ok(silent.left.every(sample => sample === 0));
  });
  it("a seamless loop preserves the first onset and repeats the overlapped window", async () => {
    const { arranged, source } = await fixture();
    const clip = arranged.clips[0]!; clip.sourceOut = 8; clip.loop = true; clip.loopFade = 2;
    const pcm = { rate: 48000, channels: 2 as const, left: Float32Array.from([0, 0.2, 0.4, 0.6, 0.8, 1, 0.8, 0.6]), right: new Float32Array(8) };
    const entry = resolveAudioArrangement(arranged, script).clips[0]!; entry.samples = 20;
    const mixed = mixAudioStudioChunk([entry], new Map([[source.file, pcm]]), 0, 20, []);
    assert.equal(mixed.left[0], 0); assert.equal(mixed.left[6], pcm.left[6]);
    assert.ok(Math.abs(mixed.left[7]! - 0.4) < 1e-6);
    assert.equal(mixed.left[8], pcm.left[2]); assert.equal(mixed.left[14], pcm.left[2]);
  });
  it("track solo is an audition option and does not change the saved state", async () => {
    const { dir, arranged } = await fixture(), before = structuredClone(arranged);
    const solo = await renderAudioStudioMix(dir, arranged, script, { solo: ["other"] });
    const pcm = readStereoWav(await readFile(join(dir, solo.file)));
    assert.ok(pcm.left.every(value => value === 0)); assert.deepEqual(arranged, before);
  });
});

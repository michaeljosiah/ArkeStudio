import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, readdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@arke-studio/contracts";
import { createAudioMediaTools, type MediaProcessRunner } from "../../src/audio/media-tools.js";
import { audioHash } from "../../src/audio/qc.js";
import { prepareAudio, acceptPreparedAudio, resolveAudioSource, audioWorldPath, cleanupAudioStaging } from "../../src/audio/storage.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { tempDir } from "../tmp.js";
import { signal, wav } from "./helpers.js";

const source = wav(Array(48000).fill(1000));
function runner(options: { output?: Uint8Array; missingAudio?: boolean; fail?: boolean; args?: string[][] } = {}): MediaProcessRunner {
  return { async run(tool, args) {
    options.args?.push([...args]);
    let stdout = "";
    if (tool === "ffprobe") stdout = JSON.stringify({ format: { duration: "1", format_name: "wav" },
      streams: options.missingAudio ? [] : [{ codec_type: "audio", codec_name: "pcm_s16le", sample_fmt: "s16", sample_rate: "48000", channels: 1, bits_per_sample: 16 }] });
    else if (args[0] === "-version") stdout = "ffmpeg version 7.1-test\n";
    else await writeFile(args.at(-1)!, options.output ?? source);
    return { code: options.fail ? 1 : 0, stdout: Buffer.from(stdout), stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false };
  } };
}

it("canonical preparation is bounded non-destructive and validates the actual returned duration", async () => {
  const dir = await tempDir("audio-tools-");
  const input = join(dir, "source.wav"), output = join(dir, "out.wav");
  await writeFile(input, source);
  const args: string[][] = [];
  const tools = createAudioMediaTools(runner({ args }));
  const prepared = await tools.preparePcmWav({ sourcePath: input, destinationPath: output, expectedSourceHash: audioHash(source), signal: signal() });
  assert.equal(prepared.technical.durationSec, 1);
  assert.deepEqual(await readFile(input), Buffer.from(source));
  assert.ok(args.some(a => a.includes("pcm_s16le") && a.includes("48000") && a.includes("-nostdin")));
  await assert.rejects(tools.preparePcmWav({ sourcePath: input, destinationPath: output, expectedSourceHash: audioHash(source), signal: signal() }), /EEXIST/);
  await assert.rejects(createAudioMediaTools(runner({ output: wav([1]) })).preparePcmWav({ sourcePath: input,
    destinationPath: join(dir, "short.wav"), expectedSourceHash: audioHash(source), signal: signal() }), /malformed-output/);
  assert.ok(!(await readdir(dir)).includes("short.wav"));
});
it("no audio changed hashes abort and failed tools preserve source and leave no derivative", async () => {
  const dir = await tempDir("audio-failure-");
  const input = join(dir, "source.wav"), output = join(dir, "out.wav");
  await writeFile(input, source);
  const request = { sourcePath: input, destinationPath: output, expectedSourceHash: audioHash(source), signal: signal() };
  await assert.rejects(createAudioMediaTools(runner({ missingAudio: true })).preparePcmWav(request), /unsupported-media/);
  await assert.rejects(createAudioMediaTools(runner()).preparePcmWav({ ...request, expectedSourceHash: audioHash(wav([2])) }), /source-changed/);
  await assert.rejects(createAudioMediaTools(runner()).preparePcmWav({ ...request, signal: AbortSignal.abort() }), /cancelled/);
  await assert.rejects(createAudioMediaTools(runner({ fail: true })).preparePcmWav(request), /process-failed/);
  assert.deepEqual(await readdir(dir), ["source.wav"]);
});
it("artifact preparation and acceptance use real world ownership and retain frozen evidence in committed metadata", async t => {
  const dir = await makeTempWorld();
  const artifactId = newId("ar");
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await writeFile(join(dir, "artifacts", "sample.wav"), source);
  await writeFile(join(dir, "artifacts", "sample.wav.json"), JSON.stringify({ id: artifactId, kind: "audio", file: "sample.wav",
    hash: audioHash(source).slice(0, 19), origin: { by: "user" }, links: [], created: "2026-09-05T12:00:00Z" }));
  const store = await WorldStore.open(dir);
  t.after(() => store.close());
  const candidate = await prepareAudio(store, createAudioMediaTools(runner()), { kind: "artifact", artifactId });
  assert.equal(candidate.provenance.source.sourceMediaHash, audioHash(source));
  const file = await acceptPreparedAudio(store, candidate, "references/maren-kest/voice", (file, provenance) => ({
    kind: "audio-test", source: "test", files: [{ path: "audio-test.json", action: "create", baseHash: null, content: JSON.stringify({ file, provenance }) }] }));
  assert.deepEqual(await readFile(join(dir, file)), Buffer.from(source));
  const record = JSON.parse(await readFile(join(dir, "audio-test.json"), "utf8"));
  assert.equal(record.provenance.qualityReport.sourceHash, audioHash(source));
  const stale = await prepareAudio(store, createAudioMediaTools(runner()), { kind: "artifact", artifactId });
  await writeFile(join(dir, "artifacts", "sample.wav"), wav([1]));
  await assert.rejects(acceptPreparedAudio(store, stale, "references/maren-kest/voice", () => { throw new Error("must not commit"); }), /source-changed/);
  await cleanupAudioStaging(store, Date.now() + 1000, new Set([stale.operationId]));
  assert.ok((await readdir(join(dir, ".staging/audio"))).includes(stale.operationId));
  assert.deepEqual(await readFile(join(dir, file)), Buffer.from(source));
});
it("portable path checks refuse traversal ADS and directory junctions", async () => {
  const dir = await tempDir("audio-paths-");
  for (const path of ["../escape", "a/../../escape", "C:/escape", "a:stream", "a\\b", "a./b"]) {
    await assert.rejects(audioWorldPath(dir, path, true), /invalid/);
  }
  const outside = await tempDir("audio-outside-");
  await symlink(outside, join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(audioWorldPath(dir, "linked/file.wav", true), /invalid/);
});
it("pass segment range resolves to parent media without changing selected-relative provenance", async () => {
  const dir = await tempDir("audio-pass-");
  const parentId = newId("tk"), selectedId = newId("tk");
  await mkdir(join(dir, "productions/p/takes", parentId), { recursive: true });
  await writeFile(join(dir, "productions/p/takes", parentId, "clip.wav"), source);
  const bundle = { productions: [{ meta: { id: "p" }, takes: [{ id: parentId, media: "clip.wav" },
    { id: selectedId, segment: { passTakeId: parentId, inSec: 0.25, outSec: 0.75 } }] }], artifacts: [] };
  const store = { dir, closingSignal: signal(), getBundle: () => bundle } as unknown as WorldStore;
  const result = await resolveAudioSource(store, { kind: "production-take", productionId: "p", takeId: selectedId, range: { inSec: 0.1, outSec: 0.4 } });
  assert.deepEqual(result.physicalRange, { inSec: 0.35, outSec: 0.65 });
  assert.deepEqual(result.source.range, { inSec: 0.1, outSec: 0.4 });
  await assert.rejects(resolveAudioSource(store, { kind: "production-take", productionId: "p", takeId: selectedId, range: { inSec: 0, outSec: 0.6 } }), /range-invalid/);
});

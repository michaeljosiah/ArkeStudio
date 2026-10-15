import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readFile, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../tmp.js";
import { holdAudioStudioCache, reserveAudioStudioCache, retainAudioStudioCache } from "../../src/productions/audio-studio-cache.js";

it("evicts old mixes and windows within byte/file budgets while preserving playback and concurrent reservations", async () => {
  const dir = await tempDir("arke-audio-cache-"), folder = join(dir, ".cache/audio-studio/mix"); await mkdir(folder, { recursive: true });
  const file = `.cache/audio-studio/mix/${"a".repeat(64)}.wav`, receipt = file.replace(/wav$/, "json");
  await writeFile(join(dir, file), Buffer.alloc(60)); await writeFile(join(dir, receipt), "{}");
  await utimes(join(dir, file), new Date(0), new Date(0)); await utimes(join(dir, receipt), new Date(0), new Date(0));
  const playing = new AbortController(), signal = new AbortController().signal, budget = { bytes: 100, files: 4, graceMs: 0 };
  retainAudioStudioCache(dir, file, playing.signal);
  await assert.rejects(reserveAudioStudioCache(dir, 60, 1, signal, budget), /cache is full/);
  assert.equal((await readFile(join(dir, file))).length, 60);
  playing.abort();
  const held = holdAudioStudioCache(dir, file);
  await assert.rejects(reserveAudioStudioCache(dir, 60, 1, signal, budget), /cache is full/);
  held();
  const release = await reserveAudioStudioCache(dir, 60, 1, signal, budget);
  await assert.rejects(readFile(join(dir, file)), { code: "ENOENT" });
  await assert.rejects(reserveAudioStudioCache(dir, 60, 1, signal, budget), /cache is full/);
  release();
  const next = await reserveAudioStudioCache(dir, 60, 1, signal, budget); next();
});

it("refuses work instead of evicting a recently returned export", async () => {
  const dir = await tempDir("arke-recent-audio-"), folder = join(dir, ".cache/audio-studio/mix"); await mkdir(folder, { recursive: true });
  const file = join(folder, `${"b".repeat(64)}.wav`); await writeFile(file, Buffer.alloc(60));
  await assert.rejects(reserveAudioStudioCache(dir, 60, 1, new AbortController().signal, { bytes: 100, files: 4, graceMs: 60000 }), /cache is full/);
  assert.equal((await readFile(file)).length, 60);
});

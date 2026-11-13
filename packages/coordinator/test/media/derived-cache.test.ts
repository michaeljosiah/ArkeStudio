import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DerivedCache } from "../../src/media/derived-cache.js";
import { tempDir } from "../tmp.js";

const FOLDER = ".cache/derived";

async function setUp(files: Record<string, number>) {
  const dir = await tempDir("arke-derived-cache-");
  await mkdir(join(dir, FOLDER), { recursive: true });
  for (const [name, ageSeconds] of Object.entries(files)) {
    const path = join(dir, FOLDER, name), at = new Date(Date.now() - ageSeconds * 1000);
    await writeFile(path, "x");
    await utimes(path, at, at);
  }
  return { dir, left: async () => (await readdir(join(dir, FOLDER))).sort() };
}

const cache = (budget: { bytes: number; files: number; graceMs: number }) =>
  new DerivedCache(FOLDER, { owns: /^[a-z]\.(wav|json)$/, budget, label: "test cache" });

it("evicts the least recently used entry, a file and its receipt together, never one pinned or recent", async () => {
  // a's file is older than b's, but its receipt was used since: the entry is as recent as either.
  const { dir, left } = await setUp({ "c.wav": 500, "c.json": 500, "a.wav": 400, "a.json": 200, "b.wav": 300, "b.json": 300, "d.wav": 1, "01JSCRATCH.wav": 900 });
  const derived = cache({ bytes: 1000, files: 5, graceMs: 60_000 });
  const playing = new AbortController();
  derived.retain(dir, `${FOLDER}/c.wav`, playing.signal);
  await derived.trim(dir);
  assert.deepEqual(await left(), ["01JSCRATCH.wav", "a.json", "a.wav", "c.json", "c.wav", "d.wav"], "b went whole; c is playing, d is in its grace, the scratch file is not the cache's");
  playing.abort();
  const release = await derived.reserve(dir, 0, 2, new AbortController().signal);
  assert.deepEqual(await left(), ["01JSCRATCH.wav", "a.json", "a.wav", "d.wav"], "stopped, c is the oldest");
  release();
});

it("trims without refusing when only pinned and recent entries are left, and reserving then refuses", async () => {
  const { dir, left } = await setUp({ "a.wav": 1, "a.json": 1, "b.wav": 500 });
  const derived = cache({ bytes: 1000, files: 1, graceMs: 60_000 });
  const release = derived.hold(dir, `${FOLDER}/b.json`);
  await derived.trim(dir);
  assert.deepEqual(await left(), ["a.json", "a.wav", "b.wav"]);
  await assert.rejects(derived.reserve(dir, 0, 1, new AbortController().signal), /test cache: full/);
  release();
  await derived.trim(dir);
  assert.deepEqual(await left(), ["a.json", "a.wav"], "released, b goes; a is still in its grace");
});

it("shares one make between two asks for the same key, and makes again once it has settled", async () => {
  const derived = cache({ bytes: 1000, files: 10, graceMs: 0 });
  let made = 0;
  const make = async () => ++made;
  const [first, second] = await Promise.all([derived.once("/world", "k", make), derived.once("/world", "k", make)]);
  assert.deepEqual([first, second, made], [1, 1, 1]);
  assert.equal(await derived.once("/world", "k", make), 2);
});

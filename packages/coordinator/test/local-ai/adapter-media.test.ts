import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterMediaVisible } from "../../src/local-ai/adapter-media.js";

test("off hides known adapter media and posters without changing accepted files", async t => {
  const root = await mkdtemp(join(tmpdir(), "arke-adapter-media-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const takeDir = join(root, "productions", "film", "takes", "take-1");
  await mkdir(takeDir, { recursive: true });
  const metadata = JSON.stringify({ params: { adapters: [{ releaseId: "old-removed", sha256: "a".repeat(64), strength: 0.5 }] } });
  await writeFile(join(takeDir, "take.json"), metadata);
  await writeFile(join(takeDir, "clip.mp4"), "kept media");
  assert.equal(await adapterMediaVisible(join(takeDir, "clip.mp4"), "productions/film/takes/take-1/clip.mp4", false), false);
  assert.equal(await adapterMediaVisible(join(takeDir, "frame.png"), "productions/film/takes/take-1/frame.png", false), false);
  assert.equal(await adapterMediaVisible(join(takeDir, "clip.mp4"), "productions/film/takes/take-1/clip.mp4", true), true);
  assert.equal(await readFile(join(takeDir, "clip.mp4"), "utf8"), "kept media");
  assert.equal(await readFile(join(takeDir, "take.json"), "utf8"), metadata);
  await writeFile(join(takeDir, "take.json"), JSON.stringify({ params: {} }));
  assert.equal(await adapterMediaVisible(join(takeDir, "clip.mp4"), "productions/film/takes/take-1/clip.mp4", false), true);
});

test("artifact generation provenance and damaged records gate previews", async t => {
  const root = await mkdtemp(join(tmpdir(), "arke-adapter-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "artifacts"));
  const path = join(root, "artifacts", "clip.mp4");
  await writeFile(path + ".json", JSON.stringify({ generation: { params: { adapters: [{ releaseId: "old" }] } } }));
  assert.equal(await adapterMediaVisible(path, "artifacts/clip.mp4", false), false);
  await writeFile(path + ".json", JSON.stringify({ origin: { by: "user" } }));
  assert.equal(await adapterMediaVisible(path, "artifacts/clip.mp4", false), true);
  await writeFile(path + ".json", "{broken");
  assert.equal(await adapterMediaVisible(path, "artifacts/clip.mp4", false), false);
});

import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import fs, { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { scanWorld } from "../../src/world/scan.js";
import { makeTempWorld } from "./helpers.js";

/**
 * A scan reads its record files sixteen at a time (issue 1841) and must come out exactly as one
 * that read them in turn: problems, the manifest's key order and every record list are settled
 * in the order the files are walked, whichever read happens to finish first.
 */

const ARTIFACTS = 48;
const artifactName = (i: number) => `read-ahead-${String(i).padStart(2, "0")}.png.json`;
const ARTIFACT = /\/read-ahead-(\d+)\.png\.json$/;

/** The fixture grown with enough of every looped record, broken ones among them, to be read out of turn. */
async function largeWorld(): Promise<string> {
  const dir = await makeTempWorld();
  const sidecar = JSON.parse(await readFile(join(dir, "artifacts/board-v2.png.json"), "utf8"));
  for (let i = 0; i < ARTIFACTS; i++) {
    const text = i % 7 === 3 ? "{ not json" : JSON.stringify({ ...sidecar, id: `ar_01J8G${String(i).padStart(21, "0")}`, file: `read-ahead-${i}.png` });
    await writeFile(join(dir, "artifacts", artifactName(i)), text);
  }
  const book = join(dir, "productions/the-ledger-of-nights");
  const chapter = await readFile(join(book, "chapters/01-neap.md"), "utf8");
  await mkdir(join(book, ".continuity"), { recursive: true });
  for (let i = 0; i < 20; i++) {
    const stem = `${10 + i}-more`;
    await writeFile(join(book, "chapters", `${stem}.md`), i % 6 === 2 ? "---\nid: [\n---\n" : chapter.replace("id: neap", `id: more-${i}`).replace("number: 1", `number: ${10 + i}`));
    if (i % 3 === 0) await writeFile(join(book, ".continuity", `${stem}.json`), i % 2 === 0 ? "{" : "{}");
  }
  const scenes = join(dir, "productions/saltlight/scenes");
  const scene = JSON.parse(await readFile(join(scenes, "02-the-tables-say-neap.json"), "utf8"));
  // Every fifth claims an id already carried, which only the walk's own order can name.
  for (let i = 0; i < 20; i++) {
    await writeFile(join(scenes, `${30 + i}-more.json`), JSON.stringify({ ...scene, id: i % 5 === 0 ? "sc_02" : `sc_${300 + i}`, number: 30 + i }));
  }
  const takes = join(dir, "productions/saltlight/takes");
  const source = join(takes, "tk_01J8A0000000000000000000A1");
  const frameHash = `sha256:${createHash("sha256").update(await readFile(join(source, "frame.png"))).digest("hex")}`;
  const take = JSON.parse(await readFile(join(source, "take.json"), "utf8"));
  for (let i = 0; i < 20; i++) {
    const id = `tk_01J8Z${String(i).padStart(21, "0")}`;
    await cp(source, join(takes, id), { recursive: true });
    await writeFile(join(takes, id, "take.json"), JSON.stringify({ ...take, id }));
    const info = { sourceHash: frameHash, mediaInfo: { durationSec: 4, hasAudio: false }, probedAt: "2026-07-30T13:41:00Z" };
    if (i % 4 !== 3) await writeFile(join(takes, id, "media-info.json"), i % 4 === 2 ? "{" : JSON.stringify(info));
  }
  return dir;
}

/** Hold every read of the world for `delay(path)` ms, counting the artifact reads open at once. */
function holdReads(t: TestContext, dir: string, delay: (path: string) => number, onArtifactRead?: (started: number) => void) {
  const original = fs.readFile;
  const reads = { open: 0, peak: 0, started: 0 };
  const root = dir.replace(/\\/g, "/");
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const path = String(args[0]).replace(/\\/g, "/");
    const artifact = ARTIFACT.test(path);
    if (artifact) {
      reads.open += 1;
      reads.peak = Math.max(reads.peak, reads.open);
      reads.started += 1;
      onArtifactRead?.(reads.started);
    }
    try {
      if (path.includes(root)) await new Promise((resolve) => setTimeout(resolve, delay(path)));
      return await original(...args);
    } finally {
      if (artifact) reads.open -= 1;
    }
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return reads;
}

/** A delay that differs from file to file but not from run to run. */
const scrambled = (path: string) => createHash("sha256").update(path).digest()[0]! % 9;

it("settles a world read out of order exactly as a world read in turn", async (t) => {
  const dir = await largeWorld();
  const inTurn = await scanWorld(dir);
  holdReads(t, dir, scrambled);
  const outOfTurn = await scanWorld(dir);
  assert.equal(JSON.stringify(outOfTurn), JSON.stringify(inTurn));

  // And that order is the walk's: sorted names, problems named as the walk met them.
  const names = Array.from({ length: ARTIFACTS }, (_, i) => `artifacts/${artifactName(i)}`);
  assert.deepEqual(Object.keys(outOfTurn.manifest).filter((path) => ARTIFACT.test(`/${path}`)), names);
  const broken = names.filter((_, i) => i % 7 === 3);
  assert.deepEqual(outOfTurn.problems.map((problem) => problem.path).filter((path) => ARTIFACT.test(`/${path}`)), broken);
  assert.deepEqual(
    outOfTurn.bundle.artifacts.filter((artifact) => artifact.file.startsWith("read-ahead-")).map((artifact) => artifact.file),
    Array.from({ length: ARTIFACTS }, (_, i) => i).filter((i) => i % 7 !== 3).map((i) => `read-ahead-${i}.png`),
  );
  // A duplicate scene id is reported against the later file, as reading in turn finds it.
  const duplicates = outOfTurn.problems.filter((problem) => problem.message.startsWith("duplicate scene id sc_02"));
  assert.deepEqual(duplicates.map((problem) => problem.path), [30, 35, 40, 45].map((n) => `productions/saltlight/scenes/${n}-more.json`));
});

it("keeps sixteen reads open at once, and no more", async (t) => {
  const dir = await largeWorld();
  // Earlier files are held longest, so each window of sixteen finishes back to front.
  const reads = holdReads(t, dir, (path) => {
    const match = ARTIFACT.exec(path);
    return match ? (16 - (Number(match[1]) % 16)) * 2 : 0;
  });
  await scanWorld(dir);
  assert.equal(reads.started, ARTIFACTS);
  assert.equal(reads.peak, 16);
});

it("stops reading when the scan is aborted, and leaves no read open behind it", async (t) => {
  const dir = await largeWorld();
  const controller = new AbortController();
  const reads = holdReads(t, dir, () => 3, (started) => {
    if (started === 20) controller.abort();
  });
  await assert.rejects(scanWorld(dir, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(reads.open, 0);
  assert.ok(reads.started < ARTIFACTS, `${reads.started} artifact reads started after the abort`);
});

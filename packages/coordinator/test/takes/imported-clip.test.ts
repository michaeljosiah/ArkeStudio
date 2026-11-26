import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { takeCheckSource, takeIsCheckable, type AgentMediaInventory } from "@arke-studio/contracts";
import { clipCuts, ClipImportError, recordImportedClipTakes, segmentBounds, shelfClipFile } from "../../src/takes/imported-clip.js";
import type { AgentMediaTools } from "../../src/media/agent-media-tools.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup, tempDir } from "../tmp.js";

/*
 * A clip made outside the Studio, filed as a take (2026-11-26). Gold on Gold's hundred and seven
 * clips were made on another site; none was a take, so none was checked and Arke read none.
 */

describe("where a clip of several shots is cut", () => {
  const board = [{ shotId: "sh_21", sec: 5.6 }, { shotId: "sh_22", sec: 3.4 }, { shotId: "sh_23", sec: 6 }];

  it("cuts at the picture's cuts, not at the seconds that were asked for", () => {
    // Asked for 5.6 and 9.0; the model cut at 6.2 and 9.9.
    assert.deepEqual(segmentBounds(board, 15, [6.2, 9.9]), { from: "cuts", bounds: [
      { shotId: "sh_21", inSec: 0, outSec: 6.2 }, { shotId: "sh_22", inSec: 6.2, outSec: 9.9 }, { shotId: "sh_23", inSec: 9.9, outSec: 15 }] });
  });

  it("takes the cut nearest each seam when the model cut somewhere else as well", () => {
    const found = segmentBounds(board, 15, [2, 6.2, 9.9]);
    assert.equal(found.from, "cuts");
    assert.deepEqual(found.bounds.map(bound => bound.inSec), [0, 6.2, 9.9], "the cut at 2 s is inside the first shot");
  });

  it("divides by the plan, scaled to the clip, when a seam has no cut within reach", () => {
    assert.deepEqual(segmentBounds(board, 15, [6.2]), { from: "plan", bounds: [
      { shotId: "sh_21", inSec: 0, outSec: 5.6 }, { shotId: "sh_22", inSec: 5.6, outSec: 9 }, { shotId: "sh_23", inSec: 9, outSec: 15 }] }, "never half snapped");
    // Three shots written as ten seconds, made as fifteen.
    const scaled = segmentBounds([{ shotId: "a", sec: 2 }, { shotId: "b", sec: 3 }, { shotId: "c", sec: 5 }], 15, []);
    assert.deepEqual(scaled.bounds.map(bound => [bound.inSec, bound.outSec]), [[0, 3], [3, 7.5], [7.5, 15]]);
  });

  it("does not take a stray cut for the seam because there is one of each (codex on PR 3328)", () => {
    // Two shots, the seam written at 75 s of 90. The model cut once, at 15 s, and not at its seam at all.
    const two = [{ shotId: "sh_1", sec: 75 }, { shotId: "sh_2", sec: 15 }];
    assert.deepEqual(segmentBounds(two, 90, [15]), { from: "plan", bounds: [{ shotId: "sh_1", inSec: 0, outSec: 75 }, { shotId: "sh_2", inSec: 75, outSec: 90 }] });
    // With its real cut found as well, the seam takes the one beside it.
    assert.deepEqual(segmentBounds(two, 90, [15, 75.4]).bounds.map(bound => bound.inSec), [0, 75.4]);
  });

  it("does not make a shot of a flash, and leaves a clip of one shot whole", () => {
    assert.equal(segmentBounds(board, 15, [6.2, 6.3]).from, "plan", "two cuts a tenth apart are not two seams");
    assert.deepEqual(segmentBounds([{ shotId: "sh_21", sec: 5 }], 6.4, [3]), { from: "cuts", bounds: [{ shotId: "sh_21", inSec: 0, outSec: 6.4 }] });
  });
});

describe("a clip's cuts", () => {
  it("finds them in the picture, and says nothing on a host that cannot read one", async () => {
    const inventory: AgentMediaInventory = { durationSec: 6, streams: [
      { index: 0, kind: "video", codec: "fixture", width: 1280, height: 720, frameRate: "30/1", durationSec: 6, startTimeSec: 0 }] };
    // A room that changes at each cut, with a little movement so nothing is a still.
    const pictureOf = (cutsAt: number[]) => (i: number) => {
      const picture = new Uint8Array(64 * 36).fill(60 + 60 * cutsAt.filter(cut => i >= cut * 10).length); picture[i % 64] = 255; return picture; };
    const reading = (seconds: number, cutsAt: number[]) => {
      const windows: Array<[number, number]> = [], frame = pictureOf(cutsAt);
      const tools = { probe: async () => ({ ...inventory, durationSec: seconds }),
        grayFrames: async (_path: string, _stream: unknown, startSec: number, endSec: number, options: { fps?: number }) => {
          windows.push([startSec, endSec]);
          return { frames: Array.from({ length: Math.round((endSec - startSec) * 10) }, (_, i) => frame(Math.round(startSec * 10) + i)), width: 64, height: 36, fps: options.fps };
        } } as unknown as AgentMediaTools;
      return { tools, windows };
    };
    assert.deepEqual(await clipCuts(reading(6, [3]).tools, "clip.mp4", new AbortController().signal), { durationSec: 6, cuts: [3] });
    assert.equal(await clipCuts({ probe: async () => inventory } as unknown as AgentMediaTools, "clip.mp4", new AbortController().signal), null);
    // The whole clip, a minute at a time: a cut past the first minute, and one on the join of two readings, found once each.
    const long = reading(90, [15, 59.5, 75]);
    assert.deepEqual(await clipCuts(long.tools, "clip.mp4", new AbortController().signal), { durationSec: 90, cuts: [15, 59.5, 75] });
    assert.deepEqual(long.windows, [[0, 60], [59, 90]]);
    assert.equal(await clipCuts(reading(601, []).tools, "clip.mp4", new AbortController().signal), null, "ten minutes is not a board");
  });
});

describe("a video on the shelf", () => {
  it("is its own plain file inside the shelf, or it is not there (codex on PR 3328)", async () => {
    const dir = await tempDir("arke-shelf-");
    await mkdir(join(dir, "artifacts"));
    await writeFile(join(dir, "artifacts", "clip.mp4"), "CLIP");
    await writeFile(join(dir, "outside.mp4"), "PRIVATE");
    const shelf = [{ id: "ar_1", kind: "video", file: "clip.mp4" }, { id: "ar_2", kind: "video", file: "../outside.mp4" }, { id: "ar_3", kind: "image", file: "clip.mp4" },
      { id: "ar_4", kind: "video", file: "gone.mp4" }];
    assert.equal((await readFile((await shelfClipFile(dir, shelf, "ar_1"))!)).toString(), "CLIP");
    assert.equal(await shelfClipFile(dir, shelf, "ar_2"), null, "a name that climbs out of the shelf");
    assert.equal(await shelfClipFile(dir, shelf, "ar_3"), null, "a picture is not a clip");
    assert.equal(await shelfClipFile(dir, shelf, "ar_4"), null);
    assert.equal(await shelfClipFile(dir, shelf, "ar_9"), null);
  });
});

async function world() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir); closeOnCleanup(() => store.close());
  const outside = await tempDir("arke-clip-");
  const file = async (name: string, text: string) => { const path = join(outside, name); await writeFile(path, text); return path; };
  const takes = () => store.getBundle().productions.find(p => p.meta.id === "saltlight")!.takes;
  return { store, file, takes };
}
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

describe("a clip made outside, filed as a take", () => {
  it("is the shot's take, checkable, with what made it and from what words", async () => {
    const { store, file, takes } = await world();
    const filed = await recordImportedClipTakes(store, { productionId: "saltlight", shotIds: ["sh_12"], sourcePath: await file("shot 12 from the site.MP4", "CLIP"),
      takeId: "tk_01M8CMP0RT0000000000000001" as never, madeWith: "Wan 3.0 on another site", prompt: "  A close on her at the rail.  " });
    assert.equal(filed.segmentsFrom, null);
    assert.deepEqual(filed.takes.map(take => take.id), [filed.clip.id]);
    const take = takes().find(candidate => candidate.id === "tk_01M8CMP0RT0000000000000001")!;
    assert.ok(take, "the scan read it back");
    assert.deepEqual([take.kind, take.provider, take.model, take.coversShots, take.media, take.mediaHash], ["clip", "user", "upload", ["sh_12"], "clip-upload.mp4", sha("CLIP")]);
    assert.deepEqual(take.params, { uploadedFile: "clip-upload.mp4", madeWith: "Wan 3.0 on another site" });
    assert.equal(take.prompt, "A close on her at the rail.");
    assert.deepEqual(take.cost, { estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "local-zero" }, "the Studio paid for nothing");
    assert.equal((await readFile(join(store.dir, "productions/saltlight/takes", take.id, "clip-upload.mp4"))).toString(), "CLIP", "copied in under a name of the Studio's");
    assert.equal(takeIsCheckable(takes(), take), true, "so the checks after a take run on it");
  });

  it("files a clip made as a run of shots whole and as one take a shot, cut where its picture cuts", async () => {
    const { store, file, takes } = await world();
    const input = { productionId: "saltlight", shotIds: ["sh_12", "sh_13"], sourcePath: await file("board.mp4", "BOARD"), takeId: "tk_01M8CMP0RT0000000000000002" as never,
      measure: async () => ({ durationSec: 9, cuts: [4.4] }) };
    const filed = await recordImportedClipTakes(store, input);
    assert.equal(filed.segmentsFrom, "cuts");
    assert.deepEqual(filed.clip.coversShots, ["sh_12", "sh_13"]);
    assert.equal(takeIsCheckable(takes(), takes().find(take => take.id === filed.clip.id)!), false, "the whole clip is no one shot's");
    const segments = filed.takes.map(segment => takes().find(take => take.id === segment.id)!);
    assert.deepEqual(segments.map(take => [take.coversShots, take.segment]), [
      [["sh_12"], { passTakeId: filed.clip.id, inSec: 0, outSec: 4.4 }], [["sh_13"], { passTakeId: filed.clip.id, inSec: 4.4, outSec: 9 }]]);
    assert.deepEqual(takeCheckSource(takes(), segments[1]!), { mediaTakeId: filed.clip.id, media: "clip-upload.mp4", hash: sha("BOARD"), startSec: 4.4, endSec: 9 }, "each is checked over its own range of the clip");
    assert.equal(segments[0]!.media, undefined, "a segment is a range, not a file");
    // The same request again files nothing twice.
    const count = takes().length, again = await recordImportedClipTakes(store, input);
    assert.deepEqual([again.clip.id, again.takes.map(take => take.id), again.segmentsFrom], [filed.clip.id, filed.takes.map(take => take.id), "cuts"]);
    assert.equal(takes().length, count);
  });

  it("refuses by name what it cannot file, and leaves nothing behind", async () => {
    const { store, file, takes } = await world();
    const before = takes().length, id = "tk_01M8CMP0RT0000000000000003" as never;
    const refused = (input: Partial<Parameters<typeof recordImportedClipTakes>[1]>, says: RegExp) => assert.rejects(
      async () => recordImportedClipTakes(store, { productionId: "saltlight", shotIds: ["sh_12"], sourcePath: "", takeId: id, ...input }),
      (error: unknown) => error instanceof ClipImportError && says.test(error.message));
    await refused({ sourcePath: await file("frame.png", "PNG") }, /not a video/);
    await refused({ sourcePath: join(store.dir, "nowhere.mp4") }, /could not be read/);
    await refused({ sourcePath: await file("empty.mp4", "") }, /could not be read/);
    const clip = await file("clip.mp4", "CLIP");
    await refused({ sourcePath: clip, shotIds: ["sh_12", "sh_13"] }, /could not read the clip to find its shots/);
    await refused({ sourcePath: clip, shotIds: ["sh_13", "sh_12"], measure: async () => ({ durationSec: 9, cuts: [4.4] }) }, /not a run of consecutive shots/);
    await refused({ sourcePath: clip, shotIds: ["sh_12", "sh_12"] }, /Name the shot/);
    assert.equal(takes().length, before);
  });
});

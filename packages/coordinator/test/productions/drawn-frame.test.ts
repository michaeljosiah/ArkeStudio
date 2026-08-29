import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasOwnFrame, type Selections, type Take } from "@arke-studio/contracts";
import { fileDrawnFrame } from "../../src/takes/drawn-frame.js";
import { acceptTake } from "../../src/takes/review.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The frame slot (SPEC-036 §1.8): a picture a shot was *given* to open on, and the rule that
 * keeps it from being quietly replaced by the continuity chain.
 */

const CLOCK = () => "2026-08-29T12:00:00.000Z";

async function open() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

const production = (store: WorldStore) =>
  store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;

const selections = async (store: WorldStore): Promise<Selections> =>
  JSON.parse(await readFile(join(store.dir, "productions", "saltlight", "selections.json"), "utf8"));

/** A still take on disk, as a frame run or the bench would land one. */
async function still(store: WorldStore, id: string, shotId: string): Promise<Take> {
  const dir = join(store.dir, "productions", "saltlight", "takes", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "frame.png"), encodePng(solidImage(8, 8, [20, 30, 40, 255])));
  const take = {
    id,
    jobId: `jb_${id}`,
    kind: "frame",
    coversShots: [shotId],
    media: "frame.png",
    model: "test-image",
    provenance: { canonRevision: 1, sheets: {} },
    cost: { estimatedMicroUsd: 1000, actualMicroUsd: 1000, actualSource: "manifest-derived" },
    createdAt: CLOCK(),
    completedAt: CLOCK(),
  } as unknown as Take;
  await writeFile(join(dir, "take.json"), JSON.stringify(take, null, 2) + "\n");
  return take;
}

describe("a drawn frame is filed where the dispatch can send it", () => {
  it("files the still as an image artifact and points the frame slot at it", async () => {
    const store = await open();
    const take = await still(store, "tk_drawn01", "sh_12");
    const filed = await fileDrawnFrame(store, production(store), {
      take,
      shotId: "sh_12",
      producedBy: "frame-run:test",
    });
    assert.ok(filed.ok, `expected a filing, got ${filed.ok ? "" : filed.reason}`);

    const map = await selections(store);
    assert.equal(map["sh_12"]?.startFrameArtifactId, filed.artifactId);
    assert.equal(map["sh_12"]?.startFrameTakeId, null, "the footage pointer is cleared in the same commit");

    // The artifact carries bytes and a hash, which is what the dispatch audits against — and
    // exactly what a take could never provide.
    const sidecar = store.getBundle().artifacts.find((a) => a.id === filed.artifactId);
    assert.ok(sidecar, "the sidecar is on the world's shelf");
    assert.equal(sidecar!.kind, "image");
    assert.match(sidecar!.hash, /^sha256:[0-9a-f]{16}$/);
    assert.equal(
      sidecar!.boundaryExtraction,
      undefined,
      "no extraction provenance: that absence is what marks it as the shot's own",
    );
  });

  it("never touches the clip slot", async () => {
    const store = await open();
    const take = await still(store, "tk_drawn02", "sh_12");
    await fileDrawnFrame(store, production(store), { take, shotId: "sh_12", producedBy: "t" });
    const map = await selections(store);
    // The fixture already has a clip accepted on this shot; the point is that filing a frame
    // leaves it exactly where it was, not that the slot is empty.
    assert.equal(map["sh_12"]?.acceptedTakeId, "tk_01J8F0000000000000000000B2", "a still is not footage");
  });

  it("refuses anything that is not a still, by name", async () => {
    const store = await open();
    const clip = { ...(await still(store, "tk_clip01", "sh_12")), kind: "clip" } as Take;
    const filed = await fileDrawnFrame(store, production(store), {
      take: clip,
      shotId: "sh_12",
      producedBy: "t",
    });
    assert.equal(filed.ok, false);
    assert.ok(!filed.ok && /not a still/.test(filed.reason), filed.ok ? "" : filed.reason);
  });

  it("supersedes without deleting: the older take survives, the newest holds the slot", async () => {
    const store = await open();
    const first = await fileDrawnFrame(store, production(store), {
      take: await still(store, "tk_drawn03", "sh_12"),
      shotId: "sh_12",
      producedBy: "t1",
    });
    const second = await fileDrawnFrame(store, production(store), {
      take: await still(store, "tk_drawn04", "sh_12"),
      shotId: "sh_12",
      producedBy: "t2",
    });
    assert.ok(first.ok && second.ok);
    const map = await selections(store);
    assert.equal(map["sh_12"]?.startFrameArtifactId, second.artifactId, "the newest decision holds");
    assert.ok(
      store.getBundle().artifacts.some((a) => a.id === first.artifactId),
      "and the one it replaced is still on the shelf, not deleted",
    );
  });
});

describe("the continuity chain never overwrites a frame somebody chose", () => {
  it("leaves the following shot's own frame alone when a take is accepted before it", async () => {
    /*
     * This is the collision the precedence rule exists for. Draw a frame for shot 13, then
     * accept a clip for shot 12. Without the guard, accepting seeds shot 13's frame slot with
     * shot 12's footage and the drawn frame is silently gone — in exactly the workflow where
     * the whole point of drawing first was to choose what each shot opens on.
     */
    const store = await open();
    const drawn = await fileDrawnFrame(store, production(store), {
      take: await still(store, "tk_drawn05", "sh_13"),
      shotId: "sh_13",
      producedBy: "frame-run:test",
    });
    assert.ok(drawn.ok);

    const clipDir = join(store.dir, "productions", "saltlight", "takes", "tk_clip99");
    await mkdir(clipDir, { recursive: true });
    const clip = {
      id: "tk_clip99",
      jobId: "jb_clip99",
      kind: "clip",
      coversShots: ["sh_12"],
      media: "clip.mp4",
      model: "test-video",
      provenance: { canonRevision: 1, sheets: {} },
      cost: { estimatedMicroUsd: 1000, actualMicroUsd: 1000, actualSource: "manifest-derived" },
      createdAt: CLOCK(),
      completedAt: CLOCK(),
    } as unknown as Take;
    await writeFile(join(clipDir, "take.json"), JSON.stringify(clip, null, 2) + "\n");
    const fresh = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, { ...fresh, takes: [...fresh.takes, clip] }, {
      takeId: "tk_clip99",
      shotId: "sh_12",
      by: "test",
    });

    const map = await selections(store);
    assert.equal(
      map["sh_13"]?.startFrameArtifactId,
      drawn.artifactId,
      "the drawn frame still holds the slot",
    );
    assert.notEqual(
      map["sh_13"]?.startFrameTakeId,
      "tk_clip99",
      "and the accept did not seed footage over it",
    );
  });

  it("still seeds a following shot that has no frame of its own", async () => {
    const store = await open();
    const clipDir = join(store.dir, "productions", "saltlight", "takes", "tk_clip98");
    await mkdir(clipDir, { recursive: true });
    const clip = {
      id: "tk_clip98",
      jobId: "jb_clip98",
      kind: "clip",
      coversShots: ["sh_12"],
      media: "clip.mp4",
      model: "test-video",
      provenance: { canonRevision: 1, sheets: {} },
      cost: { estimatedMicroUsd: 1000, actualMicroUsd: 1000, actualSource: "manifest-derived" },
      createdAt: CLOCK(),
      completedAt: CLOCK(),
    } as unknown as Take;
    await writeFile(join(clipDir, "take.json"), JSON.stringify(clip, null, 2) + "\n");
    const fresh = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, { ...fresh, takes: [...fresh.takes, clip] }, {
      takeId: "tk_clip98",
      shotId: "sh_12",
      by: "test",
    });
    const map = await selections(store);
    assert.equal(map["sh_13"]?.startFrameTakeId, "tk_clip98", "continuity still does its job");
  });
});

describe("hasOwnFrame reads provenance, not a flag", () => {
  it("tells a drawn frame from a chained boundary still", () => {
    const drawn = { id: "art_drawn", kind: "image" };
    const chained = { id: "art_chain", kind: "image", boundaryExtraction: { sourceTakeId: "tk_1" } };
    const shelf = [drawn, chained];
    assert.equal(hasOwnFrame({ startFrameArtifactId: "art_drawn", trimInSec: 0 }, shelf), true);
    assert.equal(hasOwnFrame({ startFrameArtifactId: "art_chain", trimInSec: 0 }, shelf), false);
    assert.equal(hasOwnFrame({ startFrameArtifactId: "art_gone", trimInSec: 0 }, shelf), false);
    assert.equal(hasOwnFrame({ trimInSec: 0 }, shelf), false);
    assert.equal(hasOwnFrame(undefined, shelf), false);
  });
});

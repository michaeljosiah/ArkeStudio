import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasOwnFrame, type Selections, type Take } from "@arke-studio/contracts";
import { acceptStill, fileDrawnFrame } from "../../src/takes/drawn-frame.js";
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

/** Narrow to a filing that actually filed — a superseded no-op has no artifact to assert on. */
function filedOk(
  outcome: Awaited<ReturnType<typeof fileDrawnFrame>>,
): { ok: true; artifactId: string; shotId: string } {
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
  assert.ok(!("superseded" in outcome), "expected a filing, not a superseded no-op");
  return outcome as { ok: true; artifactId: string; shotId: string };
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
    const ok = filedOk(filed);

    const map = await selections(store);
    assert.equal(map["sh_12"]?.startFrameArtifactId, ok.artifactId);
    assert.equal(map["sh_12"]?.startFrameTakeId, null, "the footage pointer is cleared in the same commit");

    // The artifact carries bytes and a hash, which is what the dispatch audits against — and
    // exactly what a take could never provide.
    const sidecar = store.getBundle().artifacts.find((a) => a.id === ok.artifactId);
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
    const firstOk = filedOk(first);
    const secondOk = filedOk(second);
    const map = await selections(store);
    assert.equal(map["sh_12"]?.startFrameArtifactId, secondOk.artifactId, "the newest decision holds");
    assert.ok(
      store.getBundle().artifacts.some((a) => a.id === firstOk.artifactId),
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
    const drawnOk = filedOk(drawn);

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
      drawnOk.artifactId,
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

describe("a late arrival never overwrites a newer choice (R-22, T-18)", () => {
  it("declines to file when the slot moved since the run was authorized", async () => {
    /*
     * A frame run can be in flight for a minute. If somebody accepts a different frame for the
     * same shot meanwhile, the older job must not win by finishing later: completion order is
     * not authorization order. The take still lands — it is paid for and browsable — it is
     * simply not this shot's frame.
     */
    const store = await open();
    const authorized = (await selections(store))["sh_12"]?.startFrameArtifactId ?? null;

    // The newer choice, made while the run was out.
    const newer = filedOk(
      await fileDrawnFrame(store, production(store), {
        take: await still(store, "tk_newer", "sh_12"),
        shotId: "sh_12",
        producedBy: "accept:newer",
      }),
    );

    const late = await fileDrawnFrame(store, production(store), {
      take: await still(store, "tk_late", "sh_12"),
      shotId: "sh_12",
      producedBy: "frame-run:slow",
      expectedArtifactId: authorized,
    });
    assert.ok(late.ok, "being overtaken is not a failure");
    assert.ok("superseded" in late, "it is reported as superseded, so nothing logs an error");

    const map = await selections(store);
    assert.equal(map["sh_12"]?.startFrameArtifactId, newer.artifactId, "the newer choice stands");
  });

  it("files when the slot is exactly what the run was authorized against", async () => {
    const store = await open();
    const authorized = (await selections(store))["sh_12"]?.startFrameArtifactId ?? null;
    const filed = filedOk(
      await fileDrawnFrame(store, production(store), {
        take: await still(store, "tk_ontime", "sh_12"),
        shotId: "sh_12",
        producedBy: "frame-run:ontime",
        expectedArtifactId: authorized,
      }),
    );
    assert.equal((await selections(store))["sh_12"]?.startFrameArtifactId, filed.artifactId);
  });

  it("has no fence at all for an explicit accept", async () => {
    // Somebody pressing Accept is looking at the picture; the newest explicit act wins.
    const store = await open();
    filedOk(
      await fileDrawnFrame(store, production(store), {
        take: await still(store, "tk_first", "sh_12"),
        shotId: "sh_12",
        producedBy: "t1",
      }),
    );
    const second = filedOk(
      await fileDrawnFrame(store, production(store), {
        take: await still(store, "tk_second", "sh_12"),
        shotId: "sh_12",
        producedBy: "accept:second",
      }),
    );
    assert.equal((await selections(store))["sh_12"]?.startFrameArtifactId, second.artifactId);
  });
});

describe("accepting a still is one commit (SPEC-013 R-9, D6)", () => {
  it("lands the decision, the artifact and the frame slot together", async () => {
    const store = await open();
    const take = await still(store, "tk_acc01", "sh_13");
    const fresh = { ...production(store), takes: [...production(store).takes, take] };
    const { decision, outcome } = await acceptStill(store, fresh, {
      takeId: "tk_acc01",
      shotId: "sh_13",
      by: "user",
    });
    const ok = filedOk(outcome);
    assert.equal(decision.decision, "accept");

    // The review and the selection agree, because they were written together.
    const reviews = await readFile(
      join(store.dir, "productions", "saltlight", "reviews.jsonl"),
      "utf8",
    );
    assert.match(reviews, /tk_acc01/, "the decision is durable");
    const map = await selections(store);
    assert.equal(map["sh_13"]?.startFrameArtifactId, ok.artifactId, "and the slot names the frame");
    assert.equal(map["sh_13"]?.acceptedTakeId ?? null, null, "a still never enters the clip slot");
  });

  it("refuses a still through the footage path, rather than half-writing it", async () => {
    const store = await open();
    const take = await still(store, "tk_acc02", "sh_13");
    const fresh = { ...production(store), takes: [...production(store).takes, take] };
    await assert.rejects(
      () => acceptTake(store, fresh, { takeId: "tk_acc02", shotId: "sh_13", by: "user" }),
      /is a still/,
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasOwnFrame, orderedShots, type Job, type Selections, type Take } from "@arke-studio/contracts";
import { applySceneCommand } from "../../src/productions/scene-commands.js";
import { acceptStill, fileDrawnFrame, reviewAppendFor, slotAtAuthorizationOf } from "../../src/takes/drawn-frame.js";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import type { BoundaryFrameMaker } from "../../src/takes/boundary.js";
import { acceptTake } from "../../src/takes/review.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
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

async function boardParent(store: WorldStore): Promise<Take> {
  const landingDir = "productions/saltlight/incoming/board-parent-review-test";
  await mkdir(join(store.dir, landingDir), { recursive: true });
  await writeFile(join(store.dir, landingDir, "board.png"), encodePng(solidImage(8, 8, [20, 30, 40, 255])));
  const job = {
    id: "jb_01J8E0000000000000000000Q1",
    idempotencyKey: "01J8E1000000000000000000Q1",
    worldId: WORLD_ID,
    productionId: "saltlight",
    target: { kind: "board-sheet", coversShots: ["sh_13"] },
    capability: "image",
    provider: "test",
    model: "test-image",
    params: {
      prompt: "A board parent",
      references: [],
      provenance: { canonRevision: 42, sheets: {} },
      landing: "frame-slot",
    },
    estimatedMicroUsd: 1000,
    status: "succeeded",
    providerJobId: "board-parent-review-test",
    attempt: 1,
    landedFiles: [`${landingDir}/board.png`],
    error: null,
    createdAt: CLOCK(),
    updatedAt: CLOCK(),
  } as unknown as Job;
  const [parent] = await recordTakesFromJob(store, job, 1000);
  assert.ok(parent);
  return parent;
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

    const clipId = "tk_01J8F0000000000000000000B2";
    await acceptTake(store, production(store), {
      takeId: clipId,
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
      clipId,
      "and the accept did not seed footage over it",
    );
  });

  it("still seeds a following shot that has no frame of its own", async () => {
    const store = await open();
    const clipId = "tk_01J8C0000000000000000000C3";
    await acceptTake(store, production(store), {
      takeId: clipId,
      shotId: "sh_12",
      by: "test",
    });
    const map = await selections(store);
    assert.equal(map["sh_13"]?.startFrameTakeId, clipId, "continuity still does its job");
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
    await assert.rejects(
      () => acceptTake(store, production(store), {
        takeId: "tk_01J8A0000000000000000000A1",
        shotId: "sh_12",
        by: "user",
      }),
      /is a still/,
    );
  });

  it("refuses explicit acceptance of a durable board-sheet parent", async () => {
    const store = await open();
    const take = await boardParent(store);
    const fresh = production(store);
    await assert.rejects(
      () => acceptStill(store, fresh, { takeId: take.id, shotId: "sh_13", by: "user" }),
      /board-sheet parent/,
    );
    await assert.rejects(
      () => acceptTake(store, fresh, { takeId: take.id, shotId: "sh_13", by: "user" }),
      /board-sheet parent/,
    );
  });
});

describe("a non-PNG still normalises to PNG at filing", () => {
  /** A still whose media arrived as JPEG — valid provider output the board compiler cannot read. */
  async function jpegStill(store: WorldStore, id: string, shotId: string): Promise<Take> {
    const take = await still(store, id, shotId);
    const dir = join(store.dir, "productions", "saltlight", "takes", id);
    await writeFile(join(dir, "frame.jpg"), Buffer.from("jpeg-ish-bytes"));
    return { ...take, media: "frame.jpg" };
  }

  it("files the converted bytes, so compiled boards can decode every frame", async () => {
    const store = await open();
    const take = await jpegStill(store, "tk_jpg01", "sh_13");
    const converted = encodePng(solidImage(4, 4, [9, 9, 9, 255]));
    const toPng: BoundaryFrameMaker = {
      write: async (input, output, atSec) => {
        assert.ok(input.endsWith("frame.jpg"), "converts the take's own media");
        assert.equal(atSec, 0, "frame zero of a still image is the image");
        await writeFile(output, converted);
        return { ok: true };
      },
    };
    const filed = filedOk(
      await fileDrawnFrame(store, production(store), {
        take,
        shotId: "sh_13",
        producedBy: "frame-run:jpg",
        toPng,
      }),
    );
    const sidecar = store.getBundle().artifacts.find((a) => a.id === filed.artifactId);
    assert.ok(sidecar!.file.endsWith(".png"), "the filed frame is PNG");
    const bytes = await readFile(join(store.dir, "artifacts", sidecar!.file));
    assert.deepEqual(Uint8Array.from(bytes), Uint8Array.from(converted));
  });

  it("files the original bytes when conversion fails — a good frame is never lost to it", async () => {
    const store = await open();
    const take = await jpegStill(store, "tk_jpg02", "sh_13");
    const toPng: BoundaryFrameMaker = { write: async () => ({ ok: false, reason: "process-failed" }) };
    const filed = filedOk(
      await fileDrawnFrame(store, production(store), {
        take,
        shotId: "sh_13",
        producedBy: "frame-run:jpg",
        toPng,
      }),
    );
    const sidecar = store.getBundle().artifacts.find((a) => a.id === filed.artifactId);
    assert.ok(sidecar!.file.endsWith(".jpg"), "the original format stands");
    const bytes = await readFile(join(store.dir, "artifacts", sidecar!.file));
    assert.equal(bytes.toString(), "jpeg-ish-bytes");
  });

  it("restores an already-normalised frame without reading or converting its take again", async () => {
    const store = await open();
    const take = await jpegStill(store, "tk_jpg_restore", "sh_13");
    const converted = encodePng(solidImage(4, 4, [9, 9, 9, 255]));
    const toPng: BoundaryFrameMaker = {
      write: async (_input, output) => {
        await writeFile(output, converted);
        return { ok: true };
      },
    };
    const original = filedOk(
      await fileDrawnFrame(store, production(store), {
        take,
        shotId: "sh_13",
        producedBy: "frame-run:jpg-restore",
        toPng,
      }),
    );
    filedOk(
      await fileDrawnFrame(store, production(store), {
        take: await still(store, "tk_jpg_other", "sh_13"),
        shotId: "sh_13",
        producedBy: "frame-run:other",
      }),
    );
    await rm(join(store.dir, "productions", "saltlight", "takes", take.id), { recursive: true, force: true });
    let convertedAgain = false;
    const fresh = { ...production(store), takes: [take, ...production(store).takes.filter((candidate) => candidate.id !== take.id)] };

    const { outcome } = await acceptStill(store, fresh, {
      takeId: take.id,
      shotId: "sh_13",
      by: "user",
      requirePng: true,
      toPng: { write: async () => {
        convertedAgain = true;
        return { ok: false, reason: "process-failed" };
      } },
    });

    assert.equal(filedOk(outcome).artifactId, original.artifactId);
    assert.equal(convertedAgain, false, "the durable artifact is sufficient to restore the frame");
  });

  it("does not recreate a selection when its shot disappears during conversion", async () => {
    const store = await open();
    const scene = production(store).scenes.find((candidate) => candidate.id === "sc_04")!;
    const shotId = orderedShots(scene).at(-1)!.id;
    const take = await jpegStill(store, "tk_jpg03", shotId);
    const toPng: BoundaryFrameMaker = {
      write: async (_input, output) => {
        await applySceneCommand(store, {
          productionId: "saltlight",
          sceneFile: "04-the-verse-rises",
          sceneId: scene.id,
          baseVersion: scene.version,
          command: { kind: "delete-shot", shotId },
        });
        await writeFile(output, encodePng(solidImage(4, 4, [9, 9, 9, 255])));
        return { ok: true };
      },
    };

    const outcome = await fileDrawnFrame(store, production(store), {
      take,
      shotId,
      producedBy: "accept:deleted",
      toPng,
    });

    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.reason, /no shot/);
    assert.equal((await selections(store))[shotId], undefined);
    assert.ok(!store.getBundle().artifacts.some((artifact) => artifact.links.includes(take.id)));
  });
});

describe("the authorization snapshot rides the frozen request", () => {
  it("reads the durable frame-run shape: params.request.slotAtAuthorization", () => {
    const map = { sh_12: "ar_01J8E0000000000000000000A1", sh_13: null };
    assert.deepEqual(
      slotAtAuthorizationOf({ frameRun: "fr_x", landing: "frame-slot", request: { slotAtAuthorization: map } }),
      map,
    );
  });

  it("honours a top-level snapshot on a hand-enqueued one-shot", () => {
    const map = { sh_12: null };
    assert.deepEqual(slotAtAuthorizationOf({ landing: "frame-slot", slotAtAuthorization: map }), map);
  });

  it("returns undefined — no fence — when neither shape carries one", () => {
    assert.equal(slotAtAuthorizationOf({ landing: "frame-slot" }), undefined);
    assert.equal(slotAtAuthorizationOf({ landing: "frame-slot", request: { prompt: "x" } }), undefined);
  });
});

describe("a frame-slot finalization can replay", () => {
  it("recording twice for the same job rejoins the take it already wrote", async () => {
    /*
     * The retry path: filing failed after the take became durable, the user pressed retry, and
     * the whole finalization re-ran. The landing file is long gone — it moved into the take's
     * directory the first time — so the replay must find that take, not mint a second and try
     * to move nothing.
     */
    const store = await open();
    const landingDir = "productions/saltlight/incoming/jb-frame";
    await mkdir(join(store.dir, landingDir), { recursive: true });
    await writeFile(join(store.dir, landingDir, "output-1.png"), encodePng(solidImage(4, 4, [1, 2, 3, 255])));
    const job = {
      id: "jb_01J8E000000000000000000FR1",
      idempotencyKey: "01J8E100000000000000000FR1",
      worldId: WORLD_ID,
      productionId: "saltlight",
      target: { kind: "shot", id: "sh_13", coversShots: ["sh_13"] },
      capability: "image",
      provider: "fal",
      model: "image-like",
      params: { prompt: "the opening picture", landing: "frame-slot" },
      estimatedMicroUsd: 1000,
      status: "succeeded",
      providerJobId: "fal_1",
      attempt: 1,
      landing: { dir: landingDir },
      landedFiles: [`${landingDir}/output-1.png`],
      error: null,
      createdAt: CLOCK(),
      updatedAt: CLOCK(),
    } as unknown as Job;

    const [first] = await recordTakesFromJob(store, job, null);
    assert.ok(first);
    assert.equal(first.id, `tk_${job.id.slice(3)}`, "deterministic, so a crash mid-write is recoverable");
    const [second] = await recordTakesFromJob(store, job, null);
    assert.equal(second?.id, first.id, "the replay rejoins rather than minting a second take");
  });
});

describe("an auto-filed frame is already decided", () => {
  const decisionFor = (takeId: string, shotId: string) =>
    ({
      ts: CLOCK(),
      takeId,
      shotId,
      decision: "accept",
      by: "frame-run:jb_test",
    }) as Parameters<typeof reviewAppendFor>[2];

  it("the filing carries its accept, so nothing asks for a second one", async () => {
    // computeNeedsYou counts a production take with no review as awaiting one; a frame the run
    // installed would nag for exactly the second Accept SPEC-036 R-20 retires.
    const store = await open();
    const take = await still(store, "tk_auto01", "sh_13");
    filedOk(
      await fileDrawnFrame(store, production(store), {
        take,
        shotId: "sh_13",
        producedBy: "frame-run:jb_test",
        alsoCommit: async () => [await reviewAppendFor(store, "saltlight", decisionFor("tk_auto01", "sh_13"))],
      }),
    );
    const reviews = await readFile(join(store.dir, "productions", "saltlight", "reviews.jsonl"), "utf8");
    assert.match(reviews, /tk_auto01/, "the decision landed with the filing");
  });

  it("consecutive filings chain their appends, and an overtaken one records nothing", async () => {
    const store = await open();
    const first = await still(store, "tk_auto02", "sh_13");
    const second = await still(store, "tk_auto03", "sh_14");
    filedOk(
      await fileDrawnFrame(store, production(store), {
        take: first,
        shotId: "sh_13",
        producedBy: "frame-run:jb_test",
        alsoCommit: async () => [await reviewAppendFor(store, "saltlight", decisionFor("tk_auto02", "sh_13"))],
      }),
    );
    filedOk(
      await fileDrawnFrame(store, production(store), {
        take: second,
        shotId: "sh_14",
        producedBy: "frame-run:jb_test",
        alsoCommit: async () => [await reviewAppendFor(store, "saltlight", decisionFor("tk_auto03", "sh_14"))],
      }),
    );

    // A stale fence: the append is prepared, but the superseded filing commits nothing at all.
    const late = await still(store, "tk_auto04", "sh_13");
    const overtaken = await fileDrawnFrame(store, production(store), {
      take: late,
      shotId: "sh_13",
      producedBy: "frame-run:jb_slow",
      expectedArtifactId: null,
      alsoCommit: async () => [await reviewAppendFor(store, "saltlight", decisionFor("tk_auto04", "sh_13"))],
    });
    assert.ok(overtaken.ok && "superseded" in overtaken);

    const reviews = await readFile(join(store.dir, "productions", "saltlight", "reviews.jsonl"), "utf8");
    assert.match(reviews, /tk_auto02/);
    assert.match(reviews, /tk_auto03/, "the second append chained on the first");
    assert.ok(!reviews.includes("tk_auto04"), "no decision for a frame that was never installed");
  });

  it("serializes concurrent review appends with their frame commits", async () => {
    const store = await open();
    const first = await still(store, "tk_auto06", "sh_13");
    const second = await still(store, "tk_auto07", "sh_14");
    const current = production(store);
    const [firstFiled, secondFiled] = await Promise.all([
      fileDrawnFrame(store, current, {
        take: first,
        shotId: "sh_13",
        producedBy: "frame-run:jb_parallel_1",
        alsoCommit: async () => [await reviewAppendFor(store, "saltlight", decisionFor(first.id, "sh_13"))],
      }),
      fileDrawnFrame(store, current, {
        take: second,
        shotId: "sh_14",
        producedBy: "frame-run:jb_parallel_2",
        alsoCommit: async () => [await reviewAppendFor(store, "saltlight", decisionFor(second.id, "sh_14"))],
      }),
    ]);
    filedOk(firstFiled);
    filedOk(secondFiled);
    const reviews = await readFile(join(store.dir, "productions", "saltlight", "reviews.jsonl"), "utf8");
    assert.match(reviews, /tk_auto06/);
    assert.match(reviews, /tk_auto07/);
  });

  it("replay after filing recognizes the same job's artifact instead of calling it superseded", async () => {
    const store = await open();
    const take = await still(store, "tk_auto05", "sh_13");
    const first = filedOk(await fileDrawnFrame(store, production(store), {
      take,
      shotId: "sh_13",
      producedBy: "frame-run:jb_replay",
      expectedArtifactId: null,
    }));
    const replayed = await fileDrawnFrame(store, production(store), {
      take,
      shotId: "sh_13",
      producedBy: "frame-run:jb_replay",
      expectedArtifactId: null,
    });
    assert.ok(replayed.ok && !("superseded" in replayed));
    assert.equal("artifactId" in replayed ? replayed.artifactId : null, first.artifactId);
  });
});

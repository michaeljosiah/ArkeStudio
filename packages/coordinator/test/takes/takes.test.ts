import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildExportPlan,
  buildFfmpegArgs,
  deriveCut,
  type ExportPlan,
  type Job,
  type ProductionBundle,
} from "@arke-studio/contracts";
import { closeOnCleanup, tempDir } from "../tmp.js";
import { readChanges } from "../../src/world/change-writer.js";
import { applySceneCommand } from "../../src/productions/scene-commands.js";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import { exportWorld, runExport, type FfmpegRunner } from "../../src/takes/export.js";
import { acceptTake, applyTakeAcceptance, rejectTake, setTrim } from "../../src/takes/review.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { legacySceneView, orderedShots, routingFindings } from "@arke-studio/contracts";

const CLOCK = () => "2026-08-01T12:00:00.000Z";
const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

function passJob(landed: string): Job {
  return {
    id: "jb_01J8E0000000000000000000P1",
    idempotencyKey: "01J8E1000000000000000000P1",
    worldId: WORLD,
    productionId: "saltlight",
    target: { kind: "scene-pass", id: "sc_04", coversShots: ["sh_12", "sh_13", "sh_14"] },
    capability: "video",
    provider: "fal",
    model: "seedance-2.0",
    params: {
      prompt: "the pass prompt",
      references: ["references/maren-kest/model-sheet-v4.png"],
      shotPlan: [
        { shotId: "sh_12", number: 12, startSec: 0, endSec: 6 },
        { shotId: "sh_13", number: 13, startSec: 6, endSec: 12 },
        { shotId: "sh_14", number: 14, startSec: 12, endSec: 19.5 },
      ],
      provenance: { canonRevision: 42, sheets: { "maren-kest": 4, "the-vigil": 2 } },
    },
    estimatedMicroUsd: 422507,
    status: "succeeded",
    providerJobId: "fal_p1",
    attempt: 1,
    landing: { dir: "productions/saltlight/incoming/sc_04-pass-1" },
    landedFiles: [landed],
    error: null,
    createdAt: "2026-08-01T11:00:00Z",
    updatedAt: "2026-08-01T11:05:00Z",
  };
}

async function landPass(dir: string): Promise<string> {
  const rel = "productions/saltlight/incoming/sc_04-pass-1/output-1.mp4";
  await mkdir(join(dir, "productions/saltlight/incoming/sc_04-pass-1"), { recursive: true });
  await writeFile(join(dir, rel), Buffer.from("fake-mp4-bytes-fake-mp4-bytes"));
  return rel;
}

describe("pass segmentation (R-3..R-5, D2..D4, §3.2)", () => {
  it("one media file, three range takes, boundaries from the plan, allocated costs sum exactly", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), 400000);
    assert.equal(takes.length, 4, "the pass plus three segments");
    const [pass, ...segments] = takes;

    // One media file is stored (R-3): only the pass's directory holds media.
    const takesRoot = join(dir, "productions", "saltlight", "takes");
    let mediaCount = 0;
    for (const id of takes.map((t) => t.id)) {
      const entries = await readdir(join(takesRoot, id));
      mediaCount += entries.filter((f) => f.endsWith(".mp4")).length;
    }
    assert.equal(mediaCount, 1);
    assert.equal(pass!.media, "output-1.mp4");
    const incoming = await readdir(join(dir, "productions/saltlight/incoming")).catch(() => []);
    assert.equal(incoming.length, 0, "the landing dir is consumed");

    // Boundaries match the shot plan exactly — never inspection (R-4, D3).
    assert.deepEqual(
      segments.map((s) => [s.coversShots[0], s.segment!.inSec, s.segment!.outSec]),
      [
        ["sh_12", 0, 6],
        ["sh_13", 6, 12],
        ["sh_14", 12, 19.5],
      ],
    );
    for (const s of segments) assert.equal(s.segment!.passTakeId, pass!.id);

    // The pass carries the real charge; segments carry allocated shares summing to it (R-5, D4).
    assert.equal(pass!.cost.actualMicroUsd, 400000);
    assert.notEqual(pass!.cost.allocated, true);
    const shares = segments.map((s) => s.cost.actualMicroUsd!);
    assert.equal(shares.reduce((a, b) => a + b, 0), 400000, "shares sum exactly — the remainder lands on the last");
    for (const s of segments) assert.equal(s.cost.allocated, true, "divided, and marked so");
    await store.close();
  });
});

describe("immutability and review (R-1, R-2, R-6..R-11, D1, D5, D6, §3.2)", () => {
  it("a rejected take is byte-identical; two decisions coexist and the later governs", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), 400000);
    const segment = takes[1]!;
    const takePath = join(dir, "productions", "saltlight", "takes", segment.id, "take.json");
    const before = await readFile(takePath);

    let production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await rejectTake(store, production, {
      takeId: segment.id,
      shotId: "sh_12",
      by: "user",
      citation: { sheet: "maren-kest", field: "appearance", note: "coat drifted" },
    });
    assert.deepEqual(await readFile(takePath), before, "the take record is unchanged (R-1)");

    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: segment.id, shotId: "sh_12", by: "user" });
    const reviews = (await readFile(join(dir, "productions/saltlight/reviews.jsonl"), "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { takeId: string; decision: string });
    const mine = reviews.filter((r) => r.takeId === segment.id);
    assert.equal(mine.length, 2, "append-only: the earlier decision is not erased (R-6)");
    assert.equal(mine[mine.length - 1]!.decision, "accept", "the later governs");
    await store.close();
  });

  it("a trim belongs to the footage it was measured against, so a new take resets it (#253)", async () => {
    // Codex round 1 P1. The reset was written *before* the spread of the existing selection, so a
    // nonzero trim from the old media survived onto the newly selected take — the cut would start
    // at an unrelated moment while the coordinator's own event reported a zero trim.
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), null);
    let production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;

    await assert.rejects(
      () => acceptTake(store, production, { takeId: takes[0]!.id, shotId: "sh_12", by: "user" }),
      /backing pass/,
    );
    await acceptTake(store, production, { takeId: takes[1]!.id, shotId: "sh_12", by: "user" });
    await store.ownedWrite(async () => {
      const path = join(dir, "productions/saltlight/selections.json");
      const withTrim = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        { acceptedTakeId?: string; trimInSec?: number }
      >;
      withTrim["sh_12"] = { ...withTrim["sh_12"], trimInSec: 4.25 };
      await writeFile(path, JSON.stringify(withTrim, null, 2), "utf8");
    });

    // Re-accepting the same take changes nothing about the footage, so the in-point stands.
    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: takes[1]!.id, shotId: "sh_12", by: "user" });
    assert.equal(
      store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.selections["sh_12"]?.trimInSec,
      4.25,
      "same take, same footage, same in-point",
    );

    // A different take is different footage: 4.25s into one clip is not 4.25s into another.
    const secondLanding = await landPass(dir);
    const secondTakes = await recordTakesFromJob(
      store,
      {
        ...passJob(secondLanding),
        id: "jb_01J8E0000000000000000000P2",
        idempotencyKey: "01J8E1000000000000000000P2",
        providerJobId: "fal_p2",
      },
      null,
    );
    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: secondTakes[1]!.id, shotId: "sh_12", by: "user" });
    const after = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.selections["sh_12"];
    assert.equal(after?.acceptedTakeId, secondTakes[1]!.id);
    assert.equal(after?.trimInSec, 0, "the in-point is reset, not carried onto unrelated footage");
    await store.close();
  });

  it("set-trim writes the in-point on the selection and leaves the take alone (R-8, #253)", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    // takes[0] is the backing pass; the shot's material is its own segment (see materialFor).
    const [, seg12] = await recordTakesFromJob(store, passJob(landed), null);
    let production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: seg12!.id, shotId: "sh_12", by: "user" });

    const takeBefore = await readFile(join(dir, `productions/saltlight/takes/${seg12!.id}/take.json`), "utf8");
    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const selection = await setTrim(store, production, { shotId: "sh_12", trimInSec: 2.5 });

    assert.equal(selection.trimInSec, 2.5);
    assert.equal(selection.acceptedTakeId, seg12!.id, "the selection it trims is otherwise untouched");
    assert.equal(
      store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.selections["sh_12"]?.trimInSec,
      2.5,
      "and it survives the reload",
    );
    assert.equal(
      await readFile(join(dir, `productions/saltlight/takes/${seg12!.id}/take.json`), "utf8"),
      takeBefore,
      "a take is immutable (R-1): a trim says which part of it is used, it does not edit it",
    );
    await store.close();
  });

  it("set-trim refuses a shot with no accepted take", async () => {
    // A number stored against no footage is one waiting to apply itself to whatever gets
    // selected next — the very bug acceptTake's reset exists to prevent.
    const { dir, store } = await open();
    const landed = await landPass(dir);
    await recordTakesFromJob(store, passJob(landed), null);
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await assert.rejects(
      () => setTrim(store, production, { shotId: "sh_13", trimInSec: 1 }),
      /no accepted take/,
    );
    assert.equal(store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.selections["sh_13"], undefined);
    await store.close();
  });

  it("accept refuses a backing pass the cut cannot use for one shot", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const [pass] = await recordTakesFromJob(store, passJob(landed), null);
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await assert.rejects(
      () => acceptTake(store, production, { takeId: pass!.id, shotId: "sh_12", by: "user" }),
      /backing pass/,
    );
    assert.notEqual(production.selections["sh_12"]?.acceptedTakeId, pass!.id);
    const legacy = structuredClone(production);
    legacy.selections["sh_12"] = { acceptedTakeId: pass!.id, trimInSec: 0 };
    assert.equal(
      deriveCut(legacy).entries.find((entry) => entry.shot.id === "sh_12")?.takeId,
      null,
      "a persisted backing selection is a cut gap rather than playable footage",
    );
    await store.close();
  });

  it("set-trim refuses a trim that would leave nothing of the material", async () => {
    // sh_12's segment is planned 0→6 (passJob's shotPlan), so the planned boundary bounds the
    // trim at 6s even though nothing has probed the file.
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const [, seg12] = await recordTakesFromJob(store, passJob(landed), null);
    let production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: seg12!.id, shotId: "sh_12", by: "user" });

    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await assert.rejects(() => setTrim(store, production, { shotId: "sh_12", trimInSec: 6 }), /leaves nothing/);
    await assert.rejects(() => setTrim(store, production, { shotId: "sh_12", trimInSec: 9 }), /leaves nothing/);
    assert.equal(
      store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.selections["sh_12"]?.trimInSec,
      0,
      "a refused trim writes nothing",
    );

    // Right up to the boundary is still material.
    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await setTrim(store, production, { shotId: "sh_12", trimInSec: 5.9 });
    assert.equal(
      store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.selections["sh_12"]?.trimInSec,
      5.9,
    );
    await store.close();
  });

  it("a trim set through the real writer still resets when the take changes (#253)", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const [, seg12] = await recordTakesFromJob(store, passJob(landed), null);
    let production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: seg12!.id, shotId: "sh_12", by: "user" });

    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await setTrim(store, production, { shotId: "sh_12", trimInSec: 4.25 });

    const secondLanding = await landPass(dir);
    const [, secondSeg12] = await recordTakesFromJob(
      store,
      {
        ...passJob(secondLanding),
        id: "jb_01J8E0000000000000000000P3",
        idempotencyKey: "01J8E1000000000000000000P3",
        providerJobId: "fal_p3",
      },
      null,
    );
    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: secondSeg12!.id, shotId: "sh_12", by: "user" });
    assert.equal(
      store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.selections["sh_12"]?.trimInSec,
      0,
      "4.25s into one clip is not 4.25s into another",
    );
    await store.close();
  });

  it("rejecting requires a cited sheet and field, and touches no selection (R-10)", async () => {
    const { dir, store } = await open();
    const production = store.getBundle().productions[0]!;
    await assert.rejects(
      () =>
        rejectTake(store, production, {
          takeId: "tk_01J8A0000000000000000000A1",
          by: "user",
          citation: { sheet: "maren-kest", field: "" },
        }),
      /requires a cited sheet and field/,
    );
    const selectionsBefore = await readFile(join(dir, "productions/saltlight/selections.json"), "utf8");
    await rejectTake(store, production, {
      takeId: "tk_01J8A0000000000000000000A1",
      shotId: "sh_12",
      by: "user",
      citation: { sheet: "maren-kest", field: "appearance" },
    });
    const selectionsAfter = await readFile(join(dir, "productions/saltlight/selections.json"), "utf8");
    assert.equal(selectionsAfter, selectionsBefore, "any existing selection stays untouched");
    await store.close();
  });

  it("accepting creates no proposal, bumps no scene version, and is ONE commit (R-8, R-9, D6, D7)", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), null);
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const proposalsBefore = store.getBundle().proposals.length;
    const sceneVersionBefore = production.scenes.find((s) => s.id === "sc_04")!.version;

    await acceptTake(store, production, { takeId: takes[1]!.id, shotId: "sh_12", by: "user" });

    const after = store.getBundle();
    assert.equal(after.proposals.length, proposalsBefore, "no proposal (R-8)");
    assert.equal(
      after.productions.find((p) => p.meta.id === "saltlight")!.scenes.find((s) => s.id === "sc_04")!.version,
      sceneVersionBefore,
      "no scene version bump — selections are operational, scenes are gated",
    );
    // One commit (R-9, D6): the last change records for reviews + selections share a commitId.
    const changes = await readChanges(join(dir, "changes.jsonl"));
    const tail = changes.slice(-2) as Array<{ commitId: string; entity: string }>;
    assert.equal(tail[0]!.commitId, tail[1]!.commitId, "decision and selection landed atomically");
    assert.ok(tail.some((c) => c.entity.includes("reviews")));
    assert.ok(tail.some((c) => c.entity.includes("selections")));
    await store.close();
  });

  it("continuity chains from the PASS for a segment (R-12, D8)", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), null);
    const [pass, seg12] = takes;
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: seg12!.id, shotId: "sh_12", by: "user" });
    const selections = JSON.parse(await readFile(join(dir, "productions/saltlight/selections.json"), "utf8")) as Record<
      string,
      { startFrameTakeId?: string }
    >;
    assert.equal(
      selections["sh_13"]?.startFrameTakeId,
      pass!.id,
      "the following shot's start frame comes from the pass, not the segment — no duplicated frame",
    );
    await store.close();
  });

  it("refuses acceptance when a queued deletion removes the shot first", async () => {
    const { store } = await open();
    const stale = store.getBundle().productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = stale.scenes.find((candidate) => orderedShots(candidate).some((shot) => shot.id === "sh_13"))!;

    let releaseHolder!: () => void;
    let holderEntered!: () => void;
    const held = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const inside = new Promise<void>((resolve) => { holderEntered = resolve; });
    const gateOp = store.gateOp.bind(store);
    const holder = gateOp(async () => {
      holderEntered();
      await held;
    });
    await inside;

    let deletionQueued!: () => void;
    const queued = new Promise<void>((resolve) => { deletionQueued = resolve; });
    let gateCalls = 0;
    store.gateOp = <T>(operation: () => Promise<T>): Promise<T> => {
      gateCalls += 1;
      if (gateCalls === 1) deletionQueued();
      return gateOp(operation);
    };
    const deleting = applySceneCommand(store, {
      productionId: stale.meta.id,
      sceneFile: "04-the-verse-rises",
      sceneId: scene.id,
      baseVersion: scene.version,
      command: { kind: "delete-shot", shotId: "sh_13" },
    });
    await queued;

    const accepting = acceptTake(store, stale, {
      takeId: "tk_01J8D0000000000000000000D4",
      shotId: "sh_13",
      by: "user",
    });
    const refused = assert.rejects(accepting, /shot sh_13 is no longer in production saltlight/);
    releaseHolder();
    await Promise.all([holder, deleting, refused]);

    const current = store.getBundle().productions.find((candidate) => candidate.meta.id === "saltlight")!;
    assert.ok(!current.scenes.some((candidate) => orderedShots(candidate).some((shot) => shot.id === "sh_13")));
    assert.equal(current.selections["sh_13"], undefined, "acceptance does not recreate the deleted selection");
    assert.ok(
      !current.reviews.some(
        (review) => review.takeId === "tk_01J8D0000000000000000000D4" && review.decision === "accept",
      ),
      "acceptance records no decision for the deleted shot",
    );
  });

  it("keeps a continuation on no-op accept, then clears and guards it when its predecessor changes", async () => {
    const { dir, store } = await open();
    const predecessor = "tk_01J8F0000000000000000000B2";
    const replacement = "tk_01J8C0000000000000000000C3";
    const continuation = "tk_01J8D0000000000000000000D4";
    const continuationPath = join(dir, "productions/saltlight/takes", continuation, "take.json");
    const immutableBefore = await readFile(continuationPath, "utf8");
    let acceptedSelections = store.getBundle().productions.find(
      (production) => production.meta.id === "saltlight",
    )!.selections;
    const productionWithEdge = () => {
      const current = store.getBundle().productions.find((production) => production.meta.id === "saltlight")!;
      return {
        ...current,
        selections: acceptedSelections,
        takes: current.takes.map((take) =>
          take.id === continuation ? { ...take, continuedFrom: predecessor as never } : take,
        ),
      };
    };
    const accept = (candidate: ProductionBundle, input: { takeId: string; shotId: string }): void => {
      acceptedSelections = applyTakeAcceptance(
        candidate,
        store.getBundle().artifacts,
        acceptedSelections,
        { ...input, by: "user", at: CLOCK() },
      ).selections;
    };

    accept(productionWithEdge(), { takeId: continuation, shotId: "sh_13" });
    accept(productionWithEdge(), { takeId: predecessor, shotId: "sh_12" });
    assert.equal(
      acceptedSelections["sh_13"]?.acceptedTakeId,
      continuation,
      "re-accepting the same predecessor invalidates nothing",
    );
    const reordered = productionWithEdge();
    reordered.scenes = reordered.scenes.map((record) => legacySceneView(record)).map((scene) =>
      scene.shots.some((shot) => shot.id === "sh_13")
        ? {
            ...scene,
            shots: [...scene.shots].sort((a, b) =>
              a.id === "sh_13" ? -1 : b.id === "sh_13" ? 1 : 0,
            ),
          }
        : scene,
    );
    assert.equal(
      deriveCut(reordered).entries.find((entry) => entry.shot.id === "sh_13")?.takeId,
      null,
      "reordering cannot keep a continuation whose predecessor is no longer immediately before it",
    );

    const multiHop = productionWithEdge();
    multiHop.takes = multiHop.takes.map((take) =>
      take.id === predecessor ? { ...take, continuedFrom: replacement as never } : take,
    );
    assert.throws(
      () => accept(multiHop, { takeId: continuation, shotId: "sh_13" }),
      /itself continued/,
    );
    assert.throws(
      () => accept(productionWithEdge(), { takeId: continuation, shotId: "sh_14" }),
      /does not cover shot/,
    );

    accept(productionWithEdge(), { takeId: replacement, shotId: "sh_12" });
    let production = productionWithEdge();
    assert.equal(production.selections["sh_13"]?.acceptedTakeId, null);
    assert.equal(
      deriveCut(production).entries.find((entry) => entry.shot.id === "sh_13")?.takeId,
      null,
      "the derived cut cannot keep stale continuation footage",
    );
    assert.throws(
      () => accept(production, { takeId: continuation, shotId: "sh_13" }),
      /footage no longer selected/,
    );

    accept(production, { takeId: predecessor, shotId: "sh_12" });
    production = productionWithEdge();
    accept(production, { takeId: continuation, shotId: "sh_13" });
    assert.equal(
      acceptedSelections["sh_13"]?.acceptedTakeId,
      continuation,
      "restoring the exact predecessor makes the continuation valid again",
    );
    assert.equal(await readFile(continuationPath, "utf8"), immutableBefore, "selection changes never edit the take");
    await store.close();
  });

  it("does not treat either Interactive route into a scene as its first shot's predecessor", async () => {
    const { store } = await open();
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const leftTakeId = "tk_01J8F0000000000000000000B2";
    const rightTakeId = "tk_01J8D0000000000000000000D4";
    const joinTakeId = "tk_01J8E0000000000000000000E5";
    const source = legacySceneView(
      production.scenes.find((scene) => orderedShots(scene).some((shot) => shot.id === "sh_12"))!,
    );
    const shot = (id: string) => source.shots.find((candidate) => candidate.id === id)!;
    const scenes = [
      { ...source, id: "sc_start", number: 1, slug: "start", shots: [shot("sh_15")] },
      { ...source, id: "sc_left", number: 2, slug: "left", shots: [shot("sh_12")] },
      { ...source, id: "sc_right", number: 3, slug: "right", shots: [shot("sh_13")] },
      { ...source, id: "sc_join", number: 4, slug: "join", shots: [shot("sh_14")] },
    ];
    const routed = (continuedFrom: string): ProductionBundle => ({
      ...production,
      meta: { ...production.meta, medium: "interactive-video", kind: "interactive" },
      scenes,
      routing: {
        version: 1,
        start: "sc_start",
        choices: [
          { id: "ch_left", from: "sc_start", label: "Left", to: "sc_left" },
          { id: "ch_right", from: "sc_start", label: "Right", to: "sc_right" },
          { id: "ch_left-join", from: "sc_left", label: "Join", to: "sc_join" },
          { id: "ch_right-join", from: "sc_right", label: "Join", to: "sc_join" },
        ],
        endings: [{ sceneId: "sc_join", title: "Joined" }],
        excluded: [],
        groups: [],
      },
      takes: [
        ...production.takes,
        {
          ...production.takes.find((take) => take.id === rightTakeId)!,
          id: joinTakeId,
          coversShots: ["sh_14"],
          continuedFrom: continuedFrom as never,
        },
      ],
    });

    let selected = applyTakeAcceptance(
      routed(leftTakeId),
      store.getBundle().artifacts,
      production.selections,
      { takeId: rightTakeId, shotId: "sh_13", by: "user", at: CLOCK() },
    ).selections;
    assert.equal(selected["sh_12"]?.acceptedTakeId, leftTakeId);
    assert.equal(selected["sh_13"]?.acceptedTakeId, rightTakeId);
    const reconverged = routed(leftTakeId);
    assert.ok(
      routingFindings(reconverged.routing!, reconverged.scenes).some(
        (finding) => finding.kind === "reconvergence" && finding.sceneIds.includes("sc_join"),
      ),
      "the target scene is reached from both predecessor scenes",
    );
    assert.equal(orderedShots(scenes[3]!).at(0)?.id, "sh_14", "the continuation target is the scene's first shot");

    for (const predecessor of [leftTakeId, rightTakeId]) {
      assert.throws(
        () => {
          selected = applyTakeAcceptance(
            routed(predecessor),
            store.getBundle().artifacts,
            selected,
            { takeId: joinTakeId, shotId: "sh_14", by: "user", at: CLOCK() },
          ).selections;
        },
        /in this scene/,
        `${predecessor} belongs to an inbound route, not the target scene`,
      );
    }
    assert.equal(
      selected["sh_14"],
      undefined,
      "neither route selects continuation footage for the join scene",
    );
    await store.close();
  });
});

describe("the derived cut (R-14..R-16, D9, §3.2)", () => {
  it("changes with a selection immediately; gaps carry labels and durations", async () => {
    const { dir, store } = await open();
    let production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const before = deriveCut(production);
    assert.ok(before.entries.length > 0);
    const covered = before.entries.find((e) => e.shot.id === "sh_12");
    assert.ok(covered?.takeId, "the fixture selection covers sh_12");
    const gap = before.entries.find((e) => e.takeId === null);
    assert.ok(gap, "gaps exist and are entries, not omissions");
    assert.match(gap!.label, /SHOT \d+/);
    assert.ok(gap!.durationSec > 0);

    /*
     * Accept a different take for sh_12: the cut reflects it with no reconciliation step.
     *
     * The take has to be *footage*. This used to accept `tk_...A1`, which is the fixture's
     * `kind: "frame"` take — a PNG — and asserted the cut played it. That was the collision
     * SPEC-036 R-21 ends: a still in the clip slot, which the cut then treats as a clip and
     * the export tries to encode. A still accepted anywhere now lands on the frame slot
     * instead, so the shot is covered here by a clip the test lands itself.
     */
    const landed = await landPass(dir);
    const passTakes = await recordTakesFromJob(store, passJob(landed), 400000);
    const coveringShot12 = passTakes.find(
      (t) => t.coversShots.length === 1 && t.coversShots[0] === "sh_12",
    )!;
    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: coveringShot12.id, shotId: "sh_12", by: "user" });
    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const after = deriveCut(production);
    assert.equal(after.entries.find((e) => e.shot.id === "sh_12")!.takeId, coveringShot12.id);
    await store.close();
  });

  it("a segment resolves to the pass media with its range", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), null);
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: takes[2]!.id, shotId: "sh_13", by: "user" });
    const cut = deriveCut(store.getBundle().productions.find((p) => p.meta.id === "saltlight")!);
    const entry = cut.entries.find((e) => e.shot.id === "sh_13")!;
    assert.ok(entry.media!.path.includes(takes[0]!.id), "the pass's media, not a segment file");
    assert.equal(entry.media!.inSec, 6);
    assert.equal(entry.media!.outSec, 12);
    await store.close();
  });

  it("the story clock honours the in-point, moving the window's start and not its end (#253)", async () => {
    // `-to` is an absolute position in the source -- verified against ffmpeg 8.1, where
    // `-ss 2 -to 6` yields exactly 4.0s -- so advancing `inSec` past a fixed `outSec` shortens
    // this segment from the front rather than dragging it into the next shot's footage.
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), null);
    let production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: takes[2]!.id, shotId: "sh_13", by: "user" });

    production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await setTrim(store, production, { shotId: "sh_13", trimInSec: 2 });

    const entry = deriveCut(store.getBundle().productions.find((p) => p.meta.id === "saltlight")!)
      .entries.find((e) => e.shot.id === "sh_13")!;
    assert.equal(entry.media!.inSec, 8, "6s segment start plus a 2s trim");
    assert.equal(entry.media!.outSec, 12, "the end is the plan's, and the plan did not move");
    assert.equal(entry.durationSec, 6, "the slot is still the authored duration: trim is not a boundary");

    // What the encoder is actually told, which is the half that can silently export the wrong shot.
    const args = buildFfmpegArgs(buildExportPlan(deriveCut(store.getBundle().productions.find((p) => p.meta.id === "saltlight")!), "review-cut"), "/w", "/out.mp4", "/fonts/Geist-Regular.ttf");
    const ss = args.indexOf("-ss");
    assert.equal(args[ss + 1], "8");
    assert.equal(args[args.indexOf("-to") + 1], "12");
    await store.close();
  });

  it("an untrimmed cut names no in-point at all, so an untrimmed export is unchanged (#253)", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    // One shot, no shot plan: a take that owns its media outright rather than a range within one.
    const takes = await recordTakesFromJob(
      store,
      { ...passJob(landed), target: { kind: "shot", id: "sh_12", coversShots: ["sh_12"] }, params: { ...passJob(landed).params, shotPlan: undefined } },
      null,
    );
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: takes[0]!.id, shotId: "sh_12", by: "user" });
    const entry = deriveCut(store.getBundle().productions.find((p) => p.meta.id === "saltlight")!)
      .entries.find((e) => e.shot.id === "sh_12")!;
    assert.equal(entry.media!.inSec, undefined, "no -ss where nothing was trimmed");
    await store.close();
  });

  it("a trim past a segment's own end is a gap, not an inverted window (#253)", async () => {
    // setTrim refuses this, so it can only arrive by hand — but an inverted window is not
    // something to hand an encoder, and R-15 already draws a gap for material that is not there.
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, passJob(landed), null);
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    await acceptTake(store, production, { takeId: takes[2]!.id, shotId: "sh_13", by: "user" });

    const path = join(dir, "productions/saltlight/selections.json");
    const map = JSON.parse(await readFile(path, "utf8")) as Record<string, { trimInSec?: number }>;
    map["sh_13"] = { ...map["sh_13"], trimInSec: 99 };
    await writeFile(path, JSON.stringify(map, null, 2), "utf8");
    await store.reload();
    await store.reconcileExternalEdit("productions/saltlight/selections.json");

    const entry = deriveCut(store.getBundle().productions.find((p) => p.meta.id === "saltlight")!)
      .entries.find((e) => e.shot.id === "sh_13")!;
    assert.equal(entry.media, null, "nothing left to play reads as a gap");
    const slates = buildExportPlan(deriveCut(store.getBundle().productions.find((p) => p.meta.id === "saltlight")!), "review-cut")
      .items.filter((i) => i.type === "slate");
    assert.ok(slates.some((sl) => (sl as { label: string }).label.includes("SHOT 13")), "and the export slates it");
    await store.close();
  });
});

describe("exports (R-19..R-22, D10..D12, §3.2)", () => {
  it("gaps become labelled slates and the whole plan is one encode", async () => {
    const { store } = await open();
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const plan = buildExportPlan(deriveCut(production), "review-cut");
    const slates = plan.items.filter((i) => i.type === "slate");
    assert.ok(slates.length > 0);
    assert.match((slates[0] as { label: string }).label, /SHOT \d+ .*s/);

    const args = buildFfmpegArgs(plan, "/world", "/world/out.mp4", "/fonts/Geist-Regular.ttf");
    assert.equal(args.filter((a) => a === "-filter_complex").length, 1, "exactly one encode (D11)");
    assert.ok(args.join(" ").includes(`concat=n=${plan.items.length}`));
    assert.ok(args.some((a) => a.includes("drawtext")), "slates carry their labels");
    await store.close();
  });

  it("a finished export appears whole; a cancelled one leaves no partial file (R-21)", async () => {
    const worldDir = await tempDir("arke-export-");
    const plan: ExportPlan = {
      preset: "review-cut",
      frameRate: 24,
      items: [{ type: "slate", label: "SHOT 1 · 4.0s", durationSec: 4 }],
      overlays: [],
      audio: [],
      totalSec: 4,
    };
    const okRunner: FfmpegRunner = {
      slateFont: "/fonts/Geist-Regular.ttf",
      run: async (args) => {
        await writeFile(args[args.length - 1]!, "rendered");
      },
    };
    const done = runExport(worldDir, (stage) => buildFfmpegArgs(plan, worldDir, stage, "/fonts/Geist-Regular.ttf"), "review.mp4", okRunner, () => {});
    const result = await done.done;
    assert.equal(result.status, "done");
    assert.ok(await stat(join(worldDir, "exports", "review.mp4")));

    let release: () => void = () => {};
    const slowRunner: FfmpegRunner = {
      slateFont: "/fonts/Geist-Regular.ttf",
      run: (args, _p, signal) =>
        new Promise((resolvePromise, reject) => {
          void writeFile(args[args.length - 1]!, "partial");
          release = () => reject(new Error("killed"));
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    const cancelled = runExport(worldDir, (stage) => buildFfmpegArgs(plan, worldDir, stage, "/fonts/Geist-Regular.ttf"), "cancelled.mp4", slowRunner, () => {});
    cancelled.cancel();
    const cancelledResult = await cancelled.done;
    release();
    assert.equal(cancelledResult.status, "cancelled");
    await assert.rejects(() => stat(join(worldDir, "exports", "cancelled.mp4")), "no partial file is visible");
    const stage = await readdir(join(worldDir, ".cache", "exports")).catch(() => [] as string[]);
    assert.ok(!stage.includes("cancelled.mp4"), "the stage is cleaned");
  });

  it("a world export reopens identically elsewhere — history kept, caches dropped (R-22, D12)", async () => {
    const { dir, store } = await open();
    // A versioned commit first, so `.history/` exists to travel.
    const { ProposalManager } = await import("../../src/gate/proposals.js");
    const { stageSheetRename } = await import("../../src/sheets/authoring.js");
    const gate = new ProposalManager(store);
    const staged = await stageSheetRename(store, gate, { path: "characters/maren-kest.md", name: "Maren Kest of the Vigil" });
    await gate.accept(staged.id);
    const sourceBundle = store.getBundle();
    await store.close(); // release the lock so the copy carries no live lock semantics

    const target = join(await tempDir("arke-worldexp-"), "the-undersong");
    await exportWorld(dir, target);

    const entries = await readdir(target);
    assert.ok(entries.includes(".history"), "the version record travels (D12)");
    assert.ok(!entries.includes(".index"), "derived state stays behind");
    assert.ok(!entries.includes(".proposals"));
    assert.ok(!entries.includes("world.lock"));

    const reopened = await WorldStore.open(target, { clock: CLOCK });
    const bundle = reopened.getBundle();
    assert.equal(bundle.meta.worldId, sourceBundle.meta.worldId);
    assert.equal(bundle.sheets.length, sourceBundle.sheets.length);
    assert.equal(bundle.canon.length, sourceBundle.canon.length);
    assert.equal(bundle.productions.length, sourceBundle.productions.length);
    assert.deepEqual(
      bundle.productions[0]!.takes.map((t) => t.id).sort(),
      sourceBundle.productions[0]!.takes.map((t) => t.id).sort(),
    );
    await reopened.close();
  });
});

// ---------------------------------------------------------------------------
// Arrival-time motion QC (#248): measured before the take exists, and never able
// to cost one. Every case injects a fake analyzer — ffmpeg is not on CI.
// ---------------------------------------------------------------------------

describe("take QC at arrival (#248)", () => {
  const QC = {
    method: "adjacent-framemd5-v1",
    scope: "source-media",
    status: "degraded",
    nominalFps: 24,
    effectiveFps: 14,
    duplicateFrames: 10,
    duplicateRatio: 0.416667,
    sampledFrames: 25,
    thresholdRatio: 0.8,
  } as const;

  const shotJob = (landed: string): Job => ({
    ...passJob(landed),
    target: { kind: "shot", id: "sh_12", coversShots: ["sh_12"] },
    params: { ...passJob(landed).params, shotPlan: undefined },
  });

  it("records the continuation predecessor from the durable job, once and at top level", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const continuedFrom = "tk_01J8F0000000000000000000B2";
    const [take] = await recordTakesFromJob(
      store,
      {
        ...shotJob(landed),
        target: { kind: "shot", id: "sh_13", coversShots: ["sh_13"] },
        params: { ...shotJob(landed).params, continuedFrom },
      },
      400000,
    );
    assert.equal(take!.continuedFrom, continuedFrom);
    assert.equal(take!.params["continuedFrom"], undefined, "a dedicated field is not duplicated as a setting");
    const onDisk = JSON.parse(
      await readFile(join(dir, "productions", "saltlight", "takes", take!.id, "take.json"), "utf8"),
    ) as { continuedFrom?: string; params: Record<string, unknown> };
    assert.equal(onDisk.continuedFrom, continuedFrom);
    assert.equal(onDisk.params["continuedFrom"], undefined);
    await store.close();

    const reopened = await WorldStore.open(dir, { readOnly: true, clock: CLOCK });
    assert.equal(
      reopened.getBundle().productions.find((production) => production.meta.id === "saltlight")?.takes
        .find((candidate) => candidate.id === take!.id)?.continuedFrom,
      continuedFrom,
    );
    await reopened.close();
  });

  it("refuses invalid or non-shot continuation metadata before landed media moves", async () => {
    const { dir, store } = await open();
    for (const job of [
      { continuedFrom: "not-a-take" },
      { continuedFrom: "tk_01J8F0000000000000000000Z9" },
      { continuedFrom: "tk_01J8F0000000000000000000B2", capability: "image" as const },
    ]) {
      const landed = await landPass(dir);
      const base = shotJob(landed);
      await assert.rejects(
        () =>
          recordTakesFromJob(
            store,
            {
              ...base,
              ...(job.capability !== undefined ? { capability: job.capability } : {}),
              params: { ...base.params, continuedFrom: job.continuedFrom },
            },
            400000,
          ),
        /continuedFrom/,
      );
      assert.equal(await readFile(join(dir, landed), "utf8"), "fake-mp4-bytes-fake-mp4-bytes");
    }

    const wrongCoverageLanded = await landPass(dir);
    const wrongCoverage = shotJob(wrongCoverageLanded);
    await assert.rejects(
      () =>
        recordTakesFromJob(
          store,
          {
            ...wrongCoverage,
            target: { kind: "shot", id: "sh_13", coversShots: ["sh_13", "sh_14"] },
            params: { ...wrongCoverage.params, continuedFrom: "tk_01J8F0000000000000000000B2" },
          },
          400000,
        ),
      /one exact video shot/,
    );
    assert.equal(
      await readFile(join(dir, wrongCoverageLanded), "utf8"),
      "fake-mp4-bytes-fake-mp4-bytes",
    );

    const continuedPredecessor = "tk_01J8D0000000000000000000D4";
    await store.ownedWrite(async () => {
      const path = join(dir, "productions/saltlight/takes", continuedPredecessor, "take.json");
      const predecessor = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      predecessor["continuedFrom"] = "tk_01J8F0000000000000000000B2";
      await writeFile(path, JSON.stringify(predecessor, null, 2), "utf8");
    });
    const multiHop = await landPass(dir);
    const base = shotJob(multiHop);
    await assert.rejects(
      () =>
        recordTakesFromJob(
          store,
          {
            ...base,
            target: { kind: "shot", id: "sh_14", coversShots: ["sh_14"] },
            params: { ...base.params, continuedFrom: continuedPredecessor },
          },
          400000,
        ),
      /itself continued/,
    );
    assert.equal(await readFile(join(dir, multiHop), "utf8"), "fake-mp4-bytes-fake-mp4-bytes");
    await store.close();
  });

  it("records source-media QC once on a per-shot take", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const calls: string[] = [];
    const takes = await recordTakesFromJob(store, shotJob(landed), 400000, {
      analyzer: {
        analyze: async (file) => {
          calls.push(file);
          return { ok: true, qc: QC };
        },
      },
    });
    assert.equal(calls.length, 1, "analyzed once, against the landed file");
    assert.match(calls[0]!, /output-1\.mp4$/);
    assert.deepEqual(takes[0]!.qc, QC);

    // Persisted, not merely returned: the record on disk is what review will read.
    const onDisk = JSON.parse(
      await readFile(join(dir, "productions", "saltlight", "takes", takes[0]!.id, "take.json"), "utf8"),
    );
    assert.deepEqual(onDisk.qc, QC);
    await store.close();
  });

  it("copies one pass analysis to the pass and every virtual segment", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    let analyses = 0;
    const takes = await recordTakesFromJob(store, passJob(landed), 400000, {
      analyzer: {
        analyze: async () => {
          analyses += 1;
          return { ok: true, qc: QC };
        },
      },
    });
    assert.equal(analyses, 1, "the backing media is measured once, not once per segment");
    assert.equal(takes.length, 4);
    for (const take of takes) {
      assert.deepEqual(take.qc, QC, "the same source-media record travels to every segment");
    }
    await store.close();
  });

  it("QC timeout and analyzer exceptions never fail take finalization", async () => {
    const { dir, store } = await open();

    for (const [label, analyzer, expected] of [
      ["timeout", { analyze: async () => ({ ok: false as const, reason: "timeout" as const }) }, "timeout"],
      ["throws", { analyze: () => Promise.reject(new Error("spawn failed")) }, "process-failed"],
    ] as const) {
      const landed = await landPass(dir);
      const reasons: string[] = [];
      const takes = await recordTakesFromJob(store, shotJob(landed), 400000, {
        analyzer,
        onQcUnavailable: (reason) => reasons.push(reason),
      });
      assert.equal(takes.length, 1, `${label}: the paid take is still written`);
      assert.equal(takes[0]!.qc, undefined, `${label}: absent means not measured, never "measured clean"`);
      assert.deepEqual(reasons, [expected], `${label}: the reason is reported, not swallowed`);
    }

    // Even the reporting is allowed to fail: a diagnostic must not cost a generation.
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, shotJob(landed), 400000, {
      analyzer: { analyze: async () => ({ ok: false as const, reason: "malformed-output" as const }) },
      onQcUnavailable: () => {
        throw new Error("the log is on fire");
      },
    });
    assert.equal(takes.length, 1, "a throwing callback still leaves the take recorded");
    assert.equal(takes[0]!.qc, undefined);

    // No analyzer at all is the ordinary state, reported as such.
    const noneLanded = await landPass(dir);
    const noneReasons: string[] = [];
    const none = await recordTakesFromJob(store, shotJob(noneLanded), 400000, {
      onQcUnavailable: (reason) => noneReasons.push(reason),
    });
    assert.equal(none[0]!.qc, undefined);
    assert.deepEqual(noneReasons, ["not-configured"]);
    await store.close();
  });

  it("non-video takes never invoke QC", async () => {
    const { dir, store } = await open();
    let analyses = 0;
    const analyzer = {
      analyze: async () => {
        analyses += 1;
        return { ok: true as const, qc: QC };
      },
    };
    const reasons: string[] = [];

    const stills = await landPass(dir);
    const image = await recordTakesFromJob(
      store,
      { ...shotJob(stills), capability: "image" },
      400000,
      { analyzer, onQcUnavailable: (reason) => reasons.push(reason) },
    );
    assert.equal(image[0]!.qc, undefined);

    const voiceLanded = await landPass(dir);
    const voice = await recordTakesFromJob(
      store,
      { ...shotJob(voiceLanded), capability: "voice-tts", target: { kind: "voice-line", id: "vl_1", coversShots: [] } },
      400000,
      { analyzer, onQcUnavailable: (reason) => reasons.push(reason) },
    );
    assert.equal(voice[0]!.qc, undefined);

    assert.equal(analyses, 0, "a still and a voice line have no motion to measure");
    assert.deepEqual(reasons, [], "and nothing to explain, so nothing is logged");
    await store.close();
  });

  /**
   * A read that records neither its words nor its voice (found driving the installed app,
   * 2026-08-17). `prompt` was only ever read from `params.prompt`, and a synthesis job calls
   * its words `text` — so a landed line said nothing about itself, and the voice could only be
   * recovered from the sheet, which recasting would silently rewrite under every old take.
   */
  it("a spoken take records the line it read and the voice that read it", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(
      store,
      {
        ...shotJob(landed),
        capability: "voice-tts",
        target: { kind: "voice-line", id: "sh_12", coversShots: ["sh_12"] },
        params: { text: "the verse, under the water", voiceId: "af_bella" },
      },
      0,
    );
    assert.equal(takes[0]!.prompt, "the verse, under the water");
    assert.deepEqual(takes[0]!.params, { voiceId: "af_bella" });
    // On disk, not merely returned — the take is what a later reader has.
    const written = JSON.parse(
      await readFile(join(dir, "productions", "saltlight", "takes", takes[0]!.id, "take.json"), "utf8"),
    );
    assert.equal(written.prompt, "the verse, under the water");
    await store.close();
  });

  it("voice-line finalization is idempotent after both media-move and take-write crash windows", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const job: Job = {
      ...shotJob(landed),
      capability: "voice-tts",
      target: { kind: "voice-line", id: "sh_12", coversShots: ["sh_12"] },
      params: { text: "the verse", voiceId: "af_bella" },
    };
    const takeId = `tk_${job.id.slice(3)}`;
    const takeDir = join(dir, "productions", "saltlight", "takes", takeId);
    await mkdir(takeDir, { recursive: true });
    await rename(join(dir, landed), join(takeDir, "output-1.mp4"));

    const first = await recordTakesFromJob(store, job, 0);
    const second = await recordTakesFromJob(store, job, 0);
    const discovered = await WorldStore.open(dir, { readOnly: true, clock: CLOCK });
    const persisted = discovered.getBundle().productions
      .find((production) => production.meta.id === "saltlight")?.takes
      .filter((take) => take.jobId === job.id) ?? [];
    await discovered.close();
    const matchingTakeDirs = (await readdir(join(dir, "productions", "saltlight", "takes")))
      .filter((entry) => entry === takeId);
    await store.close();
    assert.equal(first[0]?.id, takeId);
    assert.equal(first.length, 1);
    assert.deepEqual(second, first);
    assert.equal(persisted.length, 1);
    assert.deepEqual(matchingTakeDirs, [takeId]);
  });

  /**
   * How the take was made, kept with it (2026-08-17). The dispatch carries the duration, the
   * aspect and the resolution; arrival kept none of them, so nothing on disk said how to make
   * the clip again. The fixtures showed those fields populated, which is exactly why it went
   * unnoticed — they are hand-authored, and the code that writes real takes never filled them.
   */
  it("records the settings a take was made with, and not the fields that live elsewhere", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(
      store,
      {
        ...shotJob(landed),
        params: {
          prompt: "Maren at the rail",
          references: ["references/maren-kest/model-sheet-v4.png"],
          provenance: {
            canonRevision: 42,
            sheets: {},
            sceneId: "sc_04",
            sceneVersion: 2,
            jobOnly: "not take provenance",
          },
          durationSec: 6,
          aspect: "16:9",
          resolution: "720p",
          sound: false,
          seed: 4417,
        },
      },
      400000,
    );
    const take = takes[0]!;
    // Everything describing how to make it again.
    assert.deepEqual(take.params, { durationSec: 6, aspect: "16:9", resolution: "720p", sound: false, seed: 4417 });
    // And nothing that already has a home of its own — duplicated state is state that can disagree.
    assert.equal(take.prompt, "Maren at the rail");
    assert.deepEqual(take.references, ["references/maren-kest/model-sheet-v4.png"]);
    assert.deepEqual(take.provenance, {
      canonRevision: 42,
      sheets: {},
      sceneId: "sc_04",
      sceneVersion: 2,
    });
    for (const key of ["prompt", "references", "provenance"]) {
      assert.equal(key in take.params, false, `${key} is a field, not a setting`);
    }
    await store.close();
  });

  /**
   * The picture every screen shows for a video take (2026-08-17). The `frame.png` convention
   * had readers on four screens and no writer anywhere, so a generated clip was a grey box
   * with a label in it wherever it appeared.
   */
  it("draws a video take's first frame beside the clip", async () => {
    const { dir, store } = await open();
    const landed = await landPass(dir);
    const drawn: Array<{ input: string; output: string }> = [];
    const takes = await recordTakesFromJob(store, shotJob(landed), 400000, {
      poster: {
        write: async (input, output) => {
          drawn.push({ input, output });
          await writeFile(output, Buffer.from("fake-png"));
          return { ok: true };
        },
      },
    });
    assert.equal(drawn.length, 1, "asked for exactly once, against the landed clip");
    assert.match(drawn[0]!.input, /output-1\.mp4$/);
    assert.match(drawn[0]!.output, /frame\.png$/);
    // Beside the clip in the take's own directory — which is where every reader looks.
    const takeDir = join(dir, "productions", "saltlight", "takes", takes[0]!.id);
    assert.deepEqual((await readdir(takeDir)).sort(), ["frame.png", "output-1.mp4", "take.json"]);
    await store.close();
  });

  it("asks for no picture of a voice line, and loses no take when drawing fails", async () => {
    const { dir, store } = await open();

    // A spoken take has nothing to look at, so nothing is asked for and nothing is reported.
    await landPass(dir);
    const spokenRel = "productions/saltlight/incoming/sc_04-pass-1/speech.wav";
    await writeFile(join(dir, spokenRel), Buffer.from("RIFFfake"));
    let asked = 0;
    const reasons: string[] = [];
    await recordTakesFromJob(
      store,
      {
        ...shotJob(spokenRel),
        capability: "voice-tts",
        target: { kind: "voice-line", id: "sh_12", coversShots: ["sh_12"] },
        params: { text: "the verse", voiceId: "af_bella" },
        landedFiles: [spokenRel],
      },
      0,
      { poster: { write: async () => { asked += 1; return { ok: true }; } } },
    );
    assert.equal(asked, 0, "a voice line is never a picture");

    // And a thrown extraction is survivable: shot finalization is not replayable, so a diagnostic
    // that fails must never cost a paid take.
    const landed = await landPass(dir);
    const takes = await recordTakesFromJob(store, shotJob(landed), 400000, {
      poster: { write: async () => { throw new Error("ffmpeg exploded"); } },
      onPosterUnavailable: (reason) => reasons.push(reason),
    });
    assert.equal(takes.length, 1, "the take is recorded regardless");
    assert.deepEqual(reasons, ["process-failed"], "and the reason is said rather than swallowed");
    await store.close();
  });
});

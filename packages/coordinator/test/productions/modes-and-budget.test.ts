import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aspectAllowed,
  designatedVoiceSample,
  encodedBytes,
  keyframeSequence,
  lockedDurationEstimate,
  lockedParameters,
  modeAvailability,
  modeUnavailableReason,
  payloadVerdict,
  referenceBudget,
  routeFor,
  sizeParamsFor,
  supportsMode,
  type BudgetCandidate,
  type ManifestModel,
  type ReferenceKit,
  type Selections,
  type Shot,
} from "@arke-studio/contracts";
import {
  continuationAvailable,
  supersededBy,
} from "../../src/productions/continuation.js";
import { measureDurationSec } from "../../src/media/probe.js";
import { referenceByteSizes, productionAspect } from "../../src/productions/ops.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { planScene } from "@arke-studio/contracts";
import type { Take } from "@arke-studio/contracts";

/** SPEC-019 T-19..T-32: modes, the four-dimension budget, voice, keyframes and continuation. */

const BASE: ManifestModel = {
  id: "m",
  provider: "fal",
  capability: "video",
  displayName: "Test Video",
  accepts: { referenceImages: 4, startFrame: true, endFrame: true },
  limits: { maxDurationSec: 30, reliableSubjects: 3 },
  pricing: { kind: "perSecond", microUsdPerSecond: 100_000 },
};

const MODAL: ManifestModel = {
  ...BASE,
  modes: {
    generate: { locked: [] },
    edit: {
      route: "vendor/edit",
      locked: ["aspect", "duration"],
      sentinels: { aspect: "auto", duration: "auto" },
      durationToleranceSec: 0.3,
    },
    "first-frame": { route: "vendor/i2v", locked: ["aspect"] },
  },
  aspectRange: { min: 0.4, max: 2.5 },
};

describe("task modes (R-32..R-36, T-20, T-23)", () => {
  it("a model with no modes supports generate only — what every row meant before", () => {
    assert.equal(supportsMode(BASE, "generate"), true);
    assert.equal(supportsMode(BASE, "edit"), false);
    assert.match(modeUnavailableReason(BASE, "continue")!, /no continue route/);
  });

  it("offers unsupported modes disabled with a reason, never absent", () => {
    const rows = modeAvailability(MODAL, ["generate", "edit", "continue"]);
    assert.deepEqual(rows.map((r) => r.available), [true, true, false]);
    assert.equal(rows[0]!.reason, null);
    assert.match(rows[2]!.reason!, /no continue route/, "a disabled mode teaches something (D26)");
  });

  it("mode is a route on this provider, not a field (T-1)", () => {
    assert.equal(routeFor(MODAL, "edit"), "vendor/edit");
    assert.equal(routeFor(MODAL, "generate"), null, "generate uses the model's default endpoint");
  });

  it("sends no chosen value for a locked parameter, and the sentinel where the route wants one", () => {
    const chosen = { resolution: "1080p", aspect: "16:9" };
    assert.deepEqual(sizeParamsFor(MODAL, "generate", chosen), chosen, "generate locks nothing");
    // Edit locks both and declares a spelling for each.
    assert.deepEqual(sizeParamsFor(MODAL, "edit", chosen), { aspect: "auto", resolution: "1080p" });
    // first-frame locks aspect with NO sentinel: the field is omitted rather than guessed at.
    assert.deepEqual(sizeParamsFor(MODAL, "first-frame", chosen), { resolution: "1080p" });
    assert.deepEqual(lockedParameters(MODAL, "first-frame"), ["aspect"]);
  });

  it("accepts a continuous aspect range where one is declared", () => {
    assert.equal(aspectAllowed(MODAL, 16 / 9), true);
    assert.equal(aspectAllowed(MODAL, 0.3), false, "outside [0.4, 2.5]");
  });
});

describe("estimating a length nobody chose (R-37..R-39, T-24, T-25)", () => {
  it("prices from the measured input, at the top of the stated tolerance", () => {
    const estimate = lockedDurationEstimate({ model: MODAL, mode: "edit", measuredSec: 12 });
    assert.ok(estimate.ok);
    // 12s input + 0.3s the route may add. A figure that can come in under is honest; one that
    // can come in over is not (D28).
    assert.equal(estimate.ok && estimate.durationSec, 12.3);
    assert.equal(estimate.ok && estimate.estimatedMicroUsd, Math.round(12.3 * 100_000));
    assert.match(estimate.ok ? estimate.statement : "", /plus the 0.3s/);
  });

  it("refuses the mode outright when the input cannot be measured", () => {
    const estimate = lockedDurationEstimate({ model: MODAL, mode: "edit", measuredSec: null });
    assert.equal(estimate.ok, false);
    assert.match(estimate.ok ? "" : estimate.reason, /could not be read/);
  });

  it("refuses only duration-locking modes — a still-image mode never needed a duration", () => {
    // The P1 the reviewer caught: scoping this to every locked mode would disable boundary-frame
    // generation whose input is a still with no duration to measure.
    const boundary = lockedDurationEstimate({ model: MODAL, mode: "first-frame", measuredSec: null });
    assert.equal(boundary.ok, false);
    assert.match(boundary.ok ? "" : boundary.reason, /does not lock duration/);
  });
});

describe("the budget's four dimensions (R-40..R-43, T-21, T-22)", () => {
  const candidate = (sheetId: string, order: number): BudgetCandidate => ({
    sheetId,
    kind: "character",
    appearanceOrder: order,
    hasReference: true,
  });

  it("names which dimension bound the request", () => {
    const tight = { ...BASE, accepts: { ...BASE.accepts, referenceImages: 2 } };
    const bound = referenceBudget([candidate("a", 0), candidate("b", 1), candidate("c", 2)], tight);
    assert.equal(bound.boundBy, "assets");
    assert.equal(bound.carried.length, 2);
    assert.equal(bound.dropped.length, 1);
  });

  it("warns on subjects past the reliable range and carries all of them anyway", () => {
    const many = [0, 1, 2, 3].map((n) => candidate(`s${n}`, n));
    const result = referenceBudget(many, BASE);
    assert.equal(result.carried.length, 4, "the user wrote four characters into the shot");
    assert.equal(result.subjects, 4);
    assert.deepEqual(result.subjectsOverRange, { carried: 4, reliableTo: 3 });
    assert.equal(result.boundBy, "subjects");
    assert.match(result.notice!, /less stable/, "degradation is described, never enforced (D35)");
  });

  it("counts subjects, not assets — two images of one person is one subject", () => {
    const withSecond: BudgetCandidate[] = [
      { ...candidate("a", 0), hasSecondaryReference: true },
      candidate("b", 1),
    ];
    const result = referenceBudget(withSecond, BASE);
    assert.equal(result.subjects, 2, "three assets, two subjects");
    assert.equal(result.subjectsOverRange, null);
  });

  it("treats the payload ceiling as a hard limit, not a degradation range", () => {
    // base64 costs a third again on top of the file, which is what turns "fits" into "does not".
    assert.equal(encodedBytes(3), 4);
    const under = payloadVerdict(6 * 1024 * 1024, 8 * 1024 * 1024);
    assert.equal(under.over, false);
    assert.equal(under.notice, null);
    const over = payloadVerdict(7 * 1024 * 1024, 8 * 1024 * 1024);
    assert.equal(over.over, true, "7MB raw is over 8MB once encoded — the client already refuses it");
    assert.match(over.notice!, /over the 8MB/);
  });
});

describe("the designated voice sample (R-45, T-26)", () => {
  it("resolves the one nominated asset, and nothing when none is nominated", () => {
    const withSample = {
      sheetId: "maren",
      tiles: [],
      compilations: [],
      designatedVoiceSample: { file: "voice.wav", source: "cloning-recording", designatedAt: "2026-08-09T00:00:00.000Z" },
    } as unknown as ReferenceKit;
    assert.deepEqual(designatedVoiceSample(withSample), { file: "references/maren/voice.wav" });
    // No designation means no audio reference — never a take chosen by guess (D31).
    assert.equal(designatedVoiceSample({ sheetId: "x", tiles: [], compilations: [] } as unknown as ReferenceKit), null);
    assert.equal(designatedVoiceSample(null), null);
  });
});

describe("keyframe sequences (R-46, R-47, T-27, T-28)", () => {
  const shot = (n: number): Shot => ({ id: `sh_${n}`, number: n, title: `S${n}`, description: "x" });

  it("numbers frames in shot order and states the ordering", () => {
    const selections = { sh_1: { startFrameTakeId: "tk_a" }, sh_2: { acceptedTakeId: "tk_b" } } as unknown as Selections;
    const sequence = keyframeSequence({ shots: [shot(1), shot(2)], selections });
    assert.equal(sequence.ok, true);
    assert.deepEqual(sequence.frames.map((f) => f.index), [1, 2]);
    assert.deepEqual(sequence.frames.map((f) => f.takeId), ["tk_a", "tk_b"]);
    assert.match(sequence.statement, /images 1 to 2 in order as keyframes/);
  });

  it("names a shot with no frame and refuses to close the gap", () => {
    const selections = { sh_1: { startFrameTakeId: "tk_a" } } as unknown as Selections;
    const sequence = keyframeSequence({ shots: [shot(1), shot(2)], selections });
    assert.equal(sequence.ok, false, "a sequence missing a shot the user believes is in it");
    assert.deepEqual(sequence.missing.map((m) => m.number), [2]);
    assert.match(sequence.statement, /shot 2 has no accepted frame/);
    assert.equal(sequence.frames.length, 1, "the gap is not closed by renumbering");
  });
});

describe("continuation (R-49..R-54, T-29, T-31)", () => {
  const shots = [
    { id: "sh_1", number: 1 },
    { id: "sh_2", number: 2 },
    { id: "sh_3", number: 3 },
  ];
  const take = (id: string, continuedFrom?: string): Take =>
    ({ id, jobId: "jb_1", coversShots: [], kind: "shot", provider: "fal", model: "m", provenance: { canonRevision: 1, sheets: {} }, references: [], params: {}, cost: { estimatedMicroUsd: 0, actualMicroUsd: null }, dispatchedAt: "2026-08-09T00:00:00.000Z", ...(continuedFrom ? { continuedFrom } : {}) }) as unknown as Take;

  it("is unavailable on the first shot, and where the predecessor has no accepted take", () => {
    const empty = {} as Selections;
    const first = continuationAvailable({ shotIndex: 0, shots, selections: empty, takes: [] });
    assert.equal(first.available, false);
    assert.match(first.available ? "" : first.reason, /nothing before it/);

    const second = continuationAvailable({ shotIndex: 1, shots, selections: empty, takes: [] });
    assert.equal(second.available, false);
    assert.match(second.available ? "" : second.reason, /shot 1 has no accepted take/);
  });

  it("refuses a second hop, which is what holds the one-hop decision to something testable", () => {
    const selections = { sh_2: { acceptedTakeId: "tk_2" } } as unknown as Selections;
    const takes = [take("tk_1"), take("tk_2", "tk_1")];
    const third = continuationAvailable({ shotIndex: 2, shots, selections, takes });
    assert.equal(third.available, false);
    assert.match(third.available ? "" : third.reason, /stops at one hop/);
  });

  it("allows one hop when the predecessor is an ordinary take", () => {
    const selections = { sh_1: { acceptedTakeId: "tk_1" } } as unknown as Selections;
    const result = continuationAvailable({ shotIndex: 1, shots, selections, takes: [take("tk_1")] });
    assert.equal(result.available, true);
    assert.equal(result.available && result.predecessor.id, "tk_1");
  });

  it("finds what a reselection invalidates, so the selection can be cleared with the mark", () => {
    // Marking alone would leave invalidated footage in a cut derived from selections (D36).
    const selections = {
      sh_1: { acceptedTakeId: "tk_1" },
      sh_2: { acceptedTakeId: "tk_2" },
      sh_3: { acceptedTakeId: "tk_3" },
    } as unknown as Selections;
    const takes = [take("tk_1"), take("tk_2", "tk_1"), take("tk_3")];
    assert.deepEqual(supersededBy({ changedShotId: "sh_1", selections, takes }), [
      { shotId: "sh_2", takeId: "tk_2" },
    ]);
    assert.deepEqual(supersededBy({ changedShotId: "sh_3", selections, takes }), [], "nothing was built on it");
  });
});

describe("payload, measurement and aspect reach the surfaces that need them (T-24, T-26, T-35)", () => {
  async function open() {
    const dir = await makeTempWorld();
    return WorldStore.open(dir, { clock: () => "2026-08-09T12:00:00.000Z" });
  }

  it("measures real files, and answers null for anything it cannot read", async () => {
    const store = await open();
    // The seam is the point: null is a first-class answer that withdraws the mode, never a zero
    // that quietly prices a job at nothing.
    assert.equal(await measureDurationSec(store, "anything.mp4", null), null, "no probe, no measurement");
    const flaky = { durationSec: async () => { throw new Error("no codec"); } };
    assert.equal(await measureDurationSec(store, "anything.mp4", flaky), null);
    const zero = { durationSec: async () => 0 };
    assert.equal(await measureDurationSec(store, "x.mp4", zero), null, "a zero-length input is unmeasured");
    const good = { durationSec: async () => 12.5 };
    assert.equal(await measureDurationSec(store, "x.mp4", good), 12.5);
    await store.close();
  });

  it("sizes references from disk, counting an unreadable one as nothing", async () => {
    const store = await open();
    const sizes = await referenceByteSizes(store, ["world.json", "does-not-exist.png", "world.json"]);
    assert.ok(sizes["world.json"]! > 0, "a real file has a real size");
    assert.equal(sizes["does-not-exist.png"], 0, "a missing reference is a different problem");
    await store.close();
  });

  it("blocks a dispatch whose payload cannot be sent, rather than warning past it", async () => {
    const store = await open();
    const bundle = store.getBundle();
    const production = bundle.productions[0]!;
    const scene = production.scenes[0]!;
    const model = {
      ...BASE,
      accepts: { referenceImages: 4, startFrame: true, endFrame: true },
    };
    const base = {
      world: bundle.meta,
      artDirection: bundle.artDirection,
      productionId: production.meta.id,
      sheets: bundle.sheets,
      kits: bundle.referenceKits,
      scene,
      selections: production.selections,
      model,
    };
    // Without sizes there is nothing to check, and the check falls back to the transport.
    assert.equal(planScene(base, "per-shot").warnings.payloadOverflow, null);

    const carried = planScene(base, "per-shot").shots.flatMap((entry) => entry.bound.map((r) => r.file));
    const sizes = Object.fromEntries(carried.map((file) => [file, 9 * 1024 * 1024]));
    const over = planScene(
      { ...base, referenceBytes: sizes, payloadCeilingBytes: 8 * 1024 * 1024 },
      "per-shot",
    );
    if (carried.length > 0) {
      assert.ok(over.warnings.payloadOverflow, "a request the client already refuses is not a warning");
      assert.match(over.warnings.payloadOverflow!.notice!, /over the 8MB/);
    }
    await store.close();
  });

  it("takes the aspect from the production, with the world only as a default", async () => {
    const store = await open();
    const production = store.getBundle().productions[0]!;
    // One world routinely holds a 16:9 film and a 9:16 cut; a world-scoped aspect cannot express
    // both without one production silently changing the other's (D29).
    assert.equal(productionAspect(production, "16:9"), "16:9", "the world default applies when unset");
    const vertical = { ...production, meta: { ...production.meta, aspect: "9:16" } };
    assert.equal(productionAspect(vertical, "16:9"), "9:16", "the production wins over the world");
    await store.close();
  });
});

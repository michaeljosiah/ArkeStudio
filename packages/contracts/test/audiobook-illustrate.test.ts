import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IllustrationProposalSchema, illustrationTotal, paceLabel, pacePhrase, pictureBench, pictureCap, pictureStarts, priceLabel, referenceBriefLine, thinPictures } from "../src/audiobook-illustrate.js";
import { sheetReferencePicture } from "../src/world-image-references.js";

/**
 * Pictures proposed by Arke (design turn 191, SPEC-047 R-99..R-102): the clock a proposal is laid on,
 * the pace and the twenty-second rule it is held to, what its card says, and the brief a picture is
 * made from.
 */

describe("the chapter's clock (R-101)", () => {
  it("lays blocks end to end by a made take's length, else their words at the reading rate, and says it estimated", () => {
    const clock = pictureStarts([{ text: "x".repeat(150), seconds: null }, { text: "ignored", seconds: 30 }, { text: "x".repeat(30), seconds: null }]);
    assert.deepEqual(clock.starts, [0, 10, 40]);
    assert.equal(clock.total, 42);
    assert.equal(clock.estimated, true);
    assert.equal(pictureStarts([{ text: "a", seconds: 5 }]).estimated, false);
  });
});

describe("the pace and the twenty-second rule (R-101)", () => {
  it("allows about one picture every minute and a half of speech, less those already standing, and never none for a chapter with words", () => {
    assert.equal(pictureCap(630, 0), 7);
    assert.equal(pictureCap(630, 3), 4);
    assert.equal(pictureCap(630, 9), 0);
    assert.equal(pictureCap(20, 0), 1);
    assert.equal(pictureCap(20, 1), 0);
  });

  it("keeps a proposal at least twenty seconds from every picture standing and every one kept before it", () => {
    assert.deepEqual(thinPictures([{ at: 0 }, { at: 10 }, { at: 25 }, { at: 40 }, { at: 41 }], [], 9), [0, 2], "0 and 25: 10 is too near 0, and 40 and 41 too near 25");
    assert.deepEqual(thinPictures([{ at: 0 }, { at: 30 }, { at: 55 }], [28], 9), [0, 2], "30 is beside a picture already standing at 28");
  });

  it("past the cap, drops the proposal nearest a neighbour first", () => {
    const candidates = [{ at: 0 }, { at: 100 }, { at: 125 }, { at: 300 }];
    assert.deepEqual(thinPictures(candidates, [], 4), [0, 1, 2, 3]);
    assert.deepEqual(thinPictures(candidates, [], 3), [0, 1, 3], "100 and 125 sat nearest each other: one goes, the later");
    assert.deepEqual(thinPictures(candidates, [], 1), [0]);
    assert.deepEqual(thinPictures(candidates, [], 0), []);
  });

  it("counts a standing picture as a neighbour when thinning", () => {
    assert.deepEqual(thinPictures([{ at: 40 }, { at: 100 }], [85], 1), [0], "100 is 15 from the picture at 85: never proposed");
  });
});

describe("what the card says (191b)", () => {
  it("names the pace to the quarter minute", () => {
    assert.equal(paceLabel(90), "a minute and a half");
    assert.equal(paceLabel(60), "a minute");
    assert.equal(paceLabel(120), "two minutes");
    assert.equal(paceLabel(150), "two minutes and a half");
    assert.equal(paceLabel(40), "45 s");
    assert.equal(paceLabel(95), "a minute and a half", "to the nearest quarter minute");
    assert.equal(paceLabel(105), "1 m 45 s");
    assert.deepEqual([90, 60, 150, 40].map(pacePhrase), ["one a minute and a half", "one a minute", "one every two minutes and a half", "one every 45 s"]);
  });

  it("totals what Accept will spend: rows not skipped and not held, a held row when the author says without", () => {
    const rows = [
      { block: "a", estimatedMicroUsd: 40_000 },
      { block: "b", estimatedMicroUsd: 45_000, needs: ["Sereth"] },
      { block: "c", estimatedMicroUsd: 40_000 },
    ];
    assert.deepEqual(illustrationTotal(rows, new Set(), new Set()), { count: 2, microUsd: 80_000, held: 1 });
    assert.deepEqual(illustrationTotal(rows, new Set(["c"]), new Set()), { count: 1, microUsd: 40_000, held: 1 });
    assert.deepEqual(illustrationTotal(rows, new Set(), new Set(["b"])), { count: 3, microUsd: 125_000, held: 0 });
    assert.deepEqual(illustrationTotal(rows, new Set(["b"]), new Set(["b"])), { count: 2, microUsd: 80_000, held: 0 }, "a skipped row is never held");
  });

  it("says a price to the cent, rounded up, and free for nothing", () => {
    assert.equal(priceLabel(40_000), "~$0.04");
    assert.equal(priceLabel(45_000), "~$0.05");
    assert.equal(priceLabel(240_000), "~$0.24");
    assert.equal(priceLabel(1), "~$0.01");
    assert.equal(priceLabel(0), "free");
  });
});

describe("the brief a picture is made from (R-99)", () => {
  it("is the prompt, then who is shown in which attached picture, then the book's look", () => {
    const brief = pictureBench("  Maren on   the stair. ", [{ name: "Maren", kind: "character", token: "Image 1" }, { name: "The stairwell", kind: "place", token: "Image 2" }], "Wet ink.");
    assert.equal(brief, "Maren on the stair.\n\nMaren is shown in @Image 1. The setting is The stairwell, shown in @Image 2.\n\nLight and mood: Wet ink.");
    assert.equal(pictureBench("Maren.", [], undefined), "Maren.");
    assert.equal(referenceBriefLine([]), "");
  });
});

describe("a proposal", () => {
  it("reads as the coordinator sends it and refuses a stray field", () => {
    const proposal = {
      proposalId: "p1",
      hash: "h",
      rows: [{ block: "p0.0", textHash: "t", at: 12, title: "The bell", prompt: "The bell under the harbour.", who: [{ key: "maren-kest", name: "Maren", kind: "character", reference: null, carried: false }], estimatedMicroUsd: 40_000, needs: ["Maren"] }],
      model: { provider: "openai", id: "gpt-image-2", name: "GPT Image 2", references: 16 },
      aspect: "16:9",
      seconds: 630,
      estimated: true,
      standing: 0,
    };
    assert.ok(IllustrationProposalSchema.safeParse(proposal).success);
    assert.equal(IllustrationProposalSchema.safeParse({ ...proposal, stray: 1 }).success, false);
  });
});

describe("the picture that stands for a sheet (R-100)", () => {
  const kit = (over: Record<string, unknown>) => ({ sheetId: "s", tiles: [], compilations: [], ...over });
  const world = (type: "character" | "location", over: Record<string, unknown>) => ({ sheets: [{ id: "s", type, name: "S" }], referenceKits: [kit(over)] }) as never;

  it("is a character's main photo, and nothing for one without a kit or a main photo", () => {
    assert.equal(sheetReferencePicture(world("character", { mainPhoto: { file: "head-front.png", source: "legacy" } }), "s"), "references/s/head-front.png");
    assert.equal(sheetReferencePicture(world("character", {}), "s"), null);
    assert.equal(sheetReferencePicture({ sheets: [], referenceKits: [] } as never, "s"), null);
  });

  it("is a place's establishing view, else its first view, else a main photo it was given before views", () => {
    const views = [
      { id: "v1", name: "North", file: "views/north.png", status: "active", slot: 1, createdAt: "2026-01-01T00:00:00Z" },
      { id: "v2", name: "South", file: "views/south.png", status: "active", slot: 2, createdAt: "2026-01-02T00:00:00Z" },
    ];
    assert.equal(sheetReferencePicture(world("location", { locationViews: views, establishingViewId: "v2" }), "s"), "references/s/views/south.png");
    assert.equal(sheetReferencePicture(world("location", { locationViews: views }), "s"), "references/s/views/north.png");
    assert.equal(sheetReferencePicture(world("location", { mainPhoto: { file: "head-front.png", source: "legacy" } }), "s"), "references/s/head-front.png");
  });
});

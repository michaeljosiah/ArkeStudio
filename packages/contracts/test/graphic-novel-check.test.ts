import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LETTERING_THRESHOLDS, type ComicPage, type PageTextRegion } from "../src/graphic-novel.js";
import { compareLettering, normalizeLettering, takePasses } from "../src/graphic-novel-check.js";

const id = (n: number) => `01J${String(n).padStart(23, "0")}`;
const reader = { id: "test-reader", version: "1" };
const at = "2026-10-28T12:00:00.000Z";

/** Two panels side by side on a 2×2 grid: a caption and a line, then a sound. */
const PAGE: ComicPage = {
  id: id(1), layout: "grid-2x2", status: "draft",
  panels: [
    { id: id(2), description: "Ife at the wall.", characters: ["ife"], lettering: [
      { id: id(3), kind: "caption", text: "The tide came in grey." },
      { id: id(4), kind: "speech", speaker: "ife", text: "Where are you?" },
    ] },
    { id: id(5), description: "Water.", characters: [], lettering: [{ id: id(6), kind: "sfx", text: "Hsssh" }] },
  ],
};

const GOOD: PageTextRegion[] = [
  { text: "THE TIDE CAME IN GREY.", box: { x: 0.05, y: 0.05, w: 0.3, h: 0.05 } },
  { text: "WHERE ARE YOU?", box: { x: 0.1, y: 0.2, w: 0.25, h: 0.05 } },
  { text: "HSSSH!", box: { x: 0.6, y: 0.2, w: 0.2, h: 0.08 } },
];

const check = (regions: PageTextRegion[], page: ComicPage = PAGE, reading: "ltr" | "rtl" = "ltr") =>
  compareLettering({ page, reading, regions, thresholds: DEFAULT_LETTERING_THRESHOLDS, reader, at });
const kinds = (regions: PageTextRegion[]) => {
  const result = check(regions);
  return result.status === "compared" ? result.findings.map((finding) => finding.kind) : [];
};

describe("lettering check (SPEC-064 R-29 – R-33)", () => {
  it("folds case and typographic punctuation", () => {
    assert.equal(normalizeLettering("“Where’s Ife…?”"), normalizeLettering("\"WHERE'S IFE...?\""));
  });
  it("passes a page whose words are the script's", () => {
    const result = check(GOOD);
    assert.deepEqual(result.status === "compared" ? result.findings : null, []);
    assert.equal(takePasses(result), true);
    assert.equal(result.status === "compared" && result.speaker, "not-checked");
  });
  it("finds a misspelling as altered, with what was read", () => {
    const regions = structuredClone(GOOD); regions[1]!.text = "WHER ARE YOU?";
    const result = check(regions);
    assert.ok(result.status === "compared");
    const altered = result.findings.find((finding) => finding.kind === "altered");
    assert.equal(altered?.item, id(4));
    assert.equal(altered?.found, "WHER ARE YOU?");
    assert.equal(takePasses(result), false);
  });
  it("finds a balloon that is not there", () => {
    assert.deepEqual(kinds([GOOD[0]!, GOOD[2]!]), ["missing"]);
  });
  it("finds words the script never wrote", () => {
    assert.deepEqual(kinds([...GOOD, { text: "BUY SOAP", box: { x: 0.6, y: 0.6, w: 0.2, h: 0.05 } }]), ["extra"]);
  });
  it("ignores a one-character mark", () => {
    assert.deepEqual(kinds([...GOOD, { text: "~" }, { text: "a" }]), []);
  });
  it("accepts one balloon split over two lines, and two balloons read as one block", () => {
    assert.deepEqual(kinds([{ text: "THE TIDE CAME" }, { text: "IN GREY." }, GOOD[1]!, GOOD[2]!]), []);
    assert.deepEqual(kinds([{ text: "THE TIDE CAME IN GREY. WHERE ARE YOU?" }, GOOD[2]!]), []);
  });
  it("finds words cut off at the page edge", () => {
    const regions = structuredClone(GOOD); regions[2]!.box = { x: 0.85, y: 0.2, w: 0.15, h: 0.08 };
    assert.deepEqual(kinds(regions), ["clipped"]);
  });
  it("warns when the second line is read before the first", () => {
    const regions = structuredClone(GOOD); regions[0]!.box = { x: 0.1, y: 0.3, w: 0.3, h: 0.05 };
    const result = check(regions);
    assert.ok(result.status === "compared");
    assert.deepEqual(result.findings.map((finding) => finding.kind), ["order"]);
    // Order only warns (R-31).
    assert.equal(takePasses(result), true);
  });
  it("reads a right-to-left page from the right", () => {
    // Panel two sits on the left of a mirrored page, so its sound is read after panel one's lines.
    const regions: PageTextRegion[] = [
      { text: "The tide came in grey.", box: { x: 0.65, y: 0.05, w: 0.3, h: 0.05 } },
      { text: "Where are you?", box: { x: 0.6, y: 0.2, w: 0.25, h: 0.05 } },
      { text: "Hsssh", box: { x: 0.1, y: 0.2, w: 0.2, h: 0.08 } },
    ];
    const result = check(regions, PAGE, "rtl");
    assert.deepEqual(result.status === "compared" ? result.findings : null, []);
  });
  it("never passes a check that did not run", () => {
    assert.equal(takePasses(undefined), false);
    assert.equal(takePasses({ status: "unavailable", reason: "no-reader", at }), false);
  });
});

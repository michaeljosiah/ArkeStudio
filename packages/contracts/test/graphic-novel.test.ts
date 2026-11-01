import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ComicPageRecordSchema,
  ComicScriptSchema,
  ComicSettingsSchema,
  DEFAULT_COMIC_SETTINGS,
  GRAPHIC_NOVEL_KIND,
  LAYOUT_TEMPLATES,
  comicPageHash,
  letteringInOrder,
  pageReading,
  panelRects,
  REVIEW_UNAVAILABLE,
  fitLayout,
  takeBlocking,
  takeClears,
  type ComicScript,
  type LetteringFinding,
  type PageReview,
  type PageReviewFinding,
} from "../src/graphic-novel.js";
import { productionShape } from "../src/production-shape.js";

const id = (n: number) => `01J${String(n).padStart(23, "0")}`;

/** A two-page chapter: a page-turn page and a right-to-left one. */
const FIXTURE: ComicScript = {
  version: 1,
  pages: [
    {
      id: id(1), layout: "grid-2x2", status: "draft", notes: "The harbour at dawn.",
      panels: [
        { id: id(2), description: "Ife at the harbour wall, looking out.", characters: ["ife"], location: "harbour",
          lettering: [{ id: id(3), kind: "caption", text: "The tide came in grey." }, { id: id(4), kind: "speech", speaker: "ife", text: "Where are you?" }] },
        { id: id(5), description: "The empty water.", characters: [], lettering: [{ id: id(6), kind: "sfx", text: "HSSSH" }] },
      ],
    },
    {
      id: id(7), layout: "manga", reading: "rtl", status: "ready",
      panels: [{ id: id(8), description: "A boat, far out.", characters: [], lettering: [] }],
    },
  ],
};

describe("graphic novel shape (SPEC-064 R-1, R-2)", () => {
  it("is a story kind with chapters and pages that dispatches images", () => {
    const shape = productionShape({ format: "story", medium: "story", kind: GRAPHIC_NOVEL_KIND });
    assert.equal(shape.hasChapters, true);
    assert.equal(shape.hasPages, true);
    assert.equal(shape.hasScenes, false);
    assert.equal(shape.playsAsBeats, false);
    assert.equal(shape.isBranching, false);
    assert.equal(shape.dispatchCapability, "image");
    assert.equal(shape.displayLabel, "Graphic novel");
  });
  it("means nothing on a video production", () => {
    const shape = productionShape({ format: "video", medium: "video", kind: GRAPHIC_NOVEL_KIND });
    assert.equal(shape.hasPages, false);
    assert.equal(shape.dispatchCapability, "video");
  });
  it("is false for every other kind", () => {
    for (const kind of ["book", "audio-drama", "serial"]) assert.equal(productionShape({ format: "story", medium: "story", kind }).hasPages, false);
  });
});

describe("comic script (R-5 – R-11)", () => {
  it("round-trips parse → serialise without loss", () => {
    const parsed = ComicScriptSchema.parse(JSON.parse(JSON.stringify(FIXTURE)));
    assert.deepEqual(parsed, FIXTURE);
    assert.deepEqual(ComicScriptSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  });
  it("refuses a caption with a speaker", () => {
    const bad = structuredClone(FIXTURE);
    bad.pages[0]!.panels[0]!.lettering[0] = { id: id(3), kind: "caption", speaker: "ife", text: "x" };
    assert.equal(ComicScriptSchema.safeParse(bad).success, false);
  });
  it("refuses an id used twice anywhere in the chapter", () => {
    const bad = structuredClone(FIXTURE);
    bad.pages[1]!.panels[0]!.id = id(2);
    assert.equal(ComicScriptSchema.safeParse(bad).success, false);
  });
  it("refuses more than 40 lettering items on one page", () => {
    const bad = structuredClone(FIXTURE);
    bad.pages[0]!.panels = Array.from({ length: 5 }, (_, p) => ({ id: id(100 + p), description: "x", characters: [],
      lettering: Array.from({ length: 9 }, (_, l) => ({ id: id(200 + p * 10 + l), kind: "caption" as const, text: "x" })) }));
    assert.equal(ComicScriptSchema.safeParse(bad).success, false);
  });
  it("reads in page, panel, lettering order", () => {
    assert.deepEqual(letteringInOrder(FIXTURE.pages).map((entry) => entry.item.text), ["The tide came in grey.", "Where are you?", "HSSSH"]);
  });
});

describe("the picture's fingerprint (R-11, R-25)", () => {
  const page = FIXTURE.pages[0]!;
  const hash = comicPageHash(page, DEFAULT_COMIC_SETTINGS, "baked");
  it("ignores notes and status", () => {
    assert.equal(comicPageHash({ ...page, notes: "Fixed a typo.", status: "ready" }, DEFAULT_COMIC_SETTINGS, "baked"), hash);
  });
  it("changes with a panel description or a lettering string", () => {
    const described = structuredClone(page); described.panels[0]!.description = "Ife on the wall.";
    const lettered = structuredClone(page); lettered.panels[0]!.lettering[1]!.text = "Where are you now?";
    assert.notEqual(comicPageHash(described, DEFAULT_COMIC_SETTINGS, "baked"), hash);
    assert.notEqual(comicPageHash(lettered, DEFAULT_COMIC_SETTINGS, "baked"), hash);
  });
  it("ignores lettering text for overlay art, which shows none", () => {
    const lettered = structuredClone(page); lettered.panels[0]!.lettering[1]!.text = "Where are you now?";
    assert.equal(comicPageHash(lettered, DEFAULT_COMIC_SETTINGS, "overlay"), comicPageHash(page, DEFAULT_COMIC_SETTINGS, "overlay"));
  });
});

describe("layout and reading (R-9, R-12, R-14, R-15)", () => {
  it("has the library the spec names", () => {
    for (const template of ["grid-2x2", "grid-3x3", "strip-3", "splash", "manga", "webtoon"]) assert.ok(LAYOUT_TEMPLATES.some((t) => t.id === template), template);
  });
  it("mirrors a right-to-left page's panels", () => {
    const [first] = panelRects({ layout: "grid-2x2" }, "rtl");
    assert.deepEqual(first, { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  });
  it("lets the page override the book, and a webtoon always scrolls", () => {
    assert.equal(pageReading(FIXTURE.pages[1]!, DEFAULT_COMIC_SETTINGS), "rtl");
    assert.equal(pageReading({ layout: "webtoon", reading: "rtl" }, DEFAULT_COMIC_SETTINGS), "scroll");
  });
  it("defaults the book to a 2:3 page read left to right", () => {
    assert.equal(DEFAULT_COMIC_SETTINGS.aspect, "2:3");
    assert.equal(DEFAULT_COMIC_SETTINGS.reading, "ltr");
    assert.equal(ComicSettingsSchema.safeParse({ version: 1, aspect: " 2 : 3 " }).success, false);
  });
});

describe("page record (R-26)", () => {
  it("refuses an accepted take it does not hold", () => {
    assert.equal(ComicPageRecordSchema.safeParse({ version: 1, accepted: { en: id(9) } }).success, false);
  });
});

describe("a take's words and picture together (R-69, R-70, R-72)", () => {
  const AT = "2026-11-01T00:00:00.000Z";
  const read = (findings: LetteringFinding[]) =>
    ({ status: "compared" as const, reader: { id: "t", version: "1" }, normalizationVersion: 1, thresholds: { exact: 0.97, missing: 0.75 }, score: 1, findings, speaker: "not-checked" as const, regions: [], at: AT });
  const extra = { id: "extra:0", kind: "extra" as const, found: "neap" };

  it("blocks on the picture's faults as on the words', and names an unreviewed picture", () => {
    const review = (findings: PageReviewFinding[]): PageReview =>
      ({ status: "compared", reviewer: { id: "t", version: "1" }, references: [], findings, cleared: [], at: AT });
    assert.equal(takeClears({ verification: read([]), review: review([]) }), true);
    assert.deepEqual(takeBlocking({ verification: read([]), review: review([{ id: "review:caption:0", kind: "caption", note: "a pen" }]) }), ["review:caption:0"]);
    assert.equal(takeClears({ verification: read([]), review: review([{ id: "review:likeness:0", kind: "likeness", note: "hair" }]) }), true, "a warning is looked at, not fixed");
    assert.deepEqual(takeBlocking({ verification: read([]), review: { status: "unavailable", reason: "no-reviewer", at: AT } }), [REVIEW_UNAVAILABLE]);
    assert.equal(takeClears({ verification: read([]) }), true, "a take made before the review is unreviewed, not failed");
  });

  it("does not block on writing the review found the panel calls for", () => {
    const cleared: PageReview = { status: "compared", reviewer: { id: "t", version: "1" }, references: [], findings: [], cleared: [{ finding: "extra:0", reason: "the ledger" }], at: AT };
    assert.deepEqual(takeBlocking({ verification: read([extra]) }), ["extra:0"]);
    assert.deepEqual(takeBlocking({ verification: read([extra]), review: cleared }), []);
  });
});

describe("a page's layout follows its panels (turn 256)", () => {
  it("keeps a layout whose count agrees, takes the template that fits, and keeps its own when none does", () => {
    assert.equal(fitLayout("feature", 3), "feature");
    assert.equal(fitLayout("manga", 4), "grid-2x2");
    assert.equal(fitLayout("manga", 9), "grid-3x3");
    assert.equal(fitLayout("manga", 1), "splash");
    assert.equal(fitLayout("manga", 6), "manga");
  });
});

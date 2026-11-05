import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAspect } from "../src/manifest.js";
import { ulid } from "../src/ids.js";
import type { ComicPage } from "../src/graphic-novel.js";
import {
  ComicPageRecordSchema,
  ComicPlanSchema,
  comicPilotChapter,
  ComicScriptSchema,
  ComicSettingsSchema,
  DEFAULT_COMIC_SETTINGS,
  GRAPHIC_NOVEL_KIND,
  LAYOUT_TEMPLATES,
  EMPTY_COMIC_PAGE_RECORD,
  balloonBox,
  comicPageFinishable,
  comicPageHash,
  comicPanelHash,
  comicPanelRects,
  comicPanelStates,
  panelShape,
  panelTakeClears,
  unplacedLines,
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
import { comicPagePrompt } from "../src/graphic-novel-prompt.js";
import { productionShape } from "../src/production-shape.js";

const id = (n: number) => `01J${String(n).padStart(23, "0")}`;

it("names a pilot by its source chapter while keeping legacy plans readable", () => {
  const legacy = { reading: "ltr", aspect: "2:3", pilot: true, chapters: [
    { from: 1, title: "Prologue", pages: 2 }, { from: 2, title: "Chapter 1 — The Thief of Zeel", pages: 8 },
  ] };
  assert.equal(comicPilotChapter(ComicPlanSchema.parse(legacy))?.from, 1);
  assert.equal(comicPilotChapter(ComicPlanSchema.parse({ ...legacy, pilotFrom: 2 }))?.from, 2);
  assert.equal(comicPilotChapter(ComicPlanSchema.parse({ ...legacy, pilot: false })), undefined);
  assert.throws(() => ComicPlanSchema.parse({ ...legacy, pilotFrom: 3 }), /Choose one chapter/);
  assert.throws(() => ComicPlanSchema.parse({ ...legacy, pilotFrom: 2, chapters: [legacy.chapters[1], legacy.chapters[1]] }), /Choose one chapter/);
});

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
  it("counts the words on a finished overlay page, which holds them, and never on a panel's art (R-37a, R-48a)", () => {
    const lettered = structuredClone(page); lettered.panels[0]!.lettering[1]!.text = "Where are you now?";
    assert.notEqual(comicPageHash(lettered, DEFAULT_COMIC_SETTINGS, "overlay"), comicPageHash(page, DEFAULT_COMIC_SETTINGS, "overlay"));
    assert.equal(comicPanelHash(lettered.panels[0]!, "4:3"), comicPanelHash(page.panels[0]!, "4:3"));
    const described = structuredClone(page); described.panels[0]!.description = "Maren turns.";
    assert.notEqual(comicPanelHash(described.panels[0]!, "4:3"), comicPanelHash(page.panels[0]!, "4:3"));
    assert.notEqual(comicPanelHash(page.panels[0]!, "1:1"), comicPanelHash(page.panels[0]!, "4:3"));
  });
});

describe("a page laid out in code (R-37a, R-38a)", () => {
  const panels = (count: number) => Array.from({ length: count }, () => ({ id: ulid(), description: "x", characters: [], lettering: [] }));
  it("gives every panel a rectangle, from its template or as rows of two", () => {
    assert.equal(comicPanelRects({ layout: "feature", panels: panels(3) }, "ltr")[0]!.h, 0.5);
    const six = comicPanelRects({ layout: "manga", panels: panels(6) }, "ltr");
    assert.equal(six.length, 6);
    assert.deepEqual(six[3], { x: 0.5, y: 1 / 3, w: 0.5, h: 1 / 3 });
    const five = comicPanelRects({ layout: "grid-2x2", panels: panels(7) }, "rtl");
    assert.deepEqual(five[6], { x: 0, y: 0.75, w: 1, h: 0.25 });
    assert.equal(five[0]!.x, 0.5, "right to left reads the right column first");
  });
  it("names a box's shape in its lowest terms", () => {
    assert.equal(panelShape("2:3", { x: 0, y: 0, w: 1, h: 0.5 }), "4:3");
    assert.equal(panelShape("2:3", { x: 0, y: 0, w: 0.5, h: 0.5 }), "2:3");
    assert.equal(normalizeAspect(panelShape("2:3", { x: 0, y: 0, w: 0.4, h: 0.35 })) !== null, true);
  });
  it("keeps a line's box inside its panel and clear of the box before it", () => {
    const rect = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
    const first = balloonBox({ kind: "speech", text: "Where are you going at this hour of the night?" }, rect, "2:3", { x: 1, y: 1 });
    assert.ok(first.x >= 0.5 && first.x + first.w <= 1 + 1e-9);
    assert.ok(first.y >= 0.5 && first.y + first.h <= 1 + 1e-9);
    const top = balloonBox({ kind: "speech", text: "Hello" }, rect, "2:3", { x: 0, y: 0 });
    const next = balloonBox({ kind: "speech", text: "Hello again" }, rect, "2:3", { x: 0, y: 0 }, [top]);
    assert.ok(next.y >= top.y + top.h);
  });
  it("finishes a page only with every panel accepted and every line placed", () => {
    const line = { id: ulid(), kind: "caption" as const, text: "Dawn." };
    const panel = { id: ulid(), description: "x", characters: [], lettering: [line] };
    const one: ComicPage = { id: ulid(), layout: "splash", status: "ready", panels: [panel] };
    const hash = comicPanelStates(one, undefined, DEFAULT_COMIC_SETTINGS)[0]!.hash;
    const take = { id: ulid(), panel: panel.id, artifact: "art_01J00000000000000000000000" as never, hash, model: "m", at: "2026-11-05T12:00:00.000Z" };
    const held = { ...EMPTY_COMIC_PAGE_RECORD, panelTakes: [take], panelAccepted: { [panel.id]: take.id } };
    assert.equal(comicPageFinishable(one, held, DEFAULT_COMIC_SETTINGS), false);
    assert.deepEqual(unplacedLines(one, held).map((item) => item.id), [line.id]);
    const placed = { ...held, placements: [{ item: line.id, box: { x: 0, y: 0, w: 0.2, h: 0.1 } }] };
    assert.equal(comicPageFinishable(one, placed, DEFAULT_COMIC_SETTINGS), true);
    assert.equal(comicPanelStates({ ...one, panels: [{ ...panel, description: "y" }] }, placed, DEFAULT_COMIC_SETTINGS)[0]!.accepted, undefined, "a take of what it no longer shows is not the panel");
  });
  it("clears a finished overlay take without a check, and a baked one only with one (R-37b)", () => {
    assert.equal(takeClears({ mode: "overlay" }), true);
    assert.equal(takeClears({ mode: "baked" }), false);
    assert.equal(panelTakeClears({}), false);
    assert.equal(panelTakeClears({ review: { status: "unavailable", reason: "no-reviewer", at: "2026-11-05T12:00:00.000Z" } }), false);
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

  it("tells the model the page's own count when its layout draws another", () => {
    const panel = (n: number) => ({ id: id(100 + n), description: `Panel ${n}.`, characters: [], lettering: [] });
    const brief = (count: number) => comicPagePrompt({
      page: { id: id(99), layout: "manga", status: "draft", panels: Array.from({ length: count }, (_, n) => panel(n)) },
      settings: DEFAULT_COMIC_SETTINGS, mode: "baked", names: (sheet) => sheet, cited: [],
    }).split("\n")[0]!;
    assert.match(brief(5), /five panels of varied size in three tiers/);
    assert.match(brief(6), /exactly 6 panels of varied size\./);
    assert.doesNotMatch(brief(6), /five/);
  });
});

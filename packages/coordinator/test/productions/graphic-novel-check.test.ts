import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REVIEW_UNAVAILABLE, ulid, type ComicPage, type DomainEvent, type ManifestModel, type PageReviewFinding, type PageTextRegion } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { createChapter, createProduction } from "../../src/productions/ops.js";
import { comicPageRecord, saveComicScript } from "../../src/productions/graphic-novel.js";
import type { PageReader } from "../../src/productions/graphic-novel-reader.js";
import type { PageReviewInput, PageReviewer } from "../../src/productions/graphic-novel-reviewer.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { IMAGE, WORLD_ID, withHarness, type Harness } from "./picture-harness.js";

/**
 * A page's lettering checked (SPEC-064 slice 3): read back after it lands, compared with the
 * script, and accepted only when it passes or the author overrides — a check that could not run is
 * not a pass. Try until it passes stops at the book's cap.
 */
const LETTERER: ManifestModel = { ...IMAGE, id: "letterer", displayName: "Letterer", limits: { aspects: ["2:3"], maxPromptChars: 8000, lettering: true } };
let n = 0;
const rid = () => `01J0000000000000000003${String((n += 1)).padStart(4, "0")}`;
const last = <T extends DomainEvent["type"]>(events: DomainEvent[], type: T) => events.filter((event): event is Extract<DomainEvent, { type: T }> => event.type === type).at(-1);

type Looked = { findings: PageReviewFinding[]; cleared?: Array<{ finding: string; reason: string }> };
const CLEAN: Looked = { findings: [] };

/**
 * Swap the page reader for one that answers these regions, attempt by attempt, and the page
 * reviewer for one that answers these reviews; each review's input is kept for the test to read.
 */
function readerAnswering(answers: PageTextRegion[][], reviews: Looked[] = [CLEAN], asked: PageReviewInput[] = []): () => void {
  const proto = Coordinator.prototype as unknown as { pageReader: (...args: unknown[]) => PageReader | null; pageReviewer: (...args: unknown[]) => PageReviewer | null };
  const original = proto.pageReader;
  const reviewer = proto.pageReviewer;
  let call = 0;
  let looked = 0;
  proto.pageReader = () => ({ precise: true, read: async () => ({ regions: answers[Math.min(call++, answers.length - 1)]!, reader: { id: "test", version: "1" } }) });
  proto.pageReviewer = () => ({ review: async (input) => {
    asked.push(input);
    const answer = reviews[Math.min(looked++, reviews.length - 1)]!;
    return { findings: answer.findings, cleared: answer.cleared ?? [], reviewer: { id: "test", version: "1" } };
  } });
  return () => { proto.pageReader = original; proto.pageReviewer = reviewer; };
}

async function book(h: Harness) {
  const store = h.store()!;
  const production = await createProduction(store, { title: "Low Water, drawn", medium: "story", productionKind: "graphic-novel" });
  const chapter = await createChapter(store, production, { title: "The tide", order: 1 });
  const page: ComicPage = { id: ulid(), layout: "splash", status: "ready",
    panels: [{ id: ulid(), description: "Maren on the rail at dawn.", characters: [], lettering: [{ id: ulid(), kind: "caption", text: "Where are you?" }] }] };
  const saved = await saveComicScript(store, production, { chapter, pages: [page], baseHash: null });
  const record = () => comicPageRecord(store.getBundle().productions.find((p) => p.meta.id === production)!, page.id);
  return { store, production, chapter, page, saved, record };
}
const GOOD: PageTextRegion[] = [{ text: "WHERE ARE YOU?", box: { x: 0.2, y: 0.2, w: 0.3, h: 0.05 } }];
const TYPO: PageTextRegion[] = [{ text: "WHER ARE YOU?", box: { x: 0.2, y: 0.2, w: 0.3, h: 0.05 } }];

describe("a page's lettering checked (SPEC-064 R-29 – R-33)", () => {
  it("records a check that could not run, and accepts it only with an override", () =>
    withHarness(async (h) => {
      const { production, page, record } = await book(h);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
      const take = record().takes[0]!;
      assert.deepEqual([take.verification?.status, take.verification?.status === "unavailable" && take.verification.reason], ["unavailable", "no-reader"]);
      assert.equal(last(h.events, "comic.page-made")?.passed, false, "silence is not clearance");
      await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id });
      assert.equal(last(h.events, "comic.take-result")?.disposition, "refused");
      assert.deepEqual(record().accepted, {});
      assert.deepEqual([take.review?.status, take.review?.status === "unavailable" && take.review.reason], ["unavailable", "no-reviewer"], "nor the picture");
      await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id, override: { findings: [] } });
      assert.match(last(h.events, "comic.take-result")?.reason ?? "", /does not cover review:unavailable/, "an unreviewed picture is named, not waved through");
      await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id, override: { findings: [REVIEW_UNAVAILABLE], reason: "Read it myself." } });
      assert.equal(last(h.events, "comic.take-result")?.disposition, "accepted");
      assert.equal(record().accepted.en, take.id);
      assert.equal(record().takes[0]!.override?.reason, "Read it myself.");
    }, { model: LETTERER }));

  it("says making, then checking with the landed take, then made (design turn 251)", () =>
    withHarness(async (h) => {
      const restore = readerAnswering([GOOD]);
      try {
        const { production, page, record } = await book(h);
        await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
        const states = h.events.filter((event): event is Extract<DomainEvent, { type: "comic.page-made" }> => event.type === "comic.page-made");
        assert.deepEqual(states.map((event) => event.state), ["making", "checking", "made"]);
        assert.equal(states[1]!.take, record().takes[0]!.id, "the take Pages shows while it is read");
        assert.deepEqual(record().making, []);
      } finally { restore(); }
    }, { model: LETTERER }));

  it("accepts a passing take as it stands, and refuses one the script has moved past", () =>
    withHarness(async (h) => {
      const restore = readerAnswering([GOOD]);
      try {
        const { store, production, chapter, page, saved, record } = await book(h);
        await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
        const take = record().takes[0]!;
        assert.equal(take.verification?.status, "compared");
        assert.equal(last(h.events, "comic.page-made")?.passed, true);
        // The words change after the take was made: it is out of date and is not accepted.
        const edited = structuredClone(page); edited.panels[0]!.lettering[0]!.text = "Where are you now?";
        await saveComicScript(store, production, { chapter, pages: [edited], baseHash: saved.hash });
        await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id });
        assert.match(last(h.events, "comic.take-result")?.reason ?? "", /script changed/);
        assert.deepEqual(record().accepted, {});
      } finally { restore(); }
    }, { model: LETTERER }));

  it("refuses an override that does not cover every blocking finding", () =>
    withHarness(async (h) => {
      const restore = readerAnswering([TYPO]);
      try {
        const { production, page, record } = await book(h);
        await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
        const take = record().takes[0]!;
        const finding = take.verification?.status === "compared" ? take.verification.findings[0]! : undefined;
        assert.equal(finding?.kind, "altered");
        await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id, override: { findings: [] } });
        assert.match(last(h.events, "comic.take-result")?.reason ?? "", /does not cover/);
        await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id, override: { findings: [finding!.id] } });
        assert.equal(record().accepted.en, take.id);
        assert.deepEqual(record().takes[0]!.override?.findings, [finding!.id]);
      } finally { restore(); }
    }, { model: LETTERER }));

  it("tries until a take passes, and stops at the book's cap of attempts", () =>
    withHarness(async (h) => {
      const restore = readerAnswering([TYPO, GOOD]);
      try {
        const { production, page, record } = await book(h);
        await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000, untilPasses: true });
        assert.equal(h.enqueued.length, 2, "the second attempt passed");
        assert.deepEqual(record().takes.map((take) => take.verification?.status === "compared" && take.verification.findings.length === 0), [false, true]);
      } finally { restore(); }
      const stuck = readerAnswering([TYPO]);
      try {
        const { production, page } = await book(h);
        const before = h.enqueued.length;
        await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000, untilPasses: true });
        assert.equal(h.enqueued.length - before, 3, "three attempts, the default cap, and no more");
        assert.equal(last(h.events, "comic.page-made")?.attempt, 3);
      } finally { stuck(); }
    }, { model: LETTERER }));

  it("stops before an attempt the confirmed price does not cover", () =>
    withHarness(async (h) => {
      const restore = readerAnswering([TYPO]);
      try {
        const { production, page } = await book(h);
        // One page costs 40,000 micro-dollars on this model; 90,000 covers two attempts, not three.
        await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 90_000, untilPasses: true });
        assert.equal(h.enqueued.length, 2);
        assert.match(last(h.events, "comic.page-made")?.reason ?? "", /price moved/);
      } finally { restore(); }
    }, { model: LETTERER }));
});

const CAPTION: PageReviewFinding = { id: "review:caption:0", kind: "caption", panel: 1, note: "a pen, but the rail" };
const LIKENESS: PageReviewFinding = { id: "review:likeness:1", kind: "likeness", panel: 1, note: "Maren's hair" };

describe("a page looked at as a picture (SPEC-064 R-67 – R-73, turn 253)", () => {
  it("is reviewed after its words are read, from its script and never the prose, and the world is raised to 117", () =>
    withHarness(async (h) => {
      const asked: PageReviewInput[] = [];
      const restore = readerAnswering([GOOD], [CLEAN], asked);
      try {
        const { production, page, record } = await book(h);
        await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
        const take = record().takes[0]!;
        assert.equal(take.review?.status, "compared");
        assert.equal(last(h.events, "comic.page-made")?.passed, true);
        assert.match(asked[0]!.script, /Panel 1: Maren on the rail at dawn\./);
        assert.match(asked[0]!.script, /caption: "Where are you\?"/);
        assert.ok((await readWorldMeta(h.store()!.dir)).schemaVersion >= 117, "a build of 116 would drop the reviewed take");
      } finally { restore(); }
    }, { model: LETTERER }));

  it("holds a take whose picture contradicts its caption, and an override must name the fault", () =>
    withHarness(async (h) => {
      const restore = readerAnswering([GOOD], [{ findings: [CAPTION] }]);
      try {
        const { production, page, record } = await book(h);
        await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
        const take = record().takes[0]!;
        assert.equal(last(h.events, "comic.page-made")?.passed, false, "the words pass; the picture does not");
        await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id });
        assert.equal(last(h.events, "comic.take-result")?.disposition, "refused");
        await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id, override: { findings: [] } });
        assert.match(last(h.events, "comic.take-result")?.reason ?? "", /does not cover review:caption:0/);
        await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id, override: { findings: [CAPTION.id] } });
        assert.equal(record().accepted.en, take.id);
      } finally { restore(); }
    }, { model: LETTERER }));

  it("tries again until the picture passes too", () =>
    withHarness(async (h) => {
      const restore = readerAnswering([GOOD], [{ findings: [CAPTION] }, CLEAN]);
      try {
        const { production, page, record } = await book(h);
        await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000, untilPasses: true });
        assert.equal(h.enqueued.length, 2, "the second picture passed");
        assert.deepEqual(record().takes.map((take) => take.review?.status === "compared" && take.review.findings.length), [1, 0]);
      } finally { restore(); }
    }, { model: LETTERER }));

  it("clears words the panel calls for as writing in the scene, and nothing it was not asked about", () =>
    withHarness(async (h) => {
      const asked: PageReviewInput[] = [];
      const NEAP: PageTextRegion[] = [...GOOD, { text: "neap", box: { x: 0.6, y: 0.6, w: 0.1, h: 0.04 } }];
      const restore = readerAnswering([NEAP], [{ findings: [], cleared: [{ finding: "extra:1", reason: "the ledger, in the scene" }] }], asked);
      try {
        const { production, page, record } = await book(h);
        await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
        assert.deepEqual(asked[0]!.extras, [{ id: "extra:1", text: "neap" }], "the reviewer is asked about the words the read found");
        const take = record().takes[0]!;
        assert.equal(take.verification?.status === "compared" && take.verification.findings[0]?.kind, "extra", "the read keeps what it found");
        assert.equal(last(h.events, "comic.page-made")?.passed, true, "and the take passes, with the reason on it");
        await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id });
        assert.equal(record().accepted.en, take.id);
      } finally { restore(); }
    }, { model: LETTERER }));

  it("passes a take with a warning, keeps Seen on the page record, and forgets it when the take is read again", () =>
    withHarness(async (h) => {
      const restore = readerAnswering([GOOD], [{ findings: [LIKENESS] }]);
      try {
        const { production, page, record } = await book(h);
        await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 1_000_000 });
        const take = record().takes[0]!;
        assert.equal(last(h.events, "comic.page-made")?.passed, true, "a warning is looked at, not fixed");
        await h.send({ kind: "see-comic-warning", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id, warning: "likeness" });
        assert.equal(last(h.events, "comic.take-result")?.disposition, "seen");
        assert.deepEqual(record().acknowledged[take.id], ["likeness"]);
        await h.send({ kind: "check-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id });
        assert.equal(record().acknowledged[take.id], undefined, "a new review is a new verdict");
      } finally { restore(); }
    }, { model: LETTERER }));
});

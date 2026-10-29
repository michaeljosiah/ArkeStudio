import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ulid, type ComicPage, type DomainEvent, type ManifestModel, type PageTextRegion } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { createChapter, createProduction } from "../../src/productions/ops.js";
import { comicPageRecord, saveComicScript } from "../../src/productions/graphic-novel.js";
import type { PageReader } from "../../src/productions/graphic-novel-reader.js";
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

/** Swap the page reader for one that answers these regions, attempt by attempt. */
function readerAnswering(answers: PageTextRegion[][]): () => void {
  const proto = Coordinator.prototype as unknown as { pageReader: (...args: unknown[]) => PageReader | null };
  const original = proto.pageReader;
  let call = 0;
  proto.pageReader = () => ({ precise: true, read: async () => ({ regions: answers[Math.min(call++, answers.length - 1)]!, reader: { id: "test", version: "1" } }) });
  return () => { proto.pageReader = original; };
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
      await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id, override: { findings: [], reason: "Read it myself." } });
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comicBook, comicPageHash, comicPanelStates, ulid, type ComicPage, type DomainEvent, type ManifestModel, type PageReviewFinding } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { comicExportBlockers } from "../../src/productions/comic-export.js";
import { createChapter, createProduction } from "../../src/productions/ops.js";
import { productionRecord } from "../../src/world-chat/production-record.js";
import { clearOfFaces, tailClearOfFaces } from "../../src/productions/graphic-novel-placer.js";
import { changeComicPage, finishComicPage, nearestPanelShape, placeComicPage, saveComicScript, setComicLettering, setComicSettings } from "../../src/productions/graphic-novel.js";
import type { PageReviewer } from "../../src/productions/graphic-novel-reviewer.js";
import { IMAGE, WORLD_ID, withHarness, type Harness } from "./picture-harness.js";
import { until } from "../wait.js";

/**
 * Panel by panel (SPEC-064 R-36a – R-48a, design turn 269): each panel its own wordless picture, read
 * alone, a fault touching that panel; the words a layer from the script; one flattened take for the book.
 */
type Quote = Extract<DomainEvent, { type: "comic.page-quote" }>;

const DRAWER: ManifestModel = { ...IMAGE, id: "drawer", displayName: "Drawer", limits: { aspects: ["4:3", "3:2", "1:1", "2:3"], maxPromptChars: 8000 } };
let n = 0;
const rid = () => `01J0000000000000000003${String((n += 1)).padStart(4, "0")}`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const AT = "2026-11-05T12:00:00.000Z";

function reviewing(findingsFor: (script: string) => PageReviewFinding[]): () => void {
  const proto = Coordinator.prototype as unknown as { pageReviewer: (...args: unknown[]) => PageReviewer | null };
  const original = proto.pageReviewer;
  proto.pageReviewer = () => ({ review: async (input) => ({ findings: findingsFor(input.script), cleared: [], reviewer: { id: "test", version: "1" } }) });
  return () => { proto.pageReviewer = original; };
}

async function book(h: Harness) {
  const store = h.store()!;
  const production = await createProduction(store, { title: "Low Water, drawn", medium: "story", productionKind: "graphic-novel" });
  const chapter = await createChapter(store, production, { title: "The tide", order: 1 });
  const line = { id: ulid(), kind: "speech" as const, text: "Where are you?" };
  const page: ComicPage = {
    id: ulid(), layout: "feature", status: "ready",
    panels: [
      { id: ulid(), description: "Maren on the rail at dawn.", characters: [], lettering: [line] },
      { id: ulid(), description: "The empty water.", characters: [], lettering: [] },
      { id: ulid(), description: "A gull lifts.", characters: [], lettering: [] },
    ],
  };
  const { hash } = await saveComicScript(store, production, { chapter, pages: [page], baseHash: null });
  await setComicSettings(store, production, { mode: "overlay" });
  return { store, production, chapter, page, line, hash };
}
const live = (h: Harness, id: string) => h.store()!.getBundle().productions.find((p) => p.meta.id === id)!;
const record = (h: Harness, id: string) => live(h, id).comicPages![0]!.record;
const quoted = async (h: Harness, production: string, page: string, panel?: string) => {
  await h.send({ kind: "quote-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page, ...(panel ? { panel } : {}) });
  const quote = h.events.filter((event): event is Quote => event.type === "comic.page-quote").at(-1)!.quote;
  assert.ok(quote.ok, !quote.ok ? quote.reason : "");
  return quote;
};

describe("Panel by panel (SPEC-064 R-37a, R-37b)", () => {
  it("makes every panel at one price, with no line of the script in any prompt, and accepts the clean ones", () => {
    const restore = reviewing(() => []);
    return withHarness(async (h) => {
      const { production, page } = await book(h);
      const quote = await quoted(h, production, page.id);
      assert.equal(quote.microUsd > 0, true);
      assert.equal(h.enqueued.length, 0, "a quote spends nothing");
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: quote.microUsd });
      assert.equal(h.enqueued.length, 3);
      for (const job of h.enqueued) assert.doesNotMatch(String((job.params as { prompt?: string }).prompt), /Where are you/);
      // The top half of a 2:3 page is 4:3; the two below are 2:3 halves, a shape of 1:1.5.
      assert.deepEqual(h.enqueued.map((job) => (job.params as { output?: { aspect?: string } }).output?.aspect), ["4:3", "2:3", "2:3"]);
      await until(() => Object.keys(record(h, production).panelAccepted).length === 3, "the panels to land");
      assert.equal(record(h, production).takes.length, 0, "a panel is not a page take");
      assert.equal(record(h, production).making.length, 0);
    }, { model: DRAWER }).finally(restore);
  });

  it("holds a panel with a fault, and Make again redraws that panel alone", () => {
    const restore = reviewing((script) => script.includes("gull") ? [{ id: "review:defect:0", kind: "defect", note: "two left hands" }] : []);
    return withHarness(async (h) => {
      const { production, page } = await book(h);
      const quote = await quoted(h, production, page.id);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: quote.microUsd });
      await until(() => record(h, production).panelTakes.filter((take) => take.review !== undefined).length === 3, "the panels to land");
      const gull = page.panels[2]!.id;
      assert.equal(record(h, production).panelAccepted[gull], undefined);
      assert.equal(Object.keys(record(h, production).panelAccepted).length, 2);

      const before = h.enqueued.length;
      // A second page press spends nothing on a fault the author has not seen.
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: 10_000_000 });
      assert.equal(h.enqueued.length, before);
      const one = await quoted(h, production, page.id, gull);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, panel: gull, confirmedMicroUsd: one.microUsd });
      assert.equal(h.enqueued.length, before + 1);
      assert.match(String((h.enqueued.at(-1)!.params as { prompt?: string }).prompt), /gull/);

      // Accept anyway names the finding and keeps it on the take.
      await until(() => record(h, production).panelTakes.filter((take) => take.review !== undefined).length === 4, "the panels to land");
      const take = record(h, production).panelTakes.at(-1)!;
      await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id });
      assert.equal(record(h, production).panelAccepted[gull], undefined, "not without the override");
      await h.send({ kind: "accept-comic-take", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, take: take.id, override: { findings: ["review:defect:0"] } });
      assert.equal(record(h, production).panelAccepted[gull], take.id);
      assert.deepEqual(record(h, production).panelTakes.at(-1)!.override?.findings, ["review:defect:0"]);
    }, { model: DRAWER }).finally(restore);
  });

  it("looks at a filed panel the app closed on before its review, when the page is next opened", () => {
    const restore = reviewing(() => []);
    return withHarness(async (h) => {
      const { store, production, page } = await book(h);
      const quote = await quoted(h, production, page.id);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: quote.microUsd });
      await until(() => Object.keys(record(h, production).panelAccepted).length === 3, "the panels to land");
      // As the app left it: filed, with no verdict and nothing looking at it.
      await changeComicPage(store, production, page.id, (held) => ({ ...held, panelAccepted: {}, panelTakes: held.panelTakes.map(({ review: _gone, ...take }) => take) }));
      await quoted(h, production, page.id);
      await until(() => Object.keys(record(h, production).panelAccepted).length === 3, "the reviews to run again");
    }, { model: DRAWER }).finally(restore);
  });

  it("keeps every panel inside the price the press confirmed when a style reference has become available", () => {
    const restore = reviewing(() => []);
    return withHarness(async (h) => {
      const { production, page } = await book(h);
      const quote = await quoted(h, production, page.id);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: quote.microUsd });
      await until(() => record(h, production).panelTakes.length === 3, "the panels to land");
      const spent = h.enqueued.reduce((sum, job) => sum + job.estimatedMicroUsd, 0);
      assert.ok(spent <= quote.microUsd, `${spent} within ${quote.microUsd}`);
    }, { model: DRAWER }).finally(restore);
  });

  it("lets Arke read each panel's state and the review's words (turn 270)", () => {
    const restore = reviewing(() => [{ id: "review:f1", kind: "defect", note: "Left eye sits low" }]);
    return withHarness(async (h) => {
      const { store, production, page } = await book(h);
      const quote = await quoted(h, production, page.id);
      await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: production, page: page.id, confirmedMicroUsd: quote.microUsd });
      await until(() => record(h, production).panelTakes.filter((take) => take.review !== undefined).length === 3, "the reviews");
      const read = productionRecord(store.getBundle(), production) as { comicPages: Array<{ linesPlaced: number; linesTotal: number; panels: Array<{ state: string; findings: Array<{ note: string }> }> }> };
      const entry = read.comicPages[0]!;
      assert.deepEqual(entry.panels.map((panel) => panel.state), ["at-fault", "at-fault", "at-fault"]);
      assert.equal(entry.panels[0]!.findings[0]!.note, "Left eye sits low");
      assert.equal(entry.linesPlaced, 0);
      assert.ok(entry.linesTotal > 0);
    }, { model: DRAWER }).finally(restore);
  });

  it("asks for the nearest shape a model makes when it does not make the panel's", () => {
    assert.equal(nearestPanelShape(DRAWER, "4:3"), "4:3");
    assert.equal(nearestPanelShape(DRAWER, "1004:443"), "3:2");
  });
});

describe("the words and the finished page (SPEC-064 R-38a, R-39a, R-48a)", () => {
  async function ready(h: Harness) {
    const made = await book(h);
    const quote = await quoted(h, made.production, made.page.id);
    await h.send({ kind: "make-comic-page", requestId: rid(), worldId: WORLD_ID, productionId: made.production, page: made.page.id, confirmedMicroUsd: quote.microUsd });
    await until(() => Object.keys(record(h, made.production).panelAccepted).length === 3, "the panels to land");
    return made;
  }
  const BOX = { x: 0.1, y: 0.1, w: 0.3, h: 0.1 };

  it("refuses Accept page until every line is placed, then files one image the book reads", () => {
    const restore = reviewing(() => []);
    return withHarness(async (h) => {
      const { store, production, page, line } = await ready(h);
      const settings = live(h, production).comic!;
      const hash = comicPageHash(page, settings, "overlay");
      await assert.rejects(finishComicPage(store, production, page.id, { hash, jpeg: JPEG, requestId: rid() }, AT), /not placed/);
      await setComicLettering(store, production, page.id, [{ item: line.id, box: BOX }], false);
      await assert.rejects(finishComicPage(store, production, page.id, { hash: "stale", jpeg: JPEG, requestId: rid() }, AT), /script changed/);
      await finishComicPage(store, production, page.id, { hash, jpeg: JPEG, requestId: rid() }, AT);
      const entry = comicBook(live(h, production))[0]!;
      assert.equal(entry.take?.mode, "overlay");
      assert.equal(entry.cleared, true);
      assert.equal(entry.outOfDate, false);
      assert.deepEqual(comicExportBlockers(live(h, production)), []);

      // A moved balloon withdraws it; finishing again replaces the old image rather than stacking.
      await setComicLettering(store, production, page.id, [{ item: line.id, box: { ...BOX, x: 0.2 } }], false);
      assert.equal(comicBook(live(h, production))[0]!.take, undefined);
      await finishComicPage(store, production, page.id, { hash, jpeg: new Uint8Array([...JPEG, 1]), requestId: rid() }, AT);
      assert.equal(record(h, production).takes.length, 1);
      assert.equal(comicBook(live(h, production))[0]!.cleared, true);
    }, { model: DRAWER }).finally(restore);
  });

  it("a changed line makes the finished image out of date and redraws no panel", () => {
    const restore = reviewing(() => []);
    return withHarness(async (h) => {
      const { store, production, page, line, chapter } = await ready(h);
      const settings = live(h, production).comic!;
      await setComicLettering(store, production, page.id, [{ item: line.id, box: BOX }], false);
      await finishComicPage(store, production, page.id, { hash: comicPageHash(page, settings, "overlay"), jpeg: JPEG, requestId: rid() }, AT);
      const edited = structuredClone(page);
      edited.panels[0]!.lettering[0]!.text = "Where did you go?";
      await saveComicScript(store, production, { chapter, pages: [edited], baseHash: live(h, production).comicScripts![0]!.hash });
      assert.equal(comicBook(live(h, production))[0]!.outOfDate, true);
      assert.equal(comicPanelStates(edited, record(h, production), settings).every((state) => state.accepted !== undefined), true);
    }, { model: DRAWER }).finally(restore);
  });

  it("Arke places unplaced lines inside their panel, leaves the author's, and one Undo takes it back", () => {
    const restore = reviewing(() => []);
    return withHarness(async (h) => {
      const { store, production, page, line, chapter } = await ready(h);
      const own = { id: ulid(), kind: "caption" as const, text: "Dawn." };
      const edited = structuredClone(page);
      edited.panels[0]!.lettering.push(own);
      await saveComicScript(store, production, { chapter, pages: [edited], baseHash: live(h, production).comicScripts![0]!.hash });
      await setComicLettering(store, production, page.id, [{ item: own.id, box: BOX }], false);
      const signal = new AbortController().signal;
      const lines = await placeComicPage(store, production, page.id, { place: async (input) => {
        assert.deepEqual(input.lines.map((entry) => entry.id), [line.id], "only what is unplaced");
        return { lines: [{ item: line.id, x: 0.9, y: 0.9, tail: { x: 0.5, y: 0.5 } }], faces: [] };
      } }, signal, () => AT);
      assert.equal(lines, 1);
      const held = record(h, production);
      const placed = held.placements.find((entry) => entry.item === line.id)!;
      // Inside panel 1, the top half of the page, wherever the model aimed it.
      assert.ok(placed.box.y + placed.box.h <= 0.5 + 1e-9);
      assert.ok(placed.box.x + placed.box.w <= 1 + 1e-9);
      assert.ok(Math.abs(placed.tail!.x - 0.5) < 1e-9 && Math.abs(placed.tail!.y - 0.25) < 1e-9);
      // The art stops short of the layout, and the words with it (turn 271).
      assert.ok(placed.box.x + placed.box.w <= 1 - 0.008 + 1e-9);
      assert.equal(held.placedByArke?.lines, 1);
      await setComicLettering(store, production, page.id, held.placedByArke!.before, true);
      assert.deepEqual(record(h, production).placements.map((entry) => entry.item), [own.id]);
      assert.equal(record(h, production).placedByArke, undefined);
    }, { model: DRAWER }).finally(restore);
  });
});

describe("Place with Arke keeps words clear of faces (SPEC-064 R-39a, turn 271)", () => {
  const PANEL = { x: 0, y: 0, w: 1, h: 1 };
  const FACE = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };

  it("moves a balloon off a face by the least distance that stays in the panel", () => {
    const moved = clearOfFaces({ x: 0.35, y: 0.3, w: 0.2, h: 0.12 }, [FACE], [], PANEL);
    assert.deepEqual(moved, { x: 0.35, y: 0.28, w: 0.2, h: 0.12 });
  });

  it("leaves a balloon already clear, and one with nowhere clear to go", () => {
    const clear = { x: 0, y: 0, w: 0.2, h: 0.1 };
    assert.equal(clearOfFaces(clear, [FACE], [], PANEL), clear);
    const stuck = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    assert.equal(clearOfFaces(stuck, [FACE], [], PANEL), stuck);
  });

  it("does not move a balloon onto another", () => {
    const moved = clearOfFaces({ x: 0.35, y: 0.3, w: 0.2, h: 0.12 }, [FACE], [{ x: 0.3, y: 0.2, w: 0.4, h: 0.15 }], PANEL);
    assert.notEqual(moved.y, 0.28);
  });

  it("stops a tail at the face it would cross, and holds it in the panel", () => {
    const box = { x: 0.1, y: 0.45, w: 0.1, h: 0.1 };
    const tail = tailClearOfFaces(box, { x: 0.5, y: 0.5 }, [FACE], PANEL);
    assert.ok(tail.x < FACE.x, "short of the face");
    assert.ok(tail.x > box.x + box.w / 2, "still aimed at it");
    assert.deepEqual(tailClearOfFaces(box, { x: 1.4, y: 0.1 }, [], PANEL), { x: 1, y: 0.1 });
  });
});

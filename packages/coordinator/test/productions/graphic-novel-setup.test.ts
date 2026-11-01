import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyProductionSetupUpdate, newId, productionSetupProblems, productionShape, ulid, type ConversationId, type ProductionSetupDraft } from "@arke-studio/contracts";
import { ProductionSetupService, assertSourceReadForPlan } from "../../src/productions/setup.js";
import { createProductionFromPlan } from "../../src/productions/ops.js";
import { planProductionSetup } from "../../src/productions/setup-plan.js";
import { productionSetupBrief } from "../../src/productions/setup-brief.js";
import { WorldStore } from "../../src/world/store.js";
import { COMIC_ADAPTATION_SCHEMA_VERSION, COMIC_PILOT_SCHEMA_VERSION } from "../../src/world/commit.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { chapterFence } from "../../src/world-chat/target-reads.js";

/**
 * A graphic novel planned with Arke (SPEC-064 R-3, R-4, design turn 249b): setup adapts a story,
 * asks its three questions by example, proposes a chapter of pages for each of the story's, and
 * Create makes the book with those chapters, mapped to the ones they adapt.
 */
const CLOCK = "2026-10-29T15:00:00.000Z";
const STORY = "the-ledger-of-nights";
const MANGA = { words: "Japanese manga: black and white only.", preset: "manga" };
async function open() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}
const chaptersOf = (store: WorldStore) => store.getBundle().productions.find((p) => p.meta.id === STORY)!.chapters.filter((c) => !c.retired).sort((a, b) => a.order - b.order);

describe("a graphic novel planned with Arke (SPEC-064 R-3, R-4, turn 249b)", () => {
  it("persists the selected pilot and fences readers that would reject its setup", async () => {
    const store = await open();
    const service = new ProductionSetupService(store);
    const conversation = `cv_${ulid()}` as ConversationId;
    const start = await service.start(conversation, { kind: "graphic-novel", source: { productionId: STORY } });
    const source = chaptersOf(store);
    const changed = await service.update(conversation, { expectedRevision: start.draft.revision, fields: { graphicNovel: {
      reading: "ltr", aspect: "2:3", pilot: true, pilotFrom: source[1]!.order,
      chapters: source.slice(0, 2).map(chapter => ({ from: chapter.order, title: chapter.title, pages: 4 })),
    } } });
    assert.equal(changed.draft.graphicNovel?.pilotFrom, source[1]!.order);
    assert.equal((await new ProductionSetupService(store).start(conversation)).draft.graphicNovel?.pilotFrom, source[1]!.order);
    assert.equal((await readWorldMeta(store.dir)).schemaVersion, COMIC_PILOT_SCHEMA_VERSION);
    await assert.rejects(readWorldMeta(store.dir, { supports: COMIC_PILOT_SCHEMA_VERSION - 1 }), /newer|version|schema/i);
  });

  it("starts from the door's seed: the kind, the story it adapts and the style chosen on the cards", async () => {
    const store = await open();
    const draft = (await new ProductionSetupService(store).start(`cv_${ulid()}` as ConversationId, { kind: "graphic-novel", source: { productionId: STORY }, comicStyle: MANGA })).draft;
    assert.equal(draft.kind, "graphic-novel");
    assert.deepEqual(draft.graphicNovel, { reading: "ltr", aspect: "2:3", pilot: true, chapters: [], style: MANGA });
    assert.ok((await readWorldMeta(store.dir)).schemaVersion >= COMIC_ADAPTATION_SCHEMA_VERSION, "a graphic novel's setup draft is past older readers");
  });

  it("requires current full reads of the selected chapters, without requiring the rest of the book", async () => {
    const store = await open();
    const draft = (await new ProductionSetupService(store).start(`cv_${ulid()}` as ConversationId, { kind: "graphic-novel", source: { productionId: STORY } })).draft;
    const update = { expectedRevision: draft.revision, fields: { graphicNovel: { reading: "ltr" as const, aspect: "2:3", pilot: true, chapters: [{ from: 1, title: "Neap", pages: 8 }] } } };
    assert.throws(() => assertSourceReadForPlan(store.getBundle(), update, draft, []), /Read every selected chapter/);
    const source = store.getBundle().productions.find(production => production.meta.id === STORY)!;
    const first = source.chapters.find(chapter => chapter.order === 1)!;
    const whole = (id: string, extra: object = {}) => ({ id: newId("check"), runId: newId("run"), tool: "target-read", status: "complete", consulted: [], at: CLOCK,
      target: { requirement: "chapters", id: `${STORY}:${id}` }, complete: true, observedRevisionOrDigest: chapterFence(source, id), ...extra }) as never;
    assert.doesNotThrow(() => assertSourceReadForPlan(store.getBundle(), update, draft, [whole(first.id)]));
    for (const receipt of [whole(`${first.id}:beats`), whole(first.id, { complete: false }), whole(first.id, { observedRevisionOrDigest: "old" })]) {
      assert.throws(() => assertSourceReadForPlan(store.getBundle(), update, draft, [receipt]), /Still to read/);
    }
    const entire = { ...update, fields: { graphicNovel: { ...update.fields.graphicNovel, chapters: chaptersOf(store).map(chapter => ({ from: chapter.order, title: chapter.title, pages: 4 })) } } };
    assert.throws(() => assertSourceReadForPlan(store.getBundle(), entire, draft, [whole(first.id)]), /Still to read/);
    assert.doesNotThrow(() => assertSourceReadForPlan(store.getBundle(), entire, draft, chaptersOf(store).map(chapter => whole(chapter.id))));
    const preview = applyProductionSetupUpdate(draft, { ...update, fields: { ...update.fields, title: "One chapter preview" } });
    const plan = planProductionSetup(store.getBundle(), preview, CLOCK);
    await createProductionFromPlan(store, plan, { source: "test", requestId: ulid(), precondition: () => null });
    assert.equal(store.getBundle().productions.find(production => production.meta.id === plan.production.id)!.chapters.length, 1);
    // Asking a question is not a plan: it needs no reading.
    assert.doesNotThrow(() => assertSourceReadForPlan(store.getBundle(), { expectedRevision: draft.revision, fields: { comicAsk: "reading" } }, draft, []));
  });

  it("keeps the author's style through Arke's plan and a new source, and checks each planned chapter is the story's", async () => {
    const store = await open();
    const start = (await new ProductionSetupService(store).start(`cv_${ulid()}` as ConversationId, { kind: "graphic-novel", source: { productionId: STORY }, title: "The Ledger, drawn", comicStyle: MANGA })).draft;
    const asked = applyProductionSetupUpdate(start, { expectedRevision: start.revision, fields: { comicAsk: "aspect" } });
    assert.equal(asked.comicAsk, "aspect");
    const planned = applyProductionSetupUpdate(asked, { expectedRevision: asked.revision, fields: { comicAsk: null,
      graphicNovel: { reading: "rtl", aspect: "2:3", pilot: true, chapters: [{ from: 1, title: "Neap", pages: 7, layout: "feature" }, { from: 2, title: "Salt", pages: 9 }] } } });
    assert.deepEqual(planned.graphicNovel?.style, MANGA, "a plan Arke gives without a style keeps the author's");
    assert.equal(planned.comicAsk, undefined);
    assert.deepEqual(productionSetupProblems(planned, store.getBundle().sheets, store.getBundle().productions), []);
    const wrong = applyProductionSetupUpdate(planned, { expectedRevision: planned.revision, fields: { graphicNovel: { ...planned.graphicNovel!, chapters: [{ from: 99, title: "Nowhere", pages: 1 }] } } });
    assert.match(productionSetupProblems(wrong, store.getBundle().sheets, store.getBundle().productions).join("\n"), /chapter 99/);
    const elsewhere = applyProductionSetupUpdate(planned, { expectedRevision: planned.revision, fields: { source: null } });
    assert.deepEqual(elsewhere.graphicNovel, { reading: "ltr", aspect: "2:3", pilot: true, chapters: [], style: MANGA }, "another source is planned again, in the same style");
  });

  it("creates the book with a chapter for each planned one, reading and looking as planned, and mapped to the story", async () => {
    const store = await open();
    const story = chaptersOf(store);
    const start = (await new ProductionSetupService(store).start(`cv_${ulid()}` as ConversationId, { kind: "graphic-novel", source: { productionId: STORY }, title: "The Ledger, drawn", comicStyle: MANGA })).draft;
    const draft: ProductionSetupDraft = applyProductionSetupUpdate(start, { expectedRevision: start.revision, fields: {
      graphicNovel: { reading: "rtl", aspect: "2:3", pilot: true, chapters: [{ from: story[0]!.order, title: story[0]!.title, pages: 8 }, { from: story[1]!.order, title: "Second", pages: 6 }] },
    } });
    const plan = planProductionSetup(store.getBundle(), draft, CLOCK);
    await createProductionFromPlan(store, plan, { source: "test", requestId: ulid(), precondition: () => null });
    const made = store.getBundle().productions.find((p) => p.meta.id === plan.production.id)!;
    assert.equal(productionShape(made.meta).hasPages, true);
    assert.deepEqual(made.chapters.sort((a, b) => a.order - b.order).map((c) => c.title), [story[0]!.title, "Second"]);
    const comic = JSON.parse(await readFile(join(store.dir, "productions", made.meta.id, "comic.json"), "utf8"));
    assert.equal(comic.reading, "rtl");
    assert.deepEqual(comic.style, MANGA);
    assert.equal(comic.adapts.story, STORY);
    assert.deepEqual(comic.adapts.chapters.map((entry: { from: string }) => entry.from), [story[0]!.id, story[1]!.id]);
    assert.ok((await readWorldMeta(store.dir)).schemaVersion >= COMIC_ADAPTATION_SCHEMA_VERSION);
  });

  it("honours a requested preview without preloading every chapter's beats or requiring a whole-book plan", async () => {
    const store = await open();
    const draft = (await new ProductionSetupService(store).start(`cv_${ulid()}` as ConversationId, { kind: "graphic-novel", source: { productionId: STORY }, comicStyle: MANGA })).draft;
    const reads: string[] = [];
    const read = async (tool: string, args: Record<string, unknown>) => { reads.push(tool); return ({
      result: tool === "get_chapter" ? { items: [] } : { id: args.id },
      receipt: { id: newId("check"), runId: newId("run"), tool: "get-entry", status: "complete", consulted: [], at: CLOCK },
    }) as never; };
    const bundle = store.getBundle();
    for (const chapter of bundle.productions.find(production => production.meta.id === STORY)!.chapters) chapter.audiobook ??= {} as never;
    const brief = await productionSetupBrief(bundle, draft, read, 400_000);
    assert.match(brief, /This production is a graphic novel/);
    assert.match(brief, /set fields\.comicAsk to "reading", "aspect" or "pilot"/);
    assert.match(brief, /one chapter of pages for each selected source chapter/);
    assert.match(brief, /A one-chapter plan is a first-class result/);
    assert.doesNotMatch(brief, /read every chapter/i);
    assert(!reads.includes("get_chapter"), "setup does not read unrequested chapter content or beats");
    assert.match(brief, /Japanese manga/, "the author's style is named, to keep");
    assert.match(brief, /Do not propose verdicts or a page-by-page outline here/);
    const drama = await productionSetupBrief(store.getBundle(), { ...draft, kind: "audio-drama", graphicNovel: undefined }, read, 400_000);
    assert.doesNotMatch(drama, /This production is a graphic novel/);
    assert.match(drama, /read every chapter/i, "other adaptation rules remain unchanged");
  });
});

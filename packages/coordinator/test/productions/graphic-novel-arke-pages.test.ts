import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelWorldChatActionSchema, WORLD_ACTION_DESCRIPTIONS, comicPageHash, newId, ulid, type ComicPage, type ConversationId } from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { createChapter, createProduction, setChapterRetired } from "../../src/productions/ops.js";
import { saveComicScript } from "../../src/productions/graphic-novel.js";
import { stageWorldChatProductionAuthoredAction } from "../../src/world-chat/production-authoring.js";
import { productionRecord } from "../../src/world-chat/production-record.js";
import { WorldStore } from "../../src/world/store.js";
import { readWorldMeta } from "../../src/world/scan.js";
import { COMIC_ADAPTATION_SCHEMA_VERSION, COMIC_PLAN_SCHEMA_VERSION } from "../../src/world/commit.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Arke turns prose into pages (SPEC-064 R-13, design turn 249): a chapter's pages staged whole as a
 * draft the author keeps or discards, each panel citing its passage, and nothing written until kept.
 */
const CLOCK = "2026-10-29T12:00:00.000Z";
async function book(pages: ComicPage[] = []) {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  const id = await createProduction(store, { title: "Low Water, drawn", medium: "story", productionKind: "graphic-novel" });
  const chapter = await createChapter(store, id, { title: "Salt", order: 1 });
  if (pages.length > 0) await saveComicScript(store, id, { chapter, pages, baseHash: null });
  return { store, id, chapter, gate: new ProposalManager(store), intent: { actionId: newId("act"), conversationId: newId("cv") as ConversationId } };
}
const production = (store: WorldStore, id: string) => store.getBundle().productions.find((p) => p.meta.id === id)!;
const action = (id: string, chapter: string, baseHash: string | null, pages: unknown[], plan?: unknown) => ({
  kind: "world-chat-production-comic-script" as const, worldId: "", action: { kind: "production-comic-script" as const, productionId: id, chapter, baseHash, checkReceiptIds: [], pages: pages as never, ...(plan ? { plan: plan as never } : {}) },
});
const PLAN = {
  passages: [{ where: "¶ 1–2", what: "Salt in everything", verdict: "keep", why: "opens on her hands" }, { where: "¶ 3", what: "Jory and the boat", verdict: "cut", why: "a second thread" }],
  pages: [{ change: "Maren walks the hard", turn: "Bray at the door" }],
  knows: [{ name: "Bray", page: 1, how: "named" }],
  leans: [],
};
/** The plan staged alone and kept, as the author keeps it in Pages (R-60): the base the pages are drafted on. */
async function keepPlan(store: WorldStore, gate: ProposalManager, intent: { actionId: string; conversationId: ConversationId }, id: string, chapter: string): Promise<string> {
  const base = production(store, id).comicScripts?.find((entry) => entry.chapter === chapter)?.hash ?? null;
  const run = action(id, chapter, base, [], PLAN);
  run.worldId = store.worldId;
  const proposal = await stageWorldChatProductionAuthoredAction(store, gate, intent as never, run);
  assert.equal((await gate.accept(proposal.id)).status, "accepted");
  return production(store, id).comicScripts!.find((entry) => entry.chapter === chapter)!.hash;
}

describe("Arke's pages (SPEC-064 R-13, turn 249)", () => {
  it("is a model action Arke can name, with pages, panels and lines that need no id", () => {
    const parsed = ModelWorldChatActionSchema.safeParse({
      kind: "production-comic-script", productionId: "low-water-drawn", chapter: "salt", baseHash: null, checkReceiptIds: [`check_${ulid()}`],
      pages: [{ layout: "feature", panels: [{ description: "The harbour at slack water.", lettering: [{ kind: "caption", text: "Salt was in everything." }], source: { story: "low-water", chapter: "salt", paragraphs: [1, 2] } }] }],
    });
    assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
  });

  it("lists a chapter with no pages for Arke, and stages its pages as a draft, citing the chapter as it stands", async () => {
    const { store, id, chapter, gate, intent } = await book();
    const read = productionRecord(store.getBundle(), id) as { unpagedChapters?: { chapters: Array<{ chapter: string; baseHash: string | null }> } };
    assert.deepEqual(read.unpagedChapters?.chapters, [{ chapter, baseHash: null, planKept: false }]);
    const early = action(id, chapter, null, [{ layout: "splash", panels: [{ description: "x" }] }]);
    early.worldId = store.worldId;
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, early), /no kept plan/, "pages are written from a kept plan (R-60)");
    const planned = await keepPlan(store, gate, intent, id, chapter);
    assert.ok((await readWorldMeta(store.dir)).schemaVersion >= COMIC_PLAN_SCHEMA_VERSION, "a build of 117 would drop a planned chapter");
    assert.deepEqual((productionRecord(store.getBundle(), id) as { unpagedChapters?: { chapters: unknown[] } }).unpagedChapters?.chapters, [{ chapter, baseHash: planned, planKept: true }]);
    const run = action(id, chapter, planned, [{ layout: "feature", panels: [
      { description: "Maren walks the hard with her lantern.", characters: ["maren-kest"], lettering: [{ kind: "caption", text: "Salt was in everything that week." }], source: { story: id, chapter, paragraphs: [1, 2] } },
      { description: "Bray at the weigh house door.", characters: ["bray-half-hitch"], lettering: [{ kind: "speech", speaker: "bray-half-hitch", text: "You walked the hard again." }] },
    ] }]);
    run.worldId = store.worldId;
    // The studio's cold read rides on the draft (R-64): what a draft is kept with is on the record.
    const coldRead = { status: "read" as const, reader: { id: "test", version: "1" }, findings: [{ kind: "where" as const, page: 1, question: "Is this the same night?" }], redrafts: 0, at: CLOCK };
    (run.action as Record<string, unknown>).read = coldRead;
    const proposal = await stageWorldChatProductionAuthoredAction(store, gate, intent, run);
    assert.equal(proposal.kind, "comic-script");
    assert.ok((await readWorldMeta(store.dir)).schemaVersion >= COMIC_ADAPTATION_SCHEMA_VERSION, "a drafted-pages proposal is past older readers");
    assert.equal(production(store, id).comicScripts![0]!.script.pages.length, 0, "nothing is written while the draft waits");
    const staged = store.getBundle().proposals.find((entry) => entry.proposal.id === proposal.id)!;
    const drafted = Object.values(staged.comicScripts ?? {})[0]!;
    assert.deepEqual(drafted.read, coldRead);
    const panel = drafted.pages[0]!.panels[0]!;
    assert.match(panel.id, /^[0-9A-HJKMNP-TV-Z]{26}$/, "a new panel is given its id");
    assert.equal(panel.source?.version, production(store, id).chapters[0]!.version ?? 1, "an unversioned citation is pinned to the chapter as it stands");
    assert.equal((await gate.accept(proposal.id)).status, "accepted");
    assert.equal(production(store, id).comicScripts![0]!.script.pages[0]!.panels.length, 2);
    assert.deepEqual(production(store, id).comicScripts![0]!.script.plan?.pages, PLAN.pages, "the pages keep the plan they were drafted from");
  });

  it("tells Arke the plan's exact shape, and never offers it read to send (installed 0.5.77, 2026-11-01)", async () => {
    // Shown only "passages: array<object>", Arke sent {paragraphs, treatment} twice and the turn failed.
    const { actionGuideEntry } = await import("../../src/world-chat/action-guide.js");
    const entry = actionGuideEntry("production-comic-script")!;
    assert.match(entry.description, /"passages":\[\{"where":"¶ 1–6","what":"what happens","verdict":"keep","why"/);
    assert.match(entry.description, /"pages":\[\{"change":/);
    assert.ok(!entry.fields.some((field) => field.startsWith("read")), "the read is the studio's");
  });

  it("lets a new plan replace one still waiting, and fits each drafted page's layout to its panels (turn 256)", async () => {
    const { store, id, chapter, gate, intent } = await book();
    const first = action(id, chapter, null, [], PLAN);
    first.worldId = store.worldId;
    const waiting = await stageWorldChatProductionAuthoredAction(store, gate, intent, first);
    const again = action(id, chapter, null, [], { ...PLAN, mysteries: ["What is under the water?"] });
    again.worldId = store.worldId;
    const replacing = await stageWorldChatProductionAuthoredAction(store, gate, intent, again);
    const staged = store.getBundle().proposals.filter((entry) => entry.proposal.targets.some((target) => target.path.endsWith(`/comic/${chapter}.json`)));
    assert.deepEqual(staged.map((entry) => entry.proposal.id), [replacing.id], "Fix on a lean replaces the waiting plan");
    assert.notEqual(waiting.id, replacing.id);
    assert.equal((await gate.accept(replacing.id)).status, "accepted");
    const base = production(store, id).comicScripts![0]!.hash;
    const run = action(id, chapter, base, [
      { layout: "manga", panels: [{ description: "a" }, { description: "b" }, { description: "c" }, { description: "d" }] },
      { layout: "manga", panels: [{ description: "a" }, { description: "b" }] },
    ]);
    run.worldId = store.worldId;
    const drafted = await stageWorldChatProductionAuthoredAction(store, gate, intent, run);
    const pages = Object.values(store.getBundle().proposals.find((entry) => entry.proposal.id === drafted.id)!.comicScripts!)[0]!.pages;
    assert.deepEqual(pages.map((page) => page.layout), ["grid-2x2", "manga"], "four panels take the four-panel grid; two have no template and keep theirs");
  });

  it("refuses a plan sent with pages, and pages sent with a plan", async () => {
    const { store, id, chapter, gate, intent } = await book();
    const both = action(id, chapter, null, [{ layout: "splash", panels: [{ description: "x" }] }], PLAN);
    both.worldId = store.worldId;
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, both), /plan alone, with no pages/);
    const none = action(id, chapter, null, []);
    none.worldId = store.worldId;
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, none), /has no pages/);
  });

  it("keeps a page's id, so its takes stay its own, and fences on the pages Arke read", async () => {
    const page: ComicPage = { id: ulid(), layout: "feature", status: "draft", panels: [{ id: ulid(), description: "Maren on the pier.", characters: ["maren-kest"], lettering: [] }] };
    const { store, id, chapter, gate, intent } = await book([page]);
    const baseHash = await keepPlan(store, gate, intent, id, chapter);
    const stale = action(id, chapter, "sha256:old", [{ id: page.id, layout: "feature", panels: [{ id: page.panels[0]!.id, description: "Maren on the pier." }] }]);
    stale.worldId = store.worldId;
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, stale), /changed since/);
    const fresh = action(id, chapter, null, stale.action.pages);
    fresh.worldId = store.worldId;
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, fresh), /already has pages/);
    const run = action(id, chapter, baseHash, [{ id: page.id, layout: "feature", panels: [{ id: page.panels[0]!.id, description: "Maren on the pier.", characters: ["maren-kest"] }] }, { id: "guessed", layout: "splash", panels: [{ description: "The bell." }] }]);
    run.worldId = store.worldId;
    const proposal = await stageWorldChatProductionAuthoredAction(store, gate, intent, run);
    const drafted = Object.values(store.getBundle().proposals.find((entry) => entry.proposal.id === proposal.id)!.comicScripts!)[0]!;
    assert.equal(drafted.pages[0]!.id, page.id);
    assert.equal(comicPageHash(drafted.pages[0]!, { reading: "ltr", aspect: "2:3" }, "baked"), comicPageHash(page, { reading: "ltr", aspect: "2:3" }, "baked"), "an unchanged page is still the page its takes were made from");
    assert.notEqual(drafted.pages[1]!.id, "guessed", "a guessed id is never taken");
    // One draft of a chapter at a time.
    const again = action(id, chapter, baseHash, [{ layout: "splash", panels: [{ description: "The bell." }] }]);
    again.worldId = store.worldId;
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, again), /is waiting/);
  });

  it("names an emptied chapter's own base, and drafts no pages for a retired chapter (codex on PR 2246)", async () => {
    const { store, id, chapter, gate, intent } = await book();
    const saved = await saveComicScript(store, id, { chapter, pages: [], baseHash: null });
    const read = productionRecord(store.getBundle(), id) as { unpagedChapters?: { chapters: Array<{ chapter: string; baseHash: string | null }> } };
    assert.deepEqual(read.unpagedChapters?.chapters, [{ chapter, baseHash: saved.hash, planKept: false }], "a saved empty script is drafted on its own hash, not null");
    await setChapterRetired(store, id, production(store, id).chapters.find((c) => c.id === chapter)!.file, true);
    assert.deepEqual((productionRecord(store.getBundle(), id) as { unpagedChapters?: { chapters: unknown[] } }).unpagedChapters?.chapters, []);
    const retired = action(id, chapter, saved.hash, [{ layout: "splash", panels: [{ description: "x" }] }]);
    retired.worldId = store.worldId;
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, retired), /has no chapter/);
  });

  it("refuses a sheet that is not in the world, a passage in a chapter that is not, and a book that is not a graphic novel", async () => {
    const { store, id, chapter, gate, intent } = await book();
    const planned = await keepPlan(store, gate, intent, id, chapter);
    const nobody = action(id, chapter, planned, [{ layout: "splash", panels: [{ description: "x", characters: ["nobody-at-all"] }] }]);
    nobody.worldId = store.worldId;
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, nobody), /not a sheet/);
    const nowhere = action(id, chapter, planned, [{ layout: "splash", panels: [{ description: "x", source: { story: id, chapter: "nowhere", paragraphs: [1] } }] }]);
    nowhere.worldId = store.worldId;
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, nowhere), /not in this world/);
    const novel = await createProduction(store, { title: "A book", medium: "story" });
    const wrong = action(novel, chapter, null, [{ layout: "splash", panels: [{ description: "x" }] }]);
    wrong.worldId = store.worldId;
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, wrong), /not a graphic novel/);
  });

  it("refuses a line that ends in a comma, the prose's dialogue with its tag cut, and tells Arke the craft", async () => {
    // The Ledger of Nights, drawn (30 October 2026): "Give me the addresses," she said became a
    // balloon reading "Give me the addresses," fourteen times over across eleven pages.
    const { store, id, chapter, gate, intent } = await book();
    const planned = await keepPlan(store, gate, intent, id, chapter);
    const cut = action(id, chapter, planned, [{ layout: "splash", panels: [{ description: "Maren at the desk.", characters: ["maren-kest"], lettering: [{ kind: "speech", speaker: "maren-kest", text: "Give me the addresses," }] }] }]);
    cut.worldId = store.worldId;
    await assert.rejects(stageWorldChatProductionAuthoredAction(store, gate, intent, cut), /Page 1 has "Give me the addresses,", which ends in a comma/);
    assert.match(WORLD_ACTION_DESCRIPTIONS["production-comic-script"], /never the prose with its tags cut/);
    assert.match(WORLD_ACTION_DESCRIPTIONS["production-comic-script"], /Name each person/);
  });
});

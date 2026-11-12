import assert from "node:assert/strict";
import { it } from "node:test";
import { newId, type WorldChatCheckReceipt } from "@arke-studio/contracts";
import { worldChatSubjectExists } from "../../src/world-chat/context-validation.js";
import { chapterDraftingBrief } from "../../src/world-chat/chapter-brief.js";
import { WorldChatRetrieval } from "../../src/world-chat/retrieval.js";
import { QueryLeaseRegistry } from "../../src/world-chat/lease.js";
import { WorldChatAttachmentStore } from "../../src/world-chat/attachments.js";
import { fixtureBundle } from "../index-db/helpers.js";
import { tempDir } from "../tmp.js";

it("assembles the plan, bounded previous ending, resolved draws and style with distinct receipts", async () => {
  const bundle = await fixtureBundle();
  const production = bundle.productions.find((p) => p.meta.id === "the-ledger-of-nights")!;
  const chapter = production.chapters[1]!;
  assert.equal(worldChatSubjectExists(bundle, { kind: "production", productionId: production.meta.id }, { kind: "chapter", chapterId: chapter.id }), true);
  assert.equal(worldChatSubjectExists(bundle, { kind: "world" }, { kind: "chapter", chapterId: chapter.id }), false);
  assert.equal(worldChatSubjectExists(bundle, { kind: "production", productionId: "saltlight" }, { kind: "chapter", chapterId: chapter.id }), false);
  chapter.synopsis = "Maren finds the missing page.";
  chapter.pov = "maren-kest";
  chapter.when = "The second watch";
  chapter.draws = { sheets: ["maren-kest"], canon: [bundle.canon[0]!.id] };
  production.treatment = "Unrelated treatment. ".repeat(10_000);
  production.proseStyle = { version: 1, voice: "Spare sentences, concrete images." };
  const leases = new QueryLeaseRegistry(() => bundle.meta.worldId);
  const lease = leases.mint({ worldId: bundle.meta.worldId, conversationId: newId("cv"), runId: newId("run"), allowedAttachmentIds: [] });
  const retrieval = new WorldChatRetrieval({
    leases, getBundle: () => bundle, getIndex: () => null,
    attachments: new WorldChatAttachmentStore(await tempDir("chapter-brief-")), findAttachment: async () => null,
    getChapterBody: async () => "Opening not needed.\n\n" + "x".repeat(7_000) + "\n\nThe tide turned.\n\nThe bell stopped.",
  });
  const receipts: WorldChatCheckReceipt[] = [];
  const read = async (tool: string, args: Record<string, unknown>) => {
    const outcome = await retrieval.call(lease.token, tool, args);
    receipts.push(outcome.receipt);
    return outcome;
  };
  const brief = await chapterDraftingBrief(bundle, production.meta.id, chapter.id, read, 60_000);
  assert.doesNotMatch(brief, /Unrelated treatment/);
  assert.match(brief, /Maren finds the missing page/);
  assert.match(brief, /The second watch/);
  assert.match(brief, /The bell stopped/);
  assert.doesNotMatch(brief, /Opening not needed/);
  assert.match(brief, /"truncated":true/);
  assert.match(brief, /Spare sentences, concrete images/);
  assert.match(brief, /Draft from the synopsis/);
  assert.match(brief, /Draft the rest/);
  assert.match(brief, /production-chapter action in the turn result's actions array/);
  assert.ok(brief.includes(`change.chapterId ${JSON.stringify(chapter.id)}`));
  assert.match(brief, /change.changes.body containing the complete proposed manuscript/);
  assert.match(brief, /changes.implies for separate decisions/);
  assert.match(brief, /Each changes.implies item is an object with kind/);
  assert.match(brief, /Do not use plain strings or title\/statement fields/);
  assert.ok(receipts.some((r) => r.target?.id.endsWith(":plan")));
  const ending = receipts.find((r) => r.target?.id.endsWith(":ending"))!;
  assert.ok(ending.complete);
  assert.ok(receipts.some((r) => r.consulted.some((c) => c.ref.kind === "sheet")));
  assert.ok(receipts.some((r) => r.consulted.some((c) => c.ref.kind === "canon")));
  const manuscriptBrief = await chapterDraftingBrief(bundle, production.meta.id, chapter.id, read, 60_000, { impliedFacts: false, manuscript: true });
  assert.match(manuscriptBrief, /Opening not needed/);
  assert.match(manuscriptBrief, /Complete current manuscript/);
  assert.match(manuscriptBrief, /do not include changes.implies/);
  assert.doesNotMatch(manuscriptBrief, /ask that specific question/);
  assert.ok(receipts.some(r => r.target?.id === `${production.meta.id}:${chapter.id}` && r.complete && r.nextCursor === null));
  assert.ok(receipts.some(r => r.target?.id === `${production.meta.id}::plan` && r.complete && r.nextCursor === null));
  production.chapters[0]!.hash = "changed";
  const reread = await read("get_chapter", { productionId: production.meta.id, chapterId: production.chapters[0]!.id, section: "ending" });
  assert.notEqual(reread.receipt.observedRevisionOrDigest, ending.observedRevisionOrDigest);
  await assert.rejects(chapterDraftingBrief(bundle, production.meta.id, chapter.id, read, 100), /too large/);
  await assert.rejects(chapterDraftingBrief(bundle, production.meta.id, chapter.id, read, brief.length + 100, { manuscript: true }), /too large/, "full manuscript reads share the context budget");
});

// The Undersong's first two chapters lost their reader on 2026-10-25: the brief for chapters 1 and 2
// asks for the book's question in the present and a turn at the end, counted along the outline the
// reader meets, so a retired chapter takes no place and chapter 3 is drafted without it.
it("asks the first two chapters of the outline to hook the reader", async () => {
  const bundle = await fixtureBundle();
  const production = bundle.productions.find((p) => p.meta.id === "the-ledger-of-nights")!;
  while (production.chapters.length < 4) {
    const n = production.chapters.length + 1;
    production.chapters.push({ ...production.chapters.at(-1)!, id: `added-${n}`, file: `0${n}-added`, title: `Added ${n}`, order: n });
  }
  const leases = new QueryLeaseRegistry(() => bundle.meta.worldId);
  const lease = leases.mint({ worldId: bundle.meta.worldId, conversationId: newId("cv"), runId: newId("run"), allowedAttachmentIds: [] });
  const retrieval = new WorldChatRetrieval({
    leases, getBundle: () => bundle, getIndex: () => null,
    attachments: new WorldChatAttachmentStore(await tempDir("chapter-opening-")), findAttachment: async () => null,
    getChapterBody: async () => "The tide turned.",
  });
  const read = (tool: string, args: Record<string, unknown>) => retrieval.call(lease.token, tool, args);
  const brief = (index: number) => chapterDraftingBrief(bundle, production.meta.id, production.chapters[index]!.id, read, 60_000);
  assert.match(await brief(0), /## Opening chapters\nThis is chapter 1 of the book\. Readers decide in the first two chapters/);
  assert.match(await brief(1), /This is chapter 2 of the book/);
  // The owner's second note on the same book: its secret was pointed at in chapter 1 by name.
  assert.match(await brief(1), /plant only signs that read innocently now and make sense at the reveal; never point at the answer/);
  assert.doesNotMatch(await brief(2), /Opening chapters/);
  production.chapters[0]!.retired = true;
  assert.match(await brief(2), /This is chapter 2 of the book/, "a retired chapter is not one the reader meets");
});

// The beats a chapter was grouped by (design turn 201), as an adaptation reads them (SPEC-052 R-15):
// each placed at the paragraph its first block begins, with its opening words; none for a chapter
// never grouped, and a section the read does not know refused.
it("reads a chapter's named beats with where each begins", async () => {
  const bundle = await fixtureBundle();
  const production = bundle.productions.find((p) => p.meta.id === "the-ledger-of-nights")!;
  const [grouped, plain] = production.chapters;
  const leases = new QueryLeaseRegistry(() => bundle.meta.worldId);
  const lease = leases.mint({ worldId: bundle.meta.worldId, conversationId: newId("cv"), runId: newId("run"), allowedAttachmentIds: [] });
  const retrieval = new WorldChatRetrieval({
    leases, getBundle: () => bundle, getIndex: () => null,
    attachments: new WorldChatAttachmentStore(await tempDir("chapter-beats-")), findAttachment: async () => null,
    getChapterBody: async () => "The tide came in.\n\nMaren rang the bell.\n\nNobody answered.",
    getChapterBeats: async (_production, file) => file === grouped!.file
      ? [{ start: "p1.0", textHash: "h1", name: "The bell", whose: "Maren" }, { start: "title", textHash: "h0" }]
      : [],
  });
  const read = (chapterId: string, section: string) => retrieval.call(lease.token, "get_chapter", { productionId: production.meta.id, chapterId, section });
  const beats = await read(grouped!.id, "beats");
  assert.equal(beats.receipt.status, "complete");
  assert.ok(beats.receipt.target?.id.endsWith(":beats"));
  const page = beats.result as { items: Array<{ beats: unknown[] }> };
  assert.deepEqual(page.items[0]!.beats, [{ name: "The bell", whose: "Maren", paragraph: 2, opens: "Maren rang the bell." }, {}]);
  const none = (await read(plain!.id, "beats")).result as { items: Array<{ beats: unknown[] }> };
  assert.deepEqual(none.items[0]!.beats, []);
  await assert.rejects(read(grouped!.id, "cast"), /plan, ending, beats, audio-studio or audiobook/);
});

// Where a chapter's audiobook reading goes quiet and breathy (SPEC-047 R-196): the measured read
// paged like any other, fenced on the takes it measured so a reread between pages starts it again,
// and refused where the host cannot measure.
it("reads where a chapter's audiobook goes quiet, fenced on its takes", async () => {
  const bundle = await fixtureBundle();
  const production = bundle.productions.find((p) => p.meta.id === "the-ledger-of-nights")!;
  const [chapter] = production.chapters;
  const leases = new QueryLeaseRegistry(() => bundle.meta.worldId);
  const lease = leases.mint({ worldId: bundle.meta.worldId, conversationId: newId("cv"), runId: newId("run"), allowedAttachmentIds: [] });
  const block = (key: string) => ({ key, label: `Block ${key}`, text: "She whispered it. Then he answered aloud.", seconds: 12,
    direction: { markers: [{ delivery: "whispered", at: [0, 17] as const, words: "She whispered it." }] },
    quiet: [{ seconds: [0.5, 9] as const, underUsualDb: 9.5, voiced: 0.3, words: "She whispered it. Then he answered", estimated: true }] });
  let takes = ["ar_one", "ar_two"];
  const quiet = { chapterId: chapter!.id, title: chapter!.title, usualDb: -16.2, measured: 2, unmeasured: [{ key: "p9.0", reason: "no current reading" }] };
  const retrieval = new WorldChatRetrieval({
    leases, getBundle: () => bundle, getIndex: () => null,
    attachments: new WorldChatAttachmentStore(await tempDir("chapter-quiet-")), findAttachment: async () => null,
    getChapterQuiet: async (_production, file) => {
      assert.equal(file, chapter!.file);
      return { ...quiet, takes, blocks: [block("p1.0"), block("p2.0")] };
    },
  });
  const read = (args: Record<string, unknown>) => retrieval.call(lease.token, "get_chapter", { productionId: production.meta.id, chapterId: chapter!.id, section: "audiobook", ...args });
  const first = await read({ limit: 2 });
  assert.equal(first.receipt.status, "complete");
  assert.ok(first.receipt.target?.id.endsWith(":audiobook"));
  const page = first.result as { items: Array<Record<string, unknown>>; nextCursor: string | null; total: number };
  assert.equal(page.total, 3);
  assert.deepEqual(page.items[0], { ...quiet });
  assert.equal((page.items[1] as { key: string }).key, "p1.0");
  takes = ["ar_one", "ar_three"];
  await assert.rejects(read({ cursor: page.nextCursor }), /changed while it was being read/);
  const without = new WorldChatRetrieval({ leases, getBundle: () => bundle, getIndex: () => null,
    attachments: new WorldChatAttachmentStore(await tempDir("chapter-quiet-none-")), findAttachment: async () => null });
  await assert.rejects(without.call(lease.token, "get_chapter", { productionId: production.meta.id, chapterId: chapter!.id, section: "audiobook" }), /unavailable for this chapter/);
});

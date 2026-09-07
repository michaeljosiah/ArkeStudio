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
  assert.ok(receipts.some((r) => r.target?.id.endsWith(":plan")));
  const ending = receipts.find((r) => r.target?.id.endsWith(":ending"))!;
  assert.ok(ending.complete);
  assert.ok(receipts.some((r) => r.consulted.some((c) => c.ref.kind === "sheet")));
  assert.ok(receipts.some((r) => r.consulted.some((c) => c.ref.kind === "canon")));
  production.chapters[0]!.hash = "changed";
  const reread = await read("get_chapter", { productionId: production.meta.id, chapterId: production.chapters[0]!.id, section: "ending" });
  assert.notEqual(reread.receipt.observedRevisionOrDigest, ending.observedRevisionOrDigest);
  await assert.rejects(chapterDraftingBrief(bundle, production.meta.id, chapter.id, read, 100), /too large/);
});

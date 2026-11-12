import assert from "node:assert/strict";
import { it } from "node:test";
import { chapterWordTotal, measuredChapterWords, proposedBatchWords, proposedChapterWords, CHAPTER_WORD_COUNT_LABEL } from "../src/chapter-word-counts.js";
import type { ConversationActionCard } from "../src/arke-actions.js";

it("measures complete prose while leaving metadata-only and non-chapter changes out", () => {
  const changes = proposedChapterWords([
    { kind: "chapter · v2", label: "River", fields: [{ field: "Prose", before: " one\t two\nthree ", proposed: "river water ".repeat(3000) }] },
    { kind: "new chapter · v1", label: "Bell", fields: [{ field: "Prose", before: null, proposed: "One bell." }] },
    { kind: "chapter · v2", label: "Plan", fields: [{ field: "Title", before: "Old", proposed: "New" }] },
    { kind: "character sheet", label: "Not a chapter", fields: [{ field: "Prose", before: null, proposed: "A character." }] },
  ]);
  assert.deepEqual(changes, [{ title: "River", before: 3, after: 6000 }, { title: "Bell", before: 0, after: 2 }]);
  assert.deepEqual(chapterWordTotal(changes), { before: 3, after: 6002, delta: 5999 });
});

it("excludes denied and superseded cards from batch totals and ignores unmeasured legacy cards", () => {
  const card = { actionKind: "world-chat-production-chapter", status: "pending", shown: { body: { family: "authored-diff", fields: [
    { label: CHAPTER_WORD_COUNT_LABEL + "River", before: "100", after: "240" },
  ] } } } as ConversationActionCard;
  assert.equal(measuredChapterWords(card)[0]?.after, 240);
  for (const status of ["denied", "superseded", "stale", "failed", "cancelled"] as const) {
    assert.deepEqual(proposedBatchWords([card, { ...card, status }]), measuredChapterWords(card));
  }
  assert.deepEqual(measuredChapterWords({ ...card, actionKind: "world-chat-sheet-edit" } as ConversationActionCard), []);
  assert.deepEqual(measuredChapterWords({ ...card, shown: { ...card.shown, body: { family: "authored-diff", fields: [{ label: "Prose", before: null, after: "An excerpt…" }], conflicts: [], openChoices: [] } } }), []);
});

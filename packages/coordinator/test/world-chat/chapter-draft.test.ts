import assert from "node:assert/strict";
import { it } from "node:test";
import { chapterDraftResult } from "../../src/world-chat/chapter-draft.js";
import type { AcceptedTurn } from "../../src/world-chat/turn-result.js";

const turn = (): AcceptedTurn => ({ reply: "Ready for review.", candidates: [], groups: [], tombstones: [],
  bibleEdits: [], editorRequests: [], sceneEdits: [], actions: [{ kind: "production-chapter", productionId: "the-ledger",
    change: { operation: "edit", chapterId: "neap", changes: { body: "Maren counted the bells.", status: "draft" } }, checkReceiptIds: [] }] });

it("shares one bounded manuscript contract between chapter chat and engine writing", () => {
  assert.deepEqual(chapterDraftResult(turn(), "the-ledger", "neap"), { body: "Maren counted the bells." });
  assert.ok("problem" in chapterDraftResult({ ...turn(), actions: [] }, "the-ledger", "neap"), "editorial prose is not a draft");
  assert.ok("problem" in chapterDraftResult(turn(), "another-book", "neap"));
  assert.ok("problem" in chapterDraftResult(turn(), "the-ledger", "another-chapter"));
  assert.ok("problem" in chapterDraftResult({ ...turn(), actions: [...turn().actions, ...turn().actions] }, "the-ledger", "neap"));
  const planned = turn();
  const action = planned.actions[0]!;
  assert.equal(action.kind, "production-chapter");
  if (action.kind !== "production-chapter" || action.change.operation !== "edit") throw Error("Invalid fixture");
  action.change.changes.synopsis = "An unrelated new plan.";
  assert.ok("problem" in chapterDraftResult(planned, "the-ledger", "neap"), "a drafting press cannot rewrite the plan");
  assert.ok("problem" in chapterDraftResult({ ...turn(), tombstones: [{} as never] }, "the-ledger", "neap"));
});

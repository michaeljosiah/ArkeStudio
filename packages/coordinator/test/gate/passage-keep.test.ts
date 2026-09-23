import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { changedSpan, composePassage, newId, passageDiff, type ConversationId } from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { stageWorldChatProductionAuthoredAction } from "../../src/world-chat/production-authoring.js";
import { MarkdownFile } from "../../src/world/text-files.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Keeping part of a passage revision (turn 128): the span the revision changed becomes what the
 * reviewer kept, found by the gate between the base and the staged chapter, and nothing else in
 * the chapter moves.
 */

const PRODUCTION = "the-ledger-of-nights";
const CHAPTER = "productions/the-ledger-of-nights/chapters/01-neap.md";
const NOW = () => "2026-09-06T12:00:00.000Z";
const FIND = "kept in a hand that changes every generation";
const WITH = "held in a hand that changes each generation";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: NOW });
  closeOnCleanup(() => store.close());
  const gate = new ProposalManager(store);
  const intent = { actionId: newId("act"), conversationId: newId("cv") as ConversationId };
  const stage = (changes: Record<string, unknown>) =>
    stageWorldChatProductionAuthoredAction(store, gate, intent, {
      kind: "world-chat-production-chapter",
      worldId: store.worldId,
      action: { kind: "production-chapter", productionId: PRODUCTION, change: { operation: "edit", chapterId: "neap", changes }, checkReceiptIds: [] },
    } as Parameters<typeof stageWorldChatProductionAuthoredAction>[3]);
  const read = async (path: string) => MarkdownFile.parse(await readFile(join(dir, ...path.split("/")), "utf8"));
  return { dir, store, gate, stage, read };
}

/** The span as the screen draws it, and the passage with only the edits at `keep` taken. */
function choose(base: string, staged: string, keep: number[]) {
  const span = changedSpan(base, staged)!;
  return { before: span.before, after: span.after, text: composePassage(passageDiff(span.before, span.after), new Set(keep)) };
}

describe("keeping part of a passage revision (turn 128)", () => {
  it("replaces only the span with the edits kept, restamps the words and moves the draft revision", async () => {
    const { gate, stage, read } = await open();
    const live = await read(CHAPTER);
    const proposal = await stage({ passage: { find: FIND, with: WITH } });
    const stagedPath = `.proposals/${proposal.id}/${CHAPTER}`;
    const staged = await read(stagedPath);
    const chosen = choose(live.body, staged.body, [1]);
    assert.equal(passageDiff(chosen.before, chosen.after).filter((s) => s.kind === "edit").length, 2, "two edits: kept→held and every→each");

    const outcome = await gate.updatePassage({ proposalId: proposal.id, requestId: "req-1", path: CHAPTER, ...chosen, expectedDraftRevision: proposal.draftRevision });
    assert.equal(outcome.status, "updated");
    const after = await read(stagedPath);
    assert.equal(after.body, live.body.replace(FIND, "kept in a hand that changes each generation"), "only the kept edit, and the rest untouched");
    assert.equal(after.data["words"], after.body.trim().split(/\s+/).length);
    assert.equal(outcome.status === "updated" ? outcome.proposal.draftRevision : 0, proposal.draftRevision + 1);

    // The same request again is the same edit, not a second one.
    const retry = await gate.updatePassage({ proposalId: proposal.id, requestId: "req-1", path: CHAPTER, ...chosen, expectedDraftRevision: proposal.draftRevision });
    assert.equal(retry.status, "updated");
    assert.equal((await read(stagedPath)).body, after.body);
  });

  it("refuses a stale revision, a span that is not the one on screen, and keeping nothing", async () => {
    const { gate, stage, read } = await open();
    const live = await read(CHAPTER);
    const proposal = await stage({ passage: { find: FIND, with: WITH } });
    const staged = await read(`.proposals/${proposal.id}/${CHAPTER}`);
    const chosen = choose(live.body, staged.body, [0]);
    const base = { proposalId: proposal.id, path: CHAPTER, expectedDraftRevision: proposal.draftRevision };

    const stale = await gate.updatePassage({ ...base, requestId: "req-stale", ...chosen, expectedDraftRevision: proposal.draftRevision + 1 });
    assert.equal(stale.status, "stale");

    const elsewhere = await gate.updatePassage({ ...base, requestId: "req-other", ...chosen, before: "another passage" });
    assert.equal(elsewhere.status, "rejected");
    assert.match(elsewhere.status === "rejected" ? elsewhere.message : "", /not the one on screen/);

    const nothing = await gate.updatePassage({ ...base, requestId: "req-none", ...chosen, text: chosen.before });
    assert.equal(nothing.status, "rejected");
    assert.match(nothing.status === "rejected" ? nothing.message : "", /Nothing is kept/);
  });

  it("refuses a whole-chapter draft, and a passage whose chapter moved after it was staged", async () => {
    const { dir, gate, stage, read } = await open();
    const live = await read(CHAPTER);

    const draft = await stage({ body: `${live.body}\n\nA closing line.` });
    const whole = await gate.updatePassage({
      proposalId: draft.id,
      requestId: "req-draft",
      path: CHAPTER,
      before: "",
      after: "A closing line.",
      text: "",
      expectedDraftRevision: draft.draftRevision,
    });
    assert.equal(whole.status, "rejected");
    assert.match(whole.status === "rejected" ? whole.message : "", /Only a passage revision/);

    const proposal = await stage({ passage: { find: FIND, with: WITH } });
    const staged = await read(`.proposals/${proposal.id}/${CHAPTER}`);
    const chosen = choose(live.body, staged.body, [0]);
    await writeFile(join(dir, ...CHAPTER.split("/")), (await readFile(join(dir, ...CHAPTER.split("/")), "utf8")).replace("Maren", "Ines"));
    const moved = await gate.updatePassage({ proposalId: proposal.id, requestId: "req-moved", path: CHAPTER, ...chosen, expectedDraftRevision: proposal.draftRevision });
    assert.equal(moved.status, "rejected");
    assert.match(moved.status === "rejected" ? moved.message : "", /chapter changed/);
  });
});

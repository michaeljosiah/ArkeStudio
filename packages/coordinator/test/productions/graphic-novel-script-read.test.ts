import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ComicPage } from "@arke-studio/contracts";
import { createChapter, createProduction } from "../../src/productions/ops.js";
import { readComicDrafts, saveComicScript } from "../../src/productions/graphic-novel.js";
import type { ScriptReader } from "../../src/productions/graphic-novel-script-reader.js";
import { ConversationActionPreparationError } from "../../src/arke-actions/lifecycle.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The cold read of Arke's drafted pages (SPEC-064 R-64 – R-66, turn 254d). The reader is given the
 * pages before the draft and the draft, never the prose; a draft it cannot follow goes back to Arke
 * once with its questions, and the redraft is offered with whatever is left on it.
 */
const AT = () => "2026-11-01T12:00:00.000Z";
const SIGNAL = new AbortController().signal;

async function book() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: AT });
  closeOnCleanup(() => store.close());
  const id = await createProduction(store, { title: "Low Water, drawn", medium: "story", productionKind: "graphic-novel" });
  const first = await createChapter(store, id, { title: "The tide", order: 1 });
  const second = await createChapter(store, id, { title: "Salt", order: 2 });
  const kept: ComicPage = { id: "01J0000000000000000000T001", layout: "splash", status: "draft",
    panels: [{ id: "01J0000000000000000000T002", description: "Maren on the hard at dawn.", characters: [], lettering: [{ id: "01J0000000000000000000T003", kind: "caption", text: "The tide came in grey." }] }] };
  await saveComicScript(store, id, { chapter: first, pages: [kept], baseHash: null });
  return { store, id, second };
}
const draft = (id: string, chapter: string, read?: unknown) => ({ kind: "production-comic-script", productionId: id, chapter, baseHash: null, checkReceiptIds: [],
  pages: [{ layout: "splash", panels: [{ description: "Maren on the mud.", characters: [], lettering: [{ kind: "speech", text: "Then where's Jory?" }] }] }], ...(read ? { read } : {}) });
function reader(answers: Array<Awaited<ReturnType<ScriptReader["read"]>>["findings"]>, asked: Array<{ before: string; draft: string }> = []): ScriptReader {
  let n = 0;
  return { read: async (input) => { asked.push(input); return { findings: answers[Math.min(n++, answers.length - 1)]!, reader: { id: "test", version: "1" } }; } };
}
const JORY = { kind: "who" as const, page: 1, panel: 1, question: "Who is Jory?" };

describe("the cold read of a draft (SPEC-064 R-64 – R-66, turn 254)", () => {
  it("reads the pages before it and the draft, never the prose, and refuses once with the reader's question", async () => {
    const { store, id, second } = await book();
    const asked: Array<{ before: string; draft: string }> = [];
    const refused = new Map<string, number>();
    const turn = { conversationId: "cv_1", turnId: "turn_1", actions: [draft(id, second)] };
    await assert.rejects(readComicDrafts(store, turn, reader([[JORY], [JORY]], asked), refused, SIGNAL, AT),
      (err: unknown) => err instanceof ConversationActionPreparationError && /could not follow Salt: page 1 panel 1, Who is Jory\?/.test(err.message));
    assert.match(asked[0]!.before, /The tide, page 1:[\s\S]*"The tide came in grey\."/, "the chapter before, as its pages");
    assert.match(asked[0]!.draft, /Page 1:[\s\S]*"Then where's Jory\?"/);
    // The next draft of the chapter in the conversation — the corrective attempt, or a later ask when
    // that attempt failed for something else — is read again and offered with what is left on it.
    const again = { conversationId: "cv_1", turnId: "turn_9", actions: [draft(id, second)] };
    await readComicDrafts(store, again, reader([[JORY]]), refused, SIGNAL, AT);
    const read = (again.actions[0] as { read?: { status: string; findings: unknown[]; redrafts: number } }).read;
    assert.deepEqual([read?.status, read?.findings, read?.redrafts], ["read", [JORY], 1]);
  });

  it("offers a draft a reader can follow, with its warnings, at once", async () => {
    const { store, id, second } = await book();
    const where = { kind: "where" as const, page: 1, question: "Is this the same night?" };
    const turn = { conversationId: "cv_2", turnId: "turn_2", actions: [draft(id, second)] };
    await readComicDrafts(store, turn, reader([[where]]), new Map(), SIGNAL, AT);
    assert.deepEqual((turn.actions[0] as { read?: { findings: unknown[] } }).read?.findings, [where]);
  });

  it("says not read when no reader can, and replaces whatever Arke wrote in read", async () => {
    const { store, id, second } = await book();
    const forged = { status: "read", reader: { id: "arke", version: "1" }, findings: [], redrafts: 0, at: AT() };
    const turn = { conversationId: "cv_3", turnId: "turn_3", actions: [draft(id, second, forged)] };
    await readComicDrafts(store, turn, null, new Map(), SIGNAL, AT);
    assert.deepEqual((turn.actions[0] as { read?: { status: string; reason: string } }).read, { status: "not-read", reason: "no-reader", detail: "no harness is ready to read", at: AT() });
    const failing: ScriptReader = { read: async () => { throw new Error("the model timed out"); } };
    const again = { conversationId: "cv_3", turnId: "turn_4", actions: [draft(id, second)] };
    await readComicDrafts(store, again, failing, new Map(), SIGNAL, AT);
    assert.equal((again.actions[0] as { read?: { reason: string } }).read?.reason, "reader-failed", "a failed read is never a pass");
  });

  it("leaves a plan alone: there are no pages to read", async () => {
    const { store, id, second } = await book();
    const plan = { kind: "production-comic-script", productionId: id, chapter: second, baseHash: null, checkReceiptIds: [], pages: [], plan: { passages: [], pages: [] } };
    const turn = { conversationId: "cv_4", turnId: "turn_5", actions: [plan] };
    let asked = 0;
    await readComicDrafts(store, turn, { read: async () => { asked += 1; return { findings: [], reader: { id: "t", version: "1" } }; } }, new Map(), SIGNAL, AT);
    assert.equal(asked, 0);
    assert.equal((turn.actions[0] as { read?: unknown }).read, undefined);
  });
});

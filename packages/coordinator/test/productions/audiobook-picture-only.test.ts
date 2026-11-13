import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAIN_PHOTO_LOOK, kitLookLibrary, pictureLookChanged, type ChapterAudiobook, type ClientMessage, type DomainEvent, type IllustrationProposal } from "@arke-studio/contracts";
import { readAudiobook } from "../../src/productions/audiobook.js";
import { AUDIOBOOK_OWN_LOOKS_SCHEMA_VERSION } from "../../src/world/commit.js";
import { buildRewritePrompt, type PromptRewriter, type RewriteInput } from "../../src/productions/audiobook-picture-rewrite.js";
import type { IllustrateDeriver } from "../../src/productions/audiobook-illustrate.js";
import { acceptCharacterLook } from "../../src/references/kit.js";
import { pngBytes } from "../queue/fake-provider.js";
import { CHAPTER, LEDGER, WORLD_ID, withHarness, type Harness, type HarnessOptions } from "./picture-harness.js";

/**
 * Only this picture (design turn 193d, rule 8; SPEC-047 R-115, R-146): a look chosen in a block's
 * look menu for that block's picture alone. Held on the block until the picture is made, it rides
 * for that person in place of the chapter's choice, is stamped `only` on the picture, and the
 * chapter's later choice never marks the picture `look changed`. Update prompt rewrites that
 * person's clothing words for it, and leaves the rest of the prompt as the author has it.
 */
const STORM = "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2Q1";
const HARBOUR = "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2Q2";
const HARBOUR_CLOSE = "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2Q3";
const STORM_LINE = "Storm coat, hood up.";
const HARBOUR_LINE = "Harbour coat, low-backed, brass buttons.";

type MadeEvent = Extract<DomainEvent, { type: "audiobook.picture-made" }>;
type RecordEvent = Extract<DomainEvent, { type: "audiobook.record" }>;
type SuggestionEvent = Extract<DomainEvent, { type: "audiobook.picture-suggestion" }>;
type PromptEvent = Extract<DomainEvent, { type: "audiobook.picture-prompt" }>;

let request = 0;
const nextId = () => `01J0000000000000000000${String((request += 1)).padStart(4, "0")}`;
const choose = (send: Harness["send"], lookId: string | null, over: Partial<Extract<ClientMessage, { kind: "choose-audiobook-look" }>> = {}) =>
  send({ kind: "choose-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, key: "maren-kest", sheet: "maren-kest", lookId, requestId: nextId(), ...over });
const suggest = (send: Harness["send"]) => send({ kind: "suggest-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", requestId: nextId() });
const make = (send: Harness["send"], over: Partial<Extract<ClientMessage, { kind: "make-audiobook-picture" }>> = {}) =>
  send({ kind: "make-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", prompt: "Wide shot from behind Maren on the rail at dawn.", who: ["maren-kest"], confirmedMicroUsd: 45_000, requestId: nextId(), ...over });
const made = (events: DomainEvent[]): MadeEvent => {
  const found = events.filter((event): event is MadeEvent => event.type === "audiobook.picture-made").at(-1);
  assert.ok(found, "the make is answered");
  assert.equal(found.state, "made", found.reason);
  return found;
};
const lastRecord = (events: DomainEvent[]): RecordEvent => {
  const found = events.filter((event): event is RecordEvent => event.type === "audiobook.record").at(-1);
  assert.ok(found, "a record is answered");
  return found;
};
const held = async (h: Pick<Harness, "store">): Promise<ChapterAudiobook> => {
  const record = await readAudiobook(h.store()!, LEDGER, CHAPTER);
  assert.ok(record !== null && record !== "unreadable", "the chapter's record reads");
  return record;
};
const references = (h: Pick<Harness, "enqueued">, n = -1) => (h.enqueued.at(n)!.params as { references?: string[] }).references;
const changed = (h: Pick<Harness, "store">, record: ChapterAudiobook, block = "p0.0") =>
  pictureLookChanged(record.pictures?.[block]?.look, record.look, kitLookLibrary(h.store()!.getBundle().referenceKits, record.look));

/** Maren's two looks: the storm coat, and the harbour coat with its close view. */
const looks: HarnessOptions = {
  prepare: async (worldDir) => {
    for (const [id, name] of [[STORM, "look.png"], [HARBOUR, "look.png"], [HARBOUR_CLOSE, "close.png"]] as const) {
      await mkdir(join(worldDir, "references", "maren-kest", "takes", id), { recursive: true });
      await writeFile(join(worldDir, "references", "maren-kest", "takes", id, name), pngBytes());
    }
  },
};
const accept = async (h: Pick<Harness, "store">) => {
  await acceptCharacterLook(h.store()!, "maren-kest", { id: STORM, file: `takes/${STORM}/look.png`, kind: "costume", prompt: STORM_LINE, takeId: STORM, artDirectionVersion: 1, framing: "full-body" });
  await acceptCharacterLook(h.store()!, "maren-kest", { id: HARBOUR, file: `takes/${HARBOUR}/look.png`, kind: "costume", prompt: HARBOUR_LINE, takeId: HARBOUR, artDirectionVersion: 1, framing: "full-body", close: { file: `takes/${HARBOUR_CLOSE}/close.png`, takeId: HARBOUR_CLOSE } });
};

describe("a look chosen for one picture (R-146)", () => {
  it("is held on the block, raising the world first, and leaves the chapter's choice as it was", () =>
    withHarness(async (h) => {
      await accept(h);
      await choose(h.send, STORM);
      await choose(h.send, HARBOUR, { block: "p0.0", only: true });
      assert.equal(lastRecord(h.events).refused, undefined);
      const record = await held(h);
      assert.equal(record.look?.characters["maren-kest"]?.lookId, STORM, "the chapter still chose the storm coat");
      assert.deepEqual(record.ownLooks, { "p0.0": { "maren-kest": HARBOUR } });
      assert.equal(h.schemaVersion(), AUDIOBOOK_OWN_LOOKS_SCHEMA_VERSION, "a build that cannot read a held look cannot open the world");
      // Chosen again as the chapter's: the block's picture follows the chapter, and nothing is held.
      await choose(h.send, STORM, { block: "p0.0" });
      assert.equal((await held(h)).ownLooks, undefined);
    }, looks));

  it("is refused for a block the chapter no longer has, and for a main photo the character does not have", () =>
    withHarness(async (h) => {
      await accept(h);
      await choose(h.send, HARBOUR, { block: "p99.0", only: true });
      assert.equal(lastRecord(h.events).refused, "that block is no longer in the chapter");
      await choose(h.send, null, { key: "bray-half-hitch", sheet: "bray-half-hitch", block: "p0.0", only: true });
      assert.match(lastRecord(h.events).refused ?? "", /no (main photo|sheet)/);
      assert.equal((await held(h).catch(() => null))?.ownLooks, undefined);
    }, looks));

  it("rides that look's image for that person only, is drafted for and stamped `only`, and the chapter's later choice never marks it", () =>
    withHarness(async (h) => {
      await accept(h);
      await choose(h.send, STORM);
      await choose(h.send, HARBOUR, { block: "p0.0", only: true });
      await suggest(h.send);
      const drafted = h.events.filter((event): event is SuggestionEvent => event.type === "audiobook.picture-suggestion").at(-1)!.suggestion!;
      const maren = drafted.who.find((who) => who.key === "maren-kest")!;
      assert.deepEqual([maren.reference, maren.look, maren.only], [`references/maren-kest/takes/${HARBOUR}/look.png`, { lookId: HARBOUR, view: "full" }, true]);
      // The brief was written for the harbour coat, named neutrally (rule 4), not the chapter's storm coat.
      const line = h.seen.at(-1)!.lines.find((entry) => entry.key === "maren-kest")!;
      assert.match(line.text, /^Harbour coat/);
      assert.doesNotMatch(line.text, /low-backed/);
      assert.deepEqual(drafted.look?.looks, { "maren-kest": { lookId: HARBOUR, view: "full", only: true } });

      await make(h.send, { looks: { "maren-kest": HARBOUR } });
      const done = made(h.events);
      assert.deepEqual(references(h), [`references/maren-kest/takes/${HARBOUR}/look.png`], "the harbour coat, never the chapter's storm coat or the main photo");
      const picture = done.record!.pictures!["p0.0"]!;
      assert.deepEqual(picture.look?.looks, { "maren-kest": { lookId: HARBOUR, view: "full", only: true } });
      assert.equal(done.record!.ownLooks, undefined, "made: the held look is the picture's stamp now");
      assert.equal(changed(h, done.record!), false);

      // The chapter changes its choice, and lets it go: the picture made with its own look is never marked.
      await choose(h.send, HARBOUR);
      assert.equal(changed(h, await held(h)), false);
      await choose(h.send, null);
      assert.equal(changed(h, await held(h)), false);
      // Make again keeps the picture's own look without its being chosen again.
      await make(h.send);
      assert.deepEqual(references(h), [`references/maren-kest/takes/${HARBOUR}/look.png`]);
      assert.equal(made(h.events).record!.pictures!["p0.0"]!.look?.looks?.["maren-kest"]?.only, true);
    }, looks));

  it("takes the look's close view for a frame that shows faces", () =>
    withHarness(async (h) => {
      await accept(h);
      await choose(h.send, HARBOUR, { block: "p0.0", only: true });
      await make(h.send, { frame: "Two-shot across the rail", looks: { "maren-kest": HARBOUR } });
      assert.deepEqual(references(h), [`references/maren-kest/takes/${HARBOUR_CLOSE}/close.png`]);
      assert.deepEqual(made(h.events).record!.pictures!["p0.0"]!.look?.looks, { "maren-kest": { lookId: HARBOUR, view: "close", only: true } });
    }, looks));

  it("rides the main photo for one picture though the chapter chose a look, and is not marked when the chapter's choice changes", () =>
    withHarness(async (h) => {
      await accept(h);
      await choose(h.send, STORM);
      await choose(h.send, null, { block: "p0.0", only: true });
      assert.deepEqual((await held(h)).ownLooks, { "p0.0": { "maren-kest": MAIN_PHOTO_LOOK } });
      // Sent without its looks, the make takes those held on the block.
      await make(h.send);
      assert.deepEqual(references(h), ["references/maren-kest/head-front.png"]);
      const record = made(h.events).record!;
      assert.deepEqual(record.pictures!["p0.0"]!.look?.looks, { "maren-kest": { lookId: MAIN_PHOTO_LOOK, view: "close", only: true } });
      await choose(h.send, HARBOUR);
      assert.equal(changed(h, await held(h)), false);
      await choose(h.send, null);
      assert.equal(changed(h, await held(h)), false);
    }, looks));

  it("Set for Chapter from the block's menu lets the picture's own look go: Make again follows the chapter, and a picture that does is marked when it changes", () =>
    withHarness(async (h) => {
      await accept(h);
      await choose(h.send, HARBOUR, { block: "p0.0", only: true });
      await make(h.send);
      assert.equal(made(h.events).record!.pictures!["p0.0"]!.look?.looks?.["maren-kest"]?.only, true);
      await choose(h.send, STORM, { block: "p0.0" });
      const record = await held(h);
      assert.equal(record.look?.characters["maren-kest"]?.lookId, STORM);
      assert.deepEqual(record.ownLooks, { "p0.0": {} }, "held empty: it stands over the picture's own look");
      await make(h.send);
      assert.deepEqual(references(h), [`references/maren-kest/takes/${STORM}/look.png`]);
      const again = made(h.events).record!;
      assert.deepEqual(again.pictures!["p0.0"]!.look?.looks, { "maren-kest": { lookId: STORM, view: "full" } });
      assert.equal(again.ownLooks, undefined);
      await choose(h.send, HARBOUR);
      assert.equal(changed(h, await held(h)), true, "a picture that follows the chapter is marked by its change");
    }, looks));
});

describe("Update prompt (R-146)", () => {
  const rewrite = (h: Harness["send"], changes: Array<{ key: string; from: string; to: string }>, prompt = "Wide shot from behind Maren in her storm coat, hood up, one hand on the wet rail.") =>
    h({ kind: "rewrite-audiobook-picture-prompt", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: "p0.0", prompt, changes, requestId: nextId() });
  const answer = (events: DomainEvent[]): PromptEvent => {
    const found = events.filter((event): event is PromptEvent => event.type === "audiobook.picture-prompt").at(-1);
    assert.ok(found, "Update prompt is answered");
    return found;
  };

  it("asks the writing service to change that person's clothing words only, from the look written for to the look now chosen, held to rule 4", async () => {
    const asked: RewriteInput[] = [];
    const writer: PromptRewriter = async (input) => {
      asked.push(input);
      return { prompt: "Wide shot from behind Maren in her low-backed harbour coat with brass buttons, one hand on the wet rail." };
    };
    await withHarness(async (h) => {
      await accept(h);
      await choose(h.send, STORM);
      await rewrite(h.send, [{ key: "maren-kest", from: STORM, to: HARBOUR }]);
      const said = answer(h.events);
      assert.equal(said.refused, undefined);
      assert.equal(said.block, "p0.0");
      assert.equal(said.prompt, "Wide shot from behind Maren in her harbour coat with brass buttons, one hand on the wet rail.", "the cut taken out where the look's image rides");
      assert.equal(asked.length, 1);
      assert.equal(asked[0]!.prompt, "Wide shot from behind Maren in her storm coat, hood up, one hand on the wet rail.");
      assert.deepEqual(asked[0]!.changes.map((change) => [change.key, change.name, change.was, change.look]), [["maren-kest", "Maren Kest", STORM_LINE, true]]);
      assert.match(asked[0]!.changes[0]!.now, /^Harbour coat/);
      assert.doesNotMatch(asked[0]!.changes[0]!.now, /low-backed/, "the new words given neutrally");
      // The brief tells it what to keep.
      const brief = buildRewritePrompt(asked[0]!);
      assert.match(brief, /Keep every other word as it is/);
      assert.match(brief, /Maren Kest \[maren-kest\]: the prompt was written for "Storm coat, hood up\."/);
      // A change that changes no words asks nothing: the prompt comes back as it was.
      await rewrite(h.send, [{ key: "maren-kest", from: HARBOUR, to: HARBOUR }], "As it was.");
      assert.equal(answer(h.events).prompt, "As it was.");
      assert.equal(asked.length, 1);
      assert.equal(h.enqueued.length, 0, "nothing made or spent");
    }, { ...looks, rewrite: writer });
  });

  it("gives the main photo the chapter's own reading of the prose", async () => {
    const asked: RewriteInput[] = [];
    await withHarness(async (h) => {
      await accept(h);
      // The chapter's look read from the prose first, then the storm coat chosen over it.
      await suggest(h.send);
      await choose(h.send, STORM);
      assert.equal((await held(h)).look?.characters["maren-kest"]?.reading, "Oilskin coat, dark with salt.");
      await rewrite(h.send, [{ key: "maren-kest", from: STORM, to: MAIN_PHOTO_LOOK }]);
      assert.equal(answer(h.events).refused, undefined);
      assert.deepEqual(asked.map((input) => input.changes.map((change) => [change.was, change.now, change.look])), [[[STORM_LINE, "Oilskin coat, dark with salt.", false]]]);
    }, { ...looks, rewrite: async (input) => (asked.push(input), { prompt: input.prompt }) });
  });

  it("is refused in one clause with no writing service", () =>
    withHarness(async (h) => {
      await accept(h);
      await rewrite(h.send, [{ key: "maren-kest", from: STORM, to: HARBOUR }]);
      assert.equal(answer(h.events).refused, "the writing service is not running");
    }, looks));
});

describe("Illustrate this chapter with a look held on a block (R-146)", () => {
  type FinishedEvent = Extract<DomainEvent, { type: "illustration.finished" }>;
  const onFirst: IllustrateDeriver = async () => ({ pictures: [{ block: "p0.0", title: "The rail", prompt: "Wide shot from behind Maren in her storm coat, hood up, at the rail.", who: ["maren-kest"], place: null }], summary: "The rail." });

  it("rides the held look on that row, rewrites its clothing words, and the run stamps it `only` and lets the held look go", () =>
    withHarness(async (h) => {
      await accept(h);
      await choose(h.send, STORM);
      await choose(h.send, HARBOUR, { block: "p0.0", only: true });
      await h.send({ kind: "illustrate-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER });
      const proposal: IllustrationProposal = h.events.filter((event): event is FinishedEvent => event.type === "illustration.finished").at(-1)!.proposal!;
      const row = proposal.rows.find((candidate) => candidate.block === "p0.0")!;
      assert.ok(row, "the row is proposed");
      assert.deepEqual([row.who[0]!.look, row.who[0]!.only], [{ lookId: HARBOUR, view: "full" }, true]);
      assert.equal(row.prompt, "Wide shot from behind Maren in her harbour coat, at the rail.", "its clothing words rewritten for the held look");
      assert.deepEqual(row.look?.looks, { "maren-kest": { lookId: HARBOUR, view: "full", only: true } });
      await h.send({ kind: "accept-illustration", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, proposalId: proposal.proposalId, blocks: [row.block], confirmedMicroUsd: row.estimatedMicroUsd });
      assert.deepEqual(references(h), [`references/maren-kest/takes/${HARBOUR}/look.png`]);
      const record = await held(h);
      assert.deepEqual(record.pictures?.["p0.0"]?.look?.looks, { "maren-kest": { lookId: HARBOUR, view: "full", only: true } });
      assert.equal(record.ownLooks, undefined);
    }, { ...looks, illustrate: onFirst, rewrite: async () => ({ prompt: "Wide shot from behind Maren in her harbour coat, at the rail." }) }));
});

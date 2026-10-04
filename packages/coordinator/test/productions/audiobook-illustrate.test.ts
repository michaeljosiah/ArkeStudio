import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acceptCharacterLook } from "../../src/references/kit.js";
import { pngBytes } from "../queue/fake-provider.js";
import { pictureLookChanged, type AudiobookPicture, type ClientMessage, type DomainEvent, type IllustrationProposal } from "@arke-studio/contracts";
import { readAudiobook } from "../../src/productions/audiobook.js";
import { AUDIOBOOK_LOOK_SCHEMA_VERSION } from "../../src/world/commit.js";
import { buildIllustratePrompt, type IllustrateDeriver, type IllustrateDeriverInput, type RawIllustration } from "../../src/productions/audiobook-illustrate.js";
import { CHAPTER, IMAGE, LEDGER, WORLD_ID, withHarness, type Harness } from "./picture-harness.js";

/**
 * Illustrate this chapter (design turn 191b, 191d, SPEC-047 R-101, R-102): where the pictures go and
 * what each shows — sparse, never over a picture the author set, never closer than the twenty
 * seconds a picture holds — held until accepted; accepted, made one at a time through the Bench
 * under ONE confirm of the total, each filed on its block as it lands.
 */
const LOOK_ID = "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2K3";
type FinishedEvent =Extract<DomainEvent, { type: "illustration.finished" }>;
type ProgressEvent = Extract<DomainEvent, { type: "illustration.progress" }>;
type RecordEvent = Extract<DomainEvent, { type: "audiobook.record" }>;

const illustrate = (send: Harness["send"]) => send({ kind: "illustrate-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER });
const finished = (events: DomainEvent[]): FinishedEvent => {
  const found = events.filter((event): event is FinishedEvent => event.type === "illustration.finished").at(-1);
  assert.ok(found, "the proposal is answered");
  return found;
};
const progressOf = (events: DomainEvent[]): ProgressEvent[] => events.filter((event): event is ProgressEvent => event.type === "illustration.progress");
const accept = (send: Harness["send"], proposal: IllustrationProposal, over: Partial<Extract<ClientMessage, { kind: "accept-illustration" }>> = {}) =>
  send({
    kind: "accept-illustration",
    worldId: WORLD_ID,
    productionId: LEDGER,
    chapterFile: CHAPTER,
    proposalId: proposal.proposalId,
    blocks: proposal.rows.map((row) => row.block),
    confirmedMicroUsd: proposal.rows.reduce((sum, row) => sum + row.estimatedMicroUsd, 0),
    ...over,
  });

/** The blocks nearest these times, each once: what a model reading the chapter might choose. */
const nearest = (input: IllustrateDeriverInput, seconds: readonly number[]): string[] => {
  const keys: string[] = [];
  for (const target of seconds) {
    const best = [...input.blocks].filter((block) => !keys.includes(block.key)).sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0];
    if (best !== undefined) keys.push(best.key);
  }
  return keys;
};
const says = (pick: (input: IllustrateDeriverInput) => string[], who: string[] = ["maren-kest"]): IllustrateDeriver => async (input): Promise<RawIllustration> => ({
  pictures: pick(input).map((block, index) => ({ block, title: `Moment ${index + 1}`, prompt: `Maren at moment ${index + 1}, grey light on the water.`, who, place: null })),
  summary: "Where the chapter turns.",
});

it("carries included-plan funding into the chapter illustration proposal before dispatch", () =>
  withHarness(async ({ events, send, enqueued }) => {
    await illustrate(send);
    const proposal = finished(events).proposal!;
    assert.equal(proposal.model.plan, "included-plan");
    assert.ok(proposal.rows.length > 0);
    assert.ok(proposal.rows.every(row => row.estimatedMicroUsd === 0));
    assert.equal(enqueued.length, 0);
  }, { model: { ...IMAGE, id: "codex-image", provider: "codex", limits: { providerSelectedSize: true }, pricing: { kind: "included-plan" } },
    illustrate: says(input => nearest(input, [0, 60])) }));

describe("Illustrate this chapter: the proposal (R-101)", () => {
  it("proposes where the pictures go and what each shows, priced, held and not made", () =>
    withHarness(
      async ({ events, send, enqueued }) => {
        await illustrate(send);
        const done = finished(events);
        assert.equal(done.outcome, "proposed");
        const proposal = done.proposal!;
        assert.ok(proposal.rows.length >= 2);
        assert.deepEqual(proposal.rows.map((row) => row.at), proposal.rows.map((row) => row.at).toSorted((x, y) => x - y), "in reading order");
        assert.ok(proposal.rows.every((row, index) => index === 0 || row.at - proposal.rows[index - 1]!.at >= 20), "never closer than the twenty seconds a picture holds");
        assert.ok(proposal.rows.every((row) => row.title !== "" && row.prompt !== ""));
        assert.ok(proposal.rows.every((row) => row.estimatedMicroUsd === (row.who.some((entry) => entry.carried) ? 45_000 : 40_000)), "each row priced from the manifest's figures and the references that ride");
        assert.equal(proposal.model.id, "stair-image");
        assert.equal(proposal.aspect, "16:9");
        assert.equal(proposal.estimated, true, "no block is read: times are estimated");
        assert.equal(proposal.standing, 0);
        assert.equal(proposal.hash.length > 0, true);
        assert.equal(enqueued.length, 0, "nothing was made or spent by reading");
      },
      { illustrate: says((input) => nearest(input, [0, 60, 130, 200])) },
    ));

  it("is held to the pace: about one a minute and a half of speech, thinned from the nearest neighbour", () =>
    withHarness(
      async ({ events, send }) => {
        await illustrate(send);
        const proposal = finished(events).proposal!;
        const cap = Math.max(1, Math.round(proposal.seconds / 90));
        assert.ok(proposal.rows.length <= cap, `${proposal.rows.length} rows against a cap of ${cap}`);
      },
      { illustrate: says((input) => input.blocks.map((block) => block.key)) },
    ));

  it("never goes over a picture the author set, and keeps clear of it", () =>
    withHarness(
      async ({ events, send, store }) => {
        const standing = (await readAudiobook(store()!, LEDGER, CHAPTER)) ?? null;
        void standing;
        // The author sets a picture on the block nearest a minute in.
        await send({ kind: "illustrate-chapter", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER });
        const first = finished(events).proposal!;
        const target = first.rows[1] ?? first.rows[0]!;
        await send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: target.block, picture: { file: "world-art.png", source: "world" } });
        await illustrate(send);
        const again = finished(events).proposal!;
        assert.ok(!again.rows.some((row) => row.block === target.block), "never over the author's picture");
        assert.ok(again.rows.every((row) => Math.abs(row.at - target.at) >= 20), "never closer to it than the twenty seconds it holds");
        assert.equal(again.standing, 1);
        const record = await readAudiobook(store()!, LEDGER, CHAPTER);
        assert.ok(record !== null && record !== "unreadable" && record.pictures?.[target.block] !== undefined, "the author's picture is as it was");
      },
      { illustrate: says((input) => nearest(input, [0, 60, 130, 200])) },
    ));

  it("holds a row whose character has a sheet and no picture, and names them; one that is only a place or has its picture is not held", () =>
    withHarness(
      async ({ events, send }) => {
        await illustrate(send);
        const rows = finished(events).proposal!.rows;
        const bray = rows.find((row) => row.who.some((entry) => entry.key === "bray-half-hitch"))!;
        assert.deepEqual(bray.needs, ["Bray Half-Hitch"]);
        assert.equal(bray.who.find((entry) => entry.key === "bray-half-hitch")!.reference, null);
        const maren = rows.find((row) => !row.who.some((entry) => entry.key === "bray-half-hitch"))!;
        assert.equal(maren.needs, undefined);
        assert.equal(maren.who[0]!.carried, true);
      },
      {
        illustrate: async (input) => {
          const keys = nearest(input, [0, 100]);
          return { pictures: [{ block: keys[0]!, title: "Maren alone", prompt: "Maren alone at the rail.", who: ["maren-kest"], place: null }, { block: keys[1]!, title: "Bray beside her", prompt: "Bray beside Maren at the rail.", who: ["maren-kest", "bray-half-hitch"], place: null }] };
        },
      },
    ));

  it("refuses in one clause with no picture model, and with no writing service", async () => {
    await withHarness(async ({ events, send }) => {
      await illustrate(send);
      const failed = finished(events);
      assert.equal(failed.outcome, "failed");
      assert.equal(failed.reason, "no picture model is on");
    }, { illustrate: says(() => []), model: null });
  });

  it("has nothing to add to a chapter that already has its pictures, and says so", () =>
    withHarness(
      async ({ events, send }) => {
        await illustrate(send);
        const first = finished(events).proposal!;
        for (const row of first.rows) await send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: row.block, picture: { file: "world-art.png", source: "world" } });
        await illustrate(send);
        const again = finished(events);
        assert.equal(again.outcome, "failed");
        assert.equal(again.reason, "the chapter has its pictures");
      },
      { illustrate: says((input) => nearest(input, [0, 60, 130, 200])) },
    ));

  it("drops what the model said of a block that is not there, twice, or without words, and names no one the sheet never depicts", () =>
    withHarness(
      async ({ events, send }) => {
        await illustrate(send);
        const rows = finished(events).proposal!.rows;
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0]!.who.map((entry) => entry.key), ["maren-kest"], "an unknown name is no one");
      },
      {
        illustrate: async (input) => ({
          pictures: [
            { block: "p99.9", title: "Nowhere", prompt: "Nowhere.", who: [] },
            { block: input.blocks[1]!.key, title: "Maren", prompt: "Maren at the rail.", who: ["maren-kest", "nobody"] },
            { block: input.blocks[1]!.key, title: "Again", prompt: "The same block twice.", who: [] },
            { block: input.blocks[4]!.key, title: "Empty", prompt: "   ", who: [] },
          ],
        }),
      },
    ));
});

describe("what the chapter is asked", () => {
  it("gives the model the chapter on its clock with who is in it, their look, where pictures already stand and the pace", () => {
    const prompt = buildIllustratePrompt({
      title: "Her own hand",
      mood: "Grey dawn light, fine grain.",
      blocks: [{ key: "p0.0", at: 0, text: "Maren reads." }, { key: "p1.0", at: 75, text: "Bray tells a story.", speaker: "Bray" }],
      lines: [{ label: "Place", text: "Dawn." }, { label: "Maren", text: "Oilskin." }],
      people: [{ key: "maren-kest", name: "Maren", appearance: "Wiry." }],
      places: [{ key: "the-vigil", name: "The Vigil" }],
      never: ["Odile"],
      standing: [150],
      cap: 3,
      maxChars: 900,
    });
    for (const part of ["[p1.0] 1:15 Bray: Bray tells a story.", "At most 3 pictures", "about one every 90 seconds", "at least 20 seconds apart", "(at 2:30)", "Maren: Oilskin.", "[maren-kest] Maren — Wiry.", "Never show, name or hint at: Odile", "at most 900 characters", "## The book's mood (light, colour and grain only)\nGrey dawn light, fine grain.", "1. THE BLOCK IS THE PICTURE.", "\"expressions\": {\"<key>\""]) assert.ok(prompt.includes(part), part);
  });
});

describe("Illustrate this chapter: made one at a time (R-102)", () => {
  const proposed = async (h: Harness): Promise<IllustrationProposal> => {
    await illustrate(h.send);
    return finished(h.events).proposal!;
  };
  const rowsWithoutNeeds = (proposal: IllustrationProposal) => proposal.rows.filter((row) => (row.needs?.length ?? 0) === 0);
  const MARENS = (input: IllustrateDeriverInput) => nearest(input, [0, 70, 140, 210]);

  it("makes the pictures one after another under one confirm of the total, each filed on its block as it lands", () =>
    withHarness(
      async (h) => {
        const proposal = await proposed(h);
        const total = proposal.rows.reduce((sum, row) => sum + row.estimatedMicroUsd, 0);
        await accept(h.send, proposal);
        const states = progressOf(h.events).map((event) => event.progress.state);
        assert.equal(states[0], "making");
        assert.equal(states.at(-1), "done");
        const last = progressOf(h.events).at(-1)!.progress;
        assert.deepEqual(last.made, proposal.rows.map((row) => row.block), "in reading order");
        assert.equal(last.failed.length, 0);
        assert.equal(last.spentMicroUsd, total, "spent what the one confirm said");
        assert.equal(last.confirmedMicroUsd, total);
        assert.equal(h.enqueued.length, proposal.rows.length, "a job for each, through the Bench");
        assert.equal(h.concurrent(), 1, "one at a time: the next is not asked for while one is in flight");
        // Each landed on its block, with its look, and the record was sent as it was made.
        const record = await readAudiobook(h.store()!, LEDGER, CHAPTER);
        assert.ok(record !== null && record !== "unreadable");
        for (const row of proposal.rows) {
          const picture: AudiobookPicture = record.pictures![row.block]!;
          assert.equal(picture.source, "generated");
          assert.equal(picture.textHash, row.textHash);
          assert.ok(picture.look !== undefined, "it keeps the look it was made under");
          assert.equal(pictureLookChanged(picture.look, record.look), false);
        }
        const records = h.events.filter((event): event is RecordEvent => event.type === "audiobook.record" && event.record?.pictures !== undefined);
        assert.equal(records.length, proposal.rows.length);
        assert.deepEqual(records.map((event) => Object.keys(event.record!.pictures!).length), proposal.rows.map((_, index) => index + 1), "each picture landed on its block before the next was begun");
        assert.equal(h.schemaVersion(), AUDIOBOOK_LOOK_SCHEMA_VERSION);
        // Nothing is left to make: the proposal is spent, and no second card follows the run.
        assert.equal(h.events.filter((event) => event.type === "illustration.finished").length, 1);
      },
      { illustrate: says((input) => MARENS(input)) },
    ));

  it("rides each person's chosen look in the proposal and in the run, and stamps it on every picture (R-119)", () =>
    withHarness(
      async (h) => {
        await acceptCharacterLook(h.store()!, "maren-kest", { id: LOOK_ID, file: `takes/${LOOK_ID}/look.png`, kind: "costume", prompt: "Storm coat, hood up.", takeId: LOOK_ID, artDirectionVersion: 1, framing: "full-body" });
        // The look is read first, then chosen, then the chapter illustrated.
        await h.send({ kind: "derive-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, requestId: "01J00000000000000000000004" });
        await h.send({ kind: "choose-audiobook-look", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, key: "maren-kest", sheet: "maren-kest", lookId: LOOK_ID, requestId: "01J00000000000000000000005" });
        const proposal = await proposed(h);
        const look = `references/maren-kest/takes/${LOOK_ID}/look.png`;
        assert.ok(proposal.rows.every((row) => row.who[0]!.reference === look && row.who[0]!.look?.lookId === LOOK_ID), "the look, not the main photo");
        await accept(h.send, proposal);
        assert.ok(h.enqueued.every((job) => JSON.stringify((job.params as { references?: string[] }).references) === JSON.stringify([look])), "each job carries the look alone");
        const record = await readAudiobook(h.store()!, LEDGER, CHAPTER);
        assert.ok(record !== null && record !== "unreadable");
        for (const row of proposal.rows) assert.deepEqual(record.pictures![row.block]!.look?.looks, { "maren-kest": { lookId: LOOK_ID, view: "full" } });
      },
      {
        illustrate: says((input) => MARENS(input)),
        prepare: async (worldDir) => {
          await mkdir(join(worldDir, "references", "maren-kest", "takes", LOOK_ID), { recursive: true });
          await writeFile(join(worldDir, "references", "maren-kest", "takes", LOOK_ID, "look.png"), pngBytes());
        },
      },
    ));

  it("refuses a confirm below the total, and the run never begins", () =>
    withHarness(
      async (h) => {
        const proposal = await proposed(h);
        const total = proposal.rows.reduce((sum, row) => sum + row.estimatedMicroUsd, 0);
        await accept(h.send, proposal, { confirmedMicroUsd: total - 1 });
        const answer = progressOf(h.events).at(-1)!;
        assert.match(answer.refused ?? "", /^the price moved · ~\$/);
        assert.equal(h.enqueued.length, 0);
      },
      { illustrate: says(MARENS) },
    ));

  it("makes only the rows left unskipped, and a held row only when the author says to go without", () =>
    withHarness(
      async (h) => {
        const proposal = await proposed(h);
        const held = proposal.rows.find((row) => (row.needs?.length ?? 0) > 0)!;
        const free = rowsWithoutNeeds(proposal);
        assert.ok(held && free.length >= 2);
        // Skip one, say nothing of the held row: neither is made.
        const skipped = free[0]!.block;
        const blocks = proposal.rows.map((row) => row.block).filter((block) => block !== skipped);
        await accept(h.send, proposal, { blocks, confirmedMicroUsd: 10_000_000 });
        const first = progressOf(h.events).at(-1)!.progress;
        assert.deepEqual(first.made, free.slice(1).map((row) => row.block), "a skipped row and a held row are not made");
        // What is left is the proposal still: the skipped row and the held one.
        const left = finished(h.events).proposal!;
        assert.deepEqual(left.rows.map((row) => row.block).sort(), [skipped, held.block].sort());
        // The author says to go without for the held one.
        await accept(h.send, left, { blocks: [held.block], without: [held.block], confirmedMicroUsd: held.estimatedMicroUsd });
        const second = progressOf(h.events).at(-1)!.progress;
        assert.deepEqual(second.made, [held.block]);
        assert.equal(second.spentMicroUsd, held.estimatedMicroUsd);
      },
      {
        illustrate: async (input) => {
          const keys = nearest(input, [0, 70, 140, 210]);
          return { pictures: keys.map((block, index) => ({ block, title: `Moment ${index}`, prompt: `Moment ${index} at the rail.`, who: index === 3 ? ["maren-kest", "bray-half-hitch"] : ["maren-kest"], place: null })) };
        },
      },
    ));

  it("holds a picture that failed with its reason, goes on to the next, and offers the failed one again", () =>
    withHarness(
      async (h) => {
        const proposal = await proposed(h);
        const free = rowsWithoutNeeds(proposal);
        await accept(h.send, proposal, { blocks: free.map((row) => row.block), confirmedMicroUsd: 10_000_000 });
        const last = progressOf(h.events).at(-1)!.progress;
        assert.equal(last.state, "done");
        assert.deepEqual(last.failed, [{ block: free[1]!.block, reason: "the provider refused the prompt" }], "held with the provider's reason");
        assert.deepEqual(last.made, free.filter((_, index) => index !== 1).map((row) => row.block), "the run went on");
        const left = finished(h.events).proposal!;
        assert.ok(left.rows.some((row) => row.block === free[1]!.block), "offered again");
        assert.ok(!left.rows.some((row) => row.block === free[0]!.block), "what was made is not offered");
        // Held with its reason on the row itself (2026-10-04), so a window that opens the proposal
        // later holds it too; it is made again only when the author names it.
        assert.equal(left.rows.find((row) => row.block === free[1]!.block)!.refused, "the provider refused the prompt");
        const made = h.enqueued.length;
        await accept(h.send, left, { blocks: [free[1]!.block], confirmedMicroUsd: 10_000_000 });
        assert.equal(progressOf(h.events).at(-1)!.refused, "nothing to make", "not named: not made");
        assert.equal(h.enqueued.length, made);
        await accept(h.send, left, { blocks: [free[1]!.block], without: [free[1]!.block], confirmedMicroUsd: 10_000_000 });
        assert.deepEqual(progressOf(h.events).at(-1)!.progress.made, [free[1]!.block], "tried again when the author says so");
      },
      { illustrate: says(MARENS), land: (n) => (n === 1 ? "fail" : "land") },
    ));

  it("holds no row for Try again when the queue failed it before any provider call (codex on PR 1559)", () =>
    withHarness(
      async (h) => {
        const proposal = await proposed(h);
        const free = rowsWithoutNeeds(proposal);
        await accept(h.send, proposal, { blocks: free.map((row) => row.block), confirmedMicroUsd: 10_000_000 });
        assert.equal(progressOf(h.events).at(-1)!.progress.failed[0]?.block, free[0]!.block, "it failed, and says why");
        assert.equal(finished(h.events).proposal!.rows.find((row) => row.block === free[0]!.block)!.refused, undefined, "not a refusal Try again could undo");
      },
      { illustrate: says(MARENS), land: (n) => (n === 0 ? "fail" : "land"), failure: "no openai client is configured", reached: false },
    ));

  it("says a safety refusal in plain words on the row it holds", () =>
    withHarness(
      async (h) => {
        const proposal = await proposed(h);
        const free = rowsWithoutNeeds(proposal);
        await accept(h.send, proposal, { blocks: free.map((row) => row.block), confirmedMicroUsd: 10_000_000 });
        const last = progressOf(h.events).at(-1)!.progress;
        assert.deepEqual(last.failed, [{ block: free[0]!.block, reason: "refused by the image safety check" }]);
        assert.equal(finished(h.events).proposal!.rows.find((row) => row.block === free[0]!.block)!.refused, "refused by the image safety check");
      },
      { illustrate: says(MARENS), land: (n) => (n === 0 ? "fail" : "land"), failure: "openai: the safety system refused the prompt (moderation blocked) — recompose the prompt away from what it flagged and try again" },
    ));

  it("stops where it stands: the picture in hand cancelled, what is made kept, nothing more asked for", () =>
    withHarness(
      async (h) => {
        const proposal = await proposed(h);
        const free = rowsWithoutNeeds(proposal);
        const running = accept(h.send, proposal, { blocks: free.map((row) => row.block), confirmedMicroUsd: 10_000_000 });
        // The first lands; the second hangs until it is stopped.
        for (let tries = 0; tries < 400 && h.enqueued.length < 2; tries += 1) await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(h.enqueued.length, 2);
        await h.send({ kind: "stop-illustration", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER });
        await running;
        const last = progressOf(h.events).at(-1)!.progress;
        assert.equal(last.state, "stopped");
        assert.deepEqual(last.made, [free[0]!.block], "what was made stays");
        assert.equal(h.cancelled.length, 1, "the job in hand was cancelled");
        assert.equal(h.enqueued.length, 2, "nothing more was asked for");
        const record = await readAudiobook(h.store()!, LEDGER, CHAPTER);
        assert.ok(record !== null && record !== "unreadable" && Object.keys(record.pictures ?? {}).join() === free[0]!.block);
        assert.equal(finished(h.events).proposal!.rows.length, proposal.rows.length - 1, "the rest is still the proposal");
      },
      { illustrate: says(MARENS), land: (n) => (n === 0 ? "land" : "hold") },
    ));

  it("leaves out a row whose block was reworded or has a picture set on it since, and says why", () =>
    withHarness(
      async (h) => {
        const proposal = await proposed(h);
        const free = rowsWithoutNeeds(proposal);
        // The author sets a picture on the second row's block before accepting.
        await h.send({ kind: "set-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER, block: free[1]!.block, picture: { file: "world-art.png", source: "world" } });
        await accept(h.send, proposal, { blocks: free.map((row) => row.block), confirmedMicroUsd: 10_000_000 });
        const last = progressOf(h.events).at(-1)!.progress;
        assert.deepEqual(last.failed, [{ block: free[1]!.block, reason: "a picture stands here now" }]);
        assert.ok(!last.made.includes(free[1]!.block));
        const record = await readAudiobook(h.store()!, LEDGER, CHAPTER);
        assert.ok(record !== null && record !== "unreadable");
        assert.equal(record.pictures![free[1]!.block]!.source, "world", "the author's picture is as it was");
        // Not a refusal Try again could undo (codex on PR 1559): no `refused` on the row.
        assert.equal(finished(h.events).proposal!.rows.find((row) => row.block === free[1]!.block)?.refused, undefined);
      },
      { illustrate: says(MARENS) },
    ));

  it("refuses to run on prose that moved since the proposal was made", () =>
    withHarness(
      async (h) => {
        const proposal = await proposed(h);
        const file = join(h.worldDir, "productions", LEDGER, "chapters", `${CHAPTER}.md`);
        await writeFile(file, (await readFile(file, "utf8")).replace("Maren", "Marenne"), "utf8");
        await h.store()!.reload();
        await accept(h.send, proposal);
        assert.equal(progressOf(h.events).at(-1)!.refused, "the prose moved · illustrate again");
        assert.equal(h.enqueued.length, 0);
      },
      { illustrate: says(MARENS) },
    ));

  it("discards a proposal at no cost, and an accept of one that is gone is refused", () =>
    withHarness(
      async (h) => {
        const proposal = await proposed(h);
        await h.send({ kind: "discard-illustration", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER });
        await accept(h.send, proposal);
        assert.equal(progressOf(h.events).at(-1)!.refused, "that proposal is gone · illustrate again");
        assert.equal(h.enqueued.length, 0);
      },
      { illustrate: says(MARENS) },
    ));
});

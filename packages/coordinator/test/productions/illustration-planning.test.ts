import assert from "node:assert/strict";
import { it } from "node:test";
import { IllustrationPlanning } from "../../src/productions/illustration-planning.js";
import type { IllustrateDeriverInput } from "../../src/productions/audiobook-illustrate.js";

const input = (): IllustrateDeriverInput => ({
  title: "A long chapter", seconds: 1200, estimated: true, lines: [], people: [], places: [], never: [], standing: [], cap: 30, maxChars: 3000,
  blocks: Array.from({ length: 9 }, (_, n) => ({ key: `p${n}.0`, at: n * 100, text: "A sentence about the harbour. ".repeat(140) })),
});

it("continues only the unfinished section after an explicit retry, retaining completed plan work (#1813)", async () => {
  const planner = new IllustrationPlanning(), calls: number[] = [];
  let refuse = true;
  const derive = async (part: IllustrateDeriverInput) => {
    calls.push(part.section!.number);
    assert.ok(part.blocks.reduce((total, block) => total + block.text.length, 0) <= 12_000);
    if (part.section!.number === 2 && refuse) { refuse = false; throw new Error("deriving took too long"); }
    return { pictures: [{ at: `${part.blocks[0]!.key}#0`, prompt: "The harbour at dawn." }, { at: "not-in-this-section#0", prompt: "Ignore this invented place." }] };
  };
  await assert.rejects(planner.derive("chapter", input(), derive), /Section 2 of 5:.*1 completed sections kept/);
  assert.deepEqual(calls, [1, 2], "no automatic retry");
  const plan = await planner.derive("chapter", input(), derive);
  assert.deepEqual(calls, [1, 2, 2, 3, 4, 5]);
  assert.equal(plan.pictures.length, 5);
  assert.equal(plan.pictures.some(picture => picture.at === "not-in-this-section#0"), false);
  const changed = input();
  changed.blocks = [{ ...changed.blocks[0]!, text: `${changed.blocks[0]!.text} Changed prose.` }, ...changed.blocks.slice(1)];
  calls.length = 0;
  await planner.derive("chapter", changed, derive);
  assert.equal(calls[0], 1, "changed input cannot borrow an old section");
  planner.discard("chapter"); calls.length = 0;
  await planner.derive("chapter", changed, derive);
  assert.equal(calls[0], 1, "discard releases retained work");
});

it("does not retain an interrupted section as completed", async () => {
  const planner = new IllustrationPlanning(), control = new AbortController();
  await assert.rejects(planner.derive("chapter", input(), async () => { control.abort(); return { pictures: [] }; }, control.signal));
  let first: number | undefined;
  await planner.derive("chapter", input(), async part => { first ??= part.section!.number; return { pictures: [] }; });
  assert.equal(first, 1);
});

it("leaves unused chapter capacity available to an uncovered section", async () => {
  const chapter = input();
  chapter.cap = 5;
  chapter.blocks = Array.from({ length: 8 }, (_, n) => ({ key: `p${n}.0`, at: n * 100, text: "x".repeat(6000) }));
  const sentences = Array.from({ length: 5 }, (_, n) => ({ id: `p8.0#${n}`, at: 800 + n * 20, text: "y".repeat(1000) }));
  chapter.blocks.push({ key: "p8.0", at: 800, text: sentences.map(sentence => sentence.text).join(" "), sentences });
  chapter.standing = chapter.blocks.slice(0, 8).map(block => block.at);
  const plan = await new IllustrationPlanning().derive("chapter", chapter, async part => ({
    pictures: part.blocks.flatMap(block => chapter.standing.includes(block.at) ? [] : block.sentences!.map(sentence => ({ at: sentence.id, prompt: "A new moment." }))).slice(0, part.cap),
  }));
  assert.deepEqual(plan.pictures.map(picture => picture.at), sentences.map(sentence => sentence.id));
});

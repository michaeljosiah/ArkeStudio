import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_SHEET_LIMITS, AgentContactSheetSchema } from "@arke-studio/contracts";
import { setTimeout as delay } from "node:timers/promises";
import { composeSheetPage, findCuts, tileLabel } from "../../src/media/contact-sheet.js";
import { inParallel } from "../../src/world-chat/media-measure.js";

test("the decode pool stops at the first failure, tells the decodes in flight to stop, and answers only once they have", async () => {
  const started: number[] = [], finished: number[] = [];
  const work = async (item: number, signal: AbortSignal) => {
    started.push(item);
    if (item === 1) { await delay(5); throw new Error("refused"); }
    // A decoder that stops when told, but takes a moment to.
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    await delay(20); finished.push(item); return item;
  };
  await assert.rejects(inParallel([0, 1, 2, 3, 4, 5], new AbortController().signal, work), /refused/);
  assert.deepEqual(started, [0, 1, 2]); assert.deepEqual(finished.sort(), [0, 2]);
  // Results keep the items' order however the work finishes, and a cancelled caller starts nothing.
  assert.deepEqual(await inParallel([3, 1, 2, 5], new AbortController().signal, async item => { await delay(item); return item * 2; }), [6, 2, 4, 10]);
  const cancelled = new AbortController(); cancelled.abort();
  let ran = 0;
  await assert.rejects(inParallel([1, 2], cancelled.signal, async item => { ran++; return item; }));
  assert.equal(ran, 0);
});

test("cuts are the steps that jump far above the steps around them; a busy shot and a flash are not cut on", () => {
  // Ten frames a second: shots change at 3.2 s and 7.5 s; a fast pan in between steps 8 a frame.
  const steps = Array.from({ length: 119 }, (_, i) => i === 31 || i === 74 ? 60 : i > 40 && i < 60 ? 8 : 1.5);
  assert.deepEqual(findCuts(steps, 10), [3.2, 7.5]);
  // Two jumps 0.3 s apart (a flash) are one cut, and none comes before half a second of picture.
  const flash = Array.from({ length: 60 }, (_, i) => i === 2 || i === 20 || i === 23 ? 60 : 1);
  assert.deepEqual(findCuts(flash, 10), [2.1]);
});

test("a tile's label is its number and start, minutes and tenths", () => {
  assert.equal(tileLabel(1, 0), "1  0:00.0"); assert.equal(tileLabel(12, 176.63), "12  2:56.6"); assert.equal(tileLabel(40, 61.04), "40  1:01.0");
});

test("a page lays tiles five to a row with their labels drawn beneath", () => {
  const { tileWidth: w, tileHeight: h } = AGENT_SHEET_LIMITS, rgba = new Uint8Array(w * h * 4).fill(200);
  const page = composeSheetPage(Array.from({ length: 7 }, (_, i) => ({ rgba, label: tileLabel(i + 1, i * 3) })));
  assert.equal(page.width, 5 * w + 6 * 8); assert.equal(page.height, 2 * (h + 22) + 3 * 8);
  // The first tile's corner is the tile; the label strip under it holds light pixels of the digits.
  assert.equal(page.pixels[(8 * page.width + 8) * 4], 200);
  let lit = 0;
  for (let y = 8 + h + 4; y < 8 + h + 18; y++) for (let x = 10; x < 120; x++) if (page.pixels[(y * page.width + x) * 4]! > 200) lit++;
  assert.ok(lit > 40, String(lit));
});

test("the sheet schema numbers shots in order and lays every shot on one page", () => {
  const image = { id: "x", label: "Contact sheet", sourceHash: `sha256:${"a".repeat(64)}`, renditionHash: `sha256:${"b".repeat(64)}`, width: 1488, height: 1160, posterOnly: true };
  const shots = [{ number: 1, startSec: 0, endSec: 4, frameSec: 2, label: "Still", clipId: "cl_still" }, { number: 2, startSec: 4, endSec: 6, frameSec: 5, label: "Film", clipId: "cl_film" }];
  const sheet = { streamIndex: 0, startSec: 0, endSec: 6, shotsFrom: "timeline", productionId: "saltlight", shots, pages: [{ image, firstShot: 1, lastShot: 2 }] };
  assert.equal(AgentContactSheetSchema.safeParse(sheet).success, true);
  assert.equal(AgentContactSheetSchema.safeParse({ ...sheet, shots: [shots[1], shots[0]] }).success, false);
  assert.equal(AgentContactSheetSchema.safeParse({ ...sheet, pages: [{ image, firstShot: 1, lastShot: 1 }] }).success, false);
  assert.equal(AgentContactSheetSchema.safeParse({ ...sheet, shotsFrom: "picture" }).success, false);
  assert.equal(AgentContactSheetSchema.safeParse({ ...sheet, shots: [{ ...shots[0]!, frameSec: 4 }, shots[1]] }).success, false);
});

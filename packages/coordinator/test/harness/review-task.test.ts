import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { it } from "node:test";
import type { HarnessAdapter, SessionConfigInput, MessagePart } from "@arke-studio/contracts";
import { makeReviewTaskRunner } from "../../src/harness/review-task.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { tempDir } from "../tmp.js";

const pixels = encodePng(solidImage(4, 4, [20, 30, 40, 255]));
function fake(vision = true) {
  let config: SessionConfigInput | undefined, sent: MessagePart[] = [], receipt = false, interrupted = 0;
  let dispatch!: () => void; const dispatched = new Promise<void>(resolve => { dispatch = resolve; });
  const adapter = { imageInput: true, prepareSession: (input: SessionConfigInput) => { config = input; }, createSession: async () => ({ sessionId: "review" }),
    imageInputForSession: () => vision, imageDestinationForSession: () => ({ provider: "test-provider", local: false }),
    dispatchAsync: async (input: { parts: MessagePart[] }) => { assert.equal(receipt, true); sent = input.parts; dispatch(); },
    streamEvents: () => ({ [Symbol.asyncIterator]: async function* () { await dispatched; yield { type: "message.completed", sessionId: "review", text: '{"facts":[],"findings":[]}' }; } }),
    interrupt: async () => { interrupted++; },
  } as unknown as HarnessAdapter;
  return { adapter, config: () => config, sent: () => sent, receipt: async () => { receipt = true; }, interrupted: () => interrupted };
}
it("pins review skills and sends real renditions only after a durable receipt", async () => {
  const f = fake(); let policies = 0;
  const run = makeReviewTaskRunner({ adapter: f.adapter, beforeDispatch: async () => {}, scratch: await tempDir("review-task-"), sessionInput: () => ({ model: "test/model", skillFamily: "video", worldQueryUrl: "wrong-world", memoryDir: "wrong-world", researchWeb: true }), cloudAllowed: async () => { policies++; return true; } });
  await run({ specialist: "visual", prompt: "Review", images: [{ block: "p0.0", bytes: pixels, extension: ".png" }] }, new AbortController().signal, f.receipt);
  assert.equal(f.config()?.skillFamily, "chapter-review"); assert.equal(f.config()?.worldQueryUrl, undefined); assert.equal(f.config()?.memoryDir, undefined); assert.equal(f.config()?.researchWeb, false);
  assert.match(f.config()?.skillBodies?.["chapter-visual-review"] ?? "", /Camera location is not character location/);
  const image = f.sent().find(part => part.type === "image"); assert.ok(image && image.type === "image"); assert.equal(image.mimeType, "image/png"); assert.ok(image.data.length > 20); assert.equal(policies, 2);
});
it("does not dispatch when the chosen session lacks vision or cloud permission is revoked", async () => {
  for (const vision of [false, true]) {
    const f = fake(vision); let policy = 0;
    const run = makeReviewTaskRunner({ adapter: f.adapter, beforeDispatch: async () => {}, scratch: await tempDir("review-task-"), sessionInput: input => input, cloudAllowed: async () => ++policy === 1 });
    await assert.rejects(run({ specialist: "visual", prompt: "Review", images: [{ block: "p0.0", bytes: pixels, extension: ".png" }] }, new AbortController().signal, f.receipt), vision ? /disabled/ : /cannot inspect/);
    assert.equal(f.sent().length, 0);
  }
});
it("a failed durable receipt prevents dispatch and no automatic retry occurs", async () => {
  const f = fake(); const run = makeReviewTaskRunner({ adapter: f.adapter, beforeDispatch: async () => {}, scratch: await tempDir("review-task-"), sessionInput: input => input, cloudAllowed: async () => true });
  await assert.rejects(run({ specialist: "script", prompt: "Review", images: [] }, new AbortController().signal, async () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(f.sent().length, 0);
});

it("rechecks ownership after receipt and cleans its sandbox on refusal", async () => {
  const f = fake(), scratch = await tempDir("review-cleanup-"); let receipt = false;
  const run = makeReviewTaskRunner({ adapter: f.adapter, scratch, sessionInput: input => input, cloudAllowed: async () => true,
    beforeDispatch: async () => { assert.equal(receipt, true); throw new Error("world ownership lost"); } });
  await assert.rejects(run({ specialist: "script", prompt: "Review", images: [] }, new AbortController().signal, async () => { receipt = true; await f.receipt(); }), /ownership lost/);
  assert.equal(f.sent().length, 0); assert.deepEqual(await readdir(scratch), []); assert.ok(f.interrupted() > 0);
});
it("removes completed and failed preparation sandboxes without hiding the result", async () => {
  for (const succeeds of [true, false]) {
    const f = fake(succeeds), scratch = await tempDir("review-cleanup-");
    const run = makeReviewTaskRunner({ adapter: f.adapter, scratch, sessionInput: input => input, cloudAllowed: async () => true, beforeDispatch: async () => {} });
    const work = run({ specialist: "visual", prompt: "Review", images: [{ block: "p0.0", bytes: pixels, extension: ".png" }] }, new AbortController().signal, f.receipt);
    if (succeeds) assert.deepEqual(await work, { facts: [], findings: [] }); else await assert.rejects(work, /cannot inspect/);
    assert.deepEqual(await readdir(scratch), []);
  }
});

it("cancellation during the final ownership check prevents dispatch and removes scratch", async () => {
  const f = fake(), scratch = await tempDir("review-cleanup-"), stop = new AbortController();
  const run = makeReviewTaskRunner({ adapter: f.adapter, scratch, sessionInput: input => input, cloudAllowed: async () => true,
    beforeDispatch: async () => { stop.abort(); } });
  await assert.rejects(run({ specialist: "script", prompt: "Review", images: [] }, stop.signal, f.receipt), /cancel|abort/i);
  assert.equal(f.sent().length, 0); assert.deepEqual(await readdir(scratch), []);
});

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

it("labels attachment order explicitly when a harness collects all text before images", async () => {
  const f = fake();
  const run = makeReviewTaskRunner({ adapter: f.adapter, beforeDispatch: async () => {}, scratch: await tempDir("review-order-"), sessionInput: input => input, cloudAllowed: async () => true });
  await run({ specialist: "visual", prompt: "Review", images: ["p1.0", "p7.0"].map(block => ({ block, bytes: pixels, extension: ".png" })) }, new AbortController().signal, f.receipt);
  const text = f.sent().flatMap(p => p.type === "text" ? [p.text] : []).join("\n");
  assert.match(text, /1\. Image block p1\.0\n2\. Image block p7\.0/);
  assert.match(text, /attachment order, not by the nearest text label/);
  assert.equal(f.sent().filter(p => p.type === "image").length, 2);
});

it("runs AI tells as the prose reviewer, with its own skill and no images", async () => {
  const f = fake();
  const run = makeReviewTaskRunner({ adapter: f.adapter, beforeDispatch: async () => {}, scratch: await tempDir("review-task-"), sessionInput: input => input, cloudAllowed: async () => true });
  await run({ specialist: "prose", prompt: "AI TELLS", images: [] }, new AbortController().signal, f.receipt);
  assert.equal(f.config()?.agent, "chapter-prose-reviewer");
  assert.equal(f.config()?.skillFamily, "chapter-review");
  assert.match(f.config()?.skillBodies?.["chapter-prose-review"] ?? "", /Tag every instance/);
  assert.equal(f.sent().some(part => part.type === "image"), false);
});

/** A harness whose session answers each turn with the next reply, recording what each turn sent. */
function scripted(replies: string[]) {
  const sent: MessagePart[][] = [];
  let answer: (event: object) => void = () => {};
  const adapter = { prepareSession: () => {}, createSession: async () => ({ sessionId: "review" }),
    dispatchAsync: async (input: { parts: MessagePart[] }) => {
      assert.ok(sent.length < replies.length, "no turn beyond the scripted replies");
      sent.push(input.parts); answer({ type: "message.completed", sessionId: "review", text: replies[sent.length - 1] });
    },
    streamEvents: () => { const event = new Promise<object>(resolve => { answer = resolve; }); return { [Symbol.asyncIterator]: async function* () { yield await event; } }; },
    interrupt: async () => {},
  } as unknown as HarnessAdapter;
  return { adapter, sent: () => sent };
}
const finding = { category: "clarity", certainty: "possible-confusion", quote: "She left.", imageBlocks: [], observation: "Exit unclear", impact: "Reader loses her", correction: "Name the door" };
it("drops keys a reviewer adds to its findings and tags, and still refuses a missing or wrong-typed field", async () => {
  const f = scripted([JSON.stringify({ facts: [{ quote: "She left.", claim: "She leaves", kind: "explicit", confidence: 0.9 }], summary: "One finding.",
    findings: [{ ...finding, claim: "The exit is unclear", certainty_note: "Probably" }], tells: [{ kind: "pivot", quote: "She left.", why: "Short" }] })]);
  const run = makeReviewTaskRunner({ adapter: f.adapter, beforeDispatch: async () => {}, scratch: await tempDir("review-task-"), sessionInput: input => input, cloudAllowed: async () => true });
  assert.deepEqual(await run({ specialist: "script", prompt: "Review", images: [] }, new AbortController().signal, async () => {}),
    { facts: [{ quote: "She left.", claim: "She leaves", kind: "explicit" }], findings: [finding], tells: [{ kind: "pivot", quote: "She left." }] });
  const { impact: _impact, ...missing } = finding;
  for (const wrong of [missing, { ...finding, certainty: 3 }, { ...finding, imageBlocks: "p0.0" }]) {
    const g = scripted([JSON.stringify({ facts: [], findings: [{ ...wrong, claim: "extra" }] })]);
    const strict = makeReviewTaskRunner({ adapter: g.adapter, beforeDispatch: async () => {}, scratch: await tempDir("review-task-"), sessionInput: input => input, cloudAllowed: async () => true });
    await assert.rejects(strict({ specialist: "script", prompt: "Review", images: [] }, new AbortController().signal, async () => {}), /findings/);
    assert.equal(g.sent().length, 1, "a schema refusal is not resent");
  }
});
it("asks once more in the same session when an answer is not valid JSON, and rechecks before resending", async () => {
  const malformed = '{"facts":[],"findings":[],"tells":[{"kind":"pivot","quote":"He said "no" twice."}]}';
  const f = scripted([malformed, '{"facts":[],"findings":[],"tells":[{"kind":"pivot","quote":"He said \\"no\\" twice."}]}']);
  let checks = 0, policies = 0;
  const run = makeReviewTaskRunner({ adapter: f.adapter, beforeDispatch: async () => { checks++; }, scratch: await tempDir("review-task-"), sessionInput: input => input,
    cloudAllowed: async () => { policies++; return true; } });
  assert.deepEqual(await run({ specialist: "prose", prompt: "AI TELLS", images: [] }, new AbortController().signal, async () => {}),
    { facts: [], findings: [], tells: [{ kind: "pivot", quote: 'He said "no" twice.' }] });
  assert.equal(f.sent().length, 2); assert.equal(checks, 2, "the resend rechecks world ownership");
  assert.equal(policies, 0, "a text-only task never asks the cloud image policy");
  const resend = f.sent()[1]!;
  assert.equal(resend.length, 1); assert.ok(resend[0]!.type === "text");
  assert.match(resend[0]!.text, /not valid JSON \(Expected ',' or '}' after property value/);
  assert.doesNotMatch(resend[0]!.text, /AI TELLS/, "the resend does not send the chapter again");
});
it("fails with the parse error when the one resend is not JSON either", async () => {
  const f = scripted(['{"facts":[],"findings":[], "tells":[{"kind":"pivot","quote":"a "b" c"}]}', "Here are the tags: none."]);
  const run = makeReviewTaskRunner({ adapter: f.adapter, beforeDispatch: async () => {}, scratch: await tempDir("review-task-"), sessionInput: input => input, cloudAllowed: async () => true });
  await assert.rejects(run({ specialist: "prose", prompt: "AI TELLS", images: [] }, new AbortController().signal, async () => {}),
    /not valid JSON, and neither was the one resend: no JSON object in the response/);
  assert.equal(f.sent().length, 2);
});

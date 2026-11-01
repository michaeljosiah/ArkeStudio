import assert from "node:assert/strict";
import { it } from "node:test";
import { planAudiobook, readAudiobook } from "../../src/productions/audiobook.js";
import { CHAPTER, LEDGER, WORLD_ID, withHarness, type Harness } from "./picture-harness.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const make = (h: Harness, block: string, n = 0) => h.send({
  kind: "make-audiobook-picture", worldId: WORLD_ID, productionId: LEDGER, chapterFile: CHAPTER,
  block, prompt: "The rail at dawn.", who: [], confirmedMicroUsd: 45_000,
  requestId: `01J0000000000000000000000${n}`,
});

it("three pictures waiting for a serial provider keep their jobs and land on their moments (#2284)", () =>
  withHarness(async h => {
    const plan = await planAudiobook(h.store()!, LEDGER, CHAPTER, { narrator: { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george" } });
    const blocks = plan.blocks.slice(0, 3).map(row => row.block.key);
    assert.equal(blocks.length, 3);
    const making = blocks.map((block, n) => make(h, block, n));
    for (let i = 0; h.enqueued.length < 3 && i < 100; i++) await pause(50);
    assert.equal(h.enqueued.length, 3);
    // Longer than the generation budget AND a polling pass, while all jobs are still queued.
    await pause(1_200);
    assert.equal(h.cancelled.length, 0);
    assert.equal(h.events.some(event => event.type === "audiobook.picture-made" && event.state === "failed"), false);
    for (let n = 0; n < 3; n++) {
      h.startHeld(n);
      await h.landHeld(n);
      await pause(100);
    }
    await Promise.all(making);
    const record = await readAudiobook(h.store()!, LEDGER, CHAPTER);
    assert.ok(record && record !== "unreadable");
    for (const block of blocks) assert.ok(record.pictures?.[block]?.file.startsWith("artifacts/"));
    assert.equal(h.enqueued.length, 3, "no replacement jobs");
  }, { land: false, reached: false, pictureWait: { waitMs: 50, lateLookMs: 20 } }));

it("cancels a started picture on timeout instead of leaving a late orphan (#2284)", () =>
  withHarness(async h => {
    await make(h, "p0.0");
    assert.equal(h.cancelled.length, 1);
    assert.ok(h.events.some(event => event.type === "audiobook.picture-made" && event.state === "failed" && event.reason === "cancelled"));
    await assert.rejects(h.landHeld(0), /not held/);
  }, { land: false, pictureWait: { waitMs: 50, lateLookMs: 20 } }));

it("files a completed picture when completion wins the timeout cancellation race (#2284)", () =>
  withHarness(async h => {
    await make(h, "p0.0");
    assert.equal(h.cancelled.length, 1);
    const record = await readAudiobook(h.store()!, LEDGER, CHAPTER);
    assert.ok(record && record !== "unreadable" && record.pictures?.["p0.0"]);
    assert.ok(h.events.some(event => event.type === "audiobook.picture-made" && event.state === "made"));
    assert.equal(h.enqueued.length, 1);
  }, { land: false, landOnCancel: true, pictureWait: { waitMs: 50, lateLookMs: 20 } }));

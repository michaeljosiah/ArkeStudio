import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewAnswer, ChapterReview } from "@arke-studio/contracts";
import { ChapterReviewService, captureReviewSource, readChapterReview, saveChapterReview, reviewPrompt } from "../../src/productions/chapter-review.js";
import { emptyAudiobook, writeAudiobook } from "../../src/productions/audiobook.js";
import { saveChapter } from "../../src/productions/ops.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempRoot, makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import type { ReviewTaskRunner } from "../../src/harness/review-task.js";

const quote = "Maren has the 1820 volume open on the rail desk";
const answer: ReviewAnswer = { facts: [{ quote, claim: "Maren holds an old ledger", kind: "explicit" }], findings: [{ category: "clarity", certainty: "possible-confusion", quote, imageBlocks: [], observation: "An unfamiliar date needs context.", impact: "A reader may mistake the era.", correction: "Establish the current year if relevant." }] };
async function fixture() {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir);
  closeOnCleanup(() => store.close());
  const target = { worldId: store.worldId, productionId: "the-ledger-of-nights", chapterId: "neap" };
  const updates: Array<ChapterReview | null> = [];
  const service = (runner: ReviewTaskRunner) => new ChapterReviewService({ withWorld: async (id, work) => { assert.equal(id, store.worldId); return work(store); }, runner: () => runner, publish: (_target, review) => updates.push(review) });
  return { dir, store, target, service, updates };
}
it("checkpoints evidence and deduplicates request IDs across new services and later runs", async () => {
  const f = await fixture(); let calls = 0;
  const runner: ReviewTaskRunner = async (_input, _signal, receipt) => {
    calls++; await receipt({ model: "test-model", sessionId: "session" });
    const saved = await readChapterReview(f.store, f.target);
    assert.equal(saved?.tasks[0]?.state, "running");
    assert.equal(saved?.tasks[0]?.model, "test-model");
    return answer;
  };
  const first = await f.service(runner).start(f.target, "first-request");
  assert.equal(first.status, "complete"); assert.equal(first.audioListened, false);
  assert.equal(first.findings[0]?.offset, first.body.indexOf(quote));
  await f.service(runner).decide(f.target, first.id, first.findings[0]!.id, "intentional", "Period contrast is intentional");
  const second = await f.service(runner).start(f.target, "second-request");
  assert.equal(second.findings[0]?.decision, "intentional");
  const replay = await f.service(runner).start(f.target, "first-request");
  assert.equal(replay.id, first.id); assert.equal(calls, 2);
  assert.equal((await readChapterReview(f.store, f.target))?.id, second.id, "old replays cannot replace latest");
});
it("rejects stale decisions and preserves the reviewed text after edits", async () => {
  const f = await fixture(), service = f.service(async () => answer);
  const review = await service.start(f.target, "request");
  const source = await captureReviewSource(f.store, f.target);
  await saveChapter(f.store, f.target.productionId, source.chapter.file, source.chapter.body + "\n\nLater, she left.", { baseHash: source.chapter.hash });
  await assert.rejects(service.decide(f.target, review.id, review.findings[0]!.id, "dismissed"), /source changed/i);
  assert.equal(f.updates.at(-1)?.stale, true, "the refusal publishes stale evidence immediately");
  const refreshed = await service.read(f.target);
  assert.equal(refreshed?.stale, true); assert.equal(refreshed?.body, review.body);
});
it("cancels a retained run and does not resubmit its uncertain task after restart", async () => {
  const f = await fixture(); let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }); let calls = 0;
  const service = f.service(async (_input, signal) => { calls++; entered(); await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })); return answer; });
  const work = service.start(f.target, "cancel-request"); await ready;
  const duplicate = service.start(f.target, "cancel-request"); assert.equal(work, duplicate);
  await service.stop(); const result = await work;
  assert.equal(result.status, "cancelled");
  assert.equal((await f.service(async () => { calls++; return answer; }).start(f.target, "cancel-request")).id, result.id);
  assert.equal(calls, 1);
});
it("marks orphaned running records interrupted without invoking a model", async () => {
  const f = await fixture(); const review = await f.service(async () => answer).start(f.target, "orphan");
  review.status = "running"; review.tasks[0]!.state = "running";
  await saveChapterReview(f.store, review);
  const restored = await f.service(async () => { throw new Error("must never run"); }).read(f.target);
  assert.equal(restored?.status, "interrupted"); assert.equal(restored?.tasks[0]?.state, "cancelled");
});
it("supplies image pixels with exact block passages and records a failed visual task honestly", async () => {
  const f = await fixture(); const source = await captureReviewSource(f.store, f.target);
  const block = source.blocks.find(b => b.key !== "title")!;
  const record = emptyAudiobook(source.chapter.version, source.chapter.hash, new Date().toISOString());
  await writeFile(join(f.dir, "review-image.png"), "test-image-bytes");
  record.pictures = { [block.key]: { file: "review-image.png", source: "generated", textHash: "old-text", at: new Date().toISOString() } };
  await writeAudiobook(f.store, f.target.productionId, source.chapter.file, record);
  const fresh = await captureReviewSource(f.store, f.target);
  assert.ok(reviewPrompt(fresh, [], [block.key]).includes(JSON.stringify(block.text)));
  assert.match(reviewPrompt(fresh, [], [block.key]), /older text/);
  const review = await f.service(async input => { if (input.specialist === "script") return answer; assert.equal(input.images.length, 1); assert.equal(Buffer.from(input.images[0]!.bytes).toString(), "test-image-bytes"); throw new Error("Vision unavailable"); }).start(f.target, "visual");
  assert.equal(review.status, "partial"); assert.equal(review.tasks[1]?.state, "failed"); assert.equal(review.findings.length, 1);
});

it("finishes in its retained world after the UI selects another world", async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root);
  const first = (await provider.listWorlds())[0]!, second = await provider.createWorld({ name: "Another world" });
  await provider.loadWorld(first.worldId);
  let release!: () => void, ready!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { ready = resolve; });
  const service = new ChapterReviewService({ withWorld: (id, work) => provider.withBackgroundWorldStore(id, work), runner: () => async () => { ready(); await barrier; return answer; }, publish: () => {} });
  try {
    const work = service.start({ worldId: first.worldId, productionId: "the-ledger-of-nights", chapterId: "neap" }, "world-switch");
    await started; await provider.loadWorld(second.worldId);
    assert.equal(provider.openStore()?.worldId, second.worldId);
    release(); const result = await work;
    assert.equal(result.status, "complete"); assert.equal(result.worldId, first.worldId);
    assert.equal(provider.openStore()?.worldId, second.worldId);
  } finally { release(); await service.stop(); await provider.close(); }
});

it("latest follows the authoritative paid checkpoint even if the pointer was not rewritten", async () => {
  const f = await fixture(); const review = await f.service(async () => answer).start(f.target, "checkpoint");
  const pointerPath = join(f.dir, "productions", f.target.productionId, ".reviews", "chapters", f.target.chapterId, "latest.json");
  const pointer = await readFile(pointerPath, "utf8");
  assert.equal(JSON.parse(pointer).body, undefined);
  review.findings[0]!.observation = "Newer durable response";
  await saveChapterReview(f.store, review, false);
  assert.equal(await readFile(pointerPath, "utf8"), pointer);
  assert.equal((await readChapterReview(f.store, f.target))?.findings[0]?.observation, "Newer durable response");
  // Upgrade a development-era full-copy index by following its ID, not its stale contents.
  await writeFile(pointerPath, JSON.stringify({ ...review, findings: [] }));
  assert.equal((await readChapterReview(f.store, f.target))?.findings.length, 1);
});
it("stopping during source preparation aborts before reading image bytes", async () => {
  const f = await fixture(); const stop = new AbortController();
  const original = f.store.assertOwnership.bind(f.store); let assertions = 0;
  f.store.assertOwnership = async () => { await original(); if (++assertions === 1) stop.abort(); };
  await assert.rejects(captureReviewSource(f.store, f.target, stop.signal), /abort/i);
});

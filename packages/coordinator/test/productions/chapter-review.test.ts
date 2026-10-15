import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewAnswer, ChapterReview } from "@arke-studio/contracts";
import { ChapterReviewService, captureReviewSource, readChapterReview, saveChapterReview, reviewPrompt, verificationPrompt, consolidationPrompt } from "../../src/productions/chapter-review.js";
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
  f.updates.length = 0;
  const replay = await f.service(runner).start(f.target, "first-request");
  assert.equal(replay.id, first.id); assert.equal(calls, 2);
  assert.equal(f.updates.length, 0, "archived replay cannot replace the displayed current review");
  await f.service(runner).read(f.target, "first-request");
  assert.equal(f.updates.length, 0, "archived reads do not publish over the current review");
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

it("reopens a changed recommendation even when its quote and observation are unchanged", async () => {
  const f = await fixture();
  const first = await f.service(async () => answer).start(f.target, "assessed");
  await f.service(async () => answer).decide(f.target, first.id, first.findings[0]!.id, "dismissed", "This suggestion is unsuitable");
  const changed = structuredClone(answer); changed.findings[0]!.correction = "Establish the century through a different character.";
  const second = await f.service(async () => changed).start(f.target, "changed-advice");
  assert.equal(second.findings[0]?.decision, "open"); assert.equal(second.findings[0]?.decisionNote, undefined);
});
it("refuses an oversized image set before any model task or review checkpoint", async () => {
  const f = await fixture(), source = await captureReviewSource(f.store, f.target);
  const record = emptyAudiobook(source.chapter.version, source.chapter.hash, new Date().toISOString());
  // Each source is below the media reader's per-file limit; together they cross the review limit.
  await writeFile(join(f.dir, "large-review.png"), Buffer.alloc(40_000_001));
  record.pictures = Object.fromEntries(["p0.0", "p1.0", "p2.0"].map(block => [block, { file: "large-review.png", source: "generated" as const, textHash: "test-source", at: new Date().toISOString() }]));
  await writeAudiobook(f.store, f.target.productionId, source.chapter.file, record);
  let calls = 0;
  await assert.rejects(f.service(async () => { calls++; return answer; }).start(f.target, "oversized"), /120 MB review source budget/);
  assert.equal(calls, 0); assert.equal(await readChapterReview(f.store, f.target), null);
});

it("a delayed old read cannot publish over a newly completed review", async () => {
  const f = await fixture(), service = f.service(async () => answer);
  const first = await service.start(f.target, "old-run"); f.updates.length = 0;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  const original = f.store.assertOwnership.bind(f.store); let pauseNext = true;
  f.store.assertOwnership = async () => { if (pauseNext) { pauseNext = false; entered(); await barrier; } await original(); };
  const reading = service.read(f.target);
  try {
    await ready;
    const next = await service.start(f.target, "new-run");
    release(); const old = await reading;
    assert.equal(old?.id, first.id);
    assert.equal(f.updates.at(-1)?.id, next.id);
    assert.ok(f.updates.every(update => update?.id === next.id));
  } finally { release(); await reading; }
});

async function visualFixture() {
  const f = await fixture(), source = await captureReviewSource(f.store, f.target);
  const block = source.blocks.find(b => b.key !== "title")!;
  const record = emptyAudiobook(source.chapter.version, source.chapter.hash, new Date().toISOString());
  await writeFile(join(f.dir, "review-image.png"), "pinned-pixels");
  record.pictures = { [block.key]: { file: "review-image.png", source: "generated", textHash: "old", at: new Date().toISOString(),
    shot: { frame: "Doctor seen through glass from patient's room", inFrame: ["doctor"], notInFrame: ["patient", "teammate"], expressions: {}, details: [], checks: [] } } };
  await writeAudiobook(f.store, f.target.productionId, source.chapter.file, record);
  const visual = { ...answer.findings[0]!, category: "image" as const, imageBlocks: [block.key] };
  return { ...f, block, visual };
}
it("pins shot intent and documents negative framing cases without elevating intent over source", async () => {
  const f = await visualFixture(), source = await captureReviewSource(f.store, f.target);
  const prompt = verificationPrompt(source, [], [f.block.key]);
  assert.match(prompt, /"notInFrame":\["patient","teammate"\]/);
  assert.match(prompt, /patient's room/); assert.match(prompt, /cropped poses/);
  assert.match(prompt, /not necessarily the same vehicle/); assert.match(prompt, /cannot excuse an actual contradiction/);
  assert.match(consolidationPrompt([]), /symbol shape and a pointed spike tip are separate/);
});
it("independently checks pictured subjects, preserves rejected originals and consolidates paraphrases", async () => {
  const f = await visualFixture();
  const service = f.service(async (input, _signal, receipt) => {
    await receipt({ sessionId: input.phase ?? input.specialist, model: "fake" });
    if (input.phase === "verification") {
      assert.equal(Buffer.from(input.images[0]!.bytes).toString(), "pinned-pixels");
      const saved = (await readChapterReview(f.store, f.target))!;
      const candidates = saved.candidates!.filter(c => c.taskId === "visual-1");
      return { facts: [], findings: [], assessments: candidates.map((c, i) => ({ findingId: c.id,
        verdict: i === 0 ? "rejected" as const : i === 3 ? "uncertain" as const : "supported" as const,
        subject: i === 0 ? "Patient rather than doctor" : "Injured hand", rationale: i === 0 ? "Quote refers to the patient in a different scene." : "Visible support checked." })) };
    }
    if (input.phase === "consolidation") {
      const saved = (await readChapterReview(f.store, f.target))!;
      const duplicates = saved.findings.filter(c => c.taskId === "visual-1" && c.certainty !== "cannot-assess");
      return { facts: [], findings: [], groups: [{ representativeId: duplicates[0]!.id, memberIds: duplicates.map(c => c.id), rationale: "Same missing splint." }] };
    }
    if (input.specialist === "script") return answer;
    return { facts: [], findings: [0, 1, 2, 3].map(i => ({ ...f.visual, observation: `Concern ${i}` })) };
  });
  const review = await service.start(f.target, "adjudicated");
  assert.equal(review.status, "complete"); assert.equal(review.candidates?.length, 5);
  assert.equal(review.assessments?.length, 4); assert.equal(review.rejectedFindings, 1);
  assert.equal(review.groups?.[0]?.memberIds.length, 2); assert.equal(review.findings.length, 3);
  assert.equal(review.findings.some(f => f.observation === "Concern 0"), false);
  assert.equal(review.candidates?.some(f => f.observation === "Concern 0"), true);
  assert.equal(review.findings.find(f => f.observation === "Concern 3")?.certainty, "cannot-assess");
  assert.deepEqual((await readChapterReview(f.store, f.target))?.candidates, review.candidates);
});
it("failed evidence checking keeps source-linked candidates and reports partial coverage without retry", async () => {
  const f = await visualFixture(); let audits = 0;
  const service = f.service(async input => {
    if (input.phase === "verification") { audits++; throw new Error("uncertain audit outcome"); }
    if (input.phase === "consolidation") return { facts: [], findings: [], groups: [] };
    return input.specialist === "script" ? answer : { facts: [], findings: [f.visual] };
  });
  const review = await service.start(f.target, "failed-audit");
  assert.equal(review.status, "partial"); assert.equal(review.findings.length, 2);
  assert.equal(review.tasks.find(t => t.specialist === "verification")?.state, "failed");
  assert.equal(review.tasks.find(t => t.specialist === "consolidation")?.state, "unavailable");
  await service.start(f.target, "failed-audit"); assert.equal(audits, 1);
});
it("malformed consolidation cannot hide findings or lose original task provenance", async () => {
  const f = await visualFixture();
  const review = await f.service(async input => {
    if (input.phase === "verification") {
      const saved = (await readChapterReview(f.store, f.target))!;
      return { facts: [], findings: [], assessments: saved.candidates!.filter(c => c.taskId === "visual-1").map(c => ({ findingId: c.id, verdict: "supported" as const, subject: "hand", rationale: "Supported" })) };
    }
    if (input.phase === "consolidation") return { facts: [], findings: [], groups: [{ representativeId: "invented", memberIds: ["invented", "other"], rationale: "No" }] };
    return input.specialist === "script" ? answer : { facts: [], findings: [f.visual] };
  }).start(f.target, "bad-groups");
  assert.equal(review.status, "partial"); assert.equal(review.findings.length, 2); assert.equal(review.candidates?.length, 2);
});

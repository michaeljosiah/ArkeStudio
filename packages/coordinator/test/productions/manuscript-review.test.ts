import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid, manuscriptReviewCoverage, type ManuscriptReview } from "@arke-studio/contracts";
import { ManuscriptReviewService, manuscriptReviewHistory, readManuscriptReview } from "../../src/productions/manuscript-review.js";
import { manuscriptReviewPdf } from "../../src/productions/manuscript-review-pdf.js";
import { createChapter, openChapter, saveChapter } from "../../src/productions/ops.js";
import { WorldStore } from "../../src/world/store.js";
import type { ImageJsonRunner } from "../../src/harness/review-task.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

const injured = "Maren could not close her right hand.", climb = "Both hands gripped the rope the next morning.";
async function fixture() {
  const dir = await makeTempWorld(), store = await WorldStore.open(dir);
  closeOnCleanup(() => store.close());
  const target = { worldId: store.worldId, productionId: "the-ledger-of-nights" };
  while (store.getBundle().productions.find(p => p.meta.id === target.productionId)!.chapters.length < 3) await createChapter(store, target.productionId, { title: "Next", order: 3 });
  const chapters = store.getBundle().productions.find(p => p.meta.id === target.productionId)!.chapters.filter(c => !c.retired).sort((a,b) => a.order-b.order || a.id.localeCompare(b.id));
  for (const [index, chapter] of chapters.entries()) {
    const source = await openChapter(store, target.productionId, chapter.id, { canonicalId: true });
    await saveChapter(store, target.productionId, source.file, [injured, climb, "The light vanished. Its keeper remained unknown."][index] ?? `Chapter ${index} ends in silence.`, { baseHash: source.hash });
  }
  const findings = [{ title: "The injured hand recovers without explanation", priority: 1, kind: "contradiction", observation: "The next-morning climb contradicts the lasting injury.", recommendation: "Use one hand or establish recovery.", preserve: "Keep the rescue and the keeper's ambiguity.", dependencies: "Set the recovery timeline first.", citations: [{ chapterId: chapters[0]!.id, quote: injured }, { chapterId: chapters[1]!.id, quote: climb }] }];
  const reading = { synopsis: "Maren is injured, climbs, and leaves the keeper unknown.", strengths: "The uncertain identity sustains tension.", editorial: "Preserve the quiet ending; clarify the physical consequence.", continuity: "Injury persists. The keeper's identity is deliberately unresolved.", findings };
  const synthesis = { ...reading, verdict: "The mystery works but the injury needs a consequence.", limitations: "Fixture model judgment; no media inspected." };
  const updates: ManuscriptReview[] = [];
  const service = (runner: ImageJsonRunner) => new ManuscriptReviewService({ withWorld: async (id, work) => { assert.equal(id, store.worldId); return work(store); }, runner: () => runner, publish: (_target, review) => { if (review) updates.push(review); } });
  const runner: ImageJsonRunner = async (input, _signal, receipt) => {
    assert.equal(input.agent, "manuscript-reviewer"); assert.deepEqual(input.images, []);
    await receipt({ model: "fixture-reader", provider: "fixture", sessionId: ulid() });
    return input.prompt.includes('"verdict"') ? synthesis : reading;
  };
  return { dir, store, target, chapters, findings, reading, synthesis, updates, service, runner };
}
it("pins all saved chapters, retains evidence/intent and author decisions, and leaves source/media bytes unchanged", async () => {
  const f = await fixture(), files = f.chapters.map(c => join(f.dir, "productions", f.target.productionId, "chapters", `${c.file}.md`));
  await writeFile(join(f.dir,"untouched-media.bin"), "media"); files.push(join(f.dir,"untouched-media.bin"));
  const before = await Promise.all(files.map(file => readFile(file))), service = f.service(f.runner), id = ulid();
  const brief = "Quiet mystery; preserve the keeper's unknown identity and the final reveal.";
  const review = await service.start(f.target, id, brief);
  assert.equal(review.status, "complete"); assert.equal(manuscriptReviewCoverage(review).chapters, f.chapters.length);
  assert.equal(review.brief, brief); assert.match(review.synthesis!.continuity, /deliberately unresolved/);
  assert.equal(review.findings.length, 1); assert.equal(review.findings[0]!.citations[0]!.offset, 0);
  assert.ok(review.tasks.every(task => task.model === "fixture-reader"));
  await service.decide(f.target, id, review.findings[0]!.id, "intentional");
  const second = await service.start(f.target, ulid(), brief);
  assert.equal(second.findings[0]!.decision, "intentional"); assert.equal(second.findings[0]!.carried, true);
  const replay = await f.service(async () => assert.fail("A replay must not call a model")).start(f.target, id, "different brief");
  assert.equal(replay.brief, brief);
  assert.equal((await manuscriptReviewHistory(f.store, f.target)).length, 2);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
});
it("marks changed supporting evidence stale while keeping the historical quotation", async () => {
  const f = await fixture(), service = f.service(f.runner), review = await service.start(f.target, ulid(), "Preserve ambiguity");
  const source = await openChapter(f.store, f.target.productionId, f.chapters[1]!.id, { canonicalId: true });
  await saveChapter(f.store, f.target.productionId, source.file, "Her left hand gripped the rope.", { baseHash: source.hash });
  const current = await service.read(f.target, review.id);
  assert.equal(current?.stale, true); assert.equal(current?.findings[0]?.stale, true);
  assert.equal(current?.findings[0]?.citations[1]?.quote, climb);
  await assert.rejects(service.decide(f.target, review.id, review.findings[0]!.id, "resolved"), /source changed/);
});
it("recovers an orphaned paid checkpoint without replay and refuses a changed snapshot on continuation", async () => {
  const f = await fixture(), id = ulid(), review = await f.service(f.runner).start(f.target,id,"");
  review.status="running";review.tasks[0]!.state="running";
  const path=join(f.dir,"productions",f.target.productionId,".reviews","manuscript");
  await writeFile(join(path,`${id}.json`),JSON.stringify(review));
  const service=f.service(async()=>assert.fail("Uncertain work must not replay"));
  const replay=await service.start(f.target,id,"");
  assert.equal(replay.status,"interrupted");assert.equal(replay.tasks[0]!.state,"interrupted");
  const snapshot=JSON.parse(await readFile(join(path,`${id}.source.json`),"utf8"));snapshot.chapters[0].body+="Changed";
  await writeFile(join(path,`${id}.source.json`),JSON.stringify(snapshot));
  await assert.rejects(service.start(f.target,id,"",true),/snapshot changed/);
});
it("preserves completed work after interruption and continues only unstarted stages after restart", async () => {
  const f = await fixture(); let calls = 0, ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const service = f.service(async (_input, signal) => {
    calls++; if (calls === 1) return f.reading;
    ready(); await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })); return f.reading;
  });
  const id = ulid(), work = service.start(f.target, id, "Preserve ambiguity"); await started; await service.stop();
  const stopped = await work;
  assert.equal(stopped.status, "cancelled"); assert.equal(stopped.tasks[0]!.state, "complete"); assert.equal(stopped.tasks[1]!.state, "interrupted");
  const resumedCalls: string[] = [];
  const resumed = await f.service(async input => { resumedCalls.push(input.prompt); return f.reading; }).start(f.target, id, "ignored", true);
  assert.equal(resumed.status, "partial"); assert.equal(resumed.synthesis, undefined);
  assert.equal(resumedCalls.length, f.chapters.length - 2); assert.equal(resumed.tasks[1]!.state, "interrupted");
  assert.ok(resumedCalls.every(prompt => !prompt.includes(`SOURCE chapterId=${f.chapters[0]!.id},`) && !prompt.includes(`SOURCE chapterId=${f.chapters[1]!.id},`)));
  assert.equal((await readManuscriptReview(f.store, f.target, id))?.tasks[0]?.reading?.synopsis, f.reading.synopsis);
});
it("reads every character of a long chapter and bounds hierarchical synthesis without dropping chapter coverage", async () => {
  const f = await fixture(), source = await openChapter(f.store, f.target.productionId, f.chapters[0]!.id, { canonicalId: true });
  const body = injured + "\n\n" + "A keeper walks by the water. ".repeat(3600) + "😀 The final lamp goes dark.";
  await saveChapter(f.store, f.target.productionId, source.file, body, { baseHash: source.hash });
  const supplied: string[] = []; let merges = 0;
  const review = await f.service(async input => {
    if (input.prompt.includes(`SOURCE chapterId=${f.chapters[0]!.id},`)) supplied.push(input.prompt.split("\nSOURCE chapterId=")[1]!.split("\n").slice(1).join("\n").replace(/\nEND SOURCE$/, ""));
    if (input.prompt.includes('"verdict"')) return f.synthesis;
    if (input.prompt.includes("ORDERED STAGED READINGS")) { merges++; return f.reading; }
    return { ...f.reading, synopsis: "Causal reading. ".repeat(350), editorial: "Editorial notes. ".repeat(340), continuity: "Persistent consequence. ".repeat(120) };
  }).start(f.target, ulid(), "Keep the ending ambiguous");
  const savedBody = (await openChapter(f.store, f.target.productionId, f.chapters[0]!.id, { canonicalId: true })).body;
  assert.ok(supplied.join("") === savedBody, "Every saved source character was supplied once, without truncation"); assert.ok(merges > 0); assert.equal(review.status, "complete");
  assert.equal(manuscriptReviewCoverage(review).chapters, f.chapters.length);
});
it("drops invented citations, retains brief mismatches as author decisions and never silently marks absent findings resolved", async () => {
  const f = await fixture();
  const mismatch = { ...f.findings[0]!, kind: "author-decision", title: "Choose between a quiet brief and an action ending" };
  const first = await f.service(async input => input.prompt.includes('"verdict"') ? { ...f.synthesis, findings: [mismatch, { ...mismatch, title: "Invented", citations: [{ chapterId: f.chapters[0]!.id, quote: "Not in the manuscript" }] }] } : f.reading).start(f.target, ulid(), "Quiet mystery");
  assert.equal(first.findings.length,1); assert.equal(first.findings[0]!.kind, "author-decision"); assert.equal(first.rejectedCitations,1);
  const second = await f.service(async input => input.prompt.includes('"verdict"') ? { ...f.synthesis, findings: [] } : f.reading).start(f.target, ulid(), "Quiet mystery");
  assert.equal(second.notRaisedAgain,1); assert.equal((await readManuscriptReview(f.store,f.target,first.id))?.findings[0]?.decision,"open");
});
it("exports a private multi-page report with Unicode, retained evidence and numbered pages", async () => {
  const f = await fixture(), review = await f.service(f.runner).start(f.target, ulid(), "Ọlá asks for a quiet ending.");
  review.synthesis!.editorial = "Keep the quiet reveal and its emotional consequence. ".repeat(260);
  const bytes = await manuscriptReviewPdf(review);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false }).promise;
  assert.ok(pdf.numPages >= 4);
  let text = "";
  for (let page = 1; page <= pdf.numPages; page++) {
    const content = await (await pdf.getPage(page)).getTextContent();
    const words = content.items.flatMap(item => "str" in item ? [item.str] : []).join(" ");
    assert.match(words, new RegExp(`${page} / ${pdf.numPages}`)); text += words;
  }
  assert.match(text,/Ọlá/); assert.ok(text.includes(injured)); assert.match(text,/Method and limitations/); await pdf.destroy();
  if (process.env.ARKE_REVIEW_TEST_ARTIFACT) await writeFile(process.env.ARKE_REVIEW_TEST_ARTIFACT, bytes);
});

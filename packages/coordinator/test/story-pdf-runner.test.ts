import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_STORY_PDF_SETTINGS, type ManuscriptDocument } from "@arke-studio/contracts";
import { createStoryPdfRunner } from "../src/publications/story-pdf-runner.js";

const document: ManuscriptDocument = { title: "Worker fixture", subtitle: "", words: 1, leftOut: 0,
  chapters: [{ title: "One", words: 1, blocks: [{ kind: "paragraph", runs: [{ text: "Hello." }] }] }] };
const options = { author: "", language: "en", settings: DEFAULT_STORY_PDF_SETTINGS, chapterIds: ["one"] };
const worker = (source: string) => new URL(`data:text/javascript,${encodeURIComponent(source)}`);

test("the development worker generates and independently validates actual PDF bytes", async () => {
  const result = await createStoryPdfRunner()(document, options);
  assert.equal(Buffer.from(result.bytes).subarray(0, 5).toString(), "%PDF-");
  assert.equal(result.receipt.checks.text, true);
  assert.equal(result.chapters[0]?.id, "one");
});

test("an unresponsive PDF renderer is terminated at the host deadline", async () => {
  const render = createStoryPdfRunner({ workerPath: worker("while (true) {}"), timeoutMs: 40 });
  await assert.rejects(render(document, options), /resource limit/);
});

test("cancellation terminates an unresponsive renderer and pre-cancellation starts no worker", async () => {
  const controller = new AbortController();
  const render = createStoryPdfRunner({ workerPath: worker("while (true) {}") });
  const operation = render(document, options, { signal: controller.signal });
  controller.abort();
  await assert.rejects(operation, /cancelled/);
  await assert.rejects(render(document, options, { signal: controller.signal }), /cancelled/);
});

test("a PDF worker without a validated result fails rather than leaving a pending operation", async () => {
  await assert.rejects(createStoryPdfRunner({ workerPath: worker("process.exit(0)") })(document, options), /before completing validation/);
});

test("memory budget violations terminate the PDF worker", async () => {
  const source = `import {parentPort} from 'node:worker_threads'; parentPort.postMessage({kind:'memory',bytes:600*1024**2}); while(true){}`;
  await assert.rejects(createStoryPdfRunner({ workerPath: worker(source) })(document, options), /512 MiB/);
});

test("PDF progress persistence is serialized and rejection fails the operation", async () => {
  const source = `import {parentPort} from 'node:worker_threads'; parentPort.postMessage({kind:'phase',phase:'Formatting pages'}); parentPort.postMessage({kind:'phase',phase:'Checking PDF'}); parentPort.postMessage({kind:'result',result:{bytes:new Uint8Array([1])}});`;
  const calls: string[] = [];
  const render = createStoryPdfRunner({ workerPath: worker(source) });
  await render(document, options, { onPhase: async phase => { await new Promise(resolve => setTimeout(resolve, 10)); calls.push(phase); } });
  assert.deepEqual(calls, ["Formatting pages", "Checking PDF"]);
  await assert.rejects(render(document, options, { onPhase: async () => { throw new Error("storage failed"); } }), /report progress/);
});

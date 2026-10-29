import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
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

// Path2D and ImageData are what PDF.js takes from @napi-rs/canvas; Node has neither. A worker
// that loads the addon can crash the whole test process on Windows when it exits.
test("PDF.js in the PDF worker loads no native canvas addon", { skip: typeof nodeModule.registerHooks !== "function" && "needs module.registerHooks (Node 22.15+)" }, async () => {
  const require = nodeModule.createRequire(import.meta.url);
  const source = `require(${JSON.stringify(require.resolve("tsx/cjs"))});
    require(${JSON.stringify(fileURLToPath(new URL("../src/publications/story-pdf.ts", import.meta.url)))}).refuseCanvasAddon();
    globalThis.DOMMatrix = function ExtractionOnlyMatrix() {};
    import(${JSON.stringify(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href)})
      .then(() => require("node:worker_threads").parentPort.postMessage([typeof Path2D, typeof ImageData]));`;
  const probe = new Worker(source, { eval: true, stdout: true, stderr: true });
  probe.stdout.resume(); probe.stderr.resume();
  try {
    const seen = await new Promise((resolve, reject) => { probe.once("message", resolve); probe.once("error", reject); });
    assert.deepEqual(seen, ["undefined", "undefined"]);
  } finally { await probe.terminate(); }
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

for (const reason of ["cancel", "timeout", "error"] as const) test(`PDF ${reason} drains a phase write before the terminal receipt`, { timeout: 10_000 }, async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  // A queued phase may correctly be skipped after failure. Require the first callback to
  // enter before the worker fails, so this exercises draining an actual admitted write.
  const phaseStarted = new SharedArrayBuffer(4), handshake = new Int32Array(phaseStarted);
  const workerOptions = { ...options, phaseStarted };
  const source = `import {parentPort,workerData} from 'node:worker_threads'; parentPort.postMessage({kind:'phase',phase:'Formatting pages'}); Atomics.wait(new Int32Array(workerData.options.phaseStarted),0,0,5000); parentPort.postMessage({kind:'phase',phase:'Checking PDF'}); ${reason === "error" ? "parentPort.postMessage({kind:'error',error:'worker failed'});" : "setInterval(()=>{},1000);"}`;
  let receipt = "captured", settled = false, calls = 0;
  const operation = createStoryPdfRunner({ workerPath: worker(source), timeoutMs: reason === "timeout" ? 2000 : 5000 })(document, workerOptions, {
    signal: controller.signal, onPhase: async () => { calls++; Atomics.store(handshake, 0, 1); Atomics.notify(handshake, 0); enter(); await gate; receipt = "creating"; },
  });
  const observed = operation.then(() => { settled = true; receipt = "ready"; }, error => { settled = true; receipt = "terminal"; throw error; });
  void observed.catch(() => {});
  try {
    await Promise.race([entered, observed]);
    if (reason === "cancel") controller.abort();
    await new Promise(resolve => setTimeout(resolve, reason === "timeout" ? 2100 : 100));
    assert.equal(settled, false, "terminal handling must wait for the in-flight write");
    release();
    await assert.rejects(observed, /cancelled|resource limit|worker failed/);
    assert.equal(calls, 1, "queued phases must not start after failure");
    assert.equal(receipt, "terminal", "a late phase cannot overwrite the terminal receipt");
  } finally { release(); controller.abort(); await observed.catch(() => {}); }
});

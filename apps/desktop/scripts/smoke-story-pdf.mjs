import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// Copy only shipped assets outside the checkout: resolving developer node_modules must not
// make an incomplete renderer bundle pass. This does not launch or restart the desktop app.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "arke-story-pdf-bundle-"));
try {
  await cp(join(root, "dist/story-pdf-worker.mjs"), join(directory, "story-pdf-worker.mjs"));
  await cp(join(root, "dist/fonts"), join(directory, "fonts"), { recursive: true });
  const prose = "Ọlamma said, ‘Ṣé o rí ₦500?’ — a promise, a smile 😀. Combining: ọ and é.";
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(join(directory, "story-pdf-worker.mjs"), { stdout: true, stderr: true, workerData: {
      document: { title: "Bundled PDF check", subtitle: "", words: 16, leftOut: 0,
        chapters: [{ title: "Chapter One", words: 16, blocks: [{ kind: "paragraph", runs: [{ text: prose }] }] }] },
      options: { author: "Arke", language: "en", chapterIds: ["one"],
        settings: { version: 1, preset: "book", font: "serif", bodySize: 11, lineSpacing: 1.4, contents: true, runningHeaders: false } },
    } });
    worker.stdout.resume(); worker.stderr.resume();
    let completed = false;
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("Bundled PDF worker timed out")); }, 30_000);
    worker.on("message", message => {
      if (message.kind === "result" || message.kind === "error") {
        completed = true; clearTimeout(timer);
        void worker.terminate().then(() => message.kind === "result" ? resolve(message.result) : reject(new Error(message.error)));
      }
    });
    worker.on("error", error => { clearTimeout(timer); reject(error); });
    worker.on("exit", () => { if (!completed) { clearTimeout(timer); reject(new Error("Bundled PDF worker exited without a result")); } });
  });
  assert.equal(Buffer.from(result.bytes).subarray(0, 5).toString(), "%PDF-");
  assert.equal(result.chapters.length, 1);
  assert.equal(result.receipt.checks.text, true);
  assert.equal(result.receipt.checks.geometry, true);
  assert.ok(result.pageCount >= 2);
  console.log(`[smoke] standalone PDF worker: ${result.pageCount} pages, Unicode/geometry/navigation validated without checkout dependencies`);
} finally { await rm(directory, { recursive: true, force: true }); }

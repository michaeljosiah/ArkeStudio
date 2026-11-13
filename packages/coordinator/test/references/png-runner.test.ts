import test from "node:test";
import assert from "node:assert/strict";
import { createPngRunner } from "../../src/references/png-runner.js";
import { decodePng, encodePng, solidImage } from "../../src/references/png.js";
import { composeLocationSheet } from "../../src/references/location-sheet.js";

test("worker preserves PNG bytes, decoded pixels and caller-owned buffers", async () => {
  const png = createPngRunner(), image = solidImage(96, 72, [13, 217, 76, 128]);
  for (const level of [3, 9]) {
    const bytes = await png.encode(image, { level });
    assert.deepEqual(bytes, encodePng(image, { level }));
    assert.deepEqual(await png.decode(bytes), decodePng(bytes));
    assert.equal(image.pixels.byteLength, 96 * 72 * 4);
    assert.ok(bytes.byteLength > 0);
  }
});

test("location-sheet content address and labels remain byte-identical", async () => {
  const panels = [{ id: "harbour", name: "Establishing view", image: solidImage(32, 24, [0, 70, 150, 255]) }];
  assert.deepEqual(await createPngRunner().locationSheet(panels), composeLocationSheet(panels));
});

test("decoder limits and invalid-image errors survive; a refused task does not poison the next", async () => {
  const png = createPngRunner(), bytes = encodePng(solidImage(10, 10, [0, 0, 0, 255]));
  await assert.rejects(png.decode(bytes, 99), /dimensions exceed/);
  await assert.rejects(png.decode(new Uint8Array([1, 2, 3])), /not a PNG/);
  assert.equal((await png.decode(bytes, 100)).width, 10);
});

test("large PNG work yields to the coordinator event loop", async () => {
  const image = solidImage(2048, 2048, [0, 0, 0, 255]);
  let seed = 12345;
  for (let i = 0; i < image.pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image.pixels[i] = seed >>> 24;
  }
  let serviced = false;
  const tick = new Promise<void>(resolve => setTimeout(() => { serviced = true; resolve(); }, 0));
  const bytes = await createPngRunner().encode(image);
  assert.equal(serviced, true, "a pending coordinator timer must run before encoding finishes");
  assert.deepEqual(decodePng(bytes).pixels, image.pixels);
  await tick;
});

const blocked = new URL("data:text/javascript,setInterval(() => {}, 1000)");
test("cancellation removes queued work and terminates active work before releasing its slot", async () => {
  const png = createPngRunner({ workerPath: blocked }), image = solidImage(1, 1, [0, 0, 0, 255]);
  const active = new AbortController(), queued = new AbortController();
  const first = png.encode(image, {}, active.signal), second = png.encode(image, {}, queued.signal);
  const checks = Promise.all([assert.rejects(first, /active cancelled/), assert.rejects(second, /queued cancelled/)]);
  queued.abort(new Error("queued cancelled"));
  active.abort(new Error("active cancelled"));
  await checks;
  const already = new AbortController(); already.abort(new Error("already cancelled"));
  await assert.rejects(png.encode(image, {}, already.signal), /already cancelled/);
});

test("timeout and early worker exit fail without a synchronous fallback", async () => {
  const image = solidImage(1, 1, [0, 0, 0, 255]);
  await assert.rejects(createPngRunner({ workerPath: blocked, timeoutMs: 20 }).encode(image), /time limit/);
  await assert.rejects(createPngRunner({ workerPath: new URL("data:text/javascript,process.exit(0)") }).encode(image), /stopped before/);
});

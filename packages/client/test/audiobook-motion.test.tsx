import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage, AudiobookPicture, AudiobookMotionQuote } from "@arke-studio/contracts";
import { AudiobookMotionControl } from "../src/components/audiobook-motion.js";
import { WordTimingControl } from "../src/components/audiobook-word-timing.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, {
  getComputedStyle: () => ({ direction: "ltr" }),
  innerWidth: 1280,
  innerHeight: 800,
});
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {}, pause() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (n: number) => void) => setTimeout(() => cb(0), 0),
});
const at = "2026-10-10T12:00:00.000Z",
  worldId = FIXTURE_STATE.world!.meta.worldId,
  productionId = "saltlight";
const still: AudiobookPicture = { file: "world-art.png", at, source: "world", textHash: "sha256:fixture" };
let root: Root | undefined;
let sent: ClientMessage[] = [];
afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount());
  root = undefined;
  dom.document.body.innerHTML = "";
  __setBridgeForTest(null);
});
async function mount(node: React.ReactNode) {
  sent = [];
  __setBridgeForTest({ send: (json: string) => sent.push(JSON.parse(json)) } as unknown as ArkeBridge);
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, manifest: { ...FIXTURE_STATE.app.manifest!, models: FIXTURE_STATE.app.manifest!.models.map((m) => ({ ...m, modes: { "first-frame": { locked: [] } } })) } } }, { connection: "open" });
    root!.render(node);
  });
}
const button = (name: string) =>
  [...dom.document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
async function press(name: string) {
  const b = button(name);
  assert.ok(b, name);
  await act(async () => {
    b.dispatchEvent(new dom.Event("click", { bubbles: true }));
  });
}
const control = (picture: AudiobookPicture) => (
  <AudiobookMotionControl
    worldId={worldId}
    productionId={productionId}
    chapterFile="neap"
    block="p0.0"
    picture={picture}
    slug="fixture"
  />
);
it("requires a current quote to generate, then an explicit choice to adopt the delivered clip", async () => {
  await mount(control(still));
  await press("Animate");
  assert.ok(button("Generate clip")?.hasAttribute("disabled"));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });
  const request = sent.find((m) => m.kind === "quote-audiobook-motion");
  assert.ok(request?.kind === "quote-audiobook-motion");
  const quote: AudiobookMotionQuote = {
    sourceFile: still.file,
    sourceAt: at,
    sourceHash: `sha256:${"a".repeat(64)}`,
    model: { id: request.model, provider: "fal", label: "Seedance 2.0" },
    params: request.params,
    prompt: request.prompt,
    estimatedMicroUsd: 100000,
  };
  await act(async () =>
    __applyEventForTest({
      at,
      type: "audiobook.motion",
      worldId,
      productionId,
      chapterId: "neap",
      block: "p0.0",
      requestId: request.requestId,
      state: "quoted",
      quote,
    }),
  );
  await press("Generate clip");
  const make = sent.find((m) => m.kind === "make-audiobook-motion");
  assert.ok(make?.kind === "make-audiobook-motion");
  assert.deepEqual(make.quote, quote);
  assert.equal(
    sent.some((m) => m.kind === "choose-audiobook-motion"),
    false,
  );
  const candidate = {
    artifactId: "ar_01J00000000000000000000001",
    file: "artifacts/clip.mp4",
    seconds: 5,
    width: 864,
    height: 480,
    sourceHash: quote.sourceHash,
    sourceAt: at,
    behavior: "repeat" as const,
    active: false,
  };
  await act(async () => {
    root!.render(control({ ...still, motionCandidate: candidate }));
    __applyEventForTest({
      at,
      type: "audiobook.motion",
      worldId,
      productionId,
      chapterId: "neap",
      block: "p0.0",
      requestId: make.requestId,
      state: "review",
    });
  });
  assert.match(dom.document.body.textContent ?? "", /Your original picture stays saved/);
  await press("Use clip");
  const choose = sent.find((m) => m.kind === "choose-audiobook-motion");
  assert.ok(choose?.kind === "choose-audiobook-motion");
  assert.equal(choose.artifactId, candidate.artifactId);
  assert.equal(choose.choice, "candidate");
});
it("ignores a quote that arrives after its starting picture changed", async () => {
  await mount(control(still));
  await press("Animate");
  await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
  const request = sent.find((m) => m.kind === "quote-audiobook-motion");
  assert.ok(request?.kind === "quote-audiobook-motion");
  await act(async () => { root!.render(control({ ...still, file: "another.png" })); });
  await act(async () => __applyEventForTest({
    at, type: "audiobook.motion", worldId, productionId, chapterId: "neap", block: "p0.0",
    requestId: request.requestId, state: "quoted", quote: {
      sourceFile: still.file, sourceAt: at, sourceHash: `sha256:${"a".repeat(64)}`,
      model: { id: request.model, provider: "fal", label: "Seedance 2.0" },
      params: request.params, prompt: request.prompt, estimatedMicroUsd: 100000,
    },
  }));
  assert.ok(button("Generate clip")?.hasAttribute("disabled"));
});
it("keeps highlighted export unready when native word timing is unavailable and offers the saved reading for review", async () => {
  const ready: boolean[] = [];
  await mount(
    <WordTimingControl
      worldId={worldId}
      productionId={productionId}
      enabled
      onReady={(value) => ready.push(value)}
      usePhrases={() => {}}
    />,
  );
  const request = sent.find((m) => m.kind === "audiobook-word-timing");
  assert.ok(request?.kind === "audiobook-word-timing");
  await act(async () =>
    __applyEventForTest({
      at,
      type: "audiobook.word-timing",
      worldId,
      productionId,
      requestId: request.requestId,
      state: {
        available: false,
        reason: "measured word timing unavailable",
        running: false,
        done: 0,
        total: 1,
        blocks: [
          {
            chapterId: "neap",
            key: "p0.0",
            label: "Chapter 1 · block 1",
            file: "artifacts/reading.wav",
            ready: false,
            reason: "uncertain timing",
          },
        ],
      },
    }),
  );
  assert.equal(ready.at(-1), false);
  assert.ok(button("Prepare word timing")?.hasAttribute("disabled"));
  await press("Review blocks");
  assert.ok(dom.document.querySelector("audio[controls]"));
  assert.ok(button("Use phrase captions"));
});

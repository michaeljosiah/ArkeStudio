import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage, AudiobookPicture, AudiobookMotionQuote } from "@arke-studio/contracts";
import { AudiobookMotionControl } from "../src/components/audiobook-motion.js";
import { WordTimingControl } from "../src/components/audiobook-word-timing.js";
import { useWordTimingActivity, WordTimingActivityRow } from "../src/components/audiobook-timing-activity.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest, useStore } from "../src/lib/store.js";
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
    __setStateForTest(
      {
        ...FIXTURE_STATE,
        app: {
          ...FIXTURE_STATE.app,
          manifest: {
            ...FIXTURE_STATE.app.manifest!,
            models: FIXTURE_STATE.app.manifest!.models.map((m) => ({
              ...m,
              modes: { "first-frame": { locked: [] } },
            })),
          },
        },
      },
      { connection: "open" },
    );
    root!.render(node);
  });
}
const button = (name: string) =>
  [...dom.document.querySelectorAll("button")].find((b) =>
    name === "Generate clip" ? b.textContent?.trim().startsWith("Generate ") : b.textContent?.trim() === name,
  );
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
  assert.match(dom.document.body.textContent ?? "", /Start frame/);
  await press("Use clip");
  const choose = sent.find((m) => m.kind === "choose-audiobook-motion");
  assert.ok(choose?.kind === "choose-audiobook-motion");
  assert.equal(choose.artifactId, candidate.artifactId);
  assert.equal(choose.choice, "candidate");
});
it("ignores a quote that arrives after its starting picture changed", async () => {
  await mount(control(still));
  await press("Animate");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });
  const request = sent.find((m) => m.kind === "quote-audiobook-motion");
  assert.ok(request?.kind === "quote-audiobook-motion");
  await act(async () => {
    root!.render(control({ ...still, file: "another.png" }));
  });
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
      quote: {
        sourceFile: still.file,
        sourceAt: at,
        sourceHash: `sha256:${"a".repeat(64)}`,
        model: { id: request.model, provider: "fal", label: "Seedance 2.0" },
        params: request.params,
        prompt: request.prompt,
        estimatedMicroUsd: 100000,
      },
    }),
  );
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
  assert.equal(button("Prepare word timing"), undefined);
  assert.ok(button("Use phrase captions"));
  await press("Review blocks");
  await press("Review");
  assert.ok(dom.document.querySelector("audio"));
  assert.ok(button("Use phrase captions"));
});

it("reprepares only the stale block named in timing review", async () => {
  await mount(
    <WordTimingControl
      worldId={worldId}
      productionId={productionId}
      chapters={["neap"]}
      enabled
      onReady={() => {}}
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
        available: true,
        running: false,
        done: 0,
        total: 2,
        blocks: [
          {
            chapterId: "neap",
            key: "p0.0",
            label: "The harbour",
            ready: false,
            reason: "Words changed after timing",
          },
          {
            chapterId: "neap",
            key: "p1.0",
            label: "At the door",
            ready: false,
            reason: "Could not match 3 words",
          },
        ],
      },
    }),
  );
  await press("Review blocks");
  await press("Prepare again");
  assert.equal(
    sent.some((message) => message.kind === "audiobook-word-timing" && message.action === "prepare"),
    false,
    "review is a separate decision before computation",
  );
  await press("Prepare timings");
  const prepare = sent.find((m) => m.kind === "audiobook-word-timing" && m.action === "prepare");
  assert.ok(prepare?.kind === "audiobook-word-timing");
  assert.deepEqual(prepare.chapters, ["neap"]);
  assert.deepEqual(prepare.blocks, [{ chapterId: "neap", key: "p0.0" }]);
});
it("plays measured timing without carrying a highlight through silence", async () => {
  await mount(<WordTimingControl worldId={worldId} productionId={productionId} enabled onReady={() => {}} usePhrases={() => {}} />);
  const request = sent.find((message) => message.kind === "audiobook-word-timing");
  assert.ok(request?.kind === "audiobook-word-timing");
  await act(async () => __applyEventForTest({ at, type: "audiobook.word-timing", worldId, productionId, requestId: request.requestId, state: { available: true, running: false, done: 1, total: 1, blocks: [{ chapterId: "neap", key: "p0.0", label: "The harbour", file: "artifacts/reading.wav", text: "Light crossed water.", fromSec: 0, toSec: 5, ready: true, words: [{ text: "Light", startSec: .1, endSec: .4, probability: .99 }, { text: "crossed", startSec: 1, endSec: 1.4, probability: .99 }, { text: "water.", startSec: 2, endSec: 2.4, probability: .99 }] }] } }));
  await press("Review timing"); await press("Review");
  const audio = dom.document.querySelector("audio")!;
  const advance = async (currentTime: number) => { await act(async () => { Object.assign(audio, { currentTime }); audio.dispatchEvent(new dom.Event("timeupdate", { bubbles: true })); }); };
  await advance(1.2);
  assert.equal(dom.document.querySelector("mark")?.textContent, "crossed");
  assert.equal(dom.document.querySelectorAll("mark").length, 1);
  await advance(1.7);
  assert.equal(dom.document.querySelector("mark"), null, "measured silence has no active word");
});

it("labels preparation as timing and sends Stop without a narration command", async () => {
  await mount(<WordTimingActivityRow state={FIXTURE_STATE} entry={{ at, type: "audiobook.word-timing", worldId, productionId, requestId: "01J00000000000000000000001", state: { available: true, running: true, chapters: ["neap"], done: 1, total: 3, blocks: [] } }} />);
  assert.match(dom.document.body.textContent ?? "", /Preparing word timings/);
  assert.match(dom.document.body.textContent ?? "", /1 of 3 blocks/);
  await press("Stop");
  assert.equal(sent.at(-1)?.kind, "audiobook-word-timing");
  assert.ok(sent.every((message) => message.kind === "audiobook-word-timing"), "no narration command is sent");
});

it("refreshes timing Activity when opened and drops an aborted world from its transient rows", async () => {
  function Probe() {
    const state = useStore().state!;
    const entries = useWordTimingActivity(state, "all", state.world?.meta.worldId ?? null);
    return <span data-testid="timing-count">{entries.length}</span>;
  }
  await mount(<Probe />);
  await act(async () => __setStateForTest({
    ...FIXTURE_STATE,
    world: { ...FIXTURE_STATE.world!, productions: FIXTURE_STATE.world!.productions.map(production => ({ ...production, meta: { ...production.meta, format: "story" as const } })) },
  }, { connection: "open" }));
  assert.ok(sent.some(message => message.kind === "audiobook-word-timing" && message.action === "read"));
  await act(async () => __applyEventForTest({ at, type: "audiobook.word-timing", worldId, productionId, requestId: "01J00000000000000000000001", state: { available: true, running: true, done: 2, total: 3, blocks: [] } }));
  assert.equal(dom.document.querySelector('[data-testid="timing-count"]')?.textContent, "1");
  await act(async () => __setStateForTest({ ...FIXTURE_STATE, world: null }, { connection: "open" }));
  assert.equal(dom.document.querySelector('[data-testid="timing-count"]')?.textContent, "0", "a world close aborts local timing and must hide its old progress");
});

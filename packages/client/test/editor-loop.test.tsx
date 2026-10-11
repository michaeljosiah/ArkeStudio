import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DEFAULT_MIX, type ClientMessage, type RenderPlan } from "@arke-studio/contracts";
import { useCutTransport, type CutTransport } from "../src/screens/editor-transport.js";
import { CutPreview } from "../src/screens/editor-preview.js";
import { CutLoopControl } from "../src/screens/editor-loop.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const callbacks = new Map<number, FrameRequestCallback>(); let sequence = 0, now = 0;
const realNow = Date.now;
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => { callbacks.set(++sequence, callback); return sequence; },
  cancelAnimationFrame: (id: number) => callbacks.delete(id) });
Object.assign(Object.getPrototypeOf(document.createElement("video")), { pause() {}, play: () => Promise.resolve(), load() {} });
Object.getPrototypeOf(document.createElement("canvas")).getContext = () => null;
const roots: Root[] = [];
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); Date.now = realNow;
  callbacks.clear(); document.body.replaceChildren(); __setBridgeForTest(null); });
const tick = async (at: number) => { now = at; const pending = [...callbacks.values()]; callbacks.clear(); await act(async () => { for (const callback of pending) callback(at); }); };

it("keeps loop, pause/seek and the canonical clock through Current/Suggested without authored writes", async () => {
  now = 0; Date.now = () => now;
  const messages: ClientMessage[] = []; __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { messages.push(JSON.parse(json)); } });
  const current: RenderPlan = { preset: "review-cut", frameRate: 30, items: [], overlays: [], audio: [], totalSec: .2, revision: 1,
    range: { startSec: 0, endSec: .2 }, scope: { kind: "production" }, mix: DEFAULT_MIX, speech: [], subtitles: null };
  const suggested: RenderPlan = { ...current, effectRender: { rendererVersion: "software-rgba-v1", width: 32, height: 18,
    frameRate: 30, startFrame: 0, endFrame: 6, pictureLayers: [], effectLayers: [], issues: [] } };
  let transport!: CutTransport;
  function Harness({ plan, token = 0 }: { plan: RenderPlan; token?: number }) {
    transport = useCutTransport(plan.totalSec);
    return <><CutLoopControl transport={transport} /><CutPreview slug={undefined} spans={[]} totalSec={plan.totalSec} transport={transport} restartToken={token} plan={plan} /></>;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
  const show = async (plan: RenderPlan, token = 0) => act(async () => root.render(<Harness plan={plan} token={token} />));
  await show(current);
  const button = () => host.querySelector<HTMLButtonElement>('[aria-label="Loop whole video"]')!;
  assert.equal(button().getAttribute("aria-pressed"), "false");
  await act(async () => button().click());
  assert.equal(transport.loop, true); assert.equal(transport.playing, false); assert.equal(transport.timeRef.current, 0);
  await act(async () => { transport.seek(.18); transport.setPlaying(true); });
  const seekEpoch = transport.discontinuityRef!.current;
  await tick(40);
  assert.ok(Math.abs(transport.timeRef.current - .02) < 1e-12); assert.equal(transport.playing, true);
  assert.ok(transport.discontinuityRef!.current > seekEpoch);
  const wrapEpoch = transport.discontinuityRef!.current;
  for (const plan of [suggested, current, suggested]) {
    await show(plan); assert.equal(transport.loop, true); assert.equal(transport.playing, true);
    assert.equal(transport.discontinuityRef!.current, wrapEpoch);
  }
  await act(async () => transport.setPlaying(false));
  await act(async () => transport.seek(.1));
  await show(current); await show(suggested);
  assert.equal(transport.timeRef.current, .1); assert.equal(transport.playing, false); assert.equal(transport.loop, true);
  await show(suggested, 1);
  assert.equal(transport.timeRef.current, 0); assert.equal(transport.playing, true); assert.equal(transport.loop, true);
  await tick(80);
  await act(async () => button().click());
  assert.equal(transport.loop, false); assert.equal(transport.playing, true);
  await tick(1000);
  assert.equal(transport.timeRef.current, .2); assert.equal(transport.playing, false);
  assert.deepEqual(messages, [], "preview controls never create a timeline revision or history command");
  await show({ ...current, totalSec: 0 }, 1);
  assert.equal(button().disabled, true); assert.equal(transport.canLoop, false);
});

it("holds an explicitly paused end frame and wraps on resume, with invalid deliveries disabled", async () => {
  now = 0; Date.now = () => now;
  let transport!: CutTransport;
  function Harness({ duration }: { duration: number }) {
    transport = useCutTransport(duration);
    return <CutLoopControl transport={transport} />;
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
  const show = async (duration: number) => act(async () => root.render(<Harness duration={duration} />));
  await show(1);
  await act(async () => { transport.setLoop(true); transport.seek(1); });
  assert.equal(transport.timeRef.current, 1); assert.equal(transport.playing, false);
  await act(async () => transport.setPlaying(true));
  await tick(50);
  assert.ok(Math.abs(transport.timeRef.current - .05) < 1e-12); assert.equal(transport.playing, true);
  await act(async () => transport.setPlaying(false));
  for (const duration of [0, -1, NaN, Infinity]) {
    await show(duration);
    assert.equal(transport.canLoop, false); assert.equal(transport.loop, false);
    assert.equal(host.querySelector<HTMLButtonElement>("button")!.disabled, true);
    await act(async () => { transport.seek(5); transport.setPlaying(true); });
    await tick(now + 20);
    assert.equal(transport.timeRef.current, 0); assert.equal(transport.time, 0); assert.equal(transport.playing, false);
  }
});

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, StrictMode, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DEFAULT_MIX, defaultEffectClip, type RenderPlan } from "@arke-studio/contracts";
import { CutPreview } from "../src/screens/editor-preview.js";
import { previewProductionFrame } from "../src/screens/editor-picture-preview.js";
import type { Transport } from "../src/screens/editor-transport.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
Object.assign(Object.getPrototypeOf(document.createElement("video")), { pause() {}, play: () => Promise.resolve(), load() {} });
// Pixel parity has its own worker coverage; these real preview branches exercise clock ownership.
Object.getPrototypeOf(document.createElement("canvas")).getContext = () => null;
const roots: Root[] = [];
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); });

function plans() {
  const current: RenderPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: 10, revision: 0,
    range: { startSec: 0, endSec: 10 }, scope: { kind: "production" }, mix: DEFAULT_MIX, speech: [], subtitles: null };
  const suggested: RenderPlan = { ...current, effectRender: {
    rendererVersion: "software-rgba-v1", width: 32, height: 18, frameRate: 24, startFrame: 0, endFrame: 240,
    pictureLayers: [], issues: [], effectLayers: [{ trackId: "tr_effect", trackOrder: 1,
      effect: defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", seed: 8, startFrame: 0, durationFrames: 240 }) }],
  } };
  return { current, suggested };
}

describe("Current/Suggested preview keeps the shared transport (SPEC-053 R-30–31)", () => {
  for (const initial of ["current", "suggested"] as const) {
    it(`does not replay an earlier Watch token when ${initial} mounts or the renderer switches`, async () => {
      const { current, suggested } = plans(), calls: Array<["seek", number] | ["playing", boolean]> = [];
      let live!: Transport;
      function Harness({ plan, token }: { plan: RenderPlan; token: number }) {
        const [time, setTime] = useState(4.25), [playing, setPlaying] = useState(false);
        const timeRef = useRef(time);
        live = { time, playing, timeRef,
          seek(value) { calls.push(["seek", value]); timeRef.current = value; setTime(value); },
          setPlaying(value) {
            const next = typeof value === "function" ? value(playing) : value;
            calls.push(["playing", next]); setPlaying(next);
          },
        };
        return <CutPreview slug={undefined} spans={[]} totalSec={10} restartToken={token} transport={live} plan={plan} />;
      }
      const host = document.createElement("div"); document.body.append(host);
      const root = createRoot(host); roots.push(root);
      const show = async (plan: RenderPlan, token = 7) => {
        await act(async () => root.render(<StrictMode><Harness plan={plan} token={token} /></StrictMode>));
        assert.equal(Boolean(host.querySelector(".fy-cutviewer--effects")), Boolean(plan.effectRender));
      };
      const pausedAt = (seconds: number) => {
        assert.equal(live.time, seconds); assert.equal(live.timeRef.current, seconds); assert.equal(live.playing, false);
        assert.equal(previewProductionFrame(suggested.effectRender!, live.timeRef.current), Math.floor(seconds * 24));
        assert.ok(host.querySelector('[aria-label="Play"]'));
      };

      await show(initial === "current" ? current : suggested);
      pausedAt(4.25); assert.deepEqual(calls, [], "an initial nonzero token is history, not an instruction");
      for (const plan of [suggested, current, suggested, current]) {
        await show(plan); pausedAt(4.25);
        assert.deepEqual(calls, [], "changing Current/Suggested cannot seek or start playback");
      }

      await show(current, 8);
      assert.deepEqual(calls, [["seek", 0], ["playing", true]], "a new Watch token runs once, including StrictMode");
      assert.equal(live.timeRef.current, 0); assert.equal(live.playing, true);
      assert.equal(host.querySelector(".fy-cutviewer--effects"), null, "Watch does not select Suggested");
      calls.length = 0;
      for (const plan of [suggested, current, suggested]) {
        await show(plan, 8);
        assert.equal(live.playing, true); assert.equal(live.timeRef.current, 0); assert.deepEqual(calls, []);
      }

      await act(async () => { live.setPlaying(false); live.seek(6.5); }); calls.length = 0;
      for (const plan of [current, suggested, current]) {
        await show(plan, 8); pausedAt(6.5); assert.deepEqual(calls, [], "a later pause/seek survives comparison");
      }
      await show(suggested, 9);
      assert.deepEqual(calls, [["seek", 0], ["playing", true]], "a new command also works while the effect renderer is active");
      calls.length = 0;
      await show(current, 0);
      assert.deepEqual(calls, [], "resetting the token is not Watch from top");
    });
  }
});

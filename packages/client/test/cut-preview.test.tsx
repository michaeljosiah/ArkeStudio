import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CutPreview } from "../src/screens/editor-preview.js";
import type { PlaybackSpan } from "../src/lib/cut-playback.js";
import type { Transport } from "../src/screens/editor-transport.js";

it("mounts stills only with a source and switches them on the frame clock, before a transport render", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), {
    pause() {}, play: () => Promise.resolve(), load() {},
  });
  Object.assign(globalThis, {
    window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const timeRef = { current: 0 };
  const transport: Transport = {
    playing: true, time: 0, timeRef,
    setPlaying: () => {}, seek: () => {},
  };
  const spans: PlaybackSpan[] = [
    { startSec: 0, endSec: 1, path: "artifacts/video.mp4", mediaInSec: 0, label: "video" },
    { startSec: 1, endSec: 2, path: "artifacts/still.png", mediaInSec: 0, label: "still", still: true },
    { startSec: 2, endSec: 3, path: null, mediaInSec: 0, label: "gap" },
    { startSec: 3, endSec: 4, path: "artifacts/overlay.png", mediaInSec: 0, label: "overlay", still: true, under: { path: "artifacts/video.mp4", mediaInSec: 0 } },
  ];
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(host);
  const root = createRoot(host);
  const tick = async (time: number) => {
    timeRef.current = time;
    const callbacks = [...frames.values()];
    frames.clear();
    await act(async () => { for (const callback of callbacks) callback(time * 1000); });
  };
  try {
    await act(async () => root.render(<CutPreview slug="test-world" spans={spans} totalSec={4} restartToken={0} transport={transport} />));
    assert.equal(host.querySelector("img"), null, "video-only playback has no empty image");
    await tick(1.01);
    const still = host.querySelector("img")!;
    assert.ok(still.getAttribute("src")?.endsWith("artifacts/still.png"));
    await tick(1.1);
    assert.equal(host.querySelector("img"), still, "the same still retains its decoded element");
    await tick(2.01);
    assert.equal(host.querySelector("img"), null, "a gap removes the still");
    await tick(3.01);
    assert.ok(host.querySelector("img")?.getAttribute("src")?.endsWith("artifacts/overlay.png"));
    assert.equal(host.querySelector("video")!.style.opacity, "1", "an overlay leaves the base video visible");
    await tick(0.2);
    assert.equal(host.querySelector("img"), null, "returning to video removes the overlay");
    assert.equal(transport.time, 0, "none of the transitions needed the throttled render clock");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

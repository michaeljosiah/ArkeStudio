import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CompareWipe, FOLLOW_RATE_MAX, FOLLOW_RATE_MIN, followStep, handleKey, pixelsScale, type CompareSide } from "../src/components/compare-wipe.js";

/*
 * Compare (design turn 273, issue 2402): one frame, the before clipped over the after, a line that
 * is a real slider, Pixels at the after's native width, and a follower that keeps time by its rate.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const before: CompareSide = { src: "/media/source.mp4", kind: "video", label: "Take 19 · 864×480" };
const after: CompareSide = { src: "/media/upscale.mp4", kind: "video", label: "Take 21 · 1920×1080" };

const mounted: { root: Root; container: HTMLElement }[] = [];
async function mount(props: Partial<Parameters<typeof CompareWipe>[0]> = {}) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<CompareWipe before={before} after={after} width={1920} height={1080} {...props} />));
  mounted.push({ root, container });
  return container;
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

async function key(target: Element, name: string, shift = false) {
  const event = new dom.window.Event("keydown", { bubbles: true });
  Object.defineProperty(event, "key", { value: name });
  Object.defineProperty(event, "shiftKey", { value: shift });
  await act(async () => void target.dispatchEvent(event));
}

describe("the handle", () => {
  it("is a slider at 50% that the arrow keys move 2%, Shift 10%, and Home and End to the edges", async () => {
    const container = await mount();
    const handle = container.querySelector('[role="slider"][aria-label="Compare"]')!;
    const now = () => handle.getAttribute("aria-valuenow");
    assert.equal(now(), "50");
    assert.equal(handle.getAttribute("aria-valuemin"), "0");
    assert.equal(handle.getAttribute("aria-valuemax"), "100");
    await key(handle, "ArrowRight");
    assert.equal(now(), "52");
    await key(handle, "ArrowLeft", true);
    assert.equal(now(), "42");
    await key(handle, "End");
    assert.equal(now(), "100");
    await key(handle, "ArrowRight", true);
    assert.equal(now(), "100", "clamped at the right edge");
    await key(handle, "Home");
    assert.equal(now(), "0");
    await key(handle, "ArrowLeft");
    assert.equal(now(), "0", "clamped at the left edge");
    const clip = (container.querySelectorAll(".fy-compare__layer")[1] as HTMLElement).getAttribute("style") ?? "";
    assert.match(clip, /inset\(0(px)? 100% 0(px)? 0(px)?\)/, "the before layer is clipped to the handle");
  });

  it("ignores keys that are not the handle's", () => {
    assert.equal(handleKey(50, "ArrowUp", false), null);
    assert.equal(handleKey(50, "a", true), null);
    assert.equal(handleKey(99, "ArrowRight", false), 100);
    assert.equal(handleKey(5, "ArrowLeft", true), 0);
  });
});

describe("the frame", () => {
  it("labels both sides with data and no caption, and draws both layers in one box at the after's aspect", async () => {
    const container = await mount();
    const labels = [...container.querySelectorAll(".fy-compare__label")].map((node) => node.textContent);
    assert.deepEqual(labels, ["Take 19 · 864×480", "Take 21 · 1920×1080"]);
    const box = container.querySelector(".fy-compare") as HTMLElement;
    // One number: a ratio written as `1920 / 1080` divides twice inside the CSS's `100cqw / …`.
    assert.match(box.getAttribute("style") ?? "", /--compare-aspect:\s*1\.777/);
    const videos = [...container.querySelectorAll("video")];
    assert.equal(videos.length, 2);
    assert.ok(videos.every((video) => video.muted || video.hasAttribute("muted")), "both muted");
    assert.ok(container.querySelector('[data-testid="bench-transport"]'), "the after's transport");
    assert.equal(container.querySelector(".fy-bench__playdisc"), null, "no resting play disc in Compare");
  });

  it("has no transport between two pictures", async () => {
    const container = await mount({ before: { ...before, kind: "image" }, after: { ...after, kind: "image" } });
    assert.equal(container.querySelectorAll("img").length, 2);
    assert.equal(container.querySelector('[data-testid="bench-transport"]'), null);
  });

  it("tells the host which side would not load", async () => {
    const failed: string[] = [];
    const container = await mount({ onFail: (side) => failed.push(side) });
    const [lead, follow] = [...container.querySelectorAll("video")];
    await act(async () => void follow!.dispatchEvent(new dom.window.Event("error")));
    await act(async () => void lead!.dispatchEvent(new dom.window.Event("error")));
    assert.deepEqual(failed, ["before", "after"]);
  });

  it("scales both layers in Pixels and neither in Fit", async () => {
    const fit = await mount();
    assert.ok([...fit.querySelectorAll("video")].every((video) => !/scale\(/.test(video.getAttribute("style") ?? "")));
    const pixels = await mount({ scale: "pixels" });
    assert.ok([...pixels.querySelectorAll("video")].every((video) => /scale\(/.test(video.getAttribute("style") ?? "")));
  });
});

describe("Pixels' scale", () => {
  it("is the after's native width over the box, never below Fit", () => {
    assert.equal(pixelsScale(1920, 960), 2);
    assert.equal(pixelsScale(1920, 2400), 1);
    assert.equal(pixelsScale(1920, 0), 1);
  });
});

describe("the follower's clock", () => {
  it("keeps time by rate inside 0.85–1.15 and seeks only past 0.3 s", () => {
    assert.deepEqual(followStep(0), { seek: false, rate: 1 });
    const behind = followStep(0.1);
    assert.equal(behind.seek, false);
    assert.ok(!behind.seek && behind.rate > 1 && behind.rate <= FOLLOW_RATE_MAX, "a follower behind speeds up");
    const ahead = followStep(-0.1);
    assert.ok(!ahead.seek && ahead.rate < 1 && ahead.rate >= FOLLOW_RATE_MIN, "a follower ahead slows down");
    assert.deepEqual(followStep(0.5), { seek: true });
    assert.deepEqual(followStep(-0.5), { seek: true });
  });
});

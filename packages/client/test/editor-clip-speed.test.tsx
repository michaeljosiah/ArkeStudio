import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { TimelineClip, TimelineCommand } from "@arke-studio/contracts";
import { ClipSpeedInspector } from "../src/screens/editor-clip-speed.js";
import { PreviewMediaPool } from "../src/lib/editor-preview-media.js";
import { pictureDragCommand } from "../src/lib/picture-edit.js";
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
const { createRoot } = await import("react-dom/client");
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });
const mount = async (element: React.ReactNode) => { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root!.render(element)); };
const clip: TimelineClip = { id: "cl_film", startFrame: 100, durationFrames: 48, sourceInFrames: 24, source: { kind: "artifact", artifactId: "ar_example", label: "Film" } };
const direction = () => document.querySelector<HTMLSelectElement>('[aria-label="Clip direction"]');
const choose = async (value: string) => {
  const select = direction()!, key = Object.keys(select).find(name => name.startsWith("__reactProps$"))!;
  await act(async () => (select as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!.onChange({ currentTarget: { value } }));
};
const speedInput = () => {
  const found = [...document.querySelectorAll("label")].find(row => row.childNodes[0]?.textContent === "Speed")!;
  return document.getElementById(found.getAttribute("for")!) as HTMLInputElement;
};
const type = async (value: string) => {
  const input = speedInput();
  await act(async () => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { const event = new Event("keydown", { bubbles: true }); Object.assign(event, { key: "Enter" }); input.dispatchEvent(event); });
};

test("a film takes a typed speed within its range and a direction, and shows the ones it has", async () => {
  const sent: TimelineCommand[][] = [];
  const view = (value: TimelineClip, disabled = false) => <ClipSpeedInspector clip={value} disabled={disabled} onCommands={commands => sent.push(commands)} />;
  await mount(view(clip));
  assert.equal(speedInput().value, "1"); assert.equal(direction()!.value, "forwards");
  await type("0.5");
  assert.deepEqual(sent.pop(), [{ kind: "set-clip-speed", clipId: "cl_film", speed: .5 }]);
  await type("1.337");
  assert.deepEqual(sent.pop(), [{ kind: "set-clip-speed", clipId: "cl_film", speed: 1.34 }], "the record keeps hundredths");
  await choose("backwards");
  assert.deepEqual(sent.pop(), [{ kind: "set-clip-reverse", clipId: "cl_film", reverse: true }]);
  await act(async () => root!.render(view({ ...clip, speed: 1.25, reverse: true })));
  assert.equal(speedInput().value, "1.25"); assert.equal(direction()!.value, "backwards");
  await choose("forwards");
  assert.deepEqual(sent.pop(), [{ kind: "set-clip-reverse", clipId: "cl_film", reverse: false }]);
  await type("8");
  assert.equal(sent.length, 0, "four times is as fast as a clip plays");
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /0\.25 to 4/);
  await act(async () => root!.render(view(clip, true)));
  assert.equal(direction()!.disabled, true); assert.equal(speedInput().disabled, true);
});

test("a reversed film's head is dragged out into the source after its window, and its tail into the source before it", () => {
  // 120 frames of source; the window is frames 24 to 72, so 24 lie before it and 48 after.
  const length = () => 120, forwards = [clip], backwards = [{ ...clip, reverse: true as const }];
  assert.deepEqual(pictureDragCommand(forwards, "cl_film", "trim-start", -60, length), { kind: "trim", clipId: "cl_film", edge: "start", deltaFrames: -24 });
  assert.deepEqual(pictureDragCommand(forwards, "cl_film", "trim-end", 60, length), { kind: "trim", clipId: "cl_film", edge: "end", deltaFrames: 48 });
  assert.deepEqual(pictureDragCommand(backwards, "cl_film", "trim-start", -60, length), { kind: "trim", clipId: "cl_film", edge: "start", deltaFrames: -48 });
  assert.deepEqual(pictureDragCommand(backwards, "cl_film", "trim-end", 60, length), { kind: "trim", clipId: "cl_film", edge: "end", deltaFrames: 24 });
  // Unmeasured, only the source's first frame bounds it: the tail backwards, the head forwards.
  assert.deepEqual(pictureDragCommand(backwards, "cl_film", "trim-start", -60), { kind: "trim", clipId: "cl_film", edge: "start", deltaFrames: -60 });
  assert.deepEqual(pictureDragCommand(backwards, "cl_film", "trim-end", 60), { kind: "trim", clipId: "cl_film", edge: "end", deltaFrames: 24 });
});

function pool() {
  const video = { readyState: 4, videoWidth: 1080, videoHeight: 1920, duration: 5, currentTime: 0, paused: true, seeking: false, playbackRate: 1, muted: false, playsInline: false, preload: "",
    crossOrigin: "", src: "", plays: 0, pause() { this.paused = true; }, play() { this.paused = false; this.plays++; return Promise.resolve(); },
    addEventListener() {}, removeEventListener() {}, removeAttribute() {}, load() {} };
  const context = { clearRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) };
  const doc = { createElement: (name: string) => name === "video" ? video : { width: 0, height: 0, getContext: () => context } } as unknown as Document;
  return { video, pool: new PreviewMediaPool(doc, path => path, () => {}) };
}

test("the preview runs a re-timed film at its speed and leaves a film at its own speed as it was", () => {
  const { video, pool: media } = pool(), source = { id: "cl_film", path: "film.mp4", still: false, sourceSec: 0 };
  assert.ok(media.capture(source, 540, 960, true, 0, 24));
  assert.equal(video.playbackRate, 1); assert.equal(video.paused, false);
  assert.ok(media.capture({ ...source, speed: .5 }, 540, 960, true, 1, 24));
  assert.equal(video.playbackRate, .5, "left to run, it keeps the clip's speed");
  // Stopped, it is the frame the film's clock names, a tenth of a millisecond inside it.
  assert.equal(media.capture({ ...source, speed: .5, sourceSec: 1.25 }, 540, 960, false, 2, 24), null);
  assert.equal(video.currentTime, 1.2501); assert.equal(video.paused, true);
  assert.ok(media.capture({ ...source, speed: .5, sourceSec: 1.25 }, 540, 960, false, 3, 24));
  media.destroy();
});

test("the preview plays a reversed film one seek at a time, and stopped it waits for the exact frame", () => {
  const { video, pool: media } = pool(), source = { id: "cl_film", path: "film.mp4", still: false, reverse: true as const };
  const at = (sourceSec: number, playing = true) => media.capture({ ...source, sourceSec }, 540, 960, playing, 0, 24);
  // The element opens at the top of the file; the film wants the window's end. That is the wrong picture, not a late one.
  assert.equal(at(4), null);
  assert.equal(video.currentTime, 4.0001); assert.equal(video.paused, true, "it never runs forwards");
  video.seeking = true;
  assert.equal(at(4 - 1 / 24), null, "nothing has landed yet");
  assert.equal(video.currentTime, 4.0001, "one seek at a time");
  video.seeking = false;
  // The seek landed a frame late: that frame stands in, and the next seek goes out.
  assert.ok(at(4 - 2 / 24));
  assert.equal(video.currentTime, 4 - 2 / 24 + .0001);
  video.seeking = true;
  assert.ok(at(4 - 3 / 24), "it draws through a seek in flight");
  assert.equal(video.currentTime, 4 - 2 / 24 + .0001);
  // Stopped on a frame, the stand-in will not do: the seek to the exact frame goes out at once.
  assert.equal(at(4 - 4 / 24, false), null);
  assert.equal(video.currentTime, 4 - 4 / 24 + .0001);
  assert.equal(at(4 - 4 / 24, false), null, "and nothing is drawn until it lands");
  video.seeking = false;
  assert.ok(at(4 - 4 / 24, false));
  assert.equal(video.plays, 0);
  media.destroy();
});

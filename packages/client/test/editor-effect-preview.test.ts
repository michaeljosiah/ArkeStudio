import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultEffectClip, type EffectClip } from "@arke-studio/contracts";
import { PreviewFrameQueue, renderPreviewFrame, type PreviewFrameRequest, type PreviewFrameResult } from "../src/lib/editor-preview-frame.js";
import { PreviewMediaPool, previewContainRect } from "../src/lib/editor-preview-media.js";
import { previewProductionFrame } from "../src/screens/editor-picture-preview.js";

const solid = (width: number, height: number, colour: readonly number[]) => Uint8ClampedArray.from(Array.from({ length: width * height }, () => colour).flat());
const frame = (absoluteFrame = 72): PreviewFrameRequest => ({ id: 1, generation: 0, absoluteFrame, frameRate: 24, width: 64, height: 36, pictures: [], composition: [] });
const effect = (preset: EffectClip["preset"]["id"] = "lights") => {
  const value = defaultEffectClip({ id: "cl_fx", lineageId: "ef_fx", seed: 42, startFrame: 0, durationFrames: 240, preset });
  value.appearance = { amount: 1, size: 1, opacity: 1, colour: "#ff0000" };
  return value;
};

describe("effect preview frame execution (SPEC-053 R-4, R-18–20)", () => {
  it("preserves every picture layer and clips scoped effects to a contained source-alpha matte", () => {
    const request = frame();
    request.pictures = [
      { id: "base", rect: { x: 0, y: 0, width: 64, height: 36 }, pixels: solid(64, 36, [0, 0, 255, 255]), effects: [] },
      { id: "middle", rect: { x: 23, y: 0, width: 18, height: 36 }, pixels: solid(18, 36, [0, 255, 0, 128]), effects: [effect()] },
      { id: "upper", rect: { x: 25, y: 0, width: 2, height: 36 }, pixels: solid(2, 36, [255, 255, 255, 255]), effects: [] },
    ];
    const result = renderPreviewFrame(request);
    for (let y = 0; y < 36; y++) {
      assert.deepEqual(Array.from(result.subarray((y * 64 + 10) * 4, (y * 64 + 10) * 4 + 4)), [0, 0, 255, 255], "letterbox never becomes a target");
      assert.deepEqual(Array.from(result.subarray((y * 64 + 25) * 4, (y * 64 + 25) * 4 + 4)), [255, 255, 255, 255], "upper picture hides scoped particles");
      assert.equal(result[(y * 64 + 30) * 4 + 2], 127, "scoped particles preserve the half-transparent source matte");
    }
  });

  it("has no scoped pixels through fully transparent source pixels", () => {
    const request = frame();
    request.pictures = [{ id: "transparent", rect: { x: 0, y: 0, width: 64, height: 36 }, pixels: solid(64, 36, [0, 255, 0, 0]), effects: [effect("smoke")] }];
    assert.deepEqual(renderPreviewFrame(request), solid(64, 36, [0, 0, 0, 255]));
  });

  it("renders every catalogue preset over a picture gap with deterministic random access", () => {
    for (const preset of ["dust", "embers", "snow", "lights", "rain", "smoke"] as const) {
      const request = { ...frame(120), width: 320, height: 180, composition: [effect(preset)] };
      const first = renderPreviewFrame(request);
      assert.ok(first.some((value, index) => index % 4 !== 3 && value !== 0), `${preset} contributes pixels`);
      renderPreviewFrame({ ...request, absoluteFrame: 35 });
      assert.deepEqual(renderPreviewFrame(request), first, `${preset} does not depend on a preceding frame`);
    }
  });

  it("uses absolute episode frames and holds only the last delivered frame", () => {
    const projection = { startFrame: 240, endFrame: 480, frameRate: 24 };
    assert.equal(previewProductionFrame(projection, 0), 240);
    assert.equal(previewProductionFrame(projection, 1 / 24), 241);
    assert.equal(previewProductionFrame(projection, 10), 479);
    assert.deepEqual(previewContainRect(100, 200, 320, 180), { x: 115, y: 0, width: 90, height: 180 });
  });

  it("bounds queued work and discards seek-invalidated frames including failures", () => {
    const sent: PreviewFrameRequest[] = [], presented: PreviewFrameResult[] = [];
    const queue = new PreviewFrameQueue(request => sent.push(request), result => presented.push(result));
    let built = 0;
    const build = (at: number) => () => { built++; return frame(at); };
    queue.request(build(1));
    queue.request(build(2));
    queue.request(build(3));
    assert.equal(sent.length, 1); assert.equal(built, 1);
    queue.invalidate();
    queue.request(build(80));
    queue.receive({ ...sent[0]!, error: "old frame failure" });
    assert.equal(presented.length, 0);
    assert.equal(sent.length, 2); assert.equal(built, 2); assert.equal(sent[1]!.absoluteFrame, 80);
    queue.receive({ ...sent[1]!, pixels: new Uint8ClampedArray() });
    assert.equal(presented.length, 1);
    queue.destroy(); queue.request(build(90));
    assert.equal(sent.length, 2);
  });

  it("seeks adjacent paused video frames exactly and makes every source decoder silent", () => {
    const events: string[] = [], seeks: number[] = [];
    let at = 0;
    const video = {
      crossOrigin: "", muted: false, playsInline: false, preload: "", paused: true, readyState: 2,
      duration: 5, videoWidth: 4, videoHeight: 2, seeking: false,
      get currentTime() { return at; }, set currentTime(value: number) { at = value; seeks.push(value); },
      set src(_value: string) { events.push(`source:${this.crossOrigin}:${this.muted}`); },
      addEventListener() {}, removeEventListener() {}, removeAttribute() {}, pause() {}, load() {}, play: () => Promise.resolve(),
    };
    const context = { clearRect() {}, drawImage() {}, getImageData: () => ({ data: solid(4, 2, [0, 0, 0, 255]) }) };
    const doc = { createElement: (name: string) => name === "video" ? video : { width: 0, height: 0, getContext: () => context } } as unknown as Document;
    const pool = new PreviewMediaPool(doc, path => path, () => {});
    const source = { id: "cl_video", path: "video.mp4", still: false, sourceSec: 1 };
    assert.equal(pool.capture(source, 4, 2, false, 0, 24), null);
    assert.ok(pool.capture(source, 4, 2, false, 0, 24));
    assert.equal(pool.capture({ ...source, sourceSec: 1 + 1 / 24 }, 4, 2, false, 0, 24), null);
    assert.deepEqual(seeks, [1.0001, 1 + 1 / 24 + 0.0001]);
    assert.deepEqual(events, ["source:anonymous:true"]);
    pool.capture({ ...source, sourceSec: 4, sourceOutSec: 2 }, 4, 2, false, 0, 24);
    assert.equal(seeks.at(-1), 2 - 0.0001, "a segment holds its last permitted physical source frame");
    pool.destroy();
  });
});

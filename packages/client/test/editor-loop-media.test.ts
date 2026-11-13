import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultEffectClip } from "@arke-studio/contracts";
import { transportClock, syncMediaElement } from "../src/lib/playback-engine.js";
import { PreviewMediaPool } from "../src/lib/editor-preview-media.js";
import { PreviewFrameQueue, renderPreviewFrame, type PreviewFrameRequest, type PreviewFrameResult } from "../src/lib/editor-preview-frame.js";

it("wraps half-open delivery while preserving delayed elapsed time at 24/25/30fps", () => {
  for (const fps of [24, 25, 30]) {
    const duration = 3 / fps;
    assert.equal(transportClock(0, 0, duration * 1000, duration, true).positionSec, 0);
    const after = transportClock(0, 0, (duration * 5 + 1 / fps) * 1000, duration, true);
    assert.equal(after.wraps, 5); assert.ok(Math.abs(after.positionSec - 1 / fps) < 1e-12);
    assert.equal(transportClock(0, 0, 5000, duration).positionSec, duration);
  }
  for (const duration of [0, -1, NaN, Infinity]) assert.deepEqual(transportClock(0, 0, 1000, duration, true), { positionSec: 0, wraps: 0 });
});

it("a short wrap bypasses both legacy and effects video drift tolerances", () => {
  let at = .15, plays = 0; const seeks: number[] = [];
  const video = {
    crossOrigin: "", muted: true, playsInline: true, preload: "", paused: false, readyState: 2, duration: 1,
    videoWidth: 4, videoHeight: 2, seeking: false,
    get currentTime() { return at; }, set currentTime(value: number) { at = value; seeks.push(value); },
    set src(_value: string) {}, addEventListener() {}, removeEventListener() {}, removeAttribute() {},
    pause() { this.paused = true; }, load() {}, play() { plays++; this.paused = false; return Promise.resolve(); },
  };
  syncMediaElement(video as unknown as HTMLMediaElement, { src: "video.mp4", targetSec: .15, playing: true, nowMs: 0, discontinuity: 0 });
  seeks.length = 0;
  video.paused = true;
  syncMediaElement(video as unknown as HTMLMediaElement, { src: "video.mp4", targetSec: .01, playing: true, nowMs: 200, discontinuity: 1 });
  assert.deepEqual(seeks, [.01]);
  assert.equal(plays, 2, "a source that ended at the wrap resumes without the 500ms retry delay");
  at = .15; seeks.length = 0;
  const context = { clearRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(32).fill(Math.round(at * 100)) }) };
  const doc = { createElement: (name: string) => name === "video" ? video : { width: 0, height: 0, getContext: () => context } } as unknown as Document;
  const pool = new PreviewMediaPool(doc, path => path, () => {});
  const source = { id: "cl_video", path: "video.mp4", still: false, sourceSec: .15 };
  assert.ok(pool.capture(source, 4, 2, true, 0, 30));
  video.paused = true;
  pool.discontinue();
  assert.equal(pool.capture({ ...source, sourceSec: .01 }, 4, 2, true, 200, 30), null, "old decoded pixels wait for the explicit seek");
  assert.deepEqual(seeks, [.0101]);
  assert.equal(pool.capture({ ...source, sourceSec: .01 }, 4, 2, true, 201, 30)?.pixels[0], 1);
  assert.equal(video.paused, false);
  assert.equal(plays, 3, "the retained effects decoder also resumes immediately after its exact seek");
  pool.destroy();
});

it("invalidates a pre-wrap worker result without changing absolute particle frames", () => {
  const effect = defaultEffectClip({ id: "cl_dust", lineageId: "ef_dust", seed: 42, startFrame: 240, durationFrames: 100 });
  const request = (absoluteFrame: number): PreviewFrameRequest => ({ id: 0, generation: 0, absoluteFrame, frameRate: 24,
    width: 32, height: 18, pictures: [], composition: [effect] });
  const sent: PreviewFrameRequest[] = [], shown: PreviewFrameResult[] = [];
  const queue = new PreviewFrameQueue(value => sent.push(value), value => shown.push(value));
  const initial = renderPreviewFrame(request(241));
  queue.request(() => request(299)); queue.invalidate(); queue.request(() => request(241));
  queue.receive({ ...sent[0]!, pixels: renderPreviewFrame(sent[0]!) });
  assert.equal(shown.length, 0);
  queue.receive({ ...sent[1]!, pixels: renderPreviewFrame(sent[1]!) });
  assert.equal(shown.length, 1); assert.deepEqual(shown[0]!.pixels, initial);
  queue.destroy();
});

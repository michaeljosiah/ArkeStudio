import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIVATION_SEEK_TOLERANCE_SEC,
  DRIFT_CORRECTION_SEC,
  PLAY_RETRY_INTERVAL_MS,
  STATE_UPDATE_INTERVAL_MS,
  onMediaReady,
  resetMediaElement,
  syncMediaElement,
  transportPosition,
} from "../src/lib/playback-engine.js";
import { mediaTimeFor, spanAt, spineSpans, storySpans } from "../src/lib/cut-playback.js";
import type { DerivedCut, DerivedSpineCut } from "@arke-studio/contracts";

/**
 * The element-sync rules ported from LTX-Desktop (Apache-2.0 — see the file header and
 * THIRD-PARTY-NOTICES.md), and the span resolver they run against. The rules are the reason a
 * preview is smooth rather than stuttering, and none of them are obvious from the outside, so
 * each one is pinned.
 */

interface Fake extends HTMLMediaElement {
  __plays: number;
  __pauses: number;
  __seeks: number[];
  __srcSets: string[];
  __fireReady: () => void;
}

describe("the transport clock", () => {
  it("derives position from an absolute start timestamp", () => {
    assert.equal(transportPosition(2, 1_000, 3_500, 10), 4.5);
    assert.equal(transportPosition(2, 1_000, 30_000, 10), 10, "a delayed frame lands on the end, not one tick later");
  });
});

function fakeElement(over: Partial<{ readyState: number; paused: boolean; currentTime: number }> = {}): Fake {
  const el = {
    readyState: over.readyState ?? 2,
    paused: over.paused ?? true,
    _currentTime: over.currentTime ?? 0,
    _src: "",
    __plays: 0,
    __pauses: 0,
    __seeks: [] as number[],
    __srcSets: [] as string[],
    _listeners: new Map<string, Set<() => void>>(),
    get currentTime() {
      return this._currentTime;
    },
    set currentTime(v: number) {
      this._currentTime = v;
      this.__seeks.push(v);
    },
    get src() {
      return this._src;
    },
    set src(v: string) {
      this._src = v;
      this.__srcSets.push(v);
    },
    play() {
      this.__plays += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.__pauses += 1;
      this.paused = true;
    },
    addEventListener(type: string, fn: () => void) {
      const set = this._listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      this._listeners.set(type, set);
    },
    removeEventListener(type: string, fn: () => void) {
      this._listeners.get(type)?.delete(fn);
    },
    /** What the browser does once the file arrives. */
    __fireReady() {
      this.readyState = 4;
      // Copied first: the handler removes itself, and deleting from a Set mid-iteration is
      // how you silently skip one.
      const pending = [...(this._listeners.get("loadeddata") ?? [])];
      for (const fn of pending) fn();
    },
  };
  return el as unknown as Fake;
}

describe("media element sync, ported", () => {
  it("assigns src once and does not reload while it stays the same", () => {
    const el = fakeElement();
    for (let i = 0; i < 5; i += 1) {
      syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 1 + i * 0.01, playing: true, nowMs: i * 16 });
    }
    assert.deepEqual(el.__srcSets, ["http://x/a.mp4"], "a reload per tick never shows a frame");
    resetMediaElement(el);
  });

  it("reloads when the span changes, and starts the new source at its in-point", () => {
    const el = fakeElement();
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 0, playing: true, nowMs: 0 });
    syncMediaElement(el, { src: "http://x/b.mp4", targetSec: 6, playing: true, nowMs: 16 });
    assert.deepEqual(el.__srcSets, ["http://x/a.mp4", "http://x/b.mp4"]);
    assert.ok(el.__seeks.includes(6), "the next shot starts where its media does, not at zero");
    resetMediaElement(el);
  });

  it("does not fight the element while it runs — the whole reason playback is smooth", () => {
    const el = fakeElement();
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 0, playing: true, nowMs: 0 });
    const seeksAfterStart = el.__seeks.length;
    // Ordinary decode wander, well inside the correction threshold.
    el.currentTime = 1.0;
    el.__seeks.length = 0;
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 1.4, playing: true, nowMs: 32 });
    assert.equal(el.__seeks.length, 0, `drift under ${DRIFT_CORRECTION_SEC}s is left alone`);
    assert.ok(seeksAfterStart >= 0);
    resetMediaElement(el);
  });

  it("pulls it back once it is properly lost", () => {
    const el = fakeElement();
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 0, playing: true, nowMs: 0 });
    el.currentTime = 1;
    el.__seeks.length = 0;
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 5, playing: true, nowMs: 32 });
    assert.deepEqual(el.__seeks, [5]);
    resetMediaElement(el);
  });

  it("waits for the element to have data before touching it", () => {
    const el = fakeElement({ readyState: 0 });
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 3, playing: true, nowMs: 0 });
    assert.deepEqual(el.__srcSets, ["http://x/a.mp4"], "the source is set");
    assert.deepEqual(el.__seeks, [], "but nothing is seeked into media that is not there");
    assert.equal(el.__plays, 0);
    resetMediaElement(el);
  });

  it("asks again once the file arrives, instead of dropping the request", () => {
    /*
     * The bug this pins was found by scrubbing the running app, not here. A source assigned this
     * tick is never ready this tick, so the readyState gate alone drops the seek — and while
     * paused nothing moves afterwards to retry it. The element sat at frame zero under a label
     * saying otherwise.
     */
    const el = fakeElement({ readyState: 0 });
    let asked = 0;
    onMediaReady(el, () => {
      asked += 1;
      syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 3, playing: false, nowMs: 0 });
    });
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 3, playing: false, nowMs: 0 });
    assert.deepEqual(el.__seeks, [], "nothing yet");
    el.__fireReady();
    assert.equal(asked, 1, "the element asks the caller for a fresh target");
    assert.deepEqual(el.__seeks, [3], "and lands on the right frame");
    resetMediaElement(el);
  });

  it("pauses and holds position where there is nothing to play", () => {
    const el = fakeElement({ paused: false });
    syncMediaElement(el, { src: null, targetSec: 0, playing: true, nowMs: 0 });
    assert.equal(el.__pauses, 1, "a slate or a black is not the previous shot still running");
    resetMediaElement(el);
  });

  it("retries a rejected play, but not on every frame", () => {
    const el = fakeElement();
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 0, playing: true, nowMs: 1000 });
    // `paused` is readonly on the DOM type; the fake owns it, so the cast is the honest way in.
    const stall = (e: Fake) => ((e as unknown as { paused: boolean }).paused = true);
    stall(el); // as a browser that refused the gesture leaves it
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 0.1, playing: true, nowMs: 1100 });
    assert.equal(el.__plays, 1, `no retry inside ${PLAY_RETRY_INTERVAL_MS}ms`);
    stall(el);
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 0.6, playing: true, nowMs: 1600 });
    assert.equal(el.__plays, 2, "and one retry after it");
    resetMediaElement(el);
  });

  it("seeks a paused element to the exact frame, within the activation tolerance", () => {
    const el = fakeElement();
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 4, playing: false, nowMs: 0 });
    assert.deepEqual(el.__seeks, [4]);
    el.__seeks.length = 0;
    syncMediaElement(el, { src: "http://x/a.mp4", targetSec: 4.05, playing: false, nowMs: 0 });
    assert.deepEqual(el.__seeks, [], `inside ${ACTIVATION_SEEK_TOLERANCE_SEC}s is already there`);
    resetMediaElement(el);
  });

  it("keeps the throttle upstream tuned", () => {
    assert.equal(STATE_UPDATE_INTERVAL_MS, 250);
  });
});

describe("the spans a preview walks", () => {
  const spine = {
    trackDurationSec: 60,
    segments: [
      { kind: "black", startSec: 0, endSec: 10, label: "10s" },
      { kind: "clip", startSec: 10, endSec: 18, label: "SC 1", media: { path: "p/clip.mp4", inSec: 2, outSec: 10 } },
      { kind: "black", startSec: 18, endSec: 60, label: "42s" },
    ],
  } as unknown as DerivedSpineCut;

  const story = {
    entries: [
      { durationSec: 4, label: "SHOT 1", media: { path: "p/a.mp4", inSec: 1.5 } },
      { durationSec: 6, label: "SHOT 2", media: null },
      { durationSec: 5, label: "SHOT 3", media: { path: "p/c.mp4" } },
    ],
  } as unknown as DerivedCut;

  it("takes the song clock's positions as they already are", () => {
    const spans = spineSpans(spine);
    assert.deepEqual(
      spans.map((s) => [s.startSec, s.endSec, s.path]),
      [
        [0, 10, null],
        [10, 18, "p/clip.mp4"],
        [18, 60, null],
      ],
    );
  });

  it("lays the story clock end to end, gaps included", () => {
    const spans = storySpans(story);
    assert.deepEqual(
      spans.map((s) => [s.startSec, s.endSec, s.path]),
      [
        [0, 4, "p/a.mp4"],
        [4, 10, null],
        [10, 15, "p/c.mp4"],
      ],
      "an uncovered shot still occupies its slot — the cut does not close up around it",
    );
  });

  it("resolves a moment to exactly one span, half-open at the boundary", () => {
    const spans = spineSpans(spine);
    assert.equal(spanAt(spans, 9.99)?.path, null);
    assert.equal(spanAt(spans, 10)?.path, "p/clip.mp4", "the boundary belongs to the span it starts");
    assert.equal(spanAt(spans, 17.99)?.path, "p/clip.mp4");
    assert.equal(spanAt(spans, 18)?.path, null);
    assert.equal(spanAt(spans, 60)?.label, "42s", "landing on the end is the last span, not nothing");
    assert.equal(spanAt(spans, 61), null);
  });

  it("offsets into the source by the span's in-point, so trim is honoured", () => {
    const clip = spineSpans(spine)[1]!;
    assert.equal(mediaTimeFor(clip, 10), 2, "the window starts where the derivation says");
    assert.equal(mediaTimeFor(clip, 14), 6);
    // The story clock's whole takes carry no in-point unless trimmed.
    assert.equal(mediaTimeFor(storySpans(story)[0]!, 0), 1.5);
    assert.equal(mediaTimeFor(storySpans(story)[2]!, 10), 0);
  });
});

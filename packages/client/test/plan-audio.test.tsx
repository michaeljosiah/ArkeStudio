import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DEFAULT_MIX, type RenderPlan } from "@arke-studio/contracts";

/**
 * The monitor mix plays the plan without restarting it.
 *
 * `CutScreen` rebuilds its render plan on every render and the transport reports four times a
 * second, so the hook is handed a structurally identical plan with a fresh identity four times
 * a second while the film runs. Nothing about the sound has changed; the elements must not
 * hear about it.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");

/** Every `<audio>` the hook makes, and what was done to it. */
interface FakeAudio {
  src: string;
  preload: string;
  crossOrigin: string | null;
  paused: boolean;
  currentTime: number;
  plays: number;
  pauses: number;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
}
const made: FakeAudio[] = [];

class FakeAudioElement implements FakeAudio {
  src: string;
  preload = "";
  crossOrigin: string | null = null;
  paused = true;
  currentTime = 0;
  plays = 0;
  pauses = 0;
  constructor(url: string) {
    this.src = url;
    made.push(this);
  }
  play(): Promise<void> {
    this.plays += 1;
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.pauses += 1;
    this.paused = true;
  }
  removeAttribute(): void {}
}

/** An AudioParam that records the level it was last asked for, however it was asked. */
const param = () => ({
  value: 0,
  setTargetAtTime(v: number) {
    this.value = v;
  },
  setValueAtTime(v: number) {
    this.value = v;
  },
  cancelScheduledValues() {},
});
const node = () => ({ connect() {}, disconnect() {} });
class FakeAudioContext {
  currentTime = 0;
  destination = node();
  createDynamicsCompressor() {
    return { ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() };
  }
  createMediaElementSource() {
    return node();
  }
  createGain() {
    return { ...node(), gain: param() };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

Object.assign(dom.window, { AudioContext: FakeAudioContext, Audio: FakeAudioElement });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Audio: FakeAudioElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});

/** rAF under the test's control: the hook's loop runs when a case says to. */
let frames: Array<() => void> = [];
Object.assign(globalThis, {
  requestAnimationFrame: (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  },
  cancelAnimationFrame: () => {},
});
const runFrame = () => {
  const pending = frames;
  frames = [];
  // One tick, not the loop: each callback re-arms itself.
  for (const cb of pending.slice(-1)) cb();
};

const { usePlanAudio } = await import("../src/lib/plan-audio.js");

/** One music bed, four seconds in, exactly what dragging a file onto a lane produces. */
function bedPlan(): RenderPlan {
  return {
    preset: "review-cut",
    frameRate: 24,
    items: [{ type: "black", durationSec: 12 }],
    overlays: [],
    audio: [{ clipId: "cl_bed", path: "artifacts/undersong.wav", startSec: 0, endSec: 12, gainDb: 0, role: "music", sourceInSec: 0 }],
    totalSec: 12,
    revision: 1,
    range: { startSec: 0, endSec: 12 },
    scope: { kind: "production" },
    mix: { ...DEFAULT_MIX, speechFirst: false },
    speech: [],
    subtitles: null,
  };
}

/** The transport's own ref: one object for the life of the screen, as `useCutTransport` makes it. */
const timeRef = { current: 0 };
const urlFor = (path: string) => `http://x/${path}`;

function Harness({ plan, playing, at }: { plan: RenderPlan; playing: boolean; at: number }) {
  timeRef.current = at;
  usePlanAudio({ plan, playing, timeRef, urlFor });
  return null;
}

describe("the monitor mix survives a re-render", () => {
  beforeEach(() => {
    made.length = 0;
    frames = [];
    timeRef.current = 0;
  });

  it("keeps the same element when the clip it plays is moved along the lane", async () => {
    const container = dom.document.createElement("div");
    let root: Root;
    await act(async () => {
      root = createRoot(container as unknown as HTMLElement);
      root.render(<Harness plan={bedPlan()} playing at={1} />);
    });
    await act(async () => {
      runFrame();
    });
    assert.equal(made.length, 1);

    // The bed nudged half a second later: the same file, in a new place.
    const moved = bedPlan();
    moved.audio[0]!.startSec = 0.5;
    moved.audio[0]!.endSec = 12.5;
    await act(async () => {
      root!.render(<Harness plan={moved} playing at={1} />);
    });
    await act(async () => {
      runFrame();
    });

    assert.equal(made.length, 1, `the move fetched the file again (${made.length} elements for one clip)`);
    assert.equal(made[0]!.pauses, 0, "and it did not stop to do it");
  });

  it("does not stop the sound when the plan is rebuilt with the same content", async () => {
    const container = dom.document.createElement("div");
    let root: Root;
    await act(async () => {
      root = createRoot(container as unknown as HTMLElement);
      root.render(<Harness plan={bedPlan()} playing at={1} />);
    });
    await act(async () => {
      runFrame();
    });
    const bed = made[0];
    assert.ok(bed, "one voice for the one placed file");
    assert.equal(bed.plays, 1, "it started once");

    // What the screen does four times a second while the film runs: same plan, new object.
    for (const at of [1.25, 1.5, 1.75, 2]) {
      await act(async () => {
        root!.render(<Harness plan={bedPlan()} playing at={at} />);
      });
      await act(async () => {
        runFrame();
      });
    }

    assert.equal(bed.pauses, 0, `the bed was paused ${bed.pauses} times while playing straight through`);
    assert.equal(bed.plays, 1, `the bed was restarted ${bed.plays} times for one continuous play`);
  });
});

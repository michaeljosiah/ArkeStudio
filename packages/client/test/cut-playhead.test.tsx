import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  applyTimelineCommands,
  seedStoryPictureTimeline,
  type ClientMessage,
  type ClientState,
} from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen, rulerTicks } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The playhead is something a hand can take hold of.
 *
 * It was a one-pixel line with `pointer-events: none`, so the transport could only be moved from
 * the ruler — a 24-pixel strip above the lanes. The line spans the whole timeline and is the
 * obvious thing to grab; these cases hold it to that.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: false, media: query }) });
Object.assign(dom.HTMLElement.prototype, {
  focus() {},
  setPointerCapture() {},
  releasePointerCapture() {},
});
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

interface MountedCut {
  container: HTMLElement;
  root: Root;
}

function bridge(sent: ClientMessage[]) {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as NonNullable<Window["arke"]>;
}

function seededState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.timeline = {
    status: "ready",
    timeline: applyTimelineCommands(seedStoryPictureTimeline(production), [
      { kind: "add-to-library", items: [{ kind: "shot", shotId: "sh_12" }, { kind: "shot", shotId: "sh_13" }] },
    ]),
  };
  return state;
}

async function mountCut(): Promise<MountedCut> {
  __setBridgeForTest(bridge([]));
  const state = seededState();
  __setStateForTest(state);
  const production = state.world!.productions[0]!;
  const path = `/w/${state.world!.meta.worldId}/p/${production.meta.id}/cut`;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

/** A lane 88px of label plus 800px of film, so a pixel is a known fraction of the cut. */
const GUTTER = 88;
const LANE = 800;
function measure(element: HTMLElement): void {
  Object.assign(element, {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: GUTTER + LANE, height: 200, right: GUTTER + LANE, bottom: 200, x: 0, y: 0 }),
  });
}

function pointer(kind: string, clientX: number): Event {
  const event = new Event(kind, { bubbles: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    button: { value: 0 },
    pointerId: { value: 1 },
  });
  return event;
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("the playhead is draggable", () => {
  it("seeks when the line itself is dragged, not only the ruler above it", async () => {
    const screen = await mountCut();
    try {
      const grab = screen.container.querySelector<HTMLElement>(".fy-playhead__grab");
      assert.ok(grab, "the playhead offers something to take hold of");
      const tracks = screen.container.querySelector<HTMLElement>(".fy-tracks");
      assert.ok(tracks);
      measure(tracks);

      const total = Number(grab.getAttribute("aria-valuemax"));
      assert.ok(total > 0, "the film has a length to seek within");
      assert.equal(grab.getAttribute("aria-valuenow"), "0", "it starts at the top");

      // Press on the line where it stands, then drag a quarter of the lane to the right.
      await act(async () => {
        grab.dispatchEvent(pointer("pointerdown", GUTTER));
      });
      await act(async () => {
        grab.dispatchEvent(pointer("pointermove", GUTTER + LANE / 4));
        grab.dispatchEvent(pointer("pointerup", GUTTER + LANE / 4));
      });

      const at = Number(screen.container.querySelector(".fy-playhead__grab")!.getAttribute("aria-valuenow"));
      assert.equal(at, Math.round(total / 4), `a quarter of the way across is a quarter of the film, not ${at}s`);
    } finally {
      await act(async () => screen.root.unmount());
    }
  });

  it("does not move the transport on a press that only takes hold of it", async () => {
    const screen = await mountCut();
    try {
      const ruler = screen.container.querySelector<HTMLElement>(".fy-timeline__ruler");
      const tracks = screen.container.querySelector<HTMLElement>(".fy-tracks");
      assert.ok(ruler && tracks);
      measure(ruler);
      measure(tracks);

      // Park the playhead mid-film from the ruler, which does jump to where it is pressed.
      await act(async () => {
        ruler.dispatchEvent(pointer("pointerdown", GUTTER + LANE / 2));
        ruler.dispatchEvent(pointer("pointerup", GUTTER + LANE / 2));
      });
      const parked = screen.container.querySelector(".fy-playhead__grab")!.getAttribute("aria-valuenow");
      assert.notEqual(parked, "0", "the ruler seeks where it is pressed");

      // The grab band is wider than the line; a press inside it must not drag the film to its centre.
      const grab = screen.container.querySelector<HTMLElement>(".fy-playhead__grab")!;
      await act(async () => {
        grab.dispatchEvent(pointer("pointerdown", GUTTER + LANE / 2 + 5));
        grab.dispatchEvent(pointer("pointerup", GUTTER + LANE / 2 + 5));
      });
      assert.equal(screen.container.querySelector(".fy-playhead__grab")!.getAttribute("aria-valuenow"), parked);
    } finally {
      await act(async () => screen.root.unmount());
    }
  });
});

describe("the ruler prints times where they are true", () => {
  it("steps at a readable interval and starts at zero", () => {
    assert.deepEqual(rulerTicks(40, 800), [0, 5, 10, 15, 20, 25, 30, 35]);
    // A long film widens the step rather than crowding the labels together.
    assert.deepEqual(rulerTicks(600, 800), [0, 60, 120, 180, 240, 300, 360, 420, 480, 540]);
    // Every label has room: none is closer to its neighbour than the text needs.
    for (const [total, width] of [[7, 400], [40, 800], [600, 800], [7200, 900]] as const) {
      const ticks = rulerTicks(total, width);
      const gap = ticks.length > 1 ? ((ticks[1]! - ticks[0]!) / total) * width : Infinity;
      assert.ok(gap >= 64, `${total}s over ${width}px leaves ${Math.round(gap)}px between labels`);
    }
  });

  it("draws nothing for a film with no length and no lane", () => {
    assert.deepEqual(rulerTicks(0, 800), []);
    assert.deepEqual(rulerTicks(40, 0), []);
    assert.deepEqual(rulerTicks(40, -10), []);
  });
});

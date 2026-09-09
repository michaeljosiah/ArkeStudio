import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  applyTimelineCommands,
  formatFrames,
  seedEmptyPictureTimeline,
  seedStoryPictureTimeline,
  type ClientMessage,
  type ClientState,
} from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A drag as the reference does it (issue 1034), and a trim the viewer follows (issue 1036).
 *
 * The sequence's command is still a reorder and the typed lane's still a frame; what these pin
 * is everything between press and release — the clip travels, the slot is drawn, neighbours make
 * room, Snap reaches the live lanes, Escape drops it all — and that a grip in hand scrubs the
 * viewer and moves the Inspector's rows before anything is written.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, {
  matchMedia: (query: string) => ({ matches: false, media: query }),
  innerWidth: 1400,
  innerHeight: 880,
});
Object.assign(dom.HTMLElement.prototype, {
  focus() {},
  setPointerCapture() {},
  releasePointerCapture() {},
  scrollIntoView() {},
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1000, height: 60, right: 1000, bottom: 60 };
  },
});
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), {
  pause() {},
  play: () => Promise.resolve(),
});
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

const BELLS = "ar_01J8G0000000000000000000R1";

interface MountedCut {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}

async function mountCut(state: ClientState): Promise<MountedCut> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as NonNullable<Window["arke"]>);
  __setStateForTest(state);
  const production = state.world!.productions[0]!;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${production.meta.id}/cut`]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root, sent };
}

async function close(screen: MountedCut): Promise<void> {
  await act(async () => screen.root.unmount());
  screen.container.remove();
}

function commandsSent(screen: MountedCut): Extract<ClientMessage, { kind: "timeline-command" }>[] {
  return screen.sent.filter((message): message is Extract<ClientMessage, { kind: "timeline-command" }> => message.kind === "timeline-command");
}

/** The story's two shots on a saved record at 24fps: sh_12 at 0–96, sh_13 at 96–240. */
function storyState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.timeline = { status: "ready", timeline: seedStoryPictureTimeline(production) };
  return state;
}

/** The bells twice on a Music lane, 48 frames each, with a gap between: a typed lane to drag on. */
function bellsState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  production.timeline = {
    status: "ready",
    timeline: applyTimelineCommands(seedStoryPictureTimeline(production), [
      { kind: "add-track", trackId: "tr_music", trackKind: "music", name: "Music" },
      { kind: "place", trackId: "tr_music", clip: { id: "cl_bells-1", startFrame: 0, durationFrames: 48, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "harbour-bells.wav" } } },
      { kind: "place", trackId: "tr_music", clip: { id: "cl_bells-2", startFrame: 120, durationFrames: 48, sourceInFrames: 0, source: { kind: "artifact", artifactId: BELLS, label: "harbour-bells.wav" } } },
    ]),
  };
  return state;
}

const PLATE = "ar_01J8G0000000000000000000V1";

/** One imported eight-second video on the Picture track, placed a second in: a clip with a strip to trim. */
function plateState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const world = state.world!;
  world.artifacts = [
    ...world.artifacts,
    {
      id: PLATE, kind: "video", file: "plate.mp4", hash: "sha256:6a1e02b9c44d7f33", origin: { by: "user" }, links: [],
      created: "2026-06-11T10:00:00Z", mediaInfo: { durationSec: 8, hasAudio: false },
    } as (typeof world.artifacts)[number],
  ];
  const production = world.productions[0]!;
  production.timeline = {
    status: "ready",
    timeline: applyTimelineCommands(seedEmptyPictureTimeline(production), [
      { kind: "place", trackId: "tr_picture", clip: { id: "cl_plate", startFrame: 0, durationFrames: 96, sourceInFrames: 24, source: { kind: "artifact", artifactId: PLATE, label: "plate.mp4" } } },
    ]),
  };
  return state;
}

function pointer(target: EventTarget, type: string, init: { clientX?: number; button?: number; altKey?: boolean } = {}): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX ?? 0 });
  Object.defineProperty(event, "clientY", { value: 0 });
  Object.defineProperty(event, "button", { value: init.button ?? 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "altKey", { value: init.altKey ?? false });
  target.dispatchEvent(event);
}

/** How many frames the lane spans, read back from a clip whose length is known. */
function spanFrom(clip: HTMLElement, durationFrames: number): number {
  const width = Number.parseFloat(clip.style.width);
  return Math.round((durationFrames * 100) / width);
}

const px = (frames: number, span: number): number => (frames / span) * 1000;

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("a move on the sequence (issue 1034)", () => {
  it("travels with the hand, draws the slot, slides the neighbour, and sends one reorder on release", async () => {
    const screen = await mountCut(storyState());
    try {
      const first = screen.container.querySelector<HTMLElement>("[data-clip='cl_sh-12']")!;
      const second = screen.container.querySelector<HTMLElement>("[data-clip='cl_sh-13']")!;
      const span = spanFrom(first, 96);
      const restingLeft = second.style.left;
      // 150 frames on: sh_12's centre (48) passes sh_13's (168), so the slot opens after sh_13.
      await act(async () => {
        pointer(first, "pointerdown", { clientX: 100 });
        pointer(first, "pointermove", { clientX: 100 + px(150, span) });
      });
      assert.ok(first.classList.contains("fy-pictclip--ghost"), "the clip in hand is the ghost");
      assert.ok(screen.container.querySelector("[data-testid='drop-slot']"), "the slot the reorder will use is drawn");
      assert.ok(second.classList.contains("fy-pictclip--shifted"), "the neighbour makes room");
      assert.notEqual(second.style.left, restingLeft, "by sliding, not swapping");
      assert.ok(screen.container.querySelector("[data-testid='drag-chip']")?.textContent?.includes(formatFrames(144, 24)), "the chip states where the slot begins: sh_13's tail, less sh_12's length");
      assert.equal(commandsSent(screen).length, 0, "the record is untouched until release");
      await act(async () => pointer(first, "pointerup", { clientX: 100 + px(150, span) }));
      assert.deepEqual(commandsSent(screen).map((message) => message.commands), [[{ kind: "move-to-order", clipId: "cl_sh-12", index: 1 }]]);
      assert.equal(first.classList.contains("fy-pictclip--ghost"), false);
      assert.equal(screen.container.querySelector("[data-testid='drop-slot']"), null);
    } finally {
      await close(screen);
    }
  });

  it("goes home on Escape and writes nothing", async () => {
    const screen = await mountCut(storyState());
    try {
      const first = screen.container.querySelector<HTMLElement>("[data-clip='cl_sh-12']")!;
      const span = spanFrom(first, 96);
      await act(async () => {
        pointer(first, "pointerdown", { clientX: 100 });
        pointer(first, "pointermove", { clientX: 100 + px(150, span) });
      });
      assert.ok(first.classList.contains("fy-pictclip--ghost"));
      await act(async () => {
        const escape = new Event("keydown", { bubbles: true, cancelable: true });
        Object.defineProperty(escape, "key", { value: "Escape" });
        window.dispatchEvent(escape);
      });
      assert.equal(first.classList.contains("fy-pictclip--ghost"), false, "the ghost is gone");
      await act(async () => pointer(first, "pointerup", { clientX: 100 + px(150, span) }));
      assert.equal(commandsSent(screen).length, 0, "a dropped gesture is not an edit");
    } finally {
      await close(screen);
    }
  });
});

describe("a move on a typed lane, with Snap (issue 1034)", () => {
  it("draws the landing rectangle, snaps the head onto a neighbour's edge, and sends the snapped frame", async () => {
    const screen = await mountCut(bellsState());
    try {
      const second = screen.container.querySelector<HTMLElement>("[data-clip='cl_bells-2']")!;
      const span = spanFrom(second, 48);
      // Two frames short of the first clip's tail (48): inside the snap band, so the head is pulled onto it.
      const target = 50;
      await act(async () => {
        pointer(second, "pointerdown", { clientX: 600 });
        pointer(second, "pointermove", { clientX: 600 - px(120 - target, span) });
      });
      assert.ok(screen.container.querySelector("[data-track-id='tr_music'] [data-testid='landing']"), "the landing rectangle is drawn");
      assert.ok(screen.container.querySelector("[data-testid='snap-line']"), "the snap line marks the edge it snapped to");
      assert.ok(second.classList.contains("fy-typedclip--ghost"));
      await act(async () => pointer(second, "pointerup", { clientX: 600 - px(120 - target, span) }));
      assert.deepEqual(commandsSent(screen).map((message) => message.commands), [[{ kind: "move-to-frame", clipId: "cl_bells-2", startFrame: 48 }]]);
    } finally {
      await close(screen);
    }
  });

  it("does not snap with the toggle off, or with Alt held", async () => {
    const screen = await mountCut(bellsState());
    try {
      const second = screen.container.querySelector<HTMLElement>("[data-clip='cl_bells-2']")!;
      const span = spanFrom(second, 48);
      await act(async () => screen.container.querySelector<HTMLButtonElement>("button[aria-label='Snap']")!.click());
      await act(async () => {
        pointer(second, "pointerdown", { clientX: 600 });
        pointer(second, "pointermove", { clientX: 600 - px(70, span) });
      });
      assert.equal(screen.container.querySelector("[data-testid='snap-line']"), null, "nothing snaps while Snap is off");
      await act(async () => pointer(second, "pointerup", { clientX: 600 - px(70, span) }));
      assert.deepEqual(commandsSent(screen).map((message) => message.commands), [[{ kind: "move-to-frame", clipId: "cl_bells-2", startFrame: 50 }]]);
    } finally {
      await close(screen);
    }
  });
});

describe("a trim the viewer follows (issue 1036)", () => {
  it("scrubs the viewer to the edge in hand, moves the Inspector's rows live, and parks the playhead on release", async () => {
    const screen = await mountCut(storyState());
    try {
      const first = screen.container.querySelector<HTMLElement>("[data-clip='cl_sh-12']")!;
      const span = spanFrom(first, 96);
      await act(async () => first.click());
      const inspector = screen.container.querySelector<HTMLElement>("#cut-inspector-panel")!;
      const out = () => inspector.querySelector<HTMLInputElement>("input[aria-label='Out timecode']")!.value;
      const ruler = screen.container.querySelector<HTMLElement>("[role='slider'][aria-label='Seek']")!;
      assert.equal(out(), formatFrames(96, 24));
      const grip = first.querySelector<HTMLElement>(".fy-pictclip__grip--end")!;
      await act(async () => {
        pointer(grip, "pointerdown", { clientX: 400 });
        pointer(grip, "pointermove", { clientX: 400 - px(24, span) });
      });
      assert.equal(out(), formatFrames(72, 24), "the Inspector reads the draft under the grip");
      assert.equal(ruler.getAttribute("aria-valuetext"), formatFrames(71, 24), "the viewer shows the new last frame");
      assert.match(screen.container.querySelector("[data-testid='drag-chip']")?.textContent ?? "", /00:00:03:00/);
      assert.equal(commandsSent(screen).length, 0);
      await act(async () => pointer(grip, "pointerup", { clientX: 400 - px(24, span) }));
      assert.deepEqual(commandsSent(screen).map((message) => message.commands), [[{ kind: "trim", clipId: "cl_sh-12", edge: "end", deltaFrames: -24 }]]);
      assert.equal(ruler.getAttribute("aria-valuetext"), formatFrames(71, 24), "parked on the edge the cut now has");
    } finally {
      await close(screen);
    }
  });

  it("moves the strip's in-point with the head while the trim is still in hand", async () => {
    // The strip reads its in-point from the resolved cut. Resolved from the saved record alone,
    // a head trim in progress kept showing the frames before the new head until the command
    // came back; the draft is resolved too, so the strip and the edge agree under the hand.
    const screen = await mountCut(plateState());
    try {
      const clip = screen.container.querySelector<HTMLElement>("[data-clip='cl_plate']")!;
      assert.equal(clip.getAttribute("data-in-sec"), "1", "placed a second into its source");
      const span = spanFrom(clip, 96);
      await act(async () => clip.click());
      const grip = clip.querySelector<HTMLElement>(".fy-pictclip__grip--start")!;
      await act(async () => {
        pointer(grip, "pointerdown", { clientX: 0 });
        pointer(grip, "pointermove", { clientX: px(24, span) });
      });
      assert.equal(screen.container.querySelector<HTMLElement>("[data-clip='cl_plate']")!.getAttribute("data-in-sec"), "2", "the strip starts where the draft's head now is");
      assert.equal(commandsSent(screen).length, 0);
      await act(async () => pointer(grip, "pointerup", { clientX: px(24, span) }));
      assert.deepEqual(commandsSent(screen).map((message) => message.commands), [[{ kind: "trim", clipId: "cl_plate", edge: "start", deltaFrames: 24 }]]);
    } finally {
      await close(screen);
    }
  });

  it("follows a stepped edge from the Inspector the same way", async () => {
    const screen = await mountCut(storyState());
    try {
      await act(async () => screen.container.querySelector<HTMLElement>("[data-clip='cl_sh-13']")!.click());
      const ruler = screen.container.querySelector<HTMLElement>("[role='slider'][aria-label='Seek']")!;
      await act(async () => screen.container.querySelector<HTMLButtonElement>("button[aria-label='In one frame later']")!.click());
      assert.deepEqual(commandsSent(screen).map((message) => message.commands), [[{ kind: "trim", clipId: "cl_sh-13", edge: "start", deltaFrames: 1 }]]);
      assert.equal(ruler.getAttribute("aria-valuetext"), formatFrames(97, 24), "the viewer goes to the new first frame");
    } finally {
      await close(screen);
    }
  });

  it("gives every clip two grips with a visible handle inside, on both kinds of lane", async () => {
    const screen = await mountCut(bellsState());
    try {
      for (const selector of ["[data-clip='cl_sh-12']", "[data-clip='cl_bells-2']"]) {
        const clip = screen.container.querySelector<HTMLElement>(selector)!;
        assert.ok(clip.querySelector(".fy-pictclip__grip--start > i"), `${selector} has a head handle`);
        assert.ok(clip.querySelector(".fy-pictclip__grip--end > i"), `${selector} has a tail handle`);
      }
    } finally {
      await close(screen);
    }
  });
});

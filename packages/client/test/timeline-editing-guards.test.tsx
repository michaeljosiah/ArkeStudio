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
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Review round one on #679: a gesture the browser cancels writes nothing, a press inside the
 * clip menu is the menu being used, and one command is in flight at a time so two quick presses
 * cannot both name the same revision and lose the second.
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

interface MountedCut {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
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

async function mountCut(state: ClientState): Promise<MountedCut> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(bridge(sent));
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
  return { container, root, sent };
}

async function close(screen: MountedCut): Promise<void> {
  await act(async () => screen.root.unmount());
  screen.container.remove();
}

function button(screen: MountedCut, label: string): HTMLButtonElement {
  const found = [...screen.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(found, `${label} is rendered`);
  return found;
}

function commandsSent(screen: MountedCut): Extract<ClientMessage, { kind: "timeline-command" }>[] {
  return screen.sent.filter((message): message is Extract<ClientMessage, { kind: "timeline-command" }> => message.kind === "timeline-command");
}

function savedState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  const seeded = seedStoryPictureTimeline(production);
  production.timeline = { status: "ready", timeline: applyTimelineCommands(seeded, [{ kind: "move-adjacent", clipId: "cl_sh-13", direction: "earlier" }]) };
  return state;
}

function pointer(target: EventTarget, type: string, init: { clientX?: number; clientY?: number; button?: number; pointerId?: number } = {}): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX ?? 0 });
  Object.defineProperty(event, "clientY", { value: init.clientY ?? 0 });
  Object.defineProperty(event, "button", { value: init.button ?? 0 });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  target.dispatchEvent(event);
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("editor command guards (#679 review)", () => {
  it("writes nothing when the browser cancels a drag, and one command when it completes", async () => {
    const screen = await mountCut(savedState());
    try {
      const clip = screen.container.querySelector<HTMLElement>("[data-clip='cl_sh-12']");
      assert.ok(clip);
      await act(async () => {
        pointer(clip, "pointerdown", { clientX: 700 });
        pointer(clip, "pointermove", { clientX: 200 });
        pointer(clip, "pointercancel", { clientX: 200 });
      });
      assert.deepEqual(commandsSent(screen), [], "a cancelled gesture is not an edit");

      await act(async () => {
        pointer(clip, "pointerdown", { clientX: 700 });
        pointer(clip, "pointermove", { clientX: 200 });
        pointer(clip, "pointerup", { clientX: 200 });
      });
      const [sent] = commandsSent(screen);
      assert.ok(sent, "a completed drag sends one command");
      assert.deepEqual(sent.commands, [{ kind: "move-to-order", clipId: "cl_sh-12", index: 0 }]);
      assert.equal(commandsSent(screen).length, 1);
    } finally {
      await close(screen);
    }
  });

  it("holds further commands until the revision moves, and releases on a refusal", async () => {
    const state = savedState();
    const screen = await mountCut(state);
    try {
      await act(async () => button(screen, "Delete").click());
      assert.equal(commandsSent(screen).length, 1);
      assert.equal(button(screen, "Delete").disabled, true, "the same revision cannot be named twice");
      assert.equal(button(screen, "Undo").disabled, true);
      await act(async () => button(screen, "Duplicate").click());
      assert.equal(commandsSent(screen).length, 1, "a press while one is in flight sends nothing");

      // The snapshot's revision advances: the gate lifts.
      const production = state.world!.productions[0]!;
      const saved = production.timeline;
      assert.ok(saved && saved.status === "ready");
      const advanced = structuredClone(state) as ClientState;
      advanced.world!.productions[0]!.timeline = {
        status: "ready",
        timeline: applyTimelineCommands(saved.timeline, [{ kind: "delete", clipId: "cl_sh-13" }]),
      };
      await act(async () => __setStateForTest(advanced));
      assert.equal(button(screen, "Delete").disabled, false);
      await act(async () => button(screen, "Delete").click());
      assert.equal(commandsSent(screen).length, 2);
      assert.equal(commandsSent(screen)[1]!.baseRevision, 2);

      // A refusal releases the gate too, so a person can try again at once.
      await act(async () =>
        __applyEventForTest({
          at: "2026-09-01T12:00:00Z",
          type: "timeline.command-refused",
          worldId: state.world!.meta.worldId,
          productionId: production.meta.id,
          reason: "the timeline moved",
        }),
      );
      assert.equal(button(screen, "Delete").disabled, false);
    } finally {
      await close(screen);
    }
  });
});

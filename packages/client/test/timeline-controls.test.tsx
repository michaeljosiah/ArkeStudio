import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  movePictureClip,
  seedStoryPictureTimeline,
  storyTimelineFingerprint,
  type ClientMessage,
  type ClientState,
} from "@arke-studio/contracts";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let focusedElement: HTMLElement | null = null;
let viewportWidth = 800;
Object.assign(dom.window, {
  matchMedia: (query: string) => ({
    matches: viewportWidth <= Number.parseInt(query.match(/max-width:\s*(\d+)px/)?.[1] ?? "0", 10),
    media: query,
  }),
});
Object.assign(dom.HTMLElement.prototype, {
  focus(this: HTMLElement) {
    focusedElement = this;
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

afterEach(() => {
  __setBridgeForTest(null);
  focusedElement = null;
  viewportWidth = 800;
  document.body.replaceChildren();
});

describe("durable Picture controls (#678)", () => {
  it("clears selection from empty timeline space", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const screen = await mountCut(state);
    try {
      assert.equal(screen.container.querySelector(".fy-cutinspect__eyebrow")?.textContent, "PICTURE CLIP");
      const canvas = screen.container.querySelector<HTMLElement>(".fy-timeline__canvas");
      assert.ok(canvas);
      await act(async () => canvas.click());
      assert.equal(screen.container.querySelector(".fy-cutinspect__eyebrow")?.textContent, "CUT");
    } finally {
      await close(screen);
    }
  });

  it("moves focus into responsive drawers and returns it on Escape", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const screen = await mountCut(state);
    try {
      const toggle = screen.container.querySelector<HTMLButtonElement>(".fy-editorpane-toggle--library");
      const panel = screen.container.querySelector<HTMLElement>("#cut-library");
      assert.ok(toggle && panel);
      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });
      assert.equal(panel.contains(focusedElement), true);

      const escape = new Event("keydown");
      Object.defineProperty(escape, "key", { value: "Escape" });
      await act(async () => {
        window.dispatchEvent(escape);
        await Promise.resolve();
      });
      assert.equal(panel.getAttribute("data-open"), "false");
      assert.equal(focusedElement, toggle);

      viewportWidth = 1000;
      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });
      const take = panel.querySelector<HTMLButtonElement>(".fy-artrow--take");
      const details = screen.container.querySelector<HTMLElement>("#cut-right-pane");
      assert.ok(take && details);
      await act(async () => {
        take.click();
        await Promise.resolve();
      });
      assert.equal(panel.getAttribute("data-open"), "false");
      assert.equal(details.getAttribute("data-open"), "true");
      assert.equal(details.contains(focusedElement), true);
    } finally {
      await close(screen);
    }
  });

  it("blocks timeline editing when the saved timeline is invalid", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    state.world!.productions[0]!.timeline = { status: "invalid", message: "history cannot be replayed" };
    const screen = await mountCut(state);
    try {
      assert.match(screen.container.querySelector(".fy-cuttimeline-error")?.textContent ?? "", /history cannot be replayed/);
      assert.equal(screen.container.querySelector(".fy-clanes"), null);
      assert.equal(button(screen, "Export film").disabled, true);
    } finally {
      await close(screen);
    }
  });

  it("disables history controls when a ready timeline cannot be resolved", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    const seeded = seedStoryPictureTimeline(production);
    production.timeline = {
      status: "ready",
      timeline: movePictureClip(seeded, seeded.tracks[0]!.clips[1]!.id, "earlier"),
    };
    production.meta.frameRate = 25;
    const screen = await mountCut(state);
    try {
      assert.match(screen.container.querySelector(".fy-cuttimeline-error")?.textContent ?? "", /fixed at 24 fps/);
      assert.equal(button(screen, "Undo").disabled, true);
      assert.equal(button(screen, "Move earlier").disabled, true);
    } finally {
      await close(screen);
    }
  });

  it("opens the real Arke pane from the assembly notice", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const screen = await mountCut(state);
    try {
      assert.match(screen.container.querySelector(".fy-cutnotice")?.textContent ?? "", /Arke assembled 1 of 2 shots/);
      await act(async () => button(screen, "what it did").click());
      const arke = [...screen.container.querySelectorAll<HTMLButtonElement>("[role='tab']")].find(
        (candidate) => candidate.textContent?.trim() === "Arke",
      );
      assert.ok(arke, "the real Arke tab remains the destination");
      assert.equal(arke.getAttribute("aria-selected"), "true");
      assert.ok(screen.container.querySelector("[role='tabpanel'][aria-labelledby='cut-arke-tab']"));
    } finally {
      await close(screen);
    }
  });

  it("states a stale-command refusal beside the controls and clears it on retry", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    const screen = await mountCut(state);
    try {
      await act(async () =>
        __applyEventForTest({
          at: "2026-09-01T12:00:00Z",
          type: "timeline.command-refused",
          worldId: state.world!.meta.worldId,
          productionId: production.meta.id,
          reason: "the timeline moved to revision 2",
        }),
      );
      assert.match(screen.container.querySelector("[role='alert']")?.textContent ?? "", /moved to revision 2/);
      await act(async () => button(screen, "Move later").click());
      assert.equal(screen.container.querySelector(".fy-timeline__refusal"), null);
    } finally {
      await close(screen);
    }
  });

  it("materialises a selected gap move with the source fingerprint", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    const screen = await mountCut(state);
    try {
      const gap = [...screen.container.querySelectorAll<HTMLButtonElement>(".fy-cutseg--gap")].find((node) =>
        node.textContent?.includes("shot 13"),
      );
      assert.ok(gap, "the unresolved shot remains a selectable Picture clip");
      await act(async () => gap.click());
      assert.equal(button(screen, "Move earlier").disabled, false);
      await act(async () => button(screen, "Move earlier").click());

      const sent = screen.sent.find((message) => message.kind === "timeline-move-picture");
      assert.ok(sent && sent.kind === "timeline-move-picture");
      assert.equal(sent.clipId, "cl_sh-13");
      assert.equal(sent.direction, "earlier");
      assert.equal(sent.baseRevision, null);
      assert.equal(sent.sourceFingerprint, storyTimelineFingerprint(production));
    } finally {
      await close(screen);
    }
  });

  it("sends Undo against the exact saved revision", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    const seeded = seedStoryPictureTimeline(production);
    production.timeline = {
      status: "ready",
      timeline: movePictureClip(seeded, seeded.tracks[0]!.clips[1]!.id, "earlier"),
    };
    const screen = await mountCut(state);
    try {
      assert.equal(button(screen, "Undo").disabled, false);
      assert.equal(button(screen, "Redo").disabled, true);
      await act(async () => button(screen, "Undo").click());
      const sent = screen.sent.find((message) => message.kind === "timeline-history");
      assert.deepEqual(sent, {
        kind: "timeline-history",
        worldId: state.world!.meta.worldId,
        productionId: production.meta.id,
        action: "undo",
        baseRevision: 1,
      });
    } finally {
      await close(screen);
    }
  });
});

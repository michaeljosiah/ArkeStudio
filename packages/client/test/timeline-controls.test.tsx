import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  applyTimelineCommands,
  assembleSceneCommands,
  movePictureClip,
  seedEmptyPictureTimeline,
  seedStoryPictureTimeline,
  storyTimelineFingerprint,
  type ClientMessage,
  type ClientState,
} from "@arke-studio/contracts";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const focusedElements = new WeakSet<HTMLElement>();
let viewportWidth = 800;
Object.assign(dom.window, {
  matchMedia: (query: string) => ({
    matches: viewportWidth <= Number.parseInt(query.match(/max-width:\s*(\d+)px/)?.[1] ?? "0", 10),
    media: query,
  }),
});
Object.assign(dom.HTMLElement.prototype, {
  focus(this: HTMLElement) {
    focusedElements.add(this);
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
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  assert.ok(found, `${label} is rendered`);
  return found;
}

/**
 * The story's shots on a saved timeline and in the Library. The editor opens empty (SPEC-039
 * §1.9), so a control that needs a clip to act on is exercised against the state a person
 * reaches once something has been placed, not against the first render.
 */
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

afterEach(() => {
  __setBridgeForTest(null);
  viewportWidth = 800;
  document.body.replaceChildren();
});

describe("durable Picture controls (#678)", () => {
  it("clears selection from empty timeline space", async () => {
    const state = seededState();
    const screen = await mountCut(state);
    try {
      // Nothing opens selected (R-25a): the Inspector shows the cut until a clip is clicked.
      assert.equal(screen.container.querySelector(".fy-cutinspect__eyebrow")?.textContent, "CUT");
      const clip = screen.container.querySelector<HTMLButtonElement>("[data-clip='cl_sh-12']");
      assert.ok(clip);
      await act(async () => clip.click());
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
    const state = seededState();
    const screen = await mountCut(state);
    try {
      const toggle = screen.container.querySelector<HTMLButtonElement>(".fy-editorpane-toggle--library");
      const panel = screen.container.querySelector<HTMLElement>("#cut-library");
      assert.ok(toggle && panel);
      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });
      assert.equal(
        [...panel.querySelectorAll<HTMLElement>("*")].some((element) => focusedElements.has(element)),
        true,
      );

      const escape = new Event("keydown");
      Object.defineProperty(escape, "key", { value: "Escape" });
      await act(async () => {
        window.dispatchEvent(escape);
        await Promise.resolve();
      });
      assert.equal(panel.getAttribute("data-open"), "false");
      assert.equal(focusedElements.has(toggle), true);

      viewportWidth = 1000;
      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });
      // Picking a Library row shows its actions; Locate is what selects on the timeline and
      // opens the details (SPEC-039 R-11, R-16).
      const take = panel.querySelector<HTMLButtonElement>('[data-library-item="shot:sh_12"] .fy-artrow__pick');
      const details = screen.container.querySelector<HTMLElement>("#cut-right-pane");
      assert.ok(take && details);
      await act(async () => {
        take.click();
        await Promise.resolve();
      });
      const locate = [...panel.querySelectorAll<HTMLButtonElement>(".fy-artrow__actions button")].find((button) => button.textContent?.includes("Locate in timeline"));
      assert.ok(locate, "a shot in the cut offers Locate");
      await act(async () => {
        locate.click();
        await Promise.resolve();
      });
      assert.equal(panel.getAttribute("data-open"), "false");
      assert.equal(details.getAttribute("data-open"), "true");
      assert.equal(
        [...details.querySelectorAll<HTMLElement>("*")].some((element) => focusedElements.has(element)),
        true,
      );
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

  it("says what Arke assembled above the preview, and keeps the Arke pane on its own tab", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    // The record as the coordinator leaves it after one assembly: one Undo entry, labelled by
    // Arke, carrying the notes the banner reads (R-46). The bells link to the world, not the
    // scene, so nothing is laid under it; both shots have lines, so subtitles are conformed.
    const assembly = assembleSceneCommands({
      production,
      timeline: seedEmptyPictureTimeline(production),
      sceneId: "sc_04",
      artifacts: state.world!.artifacts,
    });
    assert.ok(!("refused" in assembly));
    production.timeline = {
      status: "ready",
      timeline: applyTimelineCommands(seedEmptyPictureTimeline(production), assembly.commands, {
        label: "Arke assembled The verse rises",
        notes: assembly.notes,
      }),
    };
    const screen = await mountCut(state);
    try {
      const notice = () => screen.container.querySelector<HTMLElement>("[data-testid='assembly-notice']");
      assert.match(notice()?.textContent ?? "", /Arke assembled The verse rises: 1 of 2 shots and conformed the subtitles\./);
      assert.ok(screen.container.querySelector("#assembly-did") === null, "the notes wait behind what it did");
      await act(async () => button(screen, "what it did").click());
      assert.deepEqual(
        [...screen.container.querySelectorAll("#assembly-did li")].map((item) => item.textContent),
        assembly.notes,
      );
      // The banner is a summary, not a door: the Arke pane is still reached through its own tab.
      const arke = [...screen.container.querySelectorAll<HTMLButtonElement>("[role='tab']")].find(
        (candidate) => candidate.textContent?.trim() === "Arke",
      );
      assert.ok(arke, "the real Arke tab remains");
      assert.equal(arke.getAttribute("aria-selected"), "false");
      await act(async () => arke.click());
      assert.equal(arke.getAttribute("aria-selected"), "true");
      assert.ok(screen.container.querySelector("[role='tabpanel'][aria-labelledby='cut-arke-tab']"));
      await act(async () => button(screen, "Hide").click());
      assert.ok(notice() === null, "hidden is hidden");
    } finally {
      await close(screen);
    }
  });

  it("states a stale-command refusal beside the controls and clears it on retry", async () => {
    const state = seededState();
    const production = state.world!.productions[0]!;
    const screen = await mountCut(state);
    try {
      // The retry needs a clip to move, and nothing opens selected (R-25a).
      const clip = screen.container.querySelector<HTMLButtonElement>("[data-clip='cl_sh-12']");
      assert.ok(clip);
      await act(async () => clip.click());
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
      assert.equal(button(screen, "Move later").disabled, false);
      await act(async () => button(screen, "Move later").click());
      // A DOM node never goes through assert.equal: node's diff walks the whole document.
      assert.ok(screen.container.querySelector(".fy-timeline__refusal") === null, "the retry clears the refusal");
    } finally {
      await close(screen);
    }
  });

  it("materialises the record with the first write, fenced by the source fingerprint", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions[0]!;
    const screen = await mountCut(state);
    try {
      /*
       * The editor opens empty (SPEC-039 §1.9), so there is no seeded gap to move: the first
       * write a person can make is adding to the Library, from the banner that says so. It is
       * the write that materialises the record, so it names no revision and is fenced by the
       * story's fingerprint instead (SPEC-037 R-24).
       */
      const empty = screen.container.querySelector<HTMLElement>("[data-testid='empty-notice']");
      assert.ok(empty, "the empty start is stated above the preview");
      assert.match(empty.textContent ?? "", /This cut starts empty\./);
      assert.equal(button(screen, "Move earlier").disabled, true, "nothing is selected, so nothing moves");
      await act(async () => empty.querySelector<HTMLButtonElement>("button")!.click());
      await act(async () => button(screen, "Every shot of scene 4").click());
      await act(async () => screen.container.querySelector<HTMLButtonElement>(".fy-libpick__confirm")!.click());

      const sent = screen.sent.find((message) => message.kind === "timeline-command");
      assert.ok(sent && sent.kind === "timeline-command");
      assert.deepEqual(sent.commands, [
        { kind: "add-to-library", items: [{ kind: "shot", shotId: "sh_12" }, { kind: "shot", shotId: "sh_13" }] },
      ]);
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

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  applyTimelineCommands,
  seedStoryPictureTimeline,
  storyTimelineFingerprint,
  type ClientMessage,
  type ClientState,
} from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/production.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Semantic Picture editing on the saved timeline (SPEC-037 R-19..R-25, SPEC-039 R-14..R-19,
 * issue #679): every control and shortcut sends exactly one batch, the take picker goes through
 * the same door, and nothing here keeps a timeline of its own.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, {
  matchMedia: (query: string) => ({ matches: false, media: query }),
});
Object.assign(dom.HTMLElement.prototype, { focus() {} });
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
  KeyboardEvent: dom.window.KeyboardEvent ?? dom.Event,
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

/** The fixture with its Picture timeline saved once, so revision fencing is exercised. */
function savedState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  const seeded = seedStoryPictureTimeline(production);
  production.timeline = { status: "ready", timeline: applyTimelineCommands(seeded, [{ kind: "move-adjacent", clipId: "cl_sh-13", direction: "earlier" }]) };
  return state;
}

/**
 * The round trip a real command makes: the coordinator writes, the snapshot's revision moves,
 * and the editor's one-in-flight gate lifts. Tests that send twice advance it between sends.
 */
async function advance(state: ClientState): Promise<void> {
  const timeline = state.world!.productions[0]!.timeline;
  if (timeline?.status === "ready") timeline.timeline.revision += 1;
  await act(async () => __setStateForTest(structuredClone(state) as ClientState));
}

function keydown(target: EventTarget, key: string, init: { ctrlKey?: boolean; shiftKey?: boolean } = {}): void {
  const event = new Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  Object.defineProperty(event, "ctrlKey", { value: init.ctrlKey ?? false });
  Object.defineProperty(event, "metaKey", { value: false });
  Object.defineProperty(event, "altKey", { value: false });
  Object.defineProperty(event, "shiftKey", { value: init.shiftKey ?? false });
  target.dispatchEvent(event);
}

afterEach(() => {
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("semantic Picture editing (#679)", () => {
  it("draws the saved order by frame, names drift, and sends delete as one fenced batch", async () => {
    const state = savedState();
    const screen = await mountCut(state);
    try {
      const clips = [...screen.container.querySelectorAll<HTMLButtonElement>("[data-clip]")];
      assert.deepEqual(clips.map((clip) => clip.dataset["clip"]), ["cl_sh-13", "cl_sh-12"]);
      assert.match(screen.container.querySelector(".fy-driftchip")?.textContent ?? "", /order differs from the story/);
      assert.equal(clips[0]!.getAttribute("aria-pressed"), "true", "the first clip opens selected");
      assert.match(clips[0]!.getAttribute("aria-label") ?? "", /00:00:00:00 to 00:00:06:00/);

      await act(async () => button(screen, "Delete").click());
      const [sent] = commandsSent(screen);
      assert.ok(sent);
      assert.deepEqual(sent.commands, [{ kind: "delete", clipId: "cl_sh-13" }]);
      assert.equal(sent.baseRevision, 1);
      assert.equal(sent.sourceFingerprint, storyTimelineFingerprint(state.world!.productions[0]!));
      assert.equal(sent.label, "Delete clip");
    } finally {
      await close(screen);
    }
  });

  it("offers split only with the playhead inside the clip, and mints one new id per split", async () => {
    const state = savedState();
    const screen = await mountCut(state);
    try {
      assert.equal(button(screen, "Split").disabled, true, "the playhead sits on the first frame");
      const scrubber = screen.container.querySelector<HTMLElement>("[role='slider'][aria-label='Seek']");
      assert.ok(scrubber);
      // Two presses, two renders: a seek reads the time it was rendered with.
      await act(async () => keydown(scrubber, "ArrowRight"));
      await act(async () => keydown(scrubber, "ArrowRight"));
      assert.equal(button(screen, "Split").disabled, false);
      await act(async () => button(screen, "Split").click());
      const [sent] = commandsSent(screen);
      assert.ok(sent && sent.commands[0]?.kind === "split");
      assert.equal(sent.commands.length, 1);
      assert.equal(sent.commands[0].clipId, "cl_sh-13");
      assert.equal(sent.commands[0].atFrame, 48, "two seconds at 24 fps");
      assert.match(sent.commands[0].newClipId, /^cl_[0-9A-HJKMNP-TV-Z]{26}$/);

      await advance(state);
      await act(async () => button(screen, "Duplicate").click());
      const duplicate = commandsSent(screen)[1]!;
      assert.equal(duplicate.commands[0]?.kind, "duplicate");
      assert.notEqual(
        duplicate.commands[0]?.kind === "duplicate" ? duplicate.commands[0].newClipId : "",
        sent.commands[0].newClipId,
        "every new clip gets its own id",
      );
    } finally {
      await close(screen);
    }
  });

  it("routes keyboard shortcuts and the clip menu to the same single commands", async () => {
    const state = savedState();
    const screen = await mountCut(state);
    try {
      const clip = () => {
        const found = screen.container.querySelector<HTMLButtonElement>("[data-clip='cl_sh-12']");
        assert.ok(found);
        return found;
      };
      await act(async () => clip().click());
      await act(async () => keydown(clip(), "Delete", { shiftKey: true }));
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "ripple-delete", clipId: "cl_sh-12" }]);
      await advance(state);
      await act(async () => clip().click());
      await act(async () => keydown(clip(), "["));
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "move-adjacent", clipId: "cl_sh-12", direction: "earlier" }]);

      await advance(state);
      await act(async () => keydown(window, "z", { ctrlKey: true }));
      const history = () => screen.sent.filter((message) => message.kind === "timeline-history");
      assert.deepEqual(history().at(-1), {
        kind: "timeline-history",
        worldId: FIXTURE_STATE.world!.meta.worldId,
        productionId: "saltlight",
        action: "undo",
        baseRevision: 3,
      });
      await advance(state);
      assert.equal(button(screen, "Redo").disabled, true);
      await act(async () => keydown(window, "y", { ctrlKey: true }));
      assert.equal(history().length, 1, "Redo with nothing to redo sends nothing");

      await act(async () => clip().click());
      await act(async () => keydown(window, "Delete"));
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "delete", clipId: "cl_sh-12" }], "Delete outside a text field removes the selection");
    } finally {
      await close(screen);
    }
  });

  it("switches a take from the Inspector through the same command door and shows frame timing", async () => {
    const state = savedState();
    const production = state.world!.productions[0]!;
    production.selections = {};
    const screen = await mountCut(state);
    try {
      const shot12 = screen.container.querySelector<HTMLButtonElement>("[data-clip='cl_sh-12']");
      assert.ok(shot12);
      await act(async () => shot12.click());
      assert.match(screen.container.querySelector(".fy-takepick")?.textContent ?? "", /TAKES · 1/);
      assert.ok(screen.container.textContent?.includes("00:00:06:00"), "In point in HH:MM:SS:FF");
      await act(async () => button(screen, "Use").click());
      const sent = commandsSent(screen).at(-1)!;
      assert.deepEqual(sent.commands, [{ kind: "switch-take", shotId: "sh_12", takeId: "tk_01J8F0000000000000000000B2" }]);
      assert.equal(sent.label, "Switch take");

      await advance(state);
      const laterFrame = [...screen.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.getAttribute("aria-label") === "In one frame later",
      );
      assert.ok(laterFrame);
      await act(async () => laterFrame.click());
      assert.deepEqual(commandsSent(screen).at(-1)?.commands, [{ kind: "trim", clipId: "cl_sh-12", edge: "start", deltaFrames: 1 }]);
    } finally {
      await close(screen);
    }
  });

  it("keeps the first edit on the unsaved assembly fenced by the source fingerprint", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const screen = await mountCut(state);
    try {
      assert.equal(screen.container.querySelector(".fy-driftchip"), null, "nothing drifts before the first save");
      await act(async () => button(screen, "Delete").click());
      const [sent] = commandsSent(screen);
      assert.ok(sent);
      assert.equal(sent.baseRevision, null);
      assert.equal(sent.sourceFingerprint, storyTimelineFingerprint(state.world!.productions[0]!));
      assert.deepEqual(sent.commands, [{ kind: "delete", clipId: "cl_sh-12" }]);
    } finally {
      await close(screen);
    }
  });
});

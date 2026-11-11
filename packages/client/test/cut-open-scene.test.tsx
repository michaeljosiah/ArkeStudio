import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { applyTimelineCommands, mediaPlacementCommands, seedStoryPictureTimeline, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { CutScreen } from "../src/screens/cut.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * A clip's menu leads to the scene its shot belongs to (issue 2957): the fix for a wrong clip is
 * usually there, and the only other way was back to the production and finding the scene by hand.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { innerWidth: 1024, innerHeight: 768, matchMedia: (media: string) => ({ matches: false, media }) });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  HTMLMediaElement: dom.HTMLMediaElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });

/** Stands where the scene's page is, saying which scene was asked for. */
function SceneStandIn() {
  return <p data-scene-page={useParams().sceneId} />;
}

/** The story's two shots on a saved timeline, and a file of the world's after them. */
function seededState(): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const production = state.world!.productions[0]!;
  const video = { ...state.world!.artifacts[0]!, kind: "video" as const, file: "holiday.mp4", mediaInfo: { durationSec: 5, hasAudio: true } };
  state.world!.artifacts = [video];
  const seeded = seedStoryPictureTimeline(production);
  production.timeline = { status: "ready", timeline: applyTimelineCommands(seeded, mediaPlacementCommands(seeded, [video], "append", () => "cl_holiday")) };
  return state;
}

let root: Root | null = null;
async function mount(state: ClientState) {
  const sent: ClientMessage[] = [];
  const bridge = { appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json)); } };
  Object.assign(window, { arke: bridge });
  __setBridgeForTest(bridge);
  __setStateForTest(state);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter initialEntries={[`/w/${state.world!.meta.worldId}/p/${state.world!.productions[0]!.meta.id}/cut`]}>
    <Routes>
      <Route path="/w/:worldId/p/:prodId/cut" element={<CutScreen />} />
      <Route path="/w/:worldId/p/:prodId/scenes/:sceneId" element={<SceneStandIn />} />
    </Routes>
  </MemoryRouter>));
  const clipOf = (shotId: string) => {
    const timeline = state.world!.productions[0]!.timeline;
    assert.ok(timeline?.status === "ready");
    const clip = timeline.timeline.tracks.flatMap((track) => track.clips).find((candidate) => candidate.source.kind === "shot" && candidate.source.shotId === shotId);
    assert.ok(clip, shotId);
    return clip.id;
  };
  const openMenu = async (clipId: string) => {
    const event = new Event("contextmenu", { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: 100, clientY: 100 });
    await act(async () => { container.querySelector(`[data-clip="${clipId}"]`)!.dispatchEvent(event); });
  };
  const item = (action: string) => document.querySelector<HTMLButtonElement>(`[role="menu"] [data-action="${action}"]`);
  return { container, sent, clipOf, openMenu, item };
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  Reflect.deleteProperty(window, "arke");
  __setBridgeForTest(null);
  document.body.replaceChildren();
});

describe("a clip's menu opens its scene (issue 2957)", () => {
  it("goes to the scene the clip's shot belongs to, and closes the menu", async () => {
    const screen = await mount(seededState());
    await screen.openMenu(screen.clipOf("sh_13"));
    const open = screen.item("open-scene");
    assert.equal(open?.textContent?.trim(), "Open scene");
    await act(async () => open!.click());
    assert.equal(document.querySelector('[role="menu"]') === null, true, "the menu closed");
    assert.equal(screen.container.querySelector("[data-scene-page]")?.getAttribute("data-scene-page"), "sc_04");
    assert.equal(screen.sent.some((message) => message.kind === "timeline-command"), false, "it writes nothing");
  });

  it("offers nothing for a clip that is a file", async () => {
    const screen = await mount(seededState());
    await screen.openMenu("cl_holiday");
    assert.equal(screen.item("delete") !== null, true, "the menu is open");
    assert.equal(screen.item("open-scene") === null, true);
  });

  it("offers nothing for a clip whose shot the story no longer has", async () => {
    const state = seededState();
    const clipId = (() => {
      const timeline = state.world!.productions[0]!.timeline;
      assert.ok(timeline?.status === "ready");
      return timeline.timeline.tracks[0]!.clips.find((clip) => clip.source.kind === "shot" && clip.source.shotId === "sh_13")!.id;
    })();
    for (const scene of state.world!.productions[0]!.scenes) if ("shots" in scene) scene.shots = scene.shots.filter((shot) => shot.id !== "sh_13");
    const screen = await mount(state);
    await screen.openMenu(clipId);
    assert.equal(screen.item("delete") !== null, true, "the menu is open");
    assert.equal(screen.item("open-scene") === null, true);
  });

  it("stays enabled while the track takes no edits", async () => {
    const screen = await mount(seededState());
    await screen.openMenu(screen.clipOf("sh_12"));
    assert.equal(screen.item("duplicate")!.disabled, false);
    // A disabled track opens no menu, so the menu is opened first and an edit sent from the
    // toolbar beside it: while that edit is in flight the track is disabled under the open menu.
    const later = [...screen.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Move later" || button.textContent?.trim() === "Move later");
    assert.ok(later);
    await act(async () => later.click());
    assert.equal(screen.sent.some((message) => message.kind === "timeline-move-picture"), true);
    assert.equal(screen.item("duplicate")!.disabled, true, "edits are off");
    assert.equal(screen.item("open-scene")!.disabled, false);
  });
});

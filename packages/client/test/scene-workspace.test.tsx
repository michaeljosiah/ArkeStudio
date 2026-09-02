import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { insertShot, orderedShots, type ClientMessage, type ClientState, type SceneRecord } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import {
  __applyEventForTest,
  __connectionStatusForTest,
  __setBridgeForTest,
  __setStateForTest,
  isOwnSceneCreate,
} from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { SceneFlow } from "../src/screens/scene-workspace/flow.js";
import { fitPreviewStage, scenePreviewSpans } from "../src/screens/scene-workspace/preview.js";

/**
 * The scene workspace (SPEC-029 R-21..R-29; T-18, T-19, T-20).
 *
 * The one that matters most is T-18: the selection lives above the tabs, so switching views
 * keeps it. A per-view selection is unmounted with its view, and no amount of care inside
 * either view fixes that — which is why it is asserted rather than assumed.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
// linkedom has no layout and no frame loop; the app-wide toaster asks for both before it draws.
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), {
  pause() {},
  play: () => Promise.resolve(),
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const SCENE_PATH = `/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes/sc_04`;

interface Mounted {
  container: HTMLElement;
  root: Root;
}

const open: Mounted[] = [];

async function mount(path = SCENE_PATH): Promise<Mounted> {
  return mountState(FIXTURE_STATE, path);
}

async function mountState(state: ClientState, path = SCENE_PATH): Promise<Mounted> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  const mounted = { container, root };
  open.push(mounted);
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest(null);
});

function capture(sent: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as ArkeBridge;
}

const q = (m: Mounted, selector: string): HTMLElement | null =>
  m.container.querySelector(selector) as HTMLElement | null;
const all = (m: Mounted, selector: string): HTMLElement[] =>
  [...m.container.querySelectorAll(selector)] as unknown as HTMLElement[];
const menuButtons = (): HTMLButtonElement[] =>
  [...dom.document.querySelectorAll(".fy-swrow__menu button")] as unknown as HTMLButtonElement[];
const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => element.click());
};
const editTextarea = async (textarea: HTMLTextAreaElement, value: string): Promise<void> => {
  await act(async () => {
    textarea.value = value;
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
};
const mouse = (type: string, x: number, y: number): Event => {
  const event = new dom.window.Event(type, { bubbles: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
};
const apply = async (event: Parameters<typeof __applyEventForTest>[0]): Promise<void> => {
  await act(async () => __applyEventForTest(event));
};

describe("scene detail owns the workspace", () => {
  it("mounts the workspace and compact production rail by default", async () => {
    const mounted = await mount();
    assert.ok(q(mounted, '[data-testid="scene-workspace"]'));
    assert.ok(q(mounted, ".fy-prodrail--folded"), "the production rail keeps its compact main-menu form");
    assert.equal(q(mounted, '[data-testid="workspace-index"]'), null, "the retired scene index is not mounted");
    assert.ok(q(mounted, '[data-testid="workspace-rows"]'), "Storyboard is the default (R-21)");
    assert.equal(q(mounted, '[data-testid="workspace-flow"]'), null, "and Flow is not mounted yet");
    assert.ok(q(mounted, ".fy-arke"), "the real production conversation is docked beside the work");
    assert.ok(all(mounted, ".fy-sw__tab").some((tab) => tab.textContent === "Stage"));
    assert.ok(all(mounted, ".fy-sw__tab").some((tab) => tab.textContent === "Preview"));
  });

  it("opens the Stage on the selected shot, offers to stage it, and keeps the selection shared", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Stage")!);
    const stage = q(mounted, '[data-testid="workspace-stage"]')!;
    assert.match(stage.textContent ?? "", /Shot 12/);
    assert.match(stage.textContent ?? "", /Nothing staged yet\./);
    // Stepping to the next shot is the same selection the storyboard and Arke share.
    await click(q(mounted, '[aria-label="Next shot"]')!);
    assert.match(stage.textContent ?? "", /Shot 13/);
    assert.match(q(mounted, ".fy-arke__name")?.textContent ?? "", /Shot 13/);
    await click(q(mounted, '[aria-label="Previous shot"]')!);

    // Staging writes at once, as one versioned shot edit: cast from the script's references,
    // a massing box for the scene's location, and a camera move read off the framing words.
    const stageButton = [...stage.querySelectorAll("button")].find((button) => button.textContent === "Stage the shot") as unknown as HTMLElement;
    await click(stageButton);
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.equal(command.kind, "scene-command");
    assert.equal(command.command.kind, "edit-shot");
    if (command.command.kind !== "edit-shot") return;
    assert.equal(command.command.shotId, "sh_12");
    const staging = command.command.change.staging!;
    assert.equal(staging.version, 1);
    assert.deepEqual(staging.cast.map((figure) => figure.sheetId), ["maren-kest"]);
    assert.ok(staging.sets.length >= 1, "the scene's location becomes set massing");
    assert.equal(staging.keys.length, 2);
    assert.equal(staging.keys[0]!.anchor, "maren-kest", "a shot with a subject rides its keys on them");
    assert.ok(staging.keys[1]!.p[2] < staging.keys[0]!.p[2], "a push-in ends closer than it starts");
    assert.equal(staging.keys[1]!.t, 4, "the last key sits at the shot's length");
  });

  it("reads a staged shot back: readouts, keys on the track, Keep after a nudge, and the playblast state", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!
      .scenes.find((candidate) => candidate.id === "sc_04")!;
    const shot = orderedShots(scene).find((candidate) => candidate.id === "sh_12")!;
    (shot as { staging?: unknown }).staging = {
      version: 2,
      cast: [{ sheetId: "maren-kest", x: 0, z: 0, to: [0.4, -3.4] }],
      sets: [{ name: "The Vigil", x: -3.4, z: -3.4, w: 4.4, h: 2.9, d: 1.1 }],
      keys: [
        { t: 0, p: [0, 1.55, 3], l: [0, 1.25, 0], anchor: "maren-kest", track: "maren-kest" },
        { t: 2, p: [-2.5, 1.5, 0.2], l: [0, 1.25, 0], anchor: "maren-kest", track: "maren-kest" },
        { t: 4, p: [0, 1.45, -2.9], l: [0, 1.25, 0], anchor: "maren-kest", track: "maren-kest" },
      ],
    };
    const mounted = await mountState(state);
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Stage")!);
    const stage = q(mounted, '[data-testid="workspace-stage"]')!;
    assert.match(stage.textContent ?? "", /v2 · 3 keys · orbit/);
    assert.match(stage.textContent ?? "", /1\.55m/, "the camera readout is in metres");
    assert.match(stage.textContent ?? "", /rides with Maren/);
    assert.match(stage.textContent ?? "", /walks/);
    assert.match(stage.textContent ?? "", /not filed/);
    assert.equal(all(mounted, ".fy-swstage__key").length, 3);
    assert.equal(all(mounted, ".fy-swstage__key[data-mid=\"true\"]").length, 1, "only interior keys retime");
    assert.equal(q(mounted, '[data-testid="stage-moved"]'), null);

    // A move in hand cannot be rendered: the session is prepared from the KEPT staging.
    await click(q(mounted, '[aria-label="Raise"]')!);
    const held = [...stage.querySelectorAll("button")].find((button) => button.textContent === "Render with this") as unknown as HTMLButtonElement;
    assert.equal(held.disabled, true, "Render waits for Keep");
    assert.equal(held.getAttribute("title"), "Keep the move first");
    await click(q(mounted, '[data-testid="stage-moved"] [aria-label="Discard"]')!);
    assert.equal(q(mounted, '[data-testid="stage-moved"]'), null);

    // Render with this asks the bench for the clip, not a still.
    await click([...stage.querySelectorAll("button")].find((button) => button.textContent === "Render with this") as unknown as HTMLElement);
    const open = sent.at(-1) as Extract<ClientMessage, { kind: "bench-open-subject" }>;
    assert.equal(open.kind, "bench-open-subject");
    assert.deepEqual(open.subject, { kind: "shot", shotId: "sh_12" });
    assert.equal(open.mode, "video");

    // A nudge is a draft: nothing is written until Keep, and Keep writes the next version.
    await click(q(mounted, '[aria-label="Raise"]')!);
    assert.match(stage.textContent ?? "", /1\.65m/);
    const moved = q(mounted, '[data-testid="stage-moved"]')!;
    assert.match(moved.textContent ?? "", /start moved/);
    const before = sent.length;
    await click([...moved.querySelectorAll("button")].find((button) => button.textContent === "Keep") as unknown as HTMLElement);
    assert.equal(sent.length, before + 1);
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.equal(command.command.kind, "edit-shot");
    if (command.command.kind !== "edit-shot") return;
    assert.equal(command.command.change.staging?.version, 3);
    assert.equal(command.command.change.staging?.keys[0]?.p[1], 1.65);

    // Lowering back to the kept height is not a move at all — the chip goes without a click.
    await click(q(mounted, '[aria-label="Lower"]')!);
    assert.equal(q(mounted, '[data-testid="stage-moved"]'), null);
    // Discard is the draft going away.
    await click(q(mounted, '[aria-label="Lower"]')!);
    assert.match(stage.textContent ?? "", /1\.45m/);
    await click(q(mounted, '[data-testid="stage-moved"] [aria-label="Discard"]')!);
    assert.equal(q(mounted, '[data-testid="stage-moved"]'), null);
    assert.match(stage.textContent ?? "", /1\.55m/);
  });

  it("plays a staging kept before the shot was retimed to its end pose, and repairs it on Keep", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!
      .scenes.find((candidate) => candidate.id === "sc_04")!;
    const shot = orderedShots(scene).find((candidate) => candidate.id === "sh_12")!;
    // Kept when the shot ran eight seconds; the shot is four now.
    (shot as { staging?: unknown }).staging = {
      version: 1,
      cast: [],
      sets: [],
      keys: [
        { t: 0, p: [0, 1.5, 4], l: [0, 1, 0] },
        { t: 2, p: [-2, 1.5, 2], l: [0, 1, 0] },
        { t: 8, p: [0, 1.5, -2], l: [0, 1, 0] },
      ],
    };
    const mounted = await mountState(state);
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Stage")!);
    const stage = q(mounted, '[data-testid="workspace-stage"]')!;
    const keys = all(mounted, ".fy-swstage__key").map((key) => key.getAttribute("title") ?? "");
    assert.match(keys[2]!, /4.0s/, "the end key sits at the shot's length");
    assert.match(keys[1]!, /2.0s/, "an interior key that still fits is left where it was");
    assert.equal(q(mounted, '[data-testid="stage-moved"]'), null, "reading is not a move");

    await click(q(mounted, '[aria-label="Raise"]')!);
    await click([...q(mounted, '[data-testid="stage-moved"]')!.querySelectorAll("button")].find((button) => button.textContent === "Keep") as unknown as HTMLElement);
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.equal(command.command.kind, "edit-shot");
    if (command.command.kind !== "edit-shot") return;
    assert.deepEqual(command.command.change.staging?.keys.map((key) => key.t), [0, 2, 4]);
    assert.ok(stage);
  });

  it("seeds start and end poses when a key is added to a staging with none", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!
      .scenes.find((candidate) => candidate.id === "sc_04")!;
    const shot = orderedShots(scene).find((candidate) => candidate.id === "sh_12")!;
    // The schema reads a staging with no keys; the Stage must not throw on it.
    (shot as { staging?: unknown }).staging = { version: 1, cast: [], sets: [], keys: [] };
    const mounted = await mountState(state);
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Stage")!);
    assert.equal(all(mounted, ".fy-swstage__key").length, 0);
    await click(q(mounted, '[aria-label="Add a camera key at the playhead"]')!);
    const keys = all(mounted, ".fy-swstage__key").map((key) => key.getAttribute("title") ?? "");
    assert.equal(keys.length, 2, "a first key brings its end pose with it");
    assert.match(keys[0]!, /start · 0.0s/);
    assert.match(keys[1]!, /end · 4.0s/);
    assert.ok(q(mounted, '[data-testid="stage-moved"]'), "and it is a move to keep");
  });

  it("reaches the Stage from a row's menu and draws a staged shot's blocking on the canvas", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!
      .scenes.find((candidate) => candidate.id === "sc_04")!;
    const shot = orderedShots(scene).find((candidate) => candidate.id === "sh_13")!;
    (shot as { staging?: unknown }).staging = {
      version: 1,
      cast: [],
      sets: [],
      keys: [{ t: 0, p: [0, 1.5, 4], l: [0, 1, 0] }, { t: 6, p: [0, 1.5, 4], l: [0, 1, 0] }],
      playblast: { artifactId: "ar_01J8G0000000000000000000A1", version: 1 },
    };
    const mounted = await mountState(state);
    const row = q(mounted, '[data-testid="workspace-row-sh_13"]')!;
    assert.match(row.querySelector(".fy-swrow__playblast")?.textContent ?? "", /staged/);
    await click(row.querySelector(".fy-swedit") as HTMLElement);
    await click(menuButtons().find((button) => button.textContent === "Stage this shot") as unknown as HTMLElement);
    const stage = q(mounted, '[data-testid="workspace-stage"]')!;
    assert.match(stage.textContent ?? "", /Shot 13/);
    assert.match(stage.textContent ?? "", /v1 · 2 keys · static/);
    assert.match(stage.textContent ?? "", /filed/);

    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    const block = q(mounted, '[data-testid="flow-node-k:sh_13"]')!;
    assert.equal(block.getAttribute("data-kind"), "block");
    assert.match(block.textContent ?? "", /Staging · shot 13/);
    assert.match(block.textContent ?? "", /playblast filed/);
  });

  it("keeps the empty Arke dock conversation-first", async () => {
    const mounted = await mount();
    const dock = q(mounted, ".fy-arke")!;
    assert.doesNotMatch(dock.textContent ?? "", /What it understood|Wrap up|story author/);
    assert.ok(q(mounted, ".fy-arke__who .fy-mono"), "the head names the subject under the title");
    assert.ok(q(mounted, ".fy-arke__log .fy-bubble--gate"), "the conversation remains the primary surface");
  });

  it("keeps durable video plans and their Generation options with the scene owner", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(FIXTURE_STATE);
    await click(all(mounted, "button").find((button) => button.textContent?.trim() === "Show boards")!);
    await click(all(mounted, "button").find((button) => button.textContent?.trim() === "Plan video")!);
    const create = sent.find((message) => message.kind === "dispatch-scene-planned");
    assert.ok(create && create.kind === "dispatch-scene-planned");
    assert.equal(create.sceneFile, "04-the-verse-rises");
    assert.equal(create.mode, "whole-scene");
    assert.equal(create.policy, "review-gated");
    await apply({
      at: "2026-08-31T12:00:00Z",
      type: "production.plan-state",
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      states: [
        {
          planId: "dp_scene-plan",
          productionId: "saltlight",
          sceneId: "sc_04",
          mode: "whole-scene",
          policy: "review-gated",
          capMicroUsd: 120_000,
          status: "authorized",
          passes: [{ passIndex: 0, state: "materialised", estimatedMicroUsd: 80_000 }],
          spentEstimateMicroUsd: 80_000,
          next: { kind: "await-continue", passIndex: 0 },
        },
        {
          planId: "dp_other-scene",
          productionId: "saltlight",
          sceneId: "sc_elsewhere",
          mode: "whole-scene",
          policy: "review-gated",
          capMicroUsd: 10_000,
          status: "authorized",
          passes: [],
          spentEstimateMicroUsd: 0,
          next: { kind: "none" },
        },
      ],
    });

    const optionButtons = all(mounted, "button").filter((button) => button.textContent?.trim() === "Generation options");
    assert.equal(optionButtons.length, 1, "another scene's plan is not actionable here");
    const options = optionButtons[0];
    assert.ok(options, "the retired dispatch contents remain reachable from the scene");
    await click(options);
    assert.match(q(mounted, '[data-testid="generation-options-dp_scene-plan"]')?.textContent ?? "", /Strategy.*pass 1.*\$0\.08/);
    assert.ok(all(mounted, "button").some((button) => button.textContent?.includes("Continue · pass 1")));
  });
});

describe("scene completion is shared with its episode (SPEC-036 R-31)", () => {
  it("offers Done only when every shot has an accepted clip and reports the same state on the episode", async () => {
    const episodeId = "ep_the-verse-rises";
    const episodePath = `/w/${FIXTURE_WORLD_ID}/p/saltlight/episodes/${episodeId}`;
    const withEpisode = (complete: boolean): ClientState => {
      const state = structuredClone(FIXTURE_STATE) as ClientState;
      const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
      const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
      production.episodes = [{ id: episodeId, version: 1, order: 1, title: "The verse rises", scenes: [scene.id] }];
      production.episodeFiles = { [episodeId]: "01-the-verse-rises" };
      if (!complete) return state;

      const source = production.takes.find((take) => take.kind === "clip")!;
      const takeIds = ["tk_01J8F0000000000000000000C1", "tk_01J8F0000000000000000000C2"];
      const jobIds = ["jb_01J8F0000000000000000000C1", "jb_01J8F0000000000000000000C2"];
      for (const [index, shot] of orderedShots(scene).entries()) {
        const take = {
          ...structuredClone(source),
          id: takeIds[index]!,
          jobId: jobIds[index]!,
          coversShots: [shot.id],
        };
        production.takes.push(take);
        production.selections[shot.id] = { ...production.selections[shot.id], acceptedTakeId: take.id, trimInSec: 0 };
      }
      return state;
    };

    const incomplete = await mountState(withEpisode(false), episodePath);
    const incompleteCard = all(incomplete, ".fy-draftcard").find((card) => card.textContent?.includes("The verse rises"))!;
    assert.match(incompleteCard.textContent ?? "", /sc_04 · in progress/);
    await click(incompleteCard.querySelector("button") as HTMLElement);
    assert.ok(q(incomplete, '[data-testid="scene-workspace"]'));
    assert.equal(q(incomplete, ".fy-sw__done"), null, "the incomplete workspace has no Done control");

    const complete = await mountState(withEpisode(true));
    const done = q(complete, ".fy-sw__done")!;
    assert.equal(done.textContent?.trim(), "Done · back to the episode");
    await click(done);
    assert.ok(q(complete, '[data-screen="episode-detail"]'), "Done navigates back to the owning episode");
    const completeCard = all(complete, ".fy-draftcard").find((card) => card.textContent?.includes("The verse rises"))!;
    assert.match(completeCard.textContent ?? "", /sc_04 · done/);
  });
});

describe("the shell collapses rather than demanding the width (R-28)", () => {
  it("Arke can be put away and brought back, and the work keeps the room", async () => {
    const mounted = await mount();
    assert.ok(q(mounted, ".fy-arke"), "the dock starts open");
    // The put-away lives on the dock itself (a pin in its head), and a slim rail brings it back.
    await click(q(mounted, '.fy-arke__head [aria-label="Unpin the assistant"]')!);
    assert.equal(q(mounted, ".fy-arke"), null, "put away, not merely hidden");
    assert.equal(q(mounted, '[data-testid="scene-workspace"]')?.getAttribute("data-dock"), "false");
    assert.ok(q(mounted, '[data-testid="workspace-rows"]'), "and the rows are still there");
    const rail = q(mounted, ".fy-sw__rail")!;
    assert.match(rail.textContent ?? "", /Ask Arke/);

    await click(rail);
    assert.ok(q(mounted, ".fy-arke"), "and back again");
    assert.equal(q(mounted, ".fy-sw__rail"), null);
  });
});

describe("selection survives a view switch (T-18)", () => {
  it("a shot chosen in Storyboard is the node current in Flow, and back again", async () => {
    const mounted = await mount();
    const rows = all(mounted, '[data-testid^="workspace-row-"]');
    assert.ok(rows.length >= 2, "the fixture scene has rows to choose between");

    const second = rows[1]!;
    const shotId = second.getAttribute("data-testid")!.replace("workspace-row-", "");
    await click(second.querySelector(".fy-swrow__band") as unknown as HTMLElement);
    assert.equal(second.querySelector(".fy-swrow__band")?.getAttribute("data-selected"), "true");

    const tabs = all(mounted, ".fy-sw__tab");
    await click(tabs.find((tab) => tab.textContent === "Flow")!);
    const flow = q(mounted, '[data-testid="workspace-flow"]');
    assert.ok(flow, "Flow is showing");
    const currentNode = q(mounted, '.fy-swnode[data-selected="true"]');
    assert.ok(currentNode, "the same shot is the current node, not a fresh scene selection");
    assert.match(currentNode.textContent ?? "", /Shot /);

    // And back: the row is still the selected one, so nothing was lost in either direction.
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Storyboard")!);
    const back = q(mounted, `[data-testid="workspace-row-${shotId}"]`);
    assert.equal(back?.querySelector(".fy-swrow__band")?.getAttribute("data-selected"), "true");
  });

  it("Arke's subject follows the selection without being asked", async () => {
    const mounted = await mount();
    assert.match(q(mounted, ".fy-arke__name")?.textContent ?? "", /Scene /);
    const row = all(mounted, '[data-testid^="workspace-row-"]')[0]!;
    await click(row.querySelector(".fy-swrow__band") as unknown as HTMLElement);
    assert.match(q(mounted, ".fy-arke__name")?.textContent ?? "", /Shot /);

    await click(q(mounted, ".fy-sw__boards-toggle")!);
    await click(q(mounted, ".fy-swboard")!);
    assert.match(q(mounted, ".fy-arke__name")?.textContent ?? "", /Board /);
  });

  it("a node chosen in Flow is the row Storyboard shows as current", async () => {
    const mounted = await mount();
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    const nodes = all(mounted, '.fy-swnode[data-kind="shot"]');
    assert.ok(nodes.length >= 2);
    await click(nodes[1]!);
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Storyboard")!);
    const selected = all(mounted, '[data-testid^="workspace-row-"] .fy-swrow__band[data-selected="true"]');
    assert.equal(selected.length, 1, "exactly one row is current, and it is the one Flow chose");
  });

  it("moves roving focus to the surviving neighbour when the selected shot disappears", async () => {
    const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
    const originalFocus = proto.focus;
    let focused: HTMLElement | null = null;
    proto.focus = function focus() { focused = this as unknown as HTMLElement; };
    try {
      const mounted = await mount();
      const rows = all(mounted, '[data-testid^="workspace-row-"] .fy-swrow__band');
      await click(rows[1]!);
      await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
      const selected = all(mounted, '.fy-swnode[data-kind="shot"]')[1]!;
      assert.equal(selected.getAttribute("tabindex"), "0");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
      assert.equal(focused, selected, "opening Flow focuses the shot selected in Storyboard");
      selected.focus();
      await act(async () => selected.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })));

      const next = structuredClone(FIXTURE_STATE) as ClientState;
      const production = next.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
      const scene = production.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as { version: number; shots: Array<{ id: string }> };
      scene.version += 1;
      scene.shots = scene.shots.filter((shot) => shot.id !== "sh_13");
      await act(async () => __setStateForTest(next));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));

      const sequence = all(mounted, '.fy-swnode[data-kind="entry"], .fy-swnode[data-kind="shot"], .fy-swnode[data-kind="exit"]');
      const neighbour = q(mounted, '.fy-swnode[data-shot-id="sh_12"]')!;
      assert.equal(sequence.filter((node) => node.getAttribute("tabindex") === "0").length, 1);
      assert.equal(neighbour.getAttribute("tabindex"), "0");
      assert.equal(focused, neighbour, "focus follows the next surviving shot rather than falling to the document");
      assert.equal(neighbour.getAttribute("data-selected"), "true", "the shared subject follows the focus fallback");
    } finally {
      proto.focus = originalFocus;
    }
  });

  it("keeps a selected staged shot out of the roving tab stop", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    await click(all(mounted, '[data-testid^="workspace-row-"] .fy-swrow__band')[1]!);

    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const accepted = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const proposed = structuredClone(accepted) as unknown as { shots: Array<{ id: string; title: string }> };
    proposed.shots = proposed.shots.map((shot) => shot.id === "sh_13" ? { ...shot, title: `${shot.title} revised` } : shot);
    const path = "productions/saltlight/scenes/04-the-verse-rises.json";
    state.world!.proposals = [{
      proposal: {
        id: "pr_01J8H0000000000000000000Q3",
        kind: "scene-edit",
        summary: "Revise the selected shot",
        targets: [{ path, baseVersion: accepted.version, baseHash: `sha256:${"b".repeat(64)}` }],
        baseCanonRevision: 42,
        reservedCanonIds: [],
        source: "chat:scene",
        created: "2026-08-30T12:01:00Z",
        draftRevision: 1,
      },
      ripple: null,
      scenes: { [path]: proposed as unknown as SceneRecord },
    }];
    await act(async () => __setStateForTest(state));
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);

    assert.equal(q(mounted, '.fy-swnode[data-shot-id="sh_13"]')?.getAttribute("tabindex"), "-1");
    const staged = q(mounted, '.fy-swnode[data-shot-id="sh_13"]')!;
    const enter = new dom.window.Event("keydown", { bubbles: true });
    Object.defineProperty(enter, "key", { value: "Enter" });
    await act(async () => staged.dispatchEvent(enter));
    assert.equal(sent.some((message) => message.kind === "bench-open-subject"), false, "an inert staged shot cannot open");
    const neighbour = q(mounted, '.fy-swnode[data-shot-id="sh_12"]')!;
    assert.equal(neighbour.getAttribute("tabindex"), "0");
    const down = new dom.window.Event("keydown", { bubbles: true });
    Object.defineProperty(down, "key", { value: "ArrowDown" });
    await act(async () => neighbour.dispatchEvent(down));
    assert.equal(q(mounted, '.fy-swnode[data-kind="exit"]')?.getAttribute("tabindex"), "0", "arrows skip inert staged shots");
  });
});

describe("the title is typed where it reads (R-2, amended 2026-09-02)", () => {
  const press = async (element: HTMLElement, key: string): Promise<void> => {
    const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value: key });
    await act(async () => element.dispatchEvent(event));
  };

  it("renames through one edit-scene write, and a blank leaves the name alone", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    assert.match(q(mounted, ".fy-sw__title")?.textContent ?? "", /^Scene 4 · /);

    await click(q(mounted, ".fy-sw__title-text")!);
    const blank = q(mounted, ".fy-sw__title-input") as HTMLInputElement | null;
    assert.ok(blank, "a click opens the name for typing");
    blank!.value = "   ";
    await press(blank!, "Enter");
    assert.equal(q(mounted, ".fy-sw__title-input"), null, "Enter closes the box");
    assert.equal(sent.some((message) => message.kind === "scene-command"), false, "a blank is not a name");

    await click(q(mounted, ".fy-sw__title-text")!);
    const input = q(mounted, ".fy-sw__title-input") as HTMLInputElement;
    input.value = "  The verse answers  ";
    await press(input, "Enter");
    const command = sent.findLast((message) => message.kind === "scene-command");
    assert.ok(command && command.kind === "scene-command");
    assert.equal(command.sceneId, "sc_04");
    assert.deepEqual(command.command, { kind: "edit-scene", title: "The verse answers" });
  });

  it("a rename that lands while the box is open wins, and the box writes nothing (codex round 3)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    await click(q(mounted, ".fy-sw__title-text")!);
    const input = q(mounted, ".fy-sw__title-input") as HTMLInputElement;
    input.value = "What this window typed";

    // Another window — or Arke — renames the scene and its version moves.
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!
      .scenes.find((candidate) => candidate.id === "sc_04")!;
    scene.title = "Renamed elsewhere";
    scene.version += 1;
    await act(async () => __setStateForTest(state));

    assert.equal(q(mounted, ".fy-sw__title-input"), null, "the box closes on the newer name");
    assert.match(q(mounted, ".fy-sw__title")?.textContent ?? "", /Renamed elsewhere/);
    await press(q(mounted, ".fy-sw__title-text")!, "Enter");
    const reopened = q(mounted, ".fy-sw__title-input") as HTMLInputElement;
    assert.equal(reopened.value, "Renamed elsewhere", "reopening starts from the name that won");
    await press(reopened, "Escape");
    assert.equal(sent.some((message) => message.kind === "scene-command"), false, "nothing the stale box held was written");
  });

  it("Escape puts the old name back without writing", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    const before = q(mounted, ".fy-sw__title")?.textContent;
    await click(q(mounted, ".fy-sw__title-text")!);
    const input = q(mounted, ".fy-sw__title-input") as HTMLInputElement;
    input.value = "Something else";
    await press(input, "Escape");
    assert.equal(q(mounted, ".fy-sw__title-input"), null);
    assert.equal(q(mounted, ".fy-sw__title")?.textContent, before);
    assert.equal(sent.some((message) => message.kind === "scene-command"), false);
  });
});

describe("the dock offers a name while the scene is Untitled (SPEC-036 R-38)", () => {
  const chips = (mounted: Mounted): string[] => all(mounted, ".fy-arke__prompts button").map((chip) => chip.textContent ?? "");

  it("offers Name this scene on an Untitled scene, and not on a named one", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!
      .scenes.find((candidate) => candidate.id === "sc_04")!;
    scene.title = "Untitled";
    const untitled = await mountState(state);
    assert.ok(chips(untitled).includes("Name this scene"), `offered: ${chips(untitled).join(" | ")}`);
    assert.match(untitled.container.textContent ?? "", /talking can name the scene/, "the dock says what talking now changes");
    assert.doesNotMatch(untitled.container.textContent ?? "", /talking changes nothing/, "and no longer promises it changes nothing");

    const named = await mount();
    assert.ok(!chips(named).includes("Name this scene"), "a named scene is not nagged");
    assert.match(named.container.textContent ?? "", /talking can name the scene/, "a named scene can still be renamed on request");
  });
});

describe("New scene makes the scene and opens it (SPEC-036 R-37)", () => {
  const newSceneButton = (mounted: Mounted): HTMLElement =>
    all(mounted, "button").find((candidate) => candidate.textContent === "New scene")!;

  it("sends one correlated create and lands in the workspace the answer names", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount(`/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes`);
    const button = newSceneButton(mounted);
    assert.ok(button, "the Scenes screen offers New scene");
    await click(button);

    const create = sent.findLast((message) => message.kind === "create-scene");
    assert.ok(create && create.kind === "create-scene", "one press, one create — no brief form in between");
    assert.equal(create.productionId, "saltlight");
    assert.equal(create.episodeId, undefined, "a film's scenes belong to no episode");
    assert.equal(button.hasAttribute("disabled"), true, "pending until the answer arrives");

    await apply({
      at: "2026-09-02T10:00:00.000Z",
      type: "scene.create-result",
      requestId: create.requestId,
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      disposition: "created",
      sceneId: "sc_04",
    });
    assert.ok(q(mounted, '[data-testid="scene-workspace"]'), "the answer opens the scene it names");
    assert.match(q(mounted, ".fy-sw__title")?.textContent ?? "", /^Scene 4 · /);
  });

  it("comes back, still on the list, when the answer is a refusal", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount(`/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes`);
    const button = newSceneButton(mounted);
    await click(button);
    const create = sent.findLast((message) => message.kind === "create-scene");
    assert.ok(create && create.kind === "create-scene");
    await apply({
      at: "2026-09-02T10:00:00.000Z",
      type: "scene.create-result",
      requestId: create.requestId,
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      disposition: "failed",
      reason: "episode ep_nowhere is not in saltlight",
    });
    assert.ok(q(mounted, '[data-screen="scenes"]'), "nothing to open, so nowhere to go");
    assert.equal(newSceneButton(mounted).hasAttribute("disabled"), false, "and the press is offered again");
  });

  it("opens the scene under the production the answer names, not the route it was pressed from (codex round 2)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount(`/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes`);
    await click(newSceneButton(mounted));
    const create = sent.findLast((message) => message.kind === "create-scene");
    assert.ok(create && create.kind === "create-scene");
    await apply({
      at: "2026-09-02T10:00:00.000Z",
      type: "scene.create-result",
      requestId: create.requestId,
      worldId: FIXTURE_WORLD_ID,
      productionId: "the-ledger-of-nights",
      disposition: "created",
      sceneId: "sc_untitled",
    });
    assert.ok(q(mounted, '[data-screen="scene-detail"]'), "the scene route was opened");
    assert.notEqual(q(mounted, ".fy-prodrail__switchname")?.textContent, "Saltlight", "under the production the answer named");
  });

  it("a press lost to a dropped connection is offered again on reconnect (codex round 2)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount(`/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes`);
    await click(newSceneButton(mounted));
    assert.equal(newSceneButton(mounted).hasAttribute("disabled"), true);
    await act(async () => __connectionStatusForTest("closed"));
    assert.equal(newSceneButton(mounted).hasAttribute("disabled"), false, "the answer is not coming; the press comes back");
    await act(async () => __connectionStatusForTest("open"));
    assert.ok(q(mounted, '[data-screen="scenes"]'), "and nothing was opened on its behalf");
  });

  it("the promised open survives leaving the screen that pressed it (codex round 3)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount(`/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes`);
    // The screen's own button, not the rail's: the press whose screen is about to unmount.
    const screenButton = all(mounted, '[data-screen="scenes"] button').find((candidate) => candidate.textContent === "New scene")!;
    await click(screenButton);
    const create = sent.findLast((message) => message.kind === "create-scene");
    assert.ok(create && create.kind === "create-scene");
    assert.ok(isOwnSceneCreate(create.requestId), "this window remembers the press as its own");
    assert.equal(
      all(mounted, "button").filter((candidate) => candidate.textContent === "New scene" && candidate.hasAttribute("disabled")).length,
      2,
      "the rail's press and the screen's are one pending state",
    );

    await click(q(mounted, `.fy-prodrail__item[href="/w/${FIXTURE_WORLD_ID}/p/saltlight/generate"]`)!);
    assert.equal(q(mounted, '[data-screen="scenes"]'), null, "the pressing screen is gone");

    await apply({
      at: "2026-09-02T10:00:00.000Z",
      type: "scene.create-result",
      requestId: create.requestId,
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      disposition: "created",
      sceneId: "sc_04",
    });
    assert.ok(q(mounted, '[data-testid="scene-workspace"]'), "the layout kept the promise");
    assert.equal(isOwnSceneCreate(create.requestId), false, "and the answered press is forgotten");
  });

  it("a bookmark to the retired brief form lands on the list, and writes nothing", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount(`/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes/new`);
    assert.ok(q(mounted, '[data-screen="scenes"]'));
    assert.equal(sent.some((message) => message.kind === "create-scene"), false);
  });
});

describe("Preview plays the accepted scene on its authored clock (R-28)", () => {
  it("fits landscape and portrait stages inside both available dimensions", () => {
    assert.deepEqual(fitPreviewStage(900, 300, "9:16"), { width: 168.75, height: 300 });
    assert.deepEqual(fitPreviewStage(300, 900, "16:9"), { width: 300, height: 168.75 });
  });

  it("derives proportional spans, accepted media, own-frame state, and board seams", () => {
    const production = FIXTURE_STATE.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const spans = scenePreviewSpans(production, scene, FIXTURE_STATE.world!.artifacts, [
      { memberShotIds: ["sh_12"] },
      { memberShotIds: ["sh_13"] },
    ] as never);

    assert.deepEqual(spans.map((span) => [span.startSec, span.endSec]), [[0, 4], [4, 10]]);
    assert.match(spans[0]!.clipPath ?? "", /tk_01J8F0000000000000000000B2.*clip\.mp4/);
    assert.equal(spans[0]!.framed, false, "a continuity steering take is not this shot's own filed frame");
    assert.equal(spans[1]!.framed, false);
    assert.equal(spans[1]!.boardStart, true);
  });

  it("shows every shot, seeks through the filmstrip, and shares that selection with Arke", async () => {
    const mounted = await mount();
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Preview")!);

    assert.ok(q(mounted, '[data-testid="workspace-preview"]'));
    const shots = all(mounted, ".fy-swpreview__filmstrip button");
    assert.equal(shots.length, 2);
    assert.match(shots[0]!.getAttribute("style") ?? "", /flex-grow:\s*4/);
    assert.match(shots[1]!.getAttribute("style") ?? "", /flex-grow:\s*6/);
    assert.equal(shots[1]!.getAttribute("data-frameless"), "true");
    assert.match(q(mounted, ".fy-swpreview__stage")?.textContent ?? "", /shot 12/);

    await click(shots[1]!);
    assert.match(q(mounted, ".fy-swpreview__stage")?.textContent ?? "", /shot 13/);
    assert.match(q(mounted, ".fy-arke__name")?.textContent ?? "", /Shot 13/);
    assert.match(q(mounted, ".fy-swpreview__transport")?.textContent ?? "", /4\.0s \/ 10\.0s/);
  });

  it("falls back through a failed clip and frame, and lets recovered media return", async () => {
    const mounted = await mount();
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Preview")!);
    const video = q(mounted, ".fy-swpreview__stage video")!;
    let reloads = 0;
    (video as HTMLVideoElement).load = () => { reloads += 1; };
    const attempted = (video as HTMLVideoElement).src;
    assert.ok(attempted, "the selected clip was attempted");
    assert.match(q(mounted, ".fy-swpreview__kind")?.textContent ?? "", /motion · rendered/);

    Object.defineProperty(video, "currentSrc", { configurable: true, value: attempted });
    await act(async () => video.dispatchEvent(new dom.window.Event("error")));

    assert.match(q(mounted, ".fy-swpreview__kind")?.textContent ?? "", /still · animatic/);
    const still = q(mounted, ".fy-swpreview__stage img")! as HTMLImageElement;
    assert.ok(still.getAttribute("src"), "the shot's frame replaces the failed clip");
    const frameSource = still.getAttribute("src");
    assert.equal(still.style.opacity, "1");

    await act(async () => still.dispatchEvent(new dom.window.Event("error")));
    assert.match(q(mounted, ".fy-swpreview__kind")?.textContent ?? "", /still · animatic/, "the badge only ever says still or motion (R-28)");
    assert.match(q(mounted, ".fy-swpreview__empty")?.textContent ?? "", /no frame for this shot yet/);

    await click(q(mounted, ".fy-swpreview__retry")!);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
    assert.equal(reloads, 1, "retry explicitly reloads a terminal video failure");
    assert.equal(still.getAttribute("src"), frameSource, "retry reassigns the failed frame source");

    await act(async () => video.dispatchEvent(new dom.window.Event("canplay")));
    assert.match(q(mounted, ".fy-swpreview__kind")?.textContent ?? "", /motion · rendered/);
    assert.equal(q(mounted, ".fy-swpreview__retry"), null, "a recovered clip hides a failure belonging to its fallback still");
    await act(async () => still.dispatchEvent(new dom.window.Event("load")));
    assert.equal(video.style.opacity, "1");
  });
});

describe("Storyboard rows expose their authoring controls (SPEC-036 R-6)", () => {
  it("keeps frame actions, the mention-aware script, prompt disclosure, and Edit on the row", async () => {
    const mounted = await mount();
    const row = q(mounted, ".fy-swrow")!;
    const labels = [...row.querySelectorAll("button")].map((button) => button.textContent?.trim());
    assert.ok(labels.includes("Prompt"));
    assert.ok(labels.includes("Variants"));
    assert.ok(labels.includes("Upload"));
    assert.ok(labels.includes("Edit"));
    assert.match(row.querySelector(".fy-swrow__refs")?.textContent ?? "", /Maren Kest.*The Vigil/);
    assert.match(row.querySelector(".fy-swrow__overrides")?.textContent ?? "", /MCU override.*slow push-in override/);
    assert.ok(row.querySelector(".fy-swchip > span"), "shot status uses a dot rather than a filled pill");
    const script = row.querySelector(".fy-swrow__script textarea") as HTMLTextAreaElement | null;
    assert.equal(script?.getAttribute("role"), "combobox", "the shared @ picker remains live in-place");
    assert.ok(script);
    Object.defineProperties(script, {
      selectionStart: { configurable: true, value: "@maren-kest".length },
      selectionEnd: { configurable: true, value: "@maren-kest".length },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    const offsets = new Map<string, PropertyDescriptor | undefined>(
      ["offsetHeight", "offsetLeft", "offsetTop"].map(
        (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
      ),
    );
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 16 });
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get: () => 0 });
    Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get: () => 0 });
    script.getBoundingClientRect = () => ({
      left: 20, top: 10, right: 320, bottom: 110, width: 300, height: 100, x: 20, y: 10, toJSON: () => ({}),
    }) as DOMRect;
    try {
      await click(script);
      const mentions = dom.document.querySelector('[data-testid="bench-mentions"]') as unknown as HTMLElement | null;
      assert.ok(mentions, "the in-place script opens its attached-reference picker");
      assert.equal(mentions.parentElement, dom.document.body, "the picker uses viewport coordinates outside the query container");
      assert.ok(mentions.querySelector(".fy-bench__mentionthumb img"), "mention rows show their sheet portraits (#720)");
      await click(mentions.querySelector('[role="option"]') as unknown as HTMLElement);
      assert.equal(dom.document.querySelector('[data-testid="bench-mentions"]'), null, "choosing a mention closes the portal");
      assert.equal(script.value, "@maren-kest grips the rail of @the-vigil.", "a portaled suggestion still completes the in-place script");
    } finally {
      for (const [name, descriptor] of offsets) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }

    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Prompt") as HTMLElement);
    assert.ok(row.querySelector('.fy-swrow__prompt textarea[aria-label^="Image prompt for shot"]'));
  });

  it("opens its action menu out of layout without losing the row's interaction scope", async () => {
    const mounted = await mount();
    const row = q(mounted, ".fy-swrow")!;
    const trigger = row.querySelector(".fy-swedit") as unknown as HTMLElement;
    const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
    const originalFocus = proto.focus;
    const active = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
    let focused: HTMLElement | null = null;
    const portalFocus: Array<{ label: string; hidden: boolean }> = [];
    proto.focus = function focus() {
      focused = this as unknown as HTMLElement;
      const panel = focused.closest(".fy-swrow__menu, .fy-swrow__confirm") as HTMLElement | null;
      if (panel !== null) portalFocus.push({ label: focused.textContent ?? "", hidden: panel.style.visibility === "hidden" });
    };
    Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused });
    try {
      await click(trigger);
      let menu = dom.document.querySelector(".fy-swrow__menu") as unknown as HTMLElement | null;
      assert.ok(menu);
      assert.equal(menu.getAttribute("role"), "menu");
      assert.equal(menu.parentElement, dom.document.body, "viewport coordinates live outside the query container");
      assert.doesNotMatch(menu.getAttribute("style") ?? "", /NaN/);
      assert.doesNotMatch(menu.getAttribute("style") ?? "", /visibility:\s*hidden/, "the menu is visible before focus enters it");
      assert.equal((focused as unknown as HTMLElement | null)?.textContent, "Stage this shot", "opening moves focus into the menu");
      assert.deepEqual(portalFocus.filter((entry) => entry.label === "Stage this shot"), [{ label: "Stage this shot", hidden: false }]);

      const down = new dom.window.Event("keydown", { bubbles: true });
      Object.defineProperty(down, "key", { value: "ArrowDown" });
      await act(async () => menu?.dispatchEvent(down));
      assert.equal((focused as unknown as HTMLElement | null)?.textContent, "Open in generator", "arrow keys traverse enabled commands");

      await act(async () => dom.window.dispatchEvent(new dom.window.Event("scroll")));
      assert.equal(
        (focused as unknown as HTMLElement | null)?.textContent,
        "Open in generator",
        "viewport repositioning does not reset menu focus",
      );
      assert.equal(portalFocus.filter((entry) => entry.label === "Stage this shot").length, 1);

      const tab = new dom.window.Event("keydown", { bubbles: true });
      Object.defineProperty(tab, "key", { value: "Tab" });
      await act(async () => menu?.dispatchEvent(tab));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
      assert.equal(dom.document.querySelector(".fy-swrow__menu"), null);
      assert.equal(focused, trigger, "leaving the portal restores the row action trigger");

      await click(trigger);
      menu = dom.document.querySelector(".fy-swrow__menu") as unknown as HTMLElement;
      await click([...menu.querySelectorAll("button")].find((button) => button.textContent === "Delete") as HTMLElement);
      const confirmation = dom.document.querySelector('.fy-swrow__confirm[role="alertdialog"]') as unknown as HTMLElement | null;
      assert.ok(confirmation);
      assert.equal((focused as unknown as HTMLElement | null)?.textContent, "Delete", "the confirmation receives focus");
      assert.deepEqual(portalFocus.filter((entry) => entry.label === "Delete"), [{ label: "Delete", hidden: false }]);

      const blocker = dom.document.querySelector('[data-testid="row-confirmation-blocker"]') as unknown as HTMLElement;
      assert.match(blocker.getAttribute("style") ?? "", /position:\s*fixed/);
      assert.match(blocker.getAttribute("style") ?? "", /inset:\s*0/);
      const pointer = new dom.window.Event("pointerdown", { bubbles: true, cancelable: true });
      await act(async () => blocker.dispatchEvent(pointer));
      assert.equal(pointer.defaultPrevented, true);
      const outsideClick = new dom.window.Event("click", { bubbles: true, cancelable: true });
      await act(async () => blocker.dispatchEvent(outsideClick));
      assert.equal(outsideClick.defaultPrevented, true);
      assert.ok(q(mounted, '[data-testid="workspace-rows"]'), "an outside click cannot switch the workspace view");
      assert.ok(dom.document.querySelector(".fy-swrow__confirm"));

      const confirmTab = new dom.window.Event("keydown", { bubbles: true });
      Object.defineProperty(confirmTab, "key", { value: "Tab" });
      await act(async () => confirmation.dispatchEvent(confirmTab));
      assert.equal((focused as unknown as HTMLElement | null)?.textContent, "Cancel", "Tab stays inside the destructive confirmation");
      await act(async () => dom.document.body.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })));
      assert.equal((focused as unknown as HTMLElement | null)?.textContent, "Delete", "focus cannot leave an open confirmation");
      const escape = new dom.window.Event("keydown", { bubbles: true });
      Object.defineProperty(escape, "key", { value: "Escape" });
      await act(async () => confirmation.dispatchEvent(escape));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
      assert.equal(focused, trigger);
    } finally {
      proto.focus = originalFocus;
      if (active === undefined) Reflect.deleteProperty(dom.document, "activeElement");
      else Object.defineProperty(dom.document, "activeElement", active);
    }
  });

  it("rebuilds a dirty prompt without saving the draft first", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shot = orderedShots(scene)[0]!;
    shot.promptOverride = { text: "A hand-written prompt", sheetVersions: {} };
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(state);
    const row = q(mounted, `[data-testid="workspace-row-${shot.id}"]`)!;
    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Prompt") as HTMLElement);
    const prompt = row.querySelector(".fy-swrow__prompt") as unknown as HTMLElement;
    const textarea = prompt.querySelector("textarea") as HTMLTextAreaElement;
    const rebuild = [...prompt.querySelectorAll("button")].find((button) => button.textContent === "Rebuild") as HTMLElement;
    textarea.value = "A dirty draft that must not land";
    const before = sent.length;
    const movingInside = new dom.window.Event("focusout", { bubbles: true });
    Object.defineProperty(movingInside, "relatedTarget", { value: rebuild });
    await act(async () => prompt.dispatchEvent(movingInside));
    assert.equal(sent.length, before, "moving from the prompt to Rebuild does not commit the draft");
    await click(rebuild);
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.deepEqual(command.command, { kind: "set-prompt-override", shotId: shot.id, text: null });
    assert.notEqual(textarea.value, "A dirty draft that must not land");
    assert.notEqual(textarea.value, "A hand-written prompt", "the assembled prompt is visible while the clear is pending");
  });

  it("closes an unchanged shot prompt immediately without writing", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shots = orderedShots(scene);
    shots[0]!.promptOverride = { text: "Stored shot prompt", sheetVersions: {} };
    scene.boards = {
      splits: [shots[1]!.id],
      merges: [],
      prompts: [{ members: [shots[0]!.id], text: "Stored board prompt" }],
    };
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(state);
    const row = q(mounted, `[data-testid="workspace-row-${shots[0]!.id}"]`)!;
    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Prompt") as HTMLElement);
    await editTextarea(row.querySelector(".fy-swrow__prompt textarea") as HTMLTextAreaElement, "Stored shot prompt");
    const cleanShotCommands = sent.filter((message) => message.kind === "scene-command").length;
    await click([...row.querySelectorAll(".fy-swrow__prompt button")].find((button) => button.textContent === "Hide") as HTMLElement);
    assert.equal(sent.filter((message) => message.kind === "scene-command").length, cleanShotCommands);
    assert.equal(row.querySelector(".fy-swrow__prompt") === null, true, "an unchanged shot prompt closes immediately");
  });

  it("closes an unchanged board prompt immediately without writing", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shots = orderedShots(scene);
    scene.boards = {
      splits: [shots[1]!.id],
      merges: [],
      prompts: [{ members: [shots[0]!.id], text: "Stored board prompt" }],
    };
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(state);
    await click(q(mounted, ".fy-sw__boards-toggle")!);
    const board = q(mounted, "[data-testid=workspace-board-A]")!;
    await click(board.querySelector('button[title="Consolidated prompt"]') as HTMLElement);
    await editTextarea(board.querySelector(".fy-swboard__prompt textarea") as HTMLTextAreaElement, "Stored board prompt");
    const cleanBoardCommands = sent.filter((message) => message.kind === "scene-command").length;
    await click([...board.querySelectorAll(".fy-swboard__prompt button")].find((button) => button.textContent === "Hide") as HTMLElement);
    assert.equal(board.querySelector(".fy-swboard__prompt"), null, "an unchanged board prompt closes immediately");
    assert.equal(sent.filter((message) => message.kind === "scene-command").length, cleanBoardCommands);
  });

  it("waits for durable shot and board prompt props before Hide closes", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shots = orderedShots(scene);
    shots[0]!.promptOverride = { text: "Stored shot prompt", sheetVersions: {} };
    scene.boards = {
      splits: [shots[1]!.id],
      merges: [],
      prompts: [{ members: [shots[0]!.id], text: "Stored board prompt" }],
    };
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(state);
    const row = q(mounted, `[data-testid="workspace-row-${shots[0]!.id}"]`)!;
    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Prompt") as HTMLElement);
    const shotEditor = row.querySelector(".fy-swrow__prompt") as HTMLElement;
    const shotPrompt = shotEditor.querySelector("textarea") as HTMLTextAreaElement;
    await editTextarea(shotPrompt, "Committed shot draft");
    await click([...shotEditor.querySelectorAll("button")].find((button) => button.textContent === "Hide") as HTMLElement);
    assert.deepEqual((sent.findLast((message) => message.kind === "scene-command") as Extract<ClientMessage, { kind: "scene-command" }>).command, {
      kind: "set-prompt-override",
      shotId: shots[0]!.id,
      text: "Committed shot draft",
    });
    assert.ok(row.querySelector(".fy-swrow__prompt"), "command admission alone does not close the shot editor");
    assert.equal((row.querySelector(".fy-swrow__prompt button:last-child") as HTMLButtonElement).disabled, true);

    const advanced = structuredClone(state) as ClientState;
    const advancedScene = advanced.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!
      .scenes.find((candidate) => candidate.id === "sc_04")!;
    advancedScene.version += 1;
    orderedShots(advancedScene)[0]!.promptOverride = { text: "Committed shot draft", sheetVersions: {} };
    await act(async () => __setStateForTest(advanced));
    assert.equal(row.querySelector(".fy-swrow__prompt"), null, "the matching durable shot override acknowledges Hide");

    await click(q(mounted, ".fy-sw__boards-toggle")!);
    const board = q(mounted, "[data-testid=workspace-board-A]")!;
    await click(board.querySelector('button[title="Consolidated prompt"]') as HTMLElement);
    const boardEditor = board.querySelector(".fy-swboard__prompt") as HTMLElement;
    const boardPrompt = boardEditor.querySelector("textarea") as HTMLTextAreaElement;
    await editTextarea(boardPrompt, "Committed board draft");
    await click([...boardEditor.querySelectorAll("button")].find((button) => button.textContent === "Hide") as HTMLElement);
    assert.deepEqual((sent.findLast((message) => message.kind === "scene-command") as Extract<ClientMessage, { kind: "scene-command" }>).command, {
      kind: "set-board-prompt",
      members: [shots[0]!.id],
      text: "Committed board draft",
    });
    assert.ok(board.querySelector(".fy-swboard__prompt"), "command admission alone does not close the board editor");

    const durableBoard = structuredClone(advanced) as ClientState;
    const durableBoardScene = durableBoard.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!
      .scenes.find((candidate) => candidate.id === "sc_04")!;
    durableBoardScene.version += 1;
    durableBoardScene.boards!.prompts = [{ members: [shots[0]!.id], text: "Committed board draft" }];
    await act(async () => __setStateForTest(durableBoard));
    assert.equal(board.querySelector(".fy-swboard__prompt"), null, "the matching durable board override acknowledges Hide");
  });

  it("keeps admitted shot and board Hide drafts open for retry after asynchronous refusal", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shots = orderedShots(scene);
    shots[0]!.promptOverride = { text: "Stored shot prompt", sheetVersions: {} };
    scene.boards = {
      splits: [shots[1]!.id],
      merges: [],
      prompts: [{ members: [shots[0]!.id], text: "Stored board prompt" }],
    };
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(state);
    const row = q(mounted, `[data-testid="workspace-row-${shots[0]!.id}"]`)!;

    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Prompt") as HTMLElement);
    const shotEditor = row.querySelector(".fy-swrow__prompt") as HTMLElement;
    await editTextarea(shotEditor.querySelector("textarea") as HTMLTextAreaElement, "Retry this exact shot draft  ");
    await click([...shotEditor.querySelectorAll("button")].find((button) => button.textContent === "Hide") as HTMLElement);
    assert.ok(row.querySelector(".fy-swrow__prompt"));
    await apply({
      at: "2026-09-01T10:02:00.000Z",
      type: "scene.write-refused",
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      sceneFile: "04-the-verse-rises",
      reason: "The shot prompt version moved.",
    });
    const refusedShot = row.querySelector(".fy-swrow__prompt") as HTMLElement;
    assert.ok(refusedShot, "the asynchronously refused shot Hide remains open");
    assert.equal((refusedShot.querySelector("textarea") as HTMLTextAreaElement).value, "Retry this exact shot draft  ");
    assert.equal((refusedShot.querySelector("button:last-child") as HTMLButtonElement).disabled, false, "the draft can be retried");

    await click(q(mounted, ".fy-sw__boards-toggle")!);
    const board = q(mounted, "[data-testid=workspace-board-A]")!;
    await click(board.querySelector('button[title="Consolidated prompt"]') as HTMLElement);
    const boardEditor = board.querySelector(".fy-swboard__prompt") as HTMLElement;
    await editTextarea(boardEditor.querySelector("textarea") as HTMLTextAreaElement, "Retry this exact board draft  ");
    await click([...boardEditor.querySelectorAll("button")].find((button) => button.textContent === "Hide") as HTMLElement);
    assert.ok(board.querySelector(".fy-swboard__prompt"));
    await apply({
      at: "2026-09-01T10:03:00.000Z",
      type: "scene.write-refused",
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      sceneFile: "04-the-verse-rises",
      reason: "The board prompt version moved.",
    });
    const refusedBoard = board.querySelector(".fy-swboard__prompt") as HTMLElement;
    assert.ok(refusedBoard, "the asynchronously refused board Hide remains open");
    assert.equal((refusedBoard.querySelector("textarea") as HTMLTextAreaElement).value, "Retry this exact board draft  ");
    assert.equal((refusedBoard.querySelector("button:last-child") as HTMLButtonElement).disabled, false, "the board draft can be retried");
    assert.match(dom.document.body.textContent ?? "", /The board prompt version moved/, "the workspace still shows the refusal");
  });

  it("clears a dirty consolidated prompt without a blur write and restores stored copy on refusal", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shots = orderedShots(scene);
    scene.boards = {
      splits: [shots[1]!.id],
      merges: [],
      prompts: [{ members: [shots[0]!.id], text: "Stored board prompt" }],
    };
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(state);
    await click(q(mounted, ".fy-sw__boards-toggle")!);
    const board = q(mounted, "[data-testid=workspace-board-A]")!;
    await click(board.querySelector('button[title="Consolidated prompt"]') as HTMLElement);
    const editor = board.querySelector(".fy-swboard__prompt") as HTMLElement;
    const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
    const rebuild = [...editor.querySelectorAll("button")].find((button) => button.textContent === "Rebuild") as HTMLElement;
    await editTextarea(textarea, "Dirty board draft");
    const movingInside = new dom.window.Event("focusout", { bubbles: true });
    Object.defineProperty(movingInside, "relatedTarget", { value: rebuild });
    await act(async () => editor.dispatchEvent(movingInside));
    await click(rebuild);

    const sceneCommands = sent.filter((message): message is Extract<ClientMessage, { kind: "scene-command" }> => message.kind === "scene-command");
    assert.equal(sceneCommands.length, 1, "Rebuild sends only the clear command");
    assert.deepEqual(sceneCommands[0]!.command, {
      kind: "clear-board-prompt",
      members: [shots[0]!.id],
    });
    assert.notEqual(textarea.value, "Dirty board draft");
    assert.notEqual(textarea.value, "Stored board prompt", "the assembled prompt replaces the override while clear is pending");

    await apply({
      at: "2026-09-01T10:00:00.000Z",
      type: "scene.write-refused",
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      sceneFile: "04-the-verse-rises",
      reason: "The scene version moved.",
    });
    assert.equal(textarea.value, "Stored board prompt", "a refused clear restores the still-stored override");
  });

  it("focuses and selects the next surviving row after confirmed deletion", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
    const originalFocus = proto.focus;
    const active = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
    let focused: HTMLElement | null = null;
    proto.focus = function focus() { focused = this as unknown as HTMLElement; };
    Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused });
    try {
      const mounted = await mount();
      const first = q(mounted, "[data-testid=workspace-row-sh_12]")!;
      await click(first.querySelector(".fy-swedit") as HTMLElement);
      await click(menuButtons().find((button) => button.textContent === "Delete") as unknown as HTMLElement);
      const confirmation = dom.document.querySelector(".fy-swrow__confirm") as unknown as HTMLElement;
      await click([...confirmation.querySelectorAll("button")].find((button) => button.textContent === "Delete") as HTMLElement);
      assert.deepEqual((sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>).command, {
        kind: "delete-shot",
        shotId: "sh_12",
      });

      const next = structuredClone(FIXTURE_STATE) as ClientState;
      const scene = next.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!
        .scenes.find((candidate) => candidate.id === "sc_04")! as unknown as {
          version: number;
          shots: Array<{ id: string }>;
        };
      scene.version += 1;
      scene.shots = scene.shots.filter((shot) => shot.id !== "sh_12");
      await act(async () => __setStateForTest(next));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));

      const survivor = q(mounted, '[data-testid="workspace-row-sh_13"] .fy-swrow__band')!;
      assert.equal(focused, survivor);
      assert.equal(survivor.getAttribute("data-selected"), "true");
      assert.match(q(mounted, ".fy-arke__name")?.textContent ?? "", /Shot 13/);
    } finally {
      proto.focus = originalFocus;
      if (active === undefined) Reflect.deleteProperty(dom.document, "activeElement");
      else Object.defineProperty(dom.document, "activeElement", active);
    }
  });

  it("closes a stale confirmation and falls back through staged rendering", async () => {
    const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
    const originalFocus = proto.focus;
    const active = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
    let focused: HTMLElement | null = null;
    proto.focus = function focus() { focused = this as unknown as HTMLElement; };
    Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused });
    try {
      const mounted = await mount();
      const second = q(mounted, "[data-testid=workspace-row-sh_13]")!;
      await click(second.querySelector(".fy-swedit") as HTMLElement);
      await click(menuButtons().find((button) => button.textContent === "Delete") as unknown as HTMLElement);
      assert.ok(dom.document.querySelector(".fy-swrow__confirm"));

      const state = structuredClone(FIXTURE_STATE) as ClientState;
      const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
      const accepted = production.scenes.find((candidate) => candidate.id === "sc_04")!;
      const proposed = structuredClone(accepted) as unknown as { shots: Array<{ id: string }> };
      proposed.shots = proposed.shots.filter((shot) => shot.id !== "sh_13");
      const path = "productions/saltlight/scenes/04-the-verse-rises.json";
      state.world!.proposals = [{
        proposal: {
          id: "pr_01J8H0000000000000000000Q4",
          kind: "scene-edit",
          summary: "Remove the stale target",
          targets: [{ path, baseVersion: accepted.version, baseHash: `sha256:${"c".repeat(64)}` }],
          baseCanonRevision: 42,
          reservedCanonIds: [],
          source: "chat:scene",
          created: "2026-09-01T10:01:00Z",
          draftRevision: 1,
        },
        ripple: null,
        scenes: { [path]: proposed as unknown as SceneRecord },
      }];
      await act(async () => __setStateForTest(state));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));

      assert.equal(dom.document.querySelector(".fy-swrow__confirm"), null, "a vanished target cannot leave stale dialog actions");
      const survivor = q(mounted, '[data-testid="workspace-row-sh_12"] .fy-swrow__band')!;
      assert.equal(focused, survivor, "the previous surviving row receives focus");
      assert.equal(survivor.getAttribute("data-selected"), "true");
      assert.match(q(mounted, ".fy-arke__name")?.textContent ?? "", /Shot 12/);
    } finally {
      proto.focus = originalFocus;
      if (active === undefined) Reflect.deleteProperty(dom.document, "activeElement");
      else Object.defineProperty(dom.document, "activeElement", active);
    }
  });

  it("closes a mounted confirmation without restoring focus when its row becomes staged", async () => {
    const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
    const originalFocus = proto.focus;
    const active = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
    let focused: HTMLElement | null = null;
    proto.focus = function focus() { focused = this as unknown as HTMLElement; };
    Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused });
    try {
      const mounted = await mount();
      const second = q(mounted, "[data-testid=workspace-row-sh_13]")!;
      await click(second.querySelector(".fy-swedit") as HTMLElement);
      await click(menuButtons().find((button) => button.textContent === "Delete") as unknown as HTMLElement);
      assert.ok(dom.document.querySelector(".fy-swrow__confirm"));

      const state = structuredClone(FIXTURE_STATE) as ClientState;
      const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
      const accepted = production.scenes.find((candidate) => candidate.id === "sc_04")!;
      const proposed = structuredClone(accepted) as unknown as {
        shots: Array<{ id: string; title: string }>;
      };
      proposed.shots = proposed.shots.map((shot) =>
        shot.id === "sh_13" ? { ...shot, title: `${shot.title} staged` } : shot,
      );
      const path = "productions/saltlight/scenes/04-the-verse-rises.json";
      state.world!.proposals = [{
        proposal: {
          id: "pr_01J8H0000000000000000000Q5",
          kind: "scene-edit",
          summary: "Stage the confirmation target",
          targets: [{ path, baseVersion: accepted.version, baseHash: `sha256:${"d".repeat(64)}` }],
          baseCanonRevision: 42,
          reservedCanonIds: [],
          source: "chat:scene",
          created: "2026-09-01T10:04:00Z",
          draftRevision: 1,
        },
        ripple: null,
        scenes: { [path]: proposed as unknown as SceneRecord },
      }];
      await act(async () => __setStateForTest(state));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));

      assert.equal(dom.document.querySelector(".fy-swrow__confirm"), null);
      assert.equal(q(mounted, '[data-testid="workspace-row-sh_13"] .fy-swrow__band')?.getAttribute("data-staged"), "true");
      const survivor = q(mounted, '[data-testid="workspace-row-sh_12"] .fy-swrow__band')!;
      assert.equal(focused, survivor, "parent fallback focus wins over the now-inert row trigger");
      assert.equal(survivor.getAttribute("data-selected"), "true");
    } finally {
      proto.focus = originalFocus;
      if (active === undefined) Reflect.deleteProperty(dom.document, "activeElement");
      else Object.defineProperty(dom.document, "activeElement", active);
    }
  });

  it("focuses the scene root when deletion leaves no shot row", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as { shots: unknown[] };
    scene.shots = [scene.shots[0]!];
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
    const originalFocus = proto.focus;
    let focused: HTMLElement | null = null;
    proto.focus = function focus() { focused = this as unknown as HTMLElement; };
    try {
      const mounted = await mountState(state);
      const row = q(mounted, "[data-testid=workspace-row-sh_12]")!;
      await click(row.querySelector(".fy-swedit") as HTMLElement);
      await click(menuButtons().find((button) => button.textContent === "Delete") as unknown as HTMLElement);
      const confirmation = dom.document.querySelector(".fy-swrow__confirm") as unknown as HTMLElement;
      await click([...confirmation.querySelectorAll("button")].find((button) => button.textContent === "Delete") as HTMLElement);

      const empty = structuredClone(state) as ClientState;
      const updated = empty.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!
        .scenes.find((candidate) => candidate.id === "sc_04")! as unknown as { version: number; shots: unknown[] };
      updated.version += 1;
      updated.shots = [];
      await act(async () => __setStateForTest(empty));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));

      const root = q(mounted, "[data-testid=workspace-empty]")!;
      assert.equal(focused, root);
      assert.match(q(mounted, ".fy-arke__name")?.textContent ?? "", /Scene 4/);
    } finally {
      proto.focus = originalFocus;
    }
  });
});

describe("the workspace writes only named, versioned scene commands (#606)", () => {
  it("edits, reorders and inserts with stable shot ids rather than replacing scene JSON", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    const production = FIXTURE_STATE.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shots = orderedShots(scene);

    // The shot label is the reorder handle (R-6); dropping it on another row moves the shot before it.
    const second = q(mounted, `[data-testid="workspace-row-${shots[1]!.id}"]`)!;
    const firstBand = q(mounted, `[data-testid="workspace-row-${shots[0]!.id}"] .fy-swrow__band`)!;
    await act(async () => second.querySelector(".fy-swrow__label")!.dispatchEvent(new dom.window.Event("dragstart", { bubbles: true })));
    await act(async () => firstBand.dispatchEvent(new dom.window.Event("drop", { bubbles: true, cancelable: true })));
    assert.deepEqual(sent.at(-1), {
      kind: "scene-command",
      worldId: FIXTURE_WORLD_ID,
      productionId: "saltlight",
      sceneFile: "04-the-verse-rises",
      sceneId: "sc_04",
      baseVersion: scene.version,
      command: { kind: "move-shot", shotId: shots[1]!.id, to: { before: shots[0]!.id } },
    });

    const advance = async (version: number) => {
      const next = structuredClone(FIXTURE_STATE) as ClientState;
      next.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!
        .scenes.find((candidate) => candidate.id === "sc_04")!.version = version;
      await act(async () => __setStateForTest(next));
    };
    await advance(scene.version + 1);

    const divider = all(mounted, ".fy-swdivider")[0]!;
    await click(divider.querySelector("button") as HTMLElement);
    const insert = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.deepEqual(insert.command, {
      kind: "insert-shot",
      at: { before: shots[1]!.id },
      shot: { title: "Untitled shot", description: "" },
    });
    await advance(scene.version + 2);

    const scriptEditor = q(mounted, `[data-testid="workspace-row-${shots[0]!.id}"] .fy-swrow__script`)!;
    const script = scriptEditor.querySelector("textarea")! as HTMLTextAreaElement;
    script.value = "The rewritten beat.";
    await act(async () => scriptEditor.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
    const edit = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.deepEqual(edit.command, {
      kind: "edit-shot",
      shotId: shots[0]!.id,
      change: { description: "The rewritten beat." },
    });
    const before = sent.length;
    const key = new dom.window.Event("keydown", { bubbles: true }) as unknown as KeyboardEvent;
    Object.defineProperty(key, "key", { value: " " });
    await act(async () => scriptEditor.dispatchEvent(key));
    assert.equal(sent.length, before, "typing in the script is not a row action");
  });

  it("shows prototype board bands and maps split/merge to the board override commands", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    await click(q(mounted, ".fy-sw__boards-toggle")!);
    assert.ok(all(mounted, '[data-testid^="workspace-board-"]').length > 0);
    const split = all(mounted, ".fy-swdivider button").find((button) => button.textContent === "Split board here");
    assert.ok(split, "a non-boundary divider offers the named split control");
    await click(split!);
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.equal(command.command.kind, "set-board-override");
    if (command.command.kind === "set-board-override") assert.equal(command.command.override, "split");
  });

  it("reads a legacy still in the clip slot as framed, never rendered", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const still = production.takes.find((take) => take.kind === "frame")!;
    production.selections[still.coversShots[0]!] = { acceptedTakeId: still.id, trimInSec: 0 };
    const mounted = await mountState(state);
    const row = q(mounted, `[data-testid="workspace-row-${still.coversShots[0]}"] .fy-swrow__band`)!;
    assert.notEqual(row.getAttribute("data-state"), "story");
    assert.notEqual(row.getAttribute("data-state"), "rendered");
  });

  it("reconnects Flow through one move command and keeps an edge as Arke's subject", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    const shots = all(mounted, '.fy-swnode[data-kind="shot"]');
    const ports = all(mounted, ".fy-swnode__port");
    await click(ports[0]!);
    await click(shots[1]!);
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.equal(command.command.kind, "move-shot");

    await click(all(mounted, '[data-testid="workspace-flow-alt"] button')[0]!);
    assert.match(q(mounted, ".fy-arke__name")?.textContent ?? "", /Edge /);
  });

  it("reconnects a shot to Entry as the start of the canonical path", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    await click(all(mounted, ".fy-swnode__port")[1]!);
    await click(q(mounted, '.fy-swnode[data-kind="entry"]')!);

    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.deepEqual(command.command, { kind: "move-shot", shotId: "sh_13", to: { atStart: true } });
  });
});

describe("the generation-session handoff (SPEC-036 R-23)", () => {
  it("selects a report-linked shot from the scene route", async () => {
    const production = FIXTURE_STATE.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shot = orderedShots(scene)[1]!;
    const mounted = await mount(`${SCENE_PATH}?shot=${shot.id}`);
    assert.match(q(mounted, ".fy-arke__name")?.textContent ?? "", new RegExp(`Shot ${shot.number}`));
  });

  it("opens the chosen shot and navigates only for its matching answer", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    const production = FIXTURE_STATE.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shot = orderedShots(scene)[0]!;
    const row = q(mounted, `[data-testid="workspace-row-${shot.id}"]`)!;
    const actions = row.querySelector(".fy-swedit") as HTMLElement;
    assert.equal(actions.getAttribute("aria-label"), `Actions for shot ${shot.number}`);
    await click(actions);
    assert.equal(actions.getAttribute("aria-expanded"), "true");
    await click(menuButtons().find((button) => button.textContent === "Open in generator") as unknown as HTMLElement);
    const command = sent.findLast((message) => message.kind === "bench-open-subject");
    assert.ok(command && command.kind === "bench-open-subject");
    assert.deepEqual(command.subject, { kind: "shot", shotId: shot.id });
    assert.equal(command.productionId, "saltlight");
    assert.equal(command.sceneId, "sc_04");
    assert.ok(menuButtons().some((button) => button.textContent === "Opening…" && button.disabled));

    await apply({
      at: "2026-08-31T10:00:00.000Z",
      type: "bench.subject-opened",
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD",
      requestId: command.requestId,
      sessionId: "sess_01J8F3K2QW9VZX4N7M0RTYB6HE",
    });
    assert.ok(q(mounted, '[data-testid="scene-workspace"]'), "another world's answer is ignored");

    await apply({
      at: "2026-08-31T10:00:01.000Z",
      type: "bench.subject-opened",
      worldId: FIXTURE_WORLD_ID,
      requestId: command.requestId,
      sessionId: "sess_01J8F3K2QW9VZX4N7M0RTYB6HE",
    });
    assert.ok(q(mounted, '[data-screen="bench"]'), "the matching answer enters its durable session route");
  });

  it("passes an ordered board identity and leaves a matching refusal on the workspace", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    await click(q(mounted, ".fy-sw__boards-toggle")!);
    const render = all(mounted, ".fy-swboard button").find((button) => button.textContent === "Render board");
    assert.ok(render);
    await click(render);
    const command = sent.findLast((message) => message.kind === "bench-open-subject");
    assert.ok(command && command.kind === "bench-open-subject" && command.subject.kind === "board");
    const production = FIXTURE_STATE.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const order = orderedShots(scene).map((shot) => shot.id);
    assert.deepEqual(command.subject.memberShotIds, order.slice(0, command.subject.memberShotIds.length));

    await apply({
      at: "2026-08-31T10:01:00.000Z",
      type: "bench.subject-opened",
      worldId: FIXTURE_WORLD_ID,
      requestId: command.requestId,
      sessionId: null,
      reason: "That board no longer matches the current scene.",
    });
    assert.ok(q(mounted, '[data-testid="scene-workspace"]'));
    assert.match(mounted.container.textContent ?? "", /That board no longer matches the current scene/);
  });

  it("releases the handoff actions when their answer is lost with the connection", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    const row = q(mounted, ".fy-swrow")!;
    await click(row.querySelector(".fy-swedit") as HTMLElement);
    await click(menuButtons().find((button) => button.textContent === "Open in generator") as unknown as HTMLElement);
    assert.ok(menuButtons().some((button) => button.textContent === "Opening…" && button.disabled));

    await act(async () => __connectionStatusForTest("closed"));
    assert.match(mounted.container.textContent ?? "", /Connection lost - try again/);
    assert.ok(menuButtons().some((button) => button.textContent === "Open in generator" && !button.disabled));
    await act(async () => __connectionStatusForTest("open"));
  });

  it("links Flow shot and board nodes to the same subject handoff", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    const links = all(mounted, ".fy-swnode__run");
    assert.ok(links.some((button) => /^(Generate|Regenerate)$/.test(button.textContent ?? "")));
    assert.ok(links.some((button) => button.textContent === "Render"));
    const shotLink = q(mounted, '.fy-swnode[data-kind="shot"] .fy-swnode__run')!;
    await click(shotLink);
    const command = sent.findLast((message) => message.kind === "bench-open-subject");
    assert.ok(command && command.kind === "bench-open-subject" && command.subject.kind === "shot");
    assert.ok(all(mounted, ".fy-swnode__run").every((button) => button.hasAttribute("disabled")));
  });

  it("uses Enter for a Flow shot's generator action and Space only for selection", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount();
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;

    const space = new dom.window.Event("keydown", { bubbles: true });
    Object.defineProperty(space, "key", { value: " " });
    await act(async () => shot.dispatchEvent(space));
    assert.equal(sent.some((message) => message.kind === "bench-open-subject"), false);
    assert.equal(shot.getAttribute("data-selected"), "true");

    const enter = new dom.window.Event("keydown", { bubbles: true });
    Object.defineProperty(enter, "key", { value: "Enter" });
    await act(async () => shot.dispatchEvent(enter));
    const command = sent.findLast((message) => message.kind === "bench-open-subject");
    assert.ok(command && command.kind === "bench-open-subject");
    assert.deepEqual(command.subject, { kind: "shot", shotId: shot.getAttribute("data-shot-id") });

    const beforeDisabledEnter = sent.length;
    const disabledEnter = new dom.window.Event("keydown", { bubbles: true });
    Object.defineProperty(disabledEnter, "key", { value: "Enter" });
    await act(async () => shot.dispatchEvent(disabledEnter));
    assert.equal(sent.length, beforeDisabledEnter, "the pending generator state disables repeated Enter actions");
  });

  it("does not let the previous scene's delayed answer navigate back from the current scene", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const firstScene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    production.scenes.push({
      ...structuredClone(firstScene),
      id: "sc_05",
      slug: "the-next-scene",
      number: 5,
      title: "The next scene",
    });
    production.sceneFiles["sc_05"] = "05-the-next-scene";
    const mounted = await mountState(state);
    const firstRow = q(mounted, ".fy-swrow")!;
    await click(firstRow.querySelector(".fy-swedit") as HTMLElement);
    await click(menuButtons().find((button) => button.textContent === "Open in generator") as unknown as HTMLElement);
    const command = sent.findLast((message) => message.kind === "bench-open-subject");
    assert.ok(command && command.kind === "bench-open-subject");

    await click(q(mounted, `.fy-prodrail__item[href="/w/${FIXTURE_WORLD_ID}/p/saltlight/scenes"]`)!);
    const nextScene = all(mounted, ".fy-row").find((button) => (button.textContent ?? "").includes("The next scene"));
    assert.ok(nextScene);
    await click(nextScene!);
    const currentTitle = q(mounted, ".fy-sw__title")?.textContent;
    assert.ok(currentTitle && !currentTitle.includes("Scene 4"));

    await apply({
      at: "2026-08-31T10:03:00.000Z",
      type: "bench.subject-opened",
      worldId: FIXTURE_WORLD_ID,
      requestId: command.requestId,
      sessionId: "sess_01J8F3K2QW9VZX4N7M0RTYB6HE",
    });
    assert.ok(q(mounted, '[data-testid="scene-workspace"]'));
    assert.equal(q(mounted, ".fy-sw__title")?.textContent, currentTitle);
  });
});

describe("staged scene changes stay in place but inert until applied (T-12)", () => {
  it("draws a proposed shot in both views, excludes it from metrics, and keeps it after Keep discussing", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const accepted = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const proposed = insertShot(accepted, {
      at: { after: orderedShots(accepted).at(-1)!.id },
      shot: { id: "sh_999", title: "Maren hears it land", description: "She does not move." },
    });
    const path = "productions/saltlight/scenes/04-the-verse-rises.json";
    state.world!.proposals = [{
      proposal: {
        id: "pr_01J8H0000000000000000000Q2",
        kind: "scene-edit",
        summary: "Add Maren's reaction",
        targets: [{ path, baseVersion: accepted.version, baseHash: `sha256:${"a".repeat(64)}` }],
        baseCanonRevision: 42,
        reservedCanonIds: [],
        source: "chat:scene",
        created: "2026-08-30T12:00:00Z",
        draftRevision: 1,
      },
      ripple: null,
      scenes: { [path]: proposed },
    }];
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(state);

    const stagedRow = q(mounted, '[data-testid="workspace-row-sh_999"] .fy-swrow__band')!;
    assert.equal(stagedRow.getAttribute("data-staged"), "true");
    assert.equal(stagedRow.getAttribute("aria-disabled"), "true");
    assert.match(q(mounted, ".fy-sw__metrics")?.textContent ?? "", new RegExp(`^${orderedShots(accepted).length} shots`));
    assert.ok(all(mounted, "button").some((button) => button.textContent === "Apply to shots"));
    assert.match(q(mounted, ".fy-made")?.textContent ?? "", /Maren hears it land.*new/);

    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    assert.equal(q(mounted, '.fy-swnode[data-shot-id="sh_999"]')?.getAttribute("data-staged"), "true");
    const sentBeforeKeepDiscussing = sent.length;
    await click(all(mounted, "button").find((button) => button.textContent === "Keep discussing")!);
    assert.ok(q(mounted, '.fy-swnode[data-shot-id="sh_999"]'), "folding the decision does not drop the proposal");
    assert.equal(sent.length, sentBeforeKeepDiscussing, "Keep discussing is not a write or a discard");

    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Storyboard")!);
    await click(q(mounted, ".fy-madeaside")!);
    await click(all(mounted, "button").find((button) => button.textContent === "Apply to shots")!);
    assert.equal(sent.at(-1)?.kind, "proposal-accept");
  });
});

describe("every read-side operation is reachable by keyboard (T-19)", () => {
  it("rows, nodes, edges and tabs are all real controls, and each announces itself", async () => {
    const mounted = await mount();
    // A row's whole hit area is one button, so a shot is one focus stop rather than a stack.
    for (const row of all(mounted, ".fy-swrow__band")) {
      assert.equal(row.getAttribute("role"), "group");
      assert.equal(row.getAttribute("tabindex"), "0");
      assert.match(row.getAttribute("aria-label") ?? "", /^Shot \d+, /, "number, title and state");
    }
    for (const tab of all(mounted, ".fy-sw__tab")) {
      assert.equal(tab.getAttribute("role"), "radio");
      assert.ok(tab.getAttribute("aria-checked"));
    }
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    // A canvas node carries a drag, so it is a div — but it is a control besides: focusable,
    // named, and activated by Enter or Space. The whole map is one tab stop; arrows traverse the
    // deterministic graph order while Home and End retain their canonical terminal meaning.
    const flowNodes = all(mounted, '.fy-swnode[data-kind="shot"]');
    const mapNodes = all(mounted, ".fy-swnode");
    assert.equal(mapNodes.filter((node) => node.getAttribute("tabindex") === "0").length, 1);
    assert.equal(mapNodes.find((node) => node.getAttribute("tabindex") === "0")?.getAttribute("data-kind"), "entry");
    for (const node of flowNodes) {
      assert.equal(node.getAttribute("role"), "button");
      // R-63: kind, what it is, and the in/out counts a canvas would otherwise show by drawing.
      assert.match(node.getAttribute("aria-label") ?? "", /Shot \d+, shot, .*, \d+ in, \d+ out/);
    }
    // Edges are drawn as SVG paths, which no keyboard can reach — so the same graph is offered
    // in words, each edge naming its source and destination (R-63).
    const edges = all(mounted, '[data-testid="workspace-flow-alt"] button');
    assert.ok(edges.length > 0, "the graph is reachable in words as well as in the drawing");
    for (const edge of edges) {
      assert.equal(edge.tagName, "BUTTON");
      assert.match(edge.textContent ?? "", /goes to|is cited by/, "source and destination, said");
    }

    const entry = q(mounted, '.fy-swnode[data-kind="entry"]')!;
    const previous = new dom.window.Event("keydown", { bubbles: true });
    Object.defineProperty(previous, "key", { value: "ArrowUp" });
    await act(async () => entry.dispatchEvent(previous));
    const reference = mapNodes.find((node) => node.getAttribute("tabindex") === "0");
    assert.equal(reference?.getAttribute("data-kind"), "ref", "a derived reference enters the roving stop");

    const end = new dom.window.Event("keydown", { bubbles: true });
    Object.defineProperty(end, "key", { value: "End" });
    await act(async () => reference?.dispatchEvent(end));
    const exit = q(mounted, '.fy-swnode[data-kind="exit"]')!;
    assert.equal(exit.getAttribute("tabindex"), "0");

    const next = new dom.window.Event("keydown", { bubbles: true });
    Object.defineProperty(next, "key", { value: "ArrowDown" });
    await act(async () => exit.dispatchEvent(next));
    const board = mapNodes.find((node) => node.getAttribute("tabindex") === "0");
    assert.equal(board?.getAttribute("data-kind"), "board", "a derived board enters the same roving stop");

    const afterBoard = new dom.window.Event("keydown", { bubbles: true });
    Object.defineProperty(afterBoard, "key", { value: "ArrowDown" });
    await act(async () => board?.dispatchEvent(afterBoard));
    assert.equal(mapNodes.find((node) => node.getAttribute("tabindex") === "0")?.getAttribute("data-kind"), "clip");
    assert.equal(mapNodes.filter((node) => node.getAttribute("tabindex") === "0").length, 1);
  });

  it("the lists are semantic, so a screen reader gets the structure for free", async () => {
    const mounted = await mount();
    const rows = q(mounted, '[data-testid="workspace-rows"]');
    assert.equal(rows?.tagName, "OL", "shots are an ordered list because their order is meaning");
    assert.ok(rows?.getAttribute("aria-label"));
    assert.equal(q(mounted, ".fy-arke")?.tagName, "ASIDE", "the conversation is complementary to the work");
    assert.equal(q(mounted, ".fy-arke__log")?.getAttribute("aria-live"), "polite");
  });
});

describe("a scene the workspace cannot read is named, never guessed (R-29, R-60)", () => {
  it("an invalid flow shows the findings and invents no order", async () => {
    /*
     * Driven against the view directly rather than through the app. The scan keeps an invalid
     * scene OUT of the bundle — it becomes that file's problem entry, which is what leaves the
     * rest of the world open — so no route can put one in front of this component. The branch
     * is defence in depth for exactly that reason, and a test that faked a bundle carrying one
     * would be asserting about a state the app cannot reach while telling itself otherwise.
     */
    const broken = {
      id: "sc_09",
      slug: "the-unreadable",
      number: 9,
      title: "The unreadable",
      status: "draft",
      version: 1,
      flow: {
        schemaVersion: 1,
        entryNodeId: "sfn_sc-09-entry",
        exitNodeId: "sfn_sc-09-exit",
        // Entry and Exit with nothing joining them: parseable, unwalkable.
        nodes: [
          { id: "sfn_sc-09-entry", kind: "entry" },
          { id: "sfn_sc-09-exit", kind: "exit" },
        ],
        edges: [],
        storyboardGroups: [],
      },
    } as unknown as SceneRecord;

    const container = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(container);
    const root = createRoot(container);
    const production = FIXTURE_STATE.world!.productions.find((p) => p.meta.id === "saltlight")!;
    await act(async () =>
      root.render(
        <SceneFlow
          scene={broken}
          production={production}
          sheets={FIXTURE_STATE.world!.sheets}
          artifacts={FIXTURE_STATE.world!.artifacts}
          slug={FIXTURE_STATE.world!.meta.slug}
          boardPack={{ ok: true, boards: [] }}
          stagedShotIds={new Set()}
          newShotIds={new Set()}
          stagedBoards={false}
          locked={false}
          generatorPending={false}
          onCommand={() => true}
          onOpenShotInGenerator={() => {}}
          onOpenStage={() => {}}
          onRenderBoard={() => {}}
          onTalkToArke={() => {}}
        />,
      ),
    );
    open.push({ container, root });

    const invalid = container.querySelector('[data-testid="workspace-flow-invalid"]');
    assert.ok(invalid, "the view says the order cannot be trusted rather than drawing a guess");
    assert.ok((invalid.textContent ?? "").length > 0, "and names why, finding by finding");
    assert.equal(container.querySelector('.fy-swnode[data-kind="shot"]'), null, "no shot node is invented");
  });
});

describe("an empty scene keeps its canonical path (SPEC-029 R-29)", () => {
  it("draws Entry to Exit and offers both ways to begin", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const at = production.scenes.findIndex((scene) => scene.id === "sc_04");
    const empty = { ...production.scenes[at], shots: [] } as unknown as SceneRecord;
    delete (empty as { flow?: unknown }).flow;
    production.scenes[at] = empty;
    const mounted = await mountState(state);
    await click(q(mounted, '.fy-arke__head [aria-label="Unpin the assistant"]')!);
    assert.equal(q(mounted, '[data-testid="scene-workspace"]')?.getAttribute("data-dock"), "false");
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);

    assert.ok(q(mounted, '.fy-swnode[data-kind="entry"]'));
    assert.ok(q(mounted, '.fy-swnode[data-kind="exit"]'));
    assert.ok(all(mounted, '[data-testid="workspace-flow-alt"] button').some((edge) => edge.textContent === "Entry goes to Exit"));
    assert.ok(all(mounted, ".fy-swflow__empty button").some((button) => button.textContent === "Add first shot"));
    const talk = all(mounted, ".fy-swflow__empty button").find((button) => button.textContent === "Talk to Arke");
    assert.ok(talk);
    await click(talk);
    assert.equal(q(mounted, '[data-testid="scene-workspace"]')?.getAttribute("data-dock"), "true");
  });
});

describe("a 200-shot scene renders in both views (T-20, R-69)", () => {
  it("stays inside the warm interaction budget, and neither view drops a shot", async () => {
    /*
     * R-69's budget, measured rather than assumed. What this is really guarding is a quadratic
     * derivation sneaking into a row: every shot asks for its coverage, its frame and its chip,
     * and a per-row scan of the production turns 200 shots into 40,000 lookups.
     *
     * The number is deliberately loose — this runs on CI machines of unknown speed, and a tight
     * bound would fail for reasons that are not about the code. An accidental quadratic misses
     * it by an order of magnitude, which is the failure worth catching.
     */
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((p) => p.meta.id === "saltlight")!;
    const at = production.scenes.findIndex((scene) => scene.id === "sc_04");
    const base = production.scenes[at] as unknown as { shots?: unknown };
    const shots = Array.from({ length: 200 }, (_, index) => ({
      id: `sh_9${String(index).padStart(3, "0")}`,
      number: index + 1,
      title: `Shot ${index + 1}`,
      description: `Beat ${index + 1}.`,
      durationSec: 4,
    }));
    production.scenes[at] = {
      ...(base as object),
      shots,
      boards: { splits: shots.slice(1).map((shot) => shot.id), merges: [] },
    } as never;
    delete (production.scenes[at] as { flow?: unknown }).flow;
    __setStateForTest(state);
    const container = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(container);
    const root = createRoot(container);
    const started = Date.now();
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[SCENE_PATH]}>
          <App />
        </MemoryRouter>,
      );
    });
    const elapsed = Date.now() - started;
    open.push({ container, root });

    assert.equal(
      container.querySelectorAll('[data-testid^="workspace-row-"]').length,
      200,
      "every shot has a row — nothing is silently truncated",
    );
    assert.ok(elapsed < 8000, `storyboard rendered 200 shots in ${elapsed}ms`);

    const flowTab = [...container.querySelectorAll(".fy-sw__tab")].find(
      (tab) => tab.textContent === "Flow",
    ) as unknown as HTMLElement;
    const switched = Date.now();
    await act(async () => flowTab.click());
    const flowElapsed = Date.now() - switched;
    assert.equal(container.querySelectorAll('.fy-swnode[data-kind="shot"]').length, 200, "and every node");
    assert.ok(flowElapsed < 8000, `flow rendered 200 nodes in ${flowElapsed}ms`);

    const canvas = container.querySelector('[data-testid="workspace-flow"]') as unknown as HTMLElement;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 560, width: 900, height: 560, toJSON: () => ({}) }),
    });
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("resize")));
    const layer = container.querySelector('[data-testid="workspace-flow-layer"]') as unknown as HTMLElement;
    const transform = /translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([\d.]+)\)/.exec(layer.getAttribute("style") ?? "");
    assert.ok(transform);
    const panX = Number(transform[1]);
    const panY = Number(transform[2]);
    const scale = Number(transform[3]);
    assert.ok(scale < 0.5, "automatic Fit may pass the manual zoom floor to keep every node visible");
    for (const node of [...container.querySelectorAll(".fy-swnode")] as unknown as HTMLElement[]) {
      const left = Number.parseFloat(node.style.left);
      const top = Number.parseFloat(node.style.top);
      const width = Number.parseFloat(node.style.width);
      const height = Number.parseFloat(node.style.height);
      assert.ok(panX + left * scale >= -1, `${node.dataset.testid} stays inside the left edge`);
      assert.ok(panX + (left + width) * scale <= 901, `${node.dataset.testid} stays inside the right edge`);
      assert.ok(panY + (top - 30) * scale >= -1, `${node.dataset.testid} leaves room for its toolbar`);
      assert.ok(panY + (top + height) * scale <= 561, `${node.dataset.testid} stays inside the bottom edge`);
    }

    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 560, width: 500, height: 560, toJSON: () => ({}) }),
    });
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("resize")));
    assert.equal(canvas.getAttribute("data-layout"), "compact");
    const compactTransform = /translate\(([-\d.]+)px,([-\d.]+)px\) scale\(([\d.eE+-]+)\)/.exec(layer.getAttribute("style") ?? "");
    assert.ok(compactTransform);
    const compactPanX = Number(compactTransform[1]);
    const compactPanY = Number(compactTransform[2]);
    const compactScale = Number(compactTransform[3]);
    assert.ok(compactScale < 0.02, "compact Fit has no arbitrary scale clamp");
    for (const node of [...container.querySelectorAll(".fy-swnode")] as unknown as HTMLElement[]) {
      const left = Number.parseFloat(node.style.left);
      const top = Number.parseFloat(node.style.top);
      const width = Number.parseFloat(node.style.width);
      const height = Number.parseFloat(node.style.height);
      assert.ok(compactPanX + left * compactScale >= -1);
      assert.ok(compactPanX + (left + width) * compactScale <= 501);
      assert.ok(compactPanY + (top - 30) * compactScale >= -1);
      assert.ok(compactPanY + (top + height) * compactScale <= 561);
    }
    const zoomOut = container.querySelector('button[aria-label="Zoom out"]') as unknown as HTMLButtonElement;
    const fittedLabel = container.querySelector(".fy-swzoom__label")?.textContent;
    assert.equal(zoomOut.disabled, true, "zoom out cannot increase a below-floor automatic fit");
    await act(async () => zoomOut.click());
    assert.equal(container.querySelector(".fy-swzoom__label")?.textContent, fittedLabel);
    await act(async () => (container.querySelector('button[aria-label="Zoom in"]') as unknown as HTMLElement).click());
    assert.equal(container.querySelector(".fy-swzoom__label")?.textContent, "50%", "manual zoom returns to its normative floor");
  });
});

describe("Flow is a canvas at every width, and never the only way in (R-24, R-28 as amended)", () => {
  it("keeps the canvas narrow as well as wide, with the graph still in words", async () => {
    /*
     * The amendment: below 900px Flow is not replaced by a list. What must hold is that nothing
     * REQUIRES the canvas — every node is a control and every edge is offered in words, which
     * is the half the old narrow-width substitution never addressed at any width.
     */
    const mounted = await mount();
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    assert.ok(q(mounted, '[data-testid="workspace-flow-layer"]'), "still a transformed canvas");
    const words = all(mounted, '[data-testid="workspace-flow-alt"] button');
    assert.ok(words.length > 0, "and the same graph, said");
    for (const edge of words) {
      assert.match(edge.textContent ?? "", /goes to|is cited by/, "each edge names its endpoints");
    }
  });
});

describe("Flow is a canvas (the prototype's §11)", () => {
  const openFlow = async (): Promise<Mounted> => {
    const mounted = await mount();
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    return mounted;
  };

  it("draws nodes at coordinates on a transformed layer, not as a list", async () => {
    const mounted = await openFlow();
    const layer = q(mounted, '[data-testid="workspace-flow-layer"]')!;
    assert.match(layer.getAttribute("style") ?? "", /translate\(.*px.*px\) scale\(/, "pan and zoom");
    const node = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
    const style = node.getAttribute("style") ?? "";
    assert.match(style, /left:/, "a node has a position");
    assert.match(style.replace(/\s+/g, ""), /width:232px/, "and the prototype's box for its kind");
  });

  it("joins the nodes with bezier edges out of one box and into the next", async () => {
    const mounted = await openFlow();
    const paths = all(mounted, ".fy-swedges path");
    assert.ok(paths.length > 0, "the graph is drawn, not merely listed");
    for (const path of paths) {
      // M x,y C … — the prototype's cubic, leaving a right edge and arriving at a left one.
      assert.match(path.getAttribute("d") ?? "", /^M[\d.-]+,[\d.-]+ C/);
    }
    assert.ok(
      all(mounted, '[data-testid="workspace-flow-alt"] button').some((edge) => /Shot \d+ goes to shot \d+/.test(edge.textContent ?? "")),
      "the canonical sequence itself is drawn and said",
    );
    const labels = all(mounted, '[data-testid="workspace-flow-alt"] button').map((edge) => edge.textContent ?? "");
    assert.ok(labels.some((label) => /^Entry goes to shot \d+$/.test(label)));
    assert.ok(labels.some((label) => /^Shot \d+ goes to Exit$/.test(label)));
  });

  it("renders canonical terminals and ports, with Home and End reaching them", async () => {
    const mounted = await openFlow();
    const entry = q(mounted, '.fy-swnode[data-kind="entry"]')!;
    const exit = q(mounted, '.fy-swnode[data-kind="exit"]')!;
    const shots = all(mounted, '.fy-swnode[data-kind="shot"]');
    assert.match(entry.getAttribute("aria-label") ?? "", /Entry, entry, .*, 0 in, 1 out/);
    assert.match(exit.getAttribute("aria-label") ?? "", /Exit, exit, .*, 1 in, 0 out/);
    assert.equal(all(mounted, '.fy-swnode__socket[data-port="in"]').length, shots.length + 1);
    assert.equal(all(mounted, '.fy-swnode__socket[data-port="out"]').length, 1);
    assert.equal(all(mounted, ".fy-swnode__port").length, shots.length, "each shot exposes its reconnect output");

    const end = new dom.window.Event("keydown", { bubbles: true });
    Object.defineProperty(end, "key", { value: "End" });
    await act(async () => entry.dispatchEvent(end));
    assert.equal(exit.getAttribute("tabindex"), "0");

    const home = new dom.window.Event("keydown", { bubbles: true });
    Object.defineProperty(home, "key", { value: "Home" });
    await act(async () => exit.dispatchEvent(home));
    assert.equal(entry.getAttribute("tabindex"), "0");
  });

  it("contains and restores focus around Flow deletion", async () => {
    const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
    const originalFocus = proto.focus;
    const active = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
    let focused: HTMLElement | null = null;
    proto.focus = function focus() { focused = this as unknown as HTMLElement; };
    Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused });
    try {
      const mounted = await openFlow();
      const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
      shot.focus();
      const remove = new dom.window.Event("keydown", { bubbles: true });
      Object.defineProperty(remove, "key", { value: "Delete" });
      await act(async () => shot.dispatchEvent(remove));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
      const dialog = q(mounted, '.fy-swlinkhint[role="alertdialog"]')!;
      assert.equal(dialog.getAttribute("aria-modal"), "true");
      assert.equal((focused as unknown as HTMLElement | null)?.textContent, "Delete");

      const tab = new dom.window.Event("keydown", { bubbles: true });
      Object.defineProperty(tab, "key", { value: "Tab" });
      await act(async () => dialog.dispatchEvent(tab));
      assert.equal((focused as unknown as HTMLElement | null)?.textContent, "Cancel");
      const escape = new dom.window.Event("keydown", { bubbles: true });
      Object.defineProperty(escape, "key", { value: "Escape" });
      await act(async () => dialog.dispatchEvent(escape));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
      assert.equal(q(mounted, '.fy-swlinkhint[role="alertdialog"]'), null);
      assert.equal(focused, shot);
    } finally {
      proto.focus = originalFocus;
      if (active === undefined) Reflect.deleteProperty(dom.document, "activeElement");
      else Object.defineProperty(dom.document, "activeElement", active);
    }
  });

  it("blocks background controls and catches Escape after an outside focus attempt", async () => {
    const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
    const originalFocus = proto.focus;
    const active = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
    let focused: HTMLElement | null = null;
    proto.focus = function focus() { focused = this as unknown as HTMLElement; };
    Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused });
    try {
      const mounted = await openFlow();
      const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
      shot.focus();
      const remove = new dom.window.Event("keydown", { bubbles: true });
      Object.defineProperty(remove, "key", { value: "Delete" });
      await act(async () => shot.dispatchEvent(remove));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));

      const dialog = q(mounted, '.fy-swlinkhint[role="alertdialog"]')!;
      const deleteButton = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Delete")!;
      const backgroundNode = all(mounted, '.fy-swnode[data-kind="shot"]')[1]!;
      const zoomIn = q(mounted, 'button[aria-label="Zoom in"]') as HTMLButtonElement;
      const zoomBefore = q(mounted, ".fy-swzoom__label")?.textContent;
      assert.equal(focused, deleteButton);

      backgroundNode.focus();
      await act(async () => backgroundNode.dispatchEvent(new dom.window.Event("focusin", { bubbles: true, cancelable: true })));
      assert.equal(focused, deleteButton, "an outside focus attempt returns to the first modal action");
      assert.equal(zoomIn.disabled, true, "background controls expose their modal-disabled state");
      await click(zoomIn);
      assert.equal(q(mounted, ".fy-swzoom__label")?.textContent, zoomBefore, "the background zoom action is blocked");
      assert.equal(focused, deleteButton, "the blocked click leaves focus inside the dialog");

      const escape = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
      Object.defineProperty(escape, "key", { value: "Escape" });
      await act(async () => backgroundNode.dispatchEvent(escape));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
      assert.equal(q(mounted, '.fy-swlinkhint[role="alertdialog"]'), null, "Escape cancels from an outside target");
      assert.equal(focused, shot, "cancellation restores the invoking node");
    } finally {
      proto.focus = originalFocus;
      if (active === undefined) Reflect.deleteProperty(dom.document, "activeElement");
      else Object.defineProperty(dom.document, "activeElement", active);
    }
  });

  it("keeps edge focus through Delete instead of handing the key to the selected shot", async () => {
    const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
    const originalFocus = proto.focus;
    const active = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
    let focused: HTMLElement | null = null;
    proto.focus = function focus() { focused = this as unknown as HTMLElement; };
    Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused });
    try {
      const mounted = await openFlow();
      const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
      await click(shot);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
      shot.focus();
      await act(async () => shot.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })));

      const edge = all(mounted, '[data-testid="workspace-flow-alt"] button')[0]!;
      edge.focus();
      await act(async () => edge.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })));
      await click(edge);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
      assert.equal(focused, edge, "selecting an edge does not refocus the active node");

      const remove = new dom.window.Event("keydown", { bubbles: true });
      Object.defineProperty(remove, "key", { value: "Delete" });
      await act(async () => focused?.dispatchEvent(remove));
      assert.equal(q(mounted, '.fy-swlinkhint[role="alertdialog"]'), null, "Delete is not misdirected to a shot");
      assert.equal(focused, edge);
    } finally {
      proto.focus = originalFocus;
      if (active === undefined) Reflect.deleteProperty(dom.document, "activeElement");
      else Object.defineProperty(dom.document, "activeElement", active);
    }
  });

  it("closes a stale shot dialog without sending and focuses the surviving neighbour", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
    const originalFocus = proto.focus;
    const active = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
    let focused: HTMLElement | null = null;
    proto.focus = function focus() { focused = this as unknown as HTMLElement; };
    Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused });
    try {
      const mounted = await openFlow();
      const removed = q(mounted, '.fy-swnode[data-shot-id="sh_13"]')!;
      await click(removed);
      removed.focus();
      await act(async () => removed.dispatchEvent(new dom.window.Event("focusin", { bubbles: true })));
      const remove = new dom.window.Event("keydown", { bubbles: true });
      Object.defineProperty(remove, "key", { value: "Delete" });
      await act(async () => removed.dispatchEvent(remove));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
      const dialog = q(mounted, '.fy-swlinkhint[role="alertdialog"]')!;
      const staleConfirm = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Delete")!;

      const next = structuredClone(FIXTURE_STATE) as ClientState;
      const production = next.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
      const scene = production.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as {
        version: number;
        shots: Array<{ id: string }>;
      };
      scene.version += 1;
      scene.shots = scene.shots.filter((shot) => shot.id !== "sh_13");
      await act(async () => __setStateForTest(next));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));

      assert.equal(q(mounted, '.fy-swlinkhint[role="alertdialog"]'), null);
      assert.doesNotMatch(mounted.container.textContent ?? "", /Delete shot undefined/);
      const neighbour = q(mounted, '.fy-swnode[data-shot-id="sh_12"]')!;
      assert.equal(neighbour.getAttribute("tabindex"), "0");
      assert.equal(focused, neighbour);

      await click(staleConfirm as unknown as HTMLElement);
      assert.equal(
        sent.some((message) => message.kind === "scene-command" && message.command.kind === "delete-shot"),
        false,
        "a detached stale confirmation cannot send",
      );
    } finally {
      proto.focus = originalFocus;
      if (active === undefined) Reflect.deleteProperty(dom.document, "activeElement");
      else Object.defineProperty(dom.document, "activeElement", active);
    }
  });

  it("zooms between the prototype's stops and says where it is", async () => {
    const mounted = await openFlow();
    const label = () => q(mounted, ".fy-swzoom__label")?.textContent ?? "";
    const zoomIn = all(mounted, ".fy-swzoom button").find((b) => b.getAttribute("aria-label") === "Zoom in")!;
    const zoomOut = all(mounted, ".fy-swzoom button").find((b) => b.getAttribute("aria-label") === "Zoom out")!;

    const before = label();
    await click(zoomIn);
    assert.notEqual(label(), before, "zooming in changes the reading");
    // The ceiling holds: many presses cannot take it past 140%.
    for (let i = 0; i < 12; i += 1) await click(zoomIn);
    assert.equal(label(), "140%");
    for (let i = 0; i < 20; i += 1) await click(zoomOut);
    assert.equal(label(), "50%", "and the floor holds too");
  });

  it("fits the graph to the canvas, and returns to it after a drag", async () => {
    const mounted = await openFlow();
    const canvas = q(mounted, '[data-testid="workspace-flow"]')!;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 560, width: 900, height: 560, toJSON: () => ({}) }),
    });
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("resize")));
    const node = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
    const before = node.getAttribute("style") ?? "";

    // A drag moves the node itself, not the canvas under it.
    await act(async () => {
      node.dispatchEvent(mouse("mousedown", 100, 100));
      dom.window.dispatchEvent(mouse("mousemove", 180, 145));
      dom.window.dispatchEvent(mouse("mouseup", 180, 145));
    });
    const dragged = node.getAttribute("style");
    assert.notEqual(dragged, before);
    const board = all(mounted, '.fy-swnode[data-kind="board"]')[0]!;
    const boardBefore = board.getAttribute("style");
    await act(async () => {
      board.dispatchEvent(mouse("mousedown", 700, 150));
      dom.window.dispatchEvent(mouse("mousemove", 760, 190));
      dom.window.dispatchEvent(mouse("mouseup", 760, 190));
    });
    const boardDragged = board.getAttribute("style");
    assert.notEqual(boardDragged, boardBefore);

    const changed = structuredClone(FIXTURE_STATE) as ClientState;
    const changedProduction = changed.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const changedScene = changedProduction.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as {
      version: number;
      shots: Array<{ id: string; number: number; title: string; description: string; durationSec: number }>;
    };
    changedScene.version += 1;
    changedScene.shots[0]!.title = `${changedScene.shots[0]!.title} revised`;
    await act(async () => __setStateForTest(changed));
    assert.equal(node.getAttribute("style"), dragged, "a graph change preserves stable manually placed nodes");
    assert.equal(board.getAttribute("style"), boardDragged, "a board keeps its manual position while its content identity survives");

    const fit = all(mounted, ".fy-swzoom button").find((b) => b.textContent === "Arrange")!;
    await click(fit);
    const layer = q(mounted, '[data-testid="workspace-flow-layer"]')!;
    assert.match(layer.getAttribute("style") ?? "", /scale\(/, "fit leaves a transform behind it");
    assert.equal(node.getAttribute("style"), before, "Arrange clears the dragged session position");
    assert.notEqual(board.getAttribute("style"), boardDragged, "Arrange clears the derived node's manual position too");
  });

  it("keeps dragged board and clip positions with their members when an earlier board is inserted", async () => {
    const mounted = await openFlow();
    const originalBoard = all(mounted, '.fy-swnode[data-kind="board"]')[0]!;
    const originalClip = all(mounted, '.fy-swnode[data-kind="clip"]')[0]!;
    const boardId = originalBoard.getAttribute("data-testid");
    const clipId = originalClip.getAttribute("data-testid");
    assert.match(boardId ?? "", /b:sh_12:sh_13$/);
    assert.match(clipId ?? "", /c:sh_12:sh_13$/);

    await act(async () => {
      originalBoard.dispatchEvent(mouse("mousedown", 700, 150));
      dom.window.dispatchEvent(mouse("mousemove", 775, 195));
      dom.window.dispatchEvent(mouse("mouseup", 775, 195));
      originalClip.dispatchEvent(mouse("mousedown", 960, 150));
      dom.window.dispatchEvent(mouse("mousemove", 1045, 205));
      dom.window.dispatchEvent(mouse("mouseup", 1045, 205));
    });
    const boardDragged = originalBoard.getAttribute("style");
    const clipDragged = originalClip.getAttribute("style");

    const changed = structuredClone(FIXTURE_STATE) as ClientState;
    const production = changed.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as {
      version: number;
      boards?: { splits: string[]; merges: string[] };
      shots: Array<{ id: string; number: number; title: string; description: string; durationSec: number }>;
    };
    scene.version += 1;
    scene.shots = [
      { id: "sh_11", number: 11, title: "A beat before", description: "", durationSec: 2 },
      ...scene.shots,
    ];
    scene.boards = { splits: ["sh_12"], merges: [] };
    await act(async () => __setStateForTest(changed));

    const boards = all(mounted, '.fy-swnode[data-kind="board"]');
    const clips = all(mounted, '.fy-swnode[data-kind="clip"]');
    const shiftedBoard = boards.find((node) => node.textContent?.includes("Board B"))!;
    const shiftedClip = clips.find((node) => node.textContent?.includes("Clip B"))!;
    const insertedBoard = boards.find((node) => node.textContent?.includes("Board A"))!;
    assert.equal(shiftedBoard.getAttribute("data-testid"), boardId, "the same members retain the board key");
    assert.equal(shiftedClip.getAttribute("data-testid"), clipId, "the same members retain the clip key");
    assert.equal(shiftedBoard.getAttribute("style"), boardDragged);
    assert.equal(shiftedClip.getAttribute("style"), clipDragged);
    assert.notEqual(insertedBoard.getAttribute("style"), boardDragged, "the new ordinal A does not inherit B's drag");
    assert.match(shiftedBoard.getAttribute("aria-label") ?? "", /2 in, 1 out/);
    assert.match(shiftedClip.getAttribute("aria-label") ?? "", /1 in, 0 out/);
  });

  it("keeps compact board tools clear of the preceding clip", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const seed = orderedShots(scene)[0]!;
    (scene as unknown as { shots: unknown[] }).shots = Array.from({ length: 4 }, (_, index) => ({
      ...seed,
      id: `sh_8${index}`,
      number: index + 1,
      title: `Long shot ${index + 1}`,
      description: "",
      durationSec: 6,
    }));
    const mounted = await mountState(state);
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    const canvas = q(mounted, '[data-testid="workspace-flow"]')!;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 560, width: 500, height: 560, toJSON: () => ({}) }),
    });
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("resize")));

    const boards = all(mounted, '.fy-swnode[data-kind="board"]');
    const clips = all(mounted, '.fy-swnode[data-kind="clip"]');
    assert.ok(boards.length >= 2, "the long scene produces adjacent compact boards");
    assert.equal(clips.length, boards.length);
    for (let index = 0; index < clips.length - 1; index += 1) {
      const clipBottom = Number.parseFloat(clips[index]!.style.top) + Number.parseFloat(clips[index]!.style.height);
      const nextToolbar = Number.parseFloat(boards[index + 1]!.style.top) - 27;
      assert.ok(clipBottom < nextToolbar, `clip ${index + 1} clears the next board toolbar`);
    }
  });

  it("uses a compact lane before Fit would have to shrink below the readable floor", async () => {
    let notify: (() => void) | undefined;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notify = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.assign(globalThis, { ResizeObserver: TestResizeObserver });
    try {
      const mounted = await openFlow();
      const canvas = q(mounted, '[data-testid="workspace-flow"]')!;
      Object.defineProperty(canvas, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 500, bottom: 560, width: 500, height: 560, toJSON: () => ({}) }),
      });
      assert.ok(notify);
      await act(async () => notify?.());

      assert.equal(canvas.getAttribute("data-layout"), "compact");
      assert.match(all(mounted, '.fy-swnode[data-kind="shot"]')[0]!.getAttribute("style") ?? "", /left:\s*20px/);
      const board = all(mounted, '.fy-swnode[data-kind="board"]')[0]!;
      assert.match(board.getAttribute("style") ?? "", /left:\s*280px/);
      assert.match(board.getAttribute("data-testid") ?? "", /b:sh_12:sh_13$/, "board identity names its stable members");
      await click(all(mounted, ".fy-swzoom button").find((button) => button.textContent === "Arrange")!);
      assert.ok(Number.parseInt(q(mounted, ".fy-swzoom__label")?.textContent ?? "0", 10) >= 50);
    } finally {
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  });
});

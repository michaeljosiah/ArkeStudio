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
} from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { SceneFlow } from "../src/screens/scene-workspace/flow.js";

/**
 * The scene workspace (SPEC-029 R-21..R-29; T-18, T-19, T-20), behind
 * `internal.sceneWorkspace`.
 *
 * The one that matters most is T-18: the selection lives above the tabs, so switching views
 * keeps it. A per-view selection is unmounted with its view, and no amount of care inside
 * either view fixes that — which is why it is asserted rather than assumed.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
// linkedom has no layout and no frame loop; the app-wide toaster asks for both before it draws.
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
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

function stateWith(sceneWorkspace: boolean): ClientState {
  return {
    ...FIXTURE_STATE,
    app: { ...FIXTURE_STATE.app, internal: { sceneWorkspace } },
  } as ClientState;
}

interface Mounted {
  container: HTMLElement;
  root: Root;
}

const open: Mounted[] = [];

async function mount(sceneWorkspace: boolean, path = SCENE_PATH): Promise<Mounted> {
  return mountState(stateWith(sceneWorkspace), path);
}

async function mountState(state: ClientState, path = SCENE_PATH): Promise<Mounted> {
  __setStateForTest(state);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
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
const click = async (element: HTMLElement): Promise<void> => {
  await act(async () => element.click());
};
const apply = async (event: Parameters<typeof __applyEventForTest>[0]): Promise<void> => {
  await act(async () => __applyEventForTest(event));
};

describe("the flag decides whether the workspace exists at all", () => {
  it("with it off, the scene screen is the one that was always there", async () => {
    const mounted = await mount(false);
    assert.equal(q(mounted, '[data-testid="scene-workspace"]'), null);
    assert.ok(q(mounted, '[data-screen="scene-detail"]'), "the existing screen still mounts");
  });

  it("with it on, the workspace replaces it — index, views and the dock", async () => {
    const mounted = await mount(true);
    assert.ok(q(mounted, '[data-testid="scene-workspace"]'));
    assert.ok(q(mounted, '[data-testid="workspace-index"]'), "the scene index (R-22)");
    assert.ok(q(mounted, '[data-testid="workspace-rows"]'), "Storyboard is the default (R-21)");
    assert.equal(q(mounted, '[data-testid="workspace-flow"]'), null, "and Flow is not mounted yet");
  });

  it("a retired generation link reaches the workspace even before the rollout flag is on", async () => {
    const mounted = await mount(false, `${SCENE_PATH}?workspace=1`);
    assert.ok(q(mounted, '[data-testid="scene-workspace"]'));
  });
});

describe("the shell collapses rather than demanding the width (R-28)", () => {
  it("Arke can be put away and brought back, and the work keeps the room", async () => {
    const mounted = await mount(true);
    assert.ok(q(mounted, '[data-testid="workspace-subject"]'), "the dock starts open");
    const put = q(mounted, ".fy-sw__put")!;
    assert.equal(put.getAttribute("aria-pressed"), "false");

    await click(put);
    assert.equal(q(mounted, '[data-testid="workspace-subject"]'), null, "put away, not merely hidden");
    assert.equal(q(mounted, '[data-testid="scene-workspace"]')?.getAttribute("data-dock"), "false");
    assert.ok(q(mounted, '[data-testid="workspace-rows"]'), "and the rows are still there");

    await click(q(mounted, ".fy-sw__put")!);
    assert.ok(q(mounted, '[data-testid="workspace-subject"]'), "and back again");
  });
});

describe("selection survives a view switch (T-18)", () => {
  it("a shot chosen in Storyboard is the node current in Flow, and back again", async () => {
    const mounted = await mount(true);
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
    const mounted = await mount(true);
    assert.match(q(mounted, '[data-testid="workspace-subject"]')?.textContent ?? "", /Scene /);
    const row = all(mounted, '[data-testid^="workspace-row-"]')[0]!;
    await click(row.querySelector(".fy-swrow__band") as unknown as HTMLElement);
    assert.match(q(mounted, '[data-testid="workspace-subject"]')?.textContent ?? "", /Shot /);
  });

  it("a node chosen in Flow is the row Storyboard shows as current", async () => {
    const mounted = await mount(true);
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    const nodes = all(mounted, '.fy-swnode[data-kind="shot"]');
    assert.ok(nodes.length >= 2);
    await click(nodes[1]!);
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Storyboard")!);
    const selected = all(mounted, '[data-testid^="workspace-row-"] .fy-swrow__band[data-selected="true"]');
    assert.equal(selected.length, 1, "exactly one row is current, and it is the one Flow chose");
  });
});

describe("the workspace writes only named, versioned scene commands (#606)", () => {
  it("edits, reorders and inserts with stable shot ids rather than replacing scene JSON", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount(true);
    const production = FIXTURE_STATE.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shots = orderedShots(scene);

    const second = q(mounted, `[data-testid="workspace-row-${shots[1]!.id}"]`)!;
    await click(second.querySelector(".fy-swedit") as HTMLElement);
    await click([...second.querySelectorAll("button")].find((button) => button.textContent === "Move before previous") as HTMLElement);
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
      const next = structuredClone(stateWith(true)) as ClientState;
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
    assert.equal(sent.some((message) => message.kind === "save-scene"), false);
    await advance(scene.version + 2);

    const script = q(mounted, `[data-testid="workspace-row-${shots[0]!.id}"] .fy-swrow__script`)!;
    script.textContent = "The rewritten beat.";
    await act(async () => script.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
    const edit = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.deepEqual(edit.command, {
      kind: "edit-shot",
      shotId: shots[0]!.id,
      change: { description: "The rewritten beat." },
    });
    const before = sent.length;
    const key = new dom.window.Event("keydown", { bubbles: true }) as unknown as KeyboardEvent;
    Object.defineProperty(key, "key", { value: " " });
    await act(async () => script.dispatchEvent(key));
    assert.equal(sent.length, before, "typing in the script is not a row action");
  });

  it("shows prototype board bands and maps split/merge to the board override commands", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount(true);
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
    const state = structuredClone(stateWith(true)) as ClientState;
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
    const mounted = await mount(true);
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    const shots = all(mounted, '.fy-swnode[data-kind="shot"]');
    const ports = all(mounted, ".fy-swnode__port");
    await click(ports[0]!);
    await click(shots[1]!);
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.equal(command.command.kind, "move-shot");

    await click(all(mounted, '[data-testid="workspace-flow-alt"] button')[0]!);
    assert.match(q(mounted, '[data-testid="workspace-subject"]')?.textContent ?? "", /Edge /);
  });
});

describe("the generation-session handoff (SPEC-036 R-23)", () => {
  it("selects a report-linked shot from the scene route", async () => {
    const production = FIXTURE_STATE.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shot = orderedShots(scene)[1]!;
    const mounted = await mount(true, `${SCENE_PATH}?shot=${shot.id}`);
    assert.match(q(mounted, '[data-testid="workspace-subject"]')?.textContent ?? "", new RegExp(`Shot ${shot.number}`));
  });

  it("opens the chosen shot and navigates only for its matching answer", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount(true);
    const production = FIXTURE_STATE.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
    const shot = orderedShots(scene)[0]!;
    const row = q(mounted, `[data-testid="workspace-row-${shot.id}"]`)!;
    const actions = row.querySelector(".fy-swedit") as HTMLElement;
    assert.equal(actions.getAttribute("aria-label"), `Actions for shot ${shot.number}`);
    await click(actions);
    assert.equal(actions.getAttribute("aria-expanded"), "true");
    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Open in generator") as HTMLElement);
    const command = sent.findLast((message) => message.kind === "bench-open-subject");
    assert.ok(command && command.kind === "bench-open-subject");
    assert.deepEqual(command.subject, { kind: "shot", shotId: shot.id });
    assert.equal(command.productionId, "saltlight");
    assert.equal(command.sceneId, "sc_04");
    assert.ok([...row.querySelectorAll("button")].some((button) => button.textContent === "Opening…" && button.disabled));

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
    const mounted = await mount(true);
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
    const mounted = await mount(true);
    const row = q(mounted, ".fy-swrow")!;
    await click(row.querySelector(".fy-swedit") as HTMLElement);
    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Open in generator")!);
    assert.ok([...row.querySelectorAll("button")].some((button) => button.textContent === "Opening…" && button.disabled));

    await act(async () => __connectionStatusForTest("closed"));
    assert.match(mounted.container.textContent ?? "", /Connection lost - try again/);
    assert.ok([...row.querySelectorAll("button")].some((button) => button.textContent === "Open in generator" && !button.disabled));
    await act(async () => __connectionStatusForTest("open"));
  });

  it("links Flow shot and board nodes to the same subject handoff", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mount(true);
    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    const links = all(mounted, ".fy-swnode__generate");
    assert.ok(links.some((button) => button.textContent === "Open in generator"));
    assert.ok(links.some((button) => button.textContent === "Render board"));
    const shotLink = links.find((button) => button.textContent === "Open in generator")!;
    await click(shotLink);
    const command = sent.findLast((message) => message.kind === "bench-open-subject");
    assert.ok(command && command.kind === "bench-open-subject" && command.subject.kind === "shot");
    assert.ok(all(mounted, ".fy-swnode__generate").every((button) => button.hasAttribute("disabled")));
  });

  it("does not let the previous scene's delayed answer navigate back from the current scene", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = structuredClone(stateWith(true)) as ClientState;
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
    await click([...firstRow.querySelectorAll("button")].find((button) => button.textContent === "Open in generator")!);
    const command = sent.findLast((message) => message.kind === "bench-open-subject");
    assert.ok(command && command.kind === "bench-open-subject");

    const nextScene = all(mounted, ".fy-swindex__scene").find((button) => !button.hasAttribute("data-current"));
    assert.ok(nextScene);
    await click(nextScene);
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
    const state = structuredClone(stateWith(true)) as ClientState;
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
    assert.ok(all(mounted, "button").some((button) => button.textContent === "Apply changes"));

    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
    assert.equal(q(mounted, '[data-testid="flow-node-s:sh_999"]')?.getAttribute("data-staged"), "true");
    await click(all(mounted, "button").find((button) => button.textContent === "Keep discussing")!);
    assert.ok(q(mounted, '[data-testid="flow-node-s:sh_999"]'), "folding the decision does not drop the proposal");
    assert.deepEqual(sent.map((message) => message.kind), ["frame-run-list"], "Keep discussing is not a write or a discard");

    await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Storyboard")!);
    await click(q(mounted, ".fy-madeaside")!);
    await click(all(mounted, "button").find((button) => button.textContent === "Apply changes")!);
    assert.equal(sent.at(-1)?.kind, "proposal-accept");
  });
});

describe("every read-side operation is reachable by keyboard (T-19)", () => {
  it("rows, nodes, edges and tabs are all real controls, and each announces itself", async () => {
    const mounted = await mount(true);
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
    // named, and activated by Enter or Space. One node is in the tab order; arrows move within it.
    const flowNodes = all(mounted, '.fy-swnode[data-kind="shot"]');
    assert.equal(flowNodes.filter((node) => node.getAttribute("tabindex") === "0").length, 1);
    for (const node of flowNodes) {
      assert.equal(node.getAttribute("role"), "button");
      // R-63: kind, what it is, and the in/out counts a canvas would otherwise show by drawing.
      assert.match(node.getAttribute("aria-label") ?? "", /Shot \d+, shot, .*, 1 in, 1 out/);
    }
    // Edges are drawn as SVG paths, which no keyboard can reach — so the same graph is offered
    // in words, each edge naming its source and destination (R-63).
    const edges = all(mounted, '[data-testid="workspace-flow-alt"] button');
    assert.ok(edges.length > 0, "the graph is reachable in words as well as in the drawing");
    for (const edge of edges) {
      assert.equal(edge.tagName, "BUTTON");
      assert.match(edge.textContent ?? "", /goes to|is cited by/, "source and destination, said");
    }
  });

  it("the lists are semantic, so a screen reader gets the structure for free", async () => {
    const mounted = await mount(true);
    const rows = q(mounted, '[data-testid="workspace-rows"]');
    assert.equal(rows?.tagName, "OL", "shots are an ordered list because their order is meaning");
    assert.ok(rows?.getAttribute("aria-label"));
    assert.ok(q(mounted, '[data-testid="workspace-index"]')?.getAttribute("aria-label"));
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
          onRenderBoard={() => {}}
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
    production.scenes[at] = { ...(base as object), shots } as never;
    delete (production.scenes[at] as { flow?: unknown }).flow;
    state.app = { ...state.app, internal: { sceneWorkspace: true } };

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
  });
});

describe("Flow is a canvas at every width, and never the only way in (R-24, R-28 as amended)", () => {
  it("keeps the canvas narrow as well as wide, with the graph still in words", async () => {
    /*
     * The amendment: below 900px Flow is not replaced by a list. What must hold is that nothing
     * REQUIRES the canvas — every node is a control and every edge is offered in words, which
     * is the half the old narrow-width substitution never addressed at any width.
     */
    const mounted = await mount(true);
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
    const mounted = await mount(true);
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
    const node = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
    const before = node.getAttribute("style") ?? "";

    // A drag moves the node itself, not the canvas under it.
    await act(async () => {
      node.dispatchEvent(new dom.window.Event("mousedown", { bubbles: true }));
    });
    assert.ok(before.length > 0);

    const fit = all(mounted, ".fy-swzoom button").find((b) => b.textContent === "Fit")!;
    await click(fit);
    const layer = q(mounted, '[data-testid="workspace-flow-layer"]')!;
    assert.match(layer.getAttribute("style") ?? "", /scale\(/, "fit leaves a transform behind it");
  });
});

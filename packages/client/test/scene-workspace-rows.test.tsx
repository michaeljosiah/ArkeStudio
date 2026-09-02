import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { orderedShots, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The storyboard row, band and divider as the design draws them (SPEC-036 R-6..R-8, R-11): the
 * menu's order, the trailing Add shot card, the readiness line, the band's grip and icon controls,
 * and the prompt slot that hides while its disclosure is open. Same harness as
 * scene-workspace.test.tsx; these are the assertions that file did not carry.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
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

async function mountState(state: ClientState = FIXTURE_STATE): Promise<Mounted> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state);
    root.render(
      <MemoryRouter initialEntries={[SCENE_PATH]}>
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
const buttons = (scope: Element): HTMLButtonElement[] =>
  [...scope.querySelectorAll("button")] as unknown as HTMLButtonElement[];
const byText = (scope: Element, text: string): HTMLElement =>
  buttons(scope).find((button) => button.textContent?.trim() === text) as unknown as HTMLElement;

type SceneShape = {
  version: number;
  boards?: { splits: string[]; merges: string[] };
  shots: Array<{ id: string; number: number; title: string; description: string; durationSec: number; framing?: Record<string, string> }>;
};

function sceneOf(state: ClientState): SceneShape {
  const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  return production.scenes.find((candidate) => candidate.id === "sc_04")! as unknown as SceneShape;
}

describe("Storyboard rows follow the design's row anatomy (SPEC-036 R-6..R-8)", () => {
  it("orders the ··· menu as the design does and keeps reordering on the label handle", async () => {
    const mounted = await mountState();
    const row = q(mounted, ".fy-swrow")!;
    const trigger = row.querySelector(".fy-swrow__more") as unknown as HTMLElement;
    assert.ok(trigger.querySelector("svg circle"), "the trigger is the three-dot glyph, not text");
    assert.equal(trigger.getAttribute("title"), "More");
    assert.equal(row.querySelector(".fy-swrow__label")?.getAttribute("title"), "Drag to reorder");
    await click(trigger);
    assert.deepEqual(
      menuButtons().map((button) => button.textContent),
      ["Stage this shot", "Open in generator", "Advanced", "Duplicate", "Add shot after", "Delete"],
    );
  });

  it("moves a shot from the keyboard with Alt and an arrow, since the menu has no Move entries", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState();
    const shots = orderedShots(sceneOf(FIXTURE_STATE) as never);
    // The band is the focusable row (role group); the list item around it is layout.
    const rows = all(mounted, ".fy-swrow__band");
    const press = async (row: HTMLElement, key: string, altKey: boolean) => {
      const event = new dom.window.Event("keydown", { bubbles: true });
      Object.defineProperty(event, "key", { value: key });
      Object.defineProperty(event, "altKey", { value: altKey });
      await act(async () => row.dispatchEvent(event));
    };
    assert.equal(rows[0]!.getAttribute("aria-keyshortcuts"), "Alt+ArrowUp Alt+ArrowDown");
    // A command locks the rows until the coordinator answers, so the no-ops come first.
    const before = sent.length;
    await press(rows[0]!, "ArrowUp", true);
    assert.equal(sent.length, before, "the first row has nowhere up to go");
    await press(rows[1]!, "ArrowDown", false);
    assert.equal(sent.length, before, "a bare arrow is the list's to handle, not a move");
    await press(rows[1]!, "ArrowUp", true);
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.deepEqual(command.command, { kind: "move-shot", shotId: shots[1]!.id, to: { before: shots[0]!.id } });
  });

  it("appends a shot from the trailing card", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState();
    const list = q(mounted, '[data-testid="workspace-rows"]')!;
    assert.equal(list.lastElementChild?.className, "fy-swaddshot", "the card is the last item in the list");
    const add = list.querySelector(".fy-swaddshot button") as unknown as HTMLElement;
    assert.equal(add.textContent?.trim(), "Add shot");
    assert.ok(add.querySelector(".fy-swaddshot__ring svg"), "a ringed plus leads the label");
    await click(add);
    const shots = orderedShots(sceneOf(FIXTURE_STATE) as never);
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.deepEqual(command.command, {
      kind: "insert-shot",
      at: { after: shots.at(-1)!.id },
      shot: { title: "Untitled shot", description: "" },
    });
  });

  it("reads the scene's readiness under the list", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = sceneOf(state);
    for (const shot of scene.shots) shot.description = "";
    const mounted = await mountState(state);
    const line = q(mounted, ".fy-swready")!;
    assert.match(line.textContent ?? "", /2 items worth reviewing/);
    assert.equal(line.querySelector(".fy-swready__dot")?.getAttribute("data-ready"), null);
    assert.equal(line.querySelector(".fy-swready__meta")?.textContent, `scene 4 · v${scene.version}`);
    assert.ok(all(mounted, ".fy-swready").length === 1, "one line, beneath the list, not one per row");
  });

  it("puts the state dot after its label and the shot size on the title line", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = sceneOf(state);
    scene.shots[0]!.framing = { size: "wide" };
    const mounted = await mountState(state);
    const [first, second] = all(mounted, ".fy-swrow__title");
    assert.equal(first?.textContent, "Shot 12 · wide", "a framed shot names its size (notes §7.1)");
    assert.equal(second?.textContent, "Shot 13 · The lamps answer", "an unframed shot falls back to its title");
    const chip = q(mounted, ".fy-swchip")!;
    assert.equal(chip.lastElementChild?.tagName, "SPAN");
    assert.equal(chip.lastElementChild?.getAttribute("aria-hidden"), "true", "the dot follows the label");
    assert.equal(chip.firstChild?.nodeType, dom.window.Node.TEXT_NODE);
  });

  it("leads each reference chip with a round thumbnail and caps override labels at two", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    sceneOf(state).shots[0]!.framing = { size: "MCU", lens: "50mm", movement: "slow push-in" };
    const mounted = await mountState(state);
    const row = q(mounted, ".fy-swrow")!;
    const refs = [...row.querySelectorAll(".fy-swrow__ref")] as unknown as HTMLElement[];
    assert.ok(refs.length >= 2);
    for (const ref of refs) {
      assert.equal(ref.firstElementChild?.className, "fy-swrow__refthumb", "the thumb comes before the name");
      assert.match(ref.getAttribute("title") ?? "", /^(character|location|faction) · v\d+$/);
    }
    const overrides = [...row.querySelectorAll(".fy-swrow__override")] as unknown as HTMLElement[];
    assert.deepEqual(overrides.map((label) => label.textContent), ["MCU override", "50mm override"]);
    assert.ok(overrides.every((label) => label.getAttribute("title") === "overrides the scene"));
  });

  it("hides the prompt slot while its disclosure is open, and Edit opens it in place", async () => {
    const mounted = await mountState();
    const row = q(mounted, ".fy-swrow")!;
    assert.equal(row.querySelector(".fy-swrow__slot span")?.textContent, "prompt · auto");
    await click(byText(row, "Edit"));
    const prompt = row.querySelector('.fy-swrow__prompt textarea[aria-label^="Image prompt for shot"]');
    assert.equal(prompt?.getAttribute("role"), "combobox", "Edit opens the row's mention-aware prompt");
    assert.equal(row.querySelector(".fy-swrow__slot"), null, "the slot gives way to the disclosure");
    assert.ok(q(mounted, '[data-testid="workspace-rows"]'), "and nobody left the storyboard");
    assert.equal(row.querySelector(".fy-swrow__prompthead > span")?.textContent, "image prompt");
  });

  it("always offers Prompt and Rebuild, enabled only once there is something behind them", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = sceneOf(state);
    scene.shots[1]!.description = "";
    (scene.shots[1] as { promptOverride?: { text: string; sheetVersions: Record<string, never> } }).promptOverride = {
      text: "A hand-written prompt",
      sheetVersions: {},
    };
    const mounted = await mountState(state);
    const [written, blank] = all(mounted, ".fy-swrow");
    const blankPrompt = byText(blank!.querySelector(".fy-swrow__frameactions")!, "Prompt") as unknown as HTMLButtonElement;
    assert.equal(blankPrompt.disabled, true, "a blank script has no prompt to show");

    await click(byText(written!.querySelector(".fy-swrow__frameactions")!, "Prompt"));
    const rebuild = byText(written!.querySelector(".fy-swrow__prompt")!, "Rebuild") as unknown as HTMLButtonElement;
    assert.equal(rebuild.getAttribute("title"), "Rebuild from the script, references and camera");
    assert.equal(rebuild.disabled, true, "nothing to rebuild while the prompt is the assembled one");

    await click(byText(blank!, "Edit"));
    const stored = byText(blank!.querySelector(".fy-swrow__prompt")!, "Rebuild") as unknown as HTMLButtonElement;
    assert.equal(stored.disabled, false, "a stored override is something to rebuild from");
  });
});

describe("Board bands and dividers follow the design (SPEC-036 R-8, R-11)", () => {
  function split(): ClientState {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = sceneOf(state);
    scene.shots.push({ id: "sh_14", number: 14, title: "The water answers", description: "The tide turns.", durationSec: 5 });
    scene.boards = { splits: ["sh_13"], merges: [] };
    return state;
  }

  it("dresses the band with a grip, mono metadata and icon controls before Render board", async () => {
    const mounted = await mountState(split());
    await click(q(mounted, ".fy-sw__boards-toggle")!);
    const first = q(mounted, '[data-testid="workspace-board-A"]')!;
    const handle = first.querySelector(".fy-swboard__handle") as unknown as HTMLElement;
    assert.equal(handle.querySelectorAll("svg circle").length, 6, "six dots make the grip");
    assert.match(handle.textContent ?? "", /Board A/);
    const meta = [...first.querySelectorAll(".fy-swboard__meta")].map((node) => node.textContent);
    assert.equal(meta[0], "shot 12", "a one-shot board reads singular");
    assert.match(meta.at(-1) ?? "", /^\d+\.\ds \/ \d+s$/, "duration is fixed to one decimal");
    assert.match(q(mounted, '[data-testid="workspace-board-B"] .fy-swboard__meta')?.textContent ?? "", /^shots 13–14$/);

    const promptIcon = first.querySelector('button[title="Consolidated prompt"]') as unknown as HTMLElement;
    assert.ok(promptIcon.querySelector("svg path"), "the prompt control is the lines icon, not a letter");
    assert.equal(promptIcon.textContent, "");
    const sheetIcon = first.querySelector('button[title="View board sheet"]') as unknown as HTMLElement;
    assert.ok(sheetIcon.querySelector("svg rect"), "the sheet control is the grid icon");
    assert.equal(sheetIcon.querySelector("span"), null);

    const titles = buttons(first.querySelector(".fy-swboard__line")!).map((button) => button.getAttribute("title") ?? button.textContent?.trim());
    assert.deepEqual(titles, [
      "Board A",
      "Consolidated prompt",
      "View board sheet",
      "Send this board to the generator",
      "Plan video",
    ]);
    const merge = byText(q(mounted, '[data-testid="workspace-board-B"]')!, "Merge up");
    assert.equal(merge.getAttribute("title"), "Merge this board into the one above");
  });

  it("puts the insert line between a band and its first row, and makes it the drop line during a band drag", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(split());
    await click(q(mounted, ".fy-sw__boards-toggle")!);
    const item = q(mounted, '[data-testid="workspace-row-sh_13"]')!;
    assert.deepEqual(
      [...item.children].map((child) => child.className.split(" ")[0]),
      ["fy-swboard", "fy-swdivider", "fy-swrow__band"],
      "band, then the line, then the card",
    );
    const insert = item.querySelector('.fy-swdivider button[title="Insert a shot here"]') as unknown as HTMLElement;
    assert.ok(insert.querySelector("svg path"), "the insert control is the plus glyph");

    await click(q(mounted, '[data-testid="workspace-board-B"] .fy-swboard__handle')!);
    const target = q(mounted, '[data-testid="workspace-row-sh_14"] .fy-swdivider')!;
    assert.equal(target.getAttribute("data-moving"), "true");
    assert.equal(target.querySelector('button[title="Insert a shot here"]'), null, "the plus steps aside for the drop line");
    assert.equal(target.querySelectorAll(":scope > span").length, 2, "dashed rule either side of the label");
    await click(byText(target, "Move boundary here"));
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.deepEqual(command.command, { kind: "move-board-boundary", fromShotId: "sh_13", toShotId: "sh_14" });
  });
});

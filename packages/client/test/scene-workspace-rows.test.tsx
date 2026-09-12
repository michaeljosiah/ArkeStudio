import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { orderedShots, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The storyboard row, band and divider as the design draws them (SPEC-036 R-6..R-8, R-11; turn
 * 145): the Grid first and by default, the row that is a row and opens the page, the menu's order,
 * the trailing Add shot card, the readiness line, the band's grip and icon controls. Same harness
 * as scene-workspace.test.tsx; these are the assertions that file did not carry.
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
  __connectionStatusForTest("closed");
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
  it("opens on the Grid, Grid first in the control, and switches to the List without replacing the editor, draft, selection or shot order (turns 138, 145)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState();
    const list = q(mounted, '[data-testid="workspace-rows"]')!;
    assert.equal(list.dataset.layout, "grid", "the Grid is the storyboard's default (turn 145)");
    assert.equal(list.dataset.aspect, "landscape", "the fixture production is 16:9, so its cards lie down");
    assert.deepEqual(buttons(q(mounted, ".fy-sw__layouts")!).map((button) => button.textContent), ["Grid", "List"]);
    await click(byText(q(mounted, ".fy-sw__layouts")!, "List"));
    const band = q(mounted, ".fy-swrow__band")!;
    await click(band);
    const editor = band.querySelector(".fy-swrow__script textarea") as HTMLTextAreaElement;
    await act(async () => {
      editor.value = "An unfinished shot draft";
      // Linkedom does not implement React's native textarea value tracking.
      const key = Object.keys(editor).find((candidate) => candidate.startsWith("__reactProps$"))!;
      const props = (editor as unknown as Record<string, { onChange: (event: { target: HTMLTextAreaElement }) => void }>)[key]!;
      props.onChange({ target: editor });
    });
    const order = all(mounted, ".fy-swrow__band").map((row) => row.dataset.shotId);
    assert.equal(list.dataset.layout, "list");
    await click(byText(q(mounted, ".fy-sw__layouts")!, "Grid"));
    assert.equal(list.dataset.layout, "grid");
    assert.equal(q(mounted, ".fy-swrow__band"), band);
    assert.equal(band.querySelector(".fy-swrow__script textarea"), editor);
    assert.equal(editor.value, "An unfinished shot draft");
    assert.equal(band.dataset.selected, "true");
    assert.deepEqual(all(mounted, ".fy-swrow__band").map((row) => row.dataset.shotId), order);
    await click(byText(q(mounted, ".fy-sw__layouts")!, "List"));
    assert.equal(list.dataset.layout, "list");
    assert.equal(sent.filter((message) => message.kind === "scene-command").length, 0, "layout alone authors no scene change");
  });

  it("shows board controls in List and restores an ungrouped Grid without changing boards", async () => {
    const mounted = await mountState();
    await click(byText(q(mounted, ".fy-sw__layouts")!, "Grid"));
    await click(q(mounted, ".fy-sw__boards-toggle")!);
    assert.equal(q(mounted, ".fy-swrows")?.dataset.layout, "list");
    assert.ok(q(mounted, ".fy-swboard"));
    await click(byText(q(mounted, ".fy-sw__layouts")!, "Grid"));
    assert.equal(q(mounted, ".fy-swrows")?.dataset.layout, "grid");
    assert.equal(q(mounted, ".fy-swboard"), null);
    assert.equal(q(mounted, ".fy-sw__boards-toggle")?.getAttribute("aria-pressed"), "false");
  });

  it("orders the ··· menu as the design does and keeps reordering on the label handle", async () => {
    const mounted = await mountState();
    const row = q(mounted, ".fy-swrow")!;
    const trigger = row.querySelector(".fy-swrow__more") as unknown as HTMLElement;
    assert.ok(trigger.querySelector("svg circle"), "the trigger is the three-dot glyph, not text");
    assert.equal(trigger.getAttribute("title"), "More");
    assert.equal(row.querySelector(".fy-swrow__label")?.getAttribute("title"), "Open the shot · drag to reorder");
    assert.equal(row.querySelector(".fy-swrow__chevron")?.getAttribute("aria-label"), "Open shot 12", "the chevron beside the overflow opens the page");
    await click(trigger);
    // Advanced and Stage this shot left the menu (turn 145): the page is both doors.
    assert.deepEqual(
      menuButtons().map((button) => button.textContent),
      ["Open in generator", "Duplicate", "Add shot after", "Delete"],
    );
  });

  it("remembers the layout per person: the List once chosen, the Grid again once chosen back", async () => {
    const store = new Map<string, string>();
    Object.defineProperty(dom.window, "localStorage", {
      configurable: true,
      value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } },
    });
    try {
      const first = await mountState();
      await click(byText(q(first, ".fy-sw__layouts")!, "List"));
      assert.equal(store.get("arke.storyboard.layout"), "list");
      await act(async () => first.root.unmount());
      first.container.remove();
      open.splice(open.indexOf(first), 1);
      const second = await mountState();
      assert.equal(q(second, '[data-testid="workspace-rows"]')?.dataset.layout, "list", "the choice outlives the scene");
      await click(byText(q(second, ".fy-sw__layouts")!, "Grid"));
      assert.equal(store.get("arke.storyboard.layout"), "grid");
    } finally {
      Reflect.deleteProperty(dom.window, "localStorage");
    }
  });

  it("opens the page from the number, the frame, the title and the chevron, and selects on a press anywhere else (turn 145)", async () => {
    for (const door of [".fy-swrow__label", ".fy-swrow__img, .fy-swrow__hatch", ".fy-swrow__title", ".fy-swrow__chevron"]) {
      const mounted = await mountState();
      await click(byText(q(mounted, ".fy-sw__layouts")!, "List"));
      const row = q(mounted, ".fy-swrow")!;
      await click(row.querySelector(door) as HTMLElement);
      assert.ok(q(mounted, '[data-testid="shot-page"]'), `${door} opens the shot page`);
      assert.equal(q(mounted, '[data-testid="workspace-rows"]'), null);
      await act(async () => mounted.root.unmount());
      mounted.container.remove();
      open.splice(open.indexOf(mounted), 1);
    }
    const mounted = await mountState();
    await click(byText(q(mounted, ".fy-sw__layouts")!, "List"));
    const band = q(mounted, ".fy-swrow__band")!;
    await click(band.querySelector(".fy-swrow__timing") as HTMLElement);
    await click(band);
    assert.equal(band.dataset.selected, "true", "a press on the row is the selection");
    assert.ok(q(mounted, '[data-testid="workspace-rows"]'), "and it opens nothing");
    assert.equal(band.querySelector(".fy-swrow__prompt-toggle"), null, "the row carries no Frame prompt toggle (139c withdrawn)");
    assert.equal(band.getAttribute("data-open"), null, "and no row unfolds (143 withdrawn)");
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

  it("shows only exceptional state and keeps the authored title when framing is set (#931)", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const scene = sceneOf(state);
    scene.shots[0]!.framing = { size: "wide" };
    const mounted = await mountState(state);
    const [first, second] = all(mounted, ".fy-swrow__title");
    assert.equal(first?.textContent, scene.shots[0]!.title, "framing must not replace the authored title");
    assert.equal(second?.textContent, "The lamps answer", "every shot shows its title");
    const chip = q(mounted, ".fy-swchip")!;
    assert.equal(chip.firstElementChild?.tagName, "SPAN");
    assert.equal(chip.firstElementChild?.getAttribute("aria-hidden"), "true", "the exception has a decorative dot");
    assert.match(chip.textContent ?? "", /Needs frame|Needs attention/);
  });

  it("does not ask for a frame when an accepted clip makes the shot rendered", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const clip = production.takes.find((take) => take.kind === "clip")!;
    const shot = sceneOf(state).shots[0]!;
    production.selections[shot.id] = { acceptedTakeId: clip.id, trimInSec: 0 };
    const mounted = await mountState(state);
    const row = q(mounted, `[data-shot-id="${shot.id}"]`)!;
    assert.equal(row.getAttribute("data-state"), "rendered");
    assert.equal(row.querySelector(".fy-swchip"), null);
    assert.doesNotMatch(row.textContent ?? "", /Needs frame/);
  });

  it("reports the confirmed connection and version without claiming local edits are saved", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    __connectionStatusForTest("open");
    const mounted = await mountState();
    const editor = q(mounted, ".fy-swrow__script textarea") as HTMLTextAreaElement;
    await act(async () => {
      editor.value = "An unsaved local script";
      const key = Object.keys(editor).find((candidate) => candidate.startsWith("__reactProps$"))!;
      const props = (editor as unknown as Record<string, { onChange: (event: { target: HTMLTextAreaElement }) => void }>)[key]!;
      props.onChange({ target: editor });
    });
    assert.equal(editor.value, "An unsaved local script");
    assert.equal(sent.filter((message) => message.kind === "scene-command").length, 0);
    assert.equal(q(mounted, ".fy-sw__save")?.textContent, `Connected · v${sceneOf(FIXTURE_STATE).version}`);
    assert.doesNotMatch(q(mounted, ".fy-sw__save")?.textContent ?? "", /saved/i);
  });

  it("the scene dock has no language-model select above its composer", async () => {
    const mounted = await mountState();
    assert.ok(q(mounted, ".fy-arke .fy-cx"), "the composer is there");
    assert.equal(q(mounted, ".fy-arke .fy-arke__model"), null);
    assert.equal(q(mounted, '.fy-arke select[aria-label="Language model"]'), null);
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
    assert.equal(merge.getAttribute("title"), "Remove this hand split");
  });

  it("removes a hand split instead of leaving a latent merge override", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState(split());
    await click(q(mounted, ".fy-sw__boards-toggle")!);

    await click(byText(q(mounted, '[data-testid="workspace-board-B"]')!, "Merge up"));

    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.deepEqual(command.command, {
      kind: "clear-board-override",
      shotId: "sh_13",
      override: "split",
    });
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

it("shows the advisory 180-degree marker on the shot row and Flow staging node (#1045)", async () => {
  const state = structuredClone(FIXTURE_STATE);
  const scene = state.world!.productions.find(p => p.meta.id === "saltlight")!.scenes.find(s => s.id === "sc_04")!;
  const shot = orderedShots(scene)[0]!;
  shot.durationSec = 4;
  shot.staging = { version: 1, cast: [{ sheetId: "alice", x: -1, z: 0 }, { sheetId: "bob", x: 1, z: 0 }], sets: [],
    keys: [{ t: 0, p: [0, 1.5, 4], l: [0, 1, 0] }, { t: 4, p: [0, 1.5, -4], l: [0, 1, 0] }],
  };
  const mounted = await mountState(state);
  const marker = q(mounted, '.fy-swrow__titleline [title^="180° line:"]');
  assert.equal(marker?.textContent, "180° line");
  assert.match(marker?.getAttribute("title") ?? "", /crosses/);
  await click(byText(mounted.container, "Flow"));
  assert.equal(q(mounted, '.fy-swnode[data-kind="block"] [title^="180° line:"]')?.textContent, "180° line");
});

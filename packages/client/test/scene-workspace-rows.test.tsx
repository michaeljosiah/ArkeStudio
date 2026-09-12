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
  it("switches List and Grid without replacing the editor, draft, selection or shot order (turn 138)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState();
    const list = q(mounted, '[data-testid="workspace-rows"]')!;
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

  it("leads each reference chip with a round thumbnail and caps override labels at two", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    sceneOf(state).shots[0]!.framing = { size: "MCU", lens: "50mm", movement: "slow push-in" };
    const mounted = await mountState(state);
    const row = q(mounted, ".fy-swrow")!;
    await click(row.querySelector(".fy-swrow__prompt-toggle") as HTMLElement);
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

  it("opens the collapsed Frame prompt in place, as the row's own panel (turn 143)", async () => {
    const mounted = await mountState();
    const row = q(mounted, ".fy-swrow")!;
    assert.equal(row.querySelector(".fy-swrow__prompt-toggle")?.textContent, "Frame prompt");
    await click(row.querySelector(".fy-swrow__prompt-toggle") as HTMLElement);
    assert.equal(row.querySelector(".fy-swrow__band")?.getAttribute("data-open"), "true", "the toggle opens the row");
    const prompt = row.querySelector('.fy-swrow__prompt textarea[aria-label^="Image prompt for shot"]');
    assert.equal(prompt?.getAttribute("role"), "combobox", "Edit opens the row's mention-aware prompt");
    assert.equal(row.querySelector(".fy-swrow__slot"), null, "the slot gives way to the disclosure");
    assert.ok(q(mounted, '[data-testid="workspace-rows"]'), "and nobody left the storyboard");
    assert.equal(row.querySelector(".fy-swrow__panel--prompt .fy-swrow__panelhead > span")?.textContent, "Frame prompt");
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
    const blankPrompt = byText(blank!, "Frame promptAuthored") as unknown as HTMLButtonElement;
    assert.equal(blankPrompt.disabled, false, "an authored prompt remains reachable even before a script is written");

    await click(byText(written!, "Frame prompt"));
    const rebuild = byText(written!.querySelector(".fy-swrow__prompt")!, "Rebuild") as unknown as HTMLButtonElement;
    assert.equal(rebuild.getAttribute("title"), "Rebuild from the script, references and camera");
    assert.equal(rebuild.disabled, true, "nothing to rebuild while the prompt is the assembled one");

    // With the first row open the second is folded, its toggle gone with the fold; the row itself
    // opens on a press and carries the Authored mark on its timing (turn 143).
    assert.equal(blank!.querySelector(".fy-swrow__band")?.getAttribute("data-folded"), "true");
    assert.equal(blank!.querySelector(".fy-swrow__authored")?.textContent, "Authored");
    await click(blank!.querySelector(".fy-swrow__band") as HTMLElement);
    assert.equal(written!.querySelector(".fy-swrow__band")?.getAttribute("data-folded"), "true", "opening one row folds the other");
    const stored = byText(blank!.querySelector(".fy-swrow__prompt")!, "Rebuild") as unknown as HTMLButtonElement;
    assert.equal(stored.disabled, false, "a stored override is something to rebuild from");
  });
});

describe("a row opens in place and the others fold around it (design turn 143)", () => {
  const press = async (element: HTMLElement, key: string): Promise<void> => {
    const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value: key });
    await act(async () => element.dispatchEvent(event));
  };
  const reactProps = <T,>(element: Element): T => {
    const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"))!;
    return (element as unknown as Record<string, T>)[key]!;
  };

  it("one row open at a time, the open row selected, the others folded; Escape and the chevron close it", async () => {
    const mounted = await mountState();
    const [first, second] = all(mounted, ".fy-swrow__band");
    assert.equal(first!.getAttribute("data-open"), null, "nothing is open at rest");
    assert.equal(second!.getAttribute("data-folded"), null);
    assert.ok(first!.querySelector('[aria-label="Open shot 12"]'), "every row carries the chevron that opens it");

    await click(second!);
    assert.equal(second!.getAttribute("data-open"), "true");
    assert.equal(second!.getAttribute("data-selected"), "true", "open is selected: there is no selected-and-closed state");
    assert.equal(first!.getAttribute("data-folded"), "true");
    assert.equal(first!.getAttribute("data-selected"), null);
    assert.deepEqual(
      [...second!.querySelectorAll(".fy-swrow__panelhead > span:first-of-type")].map((head) => head.textContent),
      ["Description", "Frame prompt", "Notes", "Shot settings"],
      "the four panels, in the drawing's order",
    );
    assert.ok(second!.querySelector(".fy-swrow__panel--description .fy-swrow__script textarea"), "the script is edited in its panel");
    assert.equal(second!.querySelector(".fy-swrow__scriptread")?.textContent, "The lamps flare and settle.", "and read under the title");
    assert.equal(second!.querySelector('[aria-label="Close shot 13"]')?.getAttribute("aria-expanded"), "true");
    assert.equal(first!.querySelector(".fy-swrow__scriptline")?.textContent, "@maren-kest grips the rail of @the-vigil.", "a folded row keeps one line of script");
    assert.equal(first!.querySelector(".fy-swrow__frameactions"), null, "a folded strip has no hover toolbar");
    assert.equal(first!.querySelector(".fy-swrow__prompt-toggle"), null, "and no prompt toggle: the row opens to it");

    await click(first!);
    assert.equal(first!.getAttribute("data-open"), "true", "opening another row moves the open state");
    assert.equal(second!.getAttribute("data-open"), null);
    assert.equal(second!.getAttribute("data-folded"), "true");

    await press(first!, "Escape");
    assert.equal(first!.getAttribute("data-open"), null, "Escape closes the open row");
    assert.equal(second!.getAttribute("data-folded"), null, "and every row is wide again");
    assert.ok(first!.querySelector(".fy-swrow__prompt-toggle"), "with its prompt toggle back");

    await click(first!.querySelector('[aria-label="Open shot 12"]') as HTMLElement);
    assert.equal(first!.getAttribute("data-open"), "true", "the chevron opens");
    await click(first!.querySelector('[aria-label="Close shot 12"]') as HTMLElement);
    assert.equal(first!.getAttribute("data-open"), null, "and closes");
  });

  it("the location chip on the open row opens the place, and the wide row has none", async () => {
    const mounted = await mountState();
    const band = q(mounted, ".fy-swrow__band")!;
    assert.equal(band.querySelector(".fy-swrow__place"), null);
    await click(band);
    const chip = band.querySelector(".fy-swrow__place") as HTMLElement | null;
    assert.equal(chip?.textContent, "The Vigil");
    assert.equal(chip?.getAttribute("aria-haspopup"), "dialog");
    await click(chip!);
    assert.ok(q(mounted, 'dialog[aria-label="The Vigil in scene 4"]'), "the scene's place opens from the row");
  });

  it("Notes write the shot's notes on blur and clear them when emptied; Duration is a select; Aspect ratio is the production's", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const mounted = await mountState(state);
    const shots = orderedShots(sceneOf(state) as never);
    const band = q(mounted, ".fy-swrow__band")!;
    await click(band);
    const commands = () => sent.filter((message) => message.kind === "scene-command") as Array<Extract<ClientMessage, { kind: "scene-command" }>>;
    let current = state;
    const advance = async (patch: (shot: { notes?: string; durationSec?: number }) => void) => {
      const next = structuredClone(current) as ClientState;
      const scene = sceneOf(next);
      scene.version += 1;
      patch(scene.shots[0]!);
      current = next;
      await act(async () => __setStateForTest(next));
    };

    const notes = band.querySelector('[aria-label="Notes for shot 12"]') as HTMLTextAreaElement;
    assert.equal(notes.getAttribute("placeholder"), "Add notes about this shot…");
    await act(async () => reactProps<{ onChange: (event: { target: { value: string } }) => void }>(notes).onChange({ target: { value: "  Hold on the hands.  " } }));
    await act(async () => notes.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
    assert.deepEqual(commands().at(-1)?.command, { kind: "edit-shot", shotId: shots[0]!.id, change: { notes: "Hold on the hands." } });
    assert.equal(commands().length, 1, "and nothing else was written");

    await advance((shot) => { shot.notes = "Hold on the hands."; });
    await act(async () => reactProps<{ onChange: (event: { target: { value: string } }) => void }>(band.querySelector('[aria-label="Notes for shot 12"]')!).onChange({ target: { value: "" } }));
    await act(async () => band.querySelector('[aria-label="Notes for shot 12"]')!.dispatchEvent(new dom.window.Event("focusout", { bubbles: true })));
    assert.deepEqual(commands().at(-1)?.command, { kind: "edit-shot", shotId: shots[0]!.id, change: {}, clear: ["notes"] }, "an emptied note is cleared, not stored blank");

    await advance((shot) => { delete shot.notes; });
    const duration = band.querySelector('[aria-label="Duration for shot 12"]') as HTMLSelectElement;
    assert.equal(duration.tagName, "SELECT");
    assert.equal(duration.value, "4");
    assert.ok([...duration.querySelectorAll("option")].some((option) => option.value === "8"));
    await act(async () => reactProps<{ onChange: (event: { target: { value: string } }) => void }>(duration).onChange({ target: { value: "8" } }));
    assert.deepEqual(commands().at(-1)?.command, { kind: "edit-shot", shotId: shots[0]!.id, change: { durationSec: 8 } });
    assert.equal(band.querySelector('[aria-label="Edit duration for shot 12"]'), null, "the open row's timing line reads the duration the select sets");

    const aspect = band.querySelector('[aria-label="Aspect ratio for shot 12"]') as HTMLSelectElement;
    assert.equal(aspect.disabled, true, "aspect is the production's and is not changed on a shot");
    assert.equal(aspect.querySelector("option")?.value, "16:9");
  });

  it("View full prompt shows the prompt whole, and a panel folds to its head", async () => {
    const mounted = await mountState();
    const band = q(mounted, ".fy-swrow__band")!;
    await click(band);
    const prompt = band.querySelector(".fy-swrow__panel--prompt") as HTMLElement;
    assert.equal(prompt.getAttribute("data-whole"), null);
    await click(byText(prompt, "View full prompt"));
    assert.equal(prompt.getAttribute("data-whole"), "true");
    assert.ok(byText(prompt, "Show less"));
    await click(band.querySelector('[aria-label="Fold the notes for shot 12"]') as HTMLElement);
    assert.equal(band.querySelector('[aria-label="Notes for shot 12"]'), null, "a folded panel keeps only its head");
    await click(band.querySelector('[aria-label="Show the notes for shot 12"]') as HTMLElement);
    assert.ok(band.querySelector('[aria-label="Notes for shot 12"]'));
  });

  it("the Grid keeps its cards: nothing opens or folds there, and a card's prompt still hides", async () => {
    const mounted = await mountState();
    const band = q(mounted, ".fy-swrow__band")!;
    await click(band);
    assert.equal(band.getAttribute("data-open"), "true");
    await click(byText(q(mounted, ".fy-sw__layouts")!, "Grid"));
    assert.equal(band.getAttribute("data-open"), null, "a selected card is not an open row");
    assert.equal(all(mounted, '.fy-swrow__band[data-folded="true"]').length, 0);
    assert.equal(band.querySelector('[aria-label^="Open shot"]'), null, "cards carry no chevron");
    await click(band.querySelector(".fy-swrow__prompt-toggle") as HTMLElement);
    assert.equal(band.querySelector(".fy-swrow__prompthead > span")?.textContent, "image prompt");
    await click(byText(band.querySelector(".fy-swrow__prompt")!, "Hide"));
    assert.equal(band.querySelector(".fy-swrow__prompt"), null);
    await click(byText(q(mounted, ".fy-sw__layouts")!, "List"));
    assert.equal(band.getAttribute("data-open"), "true", "back in the List, the selected row is the open one");
  });

  it("switching to Grid keeps a dirty prompt in the same editor and writes an unsaved note (codex round 4)", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await mountState();
    const band = q(mounted, ".fy-swrow__band")!;
    await click(band);
    const prompt = band.querySelector(".fy-swrow__prompt textarea") as HTMLTextAreaElement;
    await act(async () => {
      prompt.value = "Kept across the switch";
      reactProps<{ onChange: (event: { target: HTMLTextAreaElement }) => void }>(prompt).onChange({ target: prompt });
    });
    const notes = band.querySelector('[aria-label="Notes for shot 12"]') as HTMLTextAreaElement;
    await act(async () => reactProps<{ onChange: (event: { target: { value: string } }) => void }>(notes).onChange({ target: { value: "Written on the switch" } }));
    // The layout button holds focus (turn 138), so neither editor blurs; the row's own leaving
    // has to keep one and write the other.
    await click(byText(q(mounted, ".fy-sw__layouts")!, "Grid"));
    assert.equal(band.getAttribute("data-open"), null);
    assert.equal(band.querySelector(".fy-swrow__prompt textarea"), prompt, "the card's prompt opens on the same editor");
    assert.equal(prompt.value, "Kept across the switch", "with the draft still in it");
    const commands = sent.filter((message) => message.kind === "scene-command") as Array<Extract<ClientMessage, { kind: "scene-command" }>>;
    assert.deepEqual(commands.map((message) => message.command), [{ kind: "edit-shot", shotId: "sh_12", change: { notes: "Written on the switch" } }], "the note, which the card has no box for, is written; the prompt is not");
    assert.equal(band.querySelector('[aria-label="Notes for shot 12"]'), null);
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

  it("offers Render board and Plan video only where the scene can be written", async () => {
    // A mutation sample found both controls' `disabled` guards untested: with `locked || staged`
    // flipped to `&&`, Plan video stayed pressable on a scene that cannot take a write. A scene
    // with no file on disk is locked and nothing on it is staged, which is the case that tells the
    // two apart.
    const open = await mountState(split());
    await click(q(open, ".fy-sw__boards-toggle")!);
    const band = (m: Mounted) => q(m, '[data-testid="workspace-board-A"] .fy-swboard__line')!;
    const control = (m: Mounted, text: string) => [...band(m).querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as unknown as HTMLButtonElement;
    assert.equal(control(open, "Plan video").disabled, false, "a scene that can be written offers the plan");
    assert.equal(control(open, "Render board").disabled, false);
    await act(async () => open.root.unmount());

    const state = split();
    const production = state.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    delete production.sceneFiles["sc_04"];
    const locked = await mountState(state);
    await click(q(locked, ".fy-sw__boards-toggle")!);
    assert.equal(control(locked, "Plan video").disabled, true, "no file to write the plan against");
    assert.equal(control(locked, "Render board").disabled, true);
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

describe("the band's chip says what the character brings to the shot (SPEC-044 R-22)", () => {
  it("reads voice · look where the character speaks, look where only cited, nothing for the place, and opens the dialog", async () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    state.world!.sheets.push({ id: "bray-half-hitch", type: "character", name: "Bray Half-Hitch", version: 2, status: "draft", canonRules: [], links: [], created: "2026-05-02", updated: "2026-05-02", sections: [] } as never);
    sceneOf(state).shots[1]!.description += " @bray-half-hitch on the stair";
    const mounted = await mountState(state);
    const rows = all(mounted, ".fy-swrow");
    const words = (row: HTMLElement) => [...row.querySelectorAll(".fy-swrow__ref")].map((chip) => chip.querySelector(".fy-swrow__refwords")?.textContent ?? null);
    // The chips ride on the open row's prompt panel, and one row is open at a time (turn 143).
    await click(rows[1]!.querySelector(".fy-swrow__band") as HTMLElement);
    assert.deepEqual(words(rows[1]!), ["look"], "cited in shot 13, silent there");
    await click(rows[0]!.querySelector(".fy-swrow__band") as HTMLElement);
    assert.match(rows[0]!.textContent ?? "", /Maren Kest.*The Vigil/);
    assert.deepEqual(words(rows[0]!), ["voice · look", null], "she speaks in shot 12 and is cited; the place brings no words");
    assert.equal(rows[0]!.querySelector(".fy-swrow__ref--door")?.getAttribute("aria-haspopup"), "dialog");
    await click(rows[0]!.querySelector(".fy-swrow__ref--door") as HTMLElement);
    assert.equal(q(mounted, ".fy-chardialog")?.getAttribute("aria-label"), "Maren Kest in scene 4");
  });
});

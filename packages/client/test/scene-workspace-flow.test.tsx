import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import { orderedShots, type ClientMessage } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { SceneFlow } from "../src/screens/scene-workspace/flow.js";
import { boardsForScene } from "../src/screens/scene-workspace/boards.js";

/**
 * Flow's cards, hover toolbar and context menus (the prototype's §11.1, §11.5 and §11.6).
 *
 * The menu is the one that matters: before it, Delete was a key and Duplicate did not exist on
 * this surface, and SPEC-029 R-64 assumes a pointer path to the same confirmation. It has to be
 * reachable without a pointer too, which is what the toolbar's More button is for.
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
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(FIXTURE_STATE);
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
const mouse = (type: string, x: number, y: number): Event => {
  const event = new dom.window.Event(type, { bubbles: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
};
const key = (name: string, shiftKey = false): Event => {
  const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, { key: { value: name }, shiftKey: { value: shiftKey } });
  return event;
};
const contextMenu = (): Event => new dom.window.Event("contextmenu", { bubbles: true, cancelable: true });
const tick = async (): Promise<void> => {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
};

const openFlow = async (): Promise<Mounted> => {
  const mounted = await mount();
  await click(all(mounted, ".fy-sw__tab").find((tab) => tab.textContent === "Flow")!);
  return mounted;
};
// Asserted as a boolean, never as the element: a failed `assert.equal(element, null)` inspects
// the element, and inspecting a linkedom node walks the whole document until memory runs out.
const menu = (m: Mounted): HTMLElement | null => q(m, ".fy-swcanvas__menu");
const menuOpen = (m: Mounted): boolean => menu(m) !== null;
const items = (m: Mounted): string[] => all(m, '.fy-swcanvas__menu [role="menuitem"]').map((item) => item.textContent ?? "");
const item = (m: Mounted, label: string): HTMLElement =>
  all(m, '.fy-swcanvas__menu [role="menuitem"]').find((candidate) => candidate.textContent === label)!;

/** linkedom tracks no focus, so the tests that care record it themselves. */
function trackFocus(): { focused: () => HTMLElement | null; restore: () => void } {
  const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
  const originalFocus = proto.focus;
  const active = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
  let focused: HTMLElement | null = null;
  proto.focus = function focus() { focused = this as unknown as HTMLElement; };
  Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused });
  return {
    focused: () => focused,
    restore: () => {
      proto.focus = originalFocus;
      if (active === undefined) Reflect.deleteProperty(dom.document, "activeElement");
      else Object.defineProperty(dom.document, "activeElement", active);
    },
  };
}

/** The view on its own, for the entries only the workspace can wire. */
async function mountFlow(props: Partial<Parameters<typeof SceneFlow>[0]> = {}): Promise<Mounted> {
  const world = FIXTURE_STATE.world!;
  const production = world.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  const scene = production.scenes.find((candidate) => candidate.id === "sc_04")!;
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <SceneFlow
        scene={scene}
        production={production}
        sheets={world.sheets}
        artifacts={world.artifacts}
        slug={world.meta.slug}
        boardPack={boardsForScene({ scene, production, artifacts: world.artifacts, sheets: world.sheets, capSec: 30 })}
        stagedShotIds={new Set()}
        newShotIds={new Set()}
        stagedBoards={false}
        locked={false}
        generatorPending={false}
        onCommand={() => true}
        onOpenShotInGenerator={() => {}}
        onRenderBoard={() => {}}
        onTalkToArke={() => {}}
        {...props}
      />,
    ),
  );
  const mounted = { container, root };
  open.push(mounted);
  return mounted;
}

describe("Flow context menus (§11.6)", () => {
  it("right-click on a shot opens its menu, and Duplicate sends one command", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await openFlow();
    const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
    const contextEvent = contextMenu();
    await act(async () => shot.dispatchEvent(contextEvent));
    assert.equal(contextEvent.defaultPrevented, true, "the browser's own menu never shows");

    const panel = menu(mounted);
    assert.ok(panel, "a menu opens");
    assert.equal(panel.getAttribute("role"), "menu");
    assert.equal(panel.getAttribute("aria-label"), `Actions for ${shot.querySelector(".fy-swnode__name")?.textContent}`);
    assert.equal(panel.querySelector(".fy-swcanvas__menu-title")?.textContent, shot.querySelector(".fy-swnode__name")?.textContent);
    assert.ok(panel.closest('[data-testid="workspace-flow"]'), "and lives inside the canvas it is clamped to");
    assert.doesNotMatch(panel.getAttribute("style") ?? "", /NaN/);
    const listed = items(mounted);
    assert.ok(listed.includes("Open in generator"));
    assert.ok(listed.includes("Duplicate"));
    assert.equal(listed.at(-1), "Delete", "the destructive entry comes last");
    assert.ok(item(mounted, "Delete").classList.contains("fy-swcanvas__danger"));
    assert.equal(shot.getAttribute("data-selected"), "true", "right-clicking a node selects it");

    await click(item(mounted, "Duplicate"));
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.deepEqual(command.command, { kind: "duplicate-shot", shotId: shot.getAttribute("data-shot-id") });
    assert.equal(menuOpen(mounted), false,"an action closes the menu");
  });

  it("opens with focus on the first entry, roves with the arrows, and Escape hands focus back", async () => {
    const focus = trackFocus();
    try {
      const mounted = await openFlow();
      const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
      await act(async () => shot.dispatchEvent(contextMenu()));
      assert.equal(focus.focused()?.textContent, "Open in generator", "opening moves focus into the menu");
      await act(async () => menu(mounted)!.dispatchEvent(key("ArrowDown")));
      assert.equal(focus.focused()?.getAttribute("role"), "menuitem");
      assert.notEqual(focus.focused()?.textContent, "Open in generator", "arrows traverse the entries");
      await act(async () => menu(mounted)!.dispatchEvent(key("End")));
      assert.equal(focus.focused()?.textContent, "Delete");

      await act(async () => menu(mounted)!.dispatchEvent(key("Escape")));
      await tick();
      assert.equal(menuOpen(mounted), false,"Escape closes the menu");
      assert.equal(focus.focused(), shot, "and the node that opened it has focus again");
    } finally {
      focus.restore();
    }
  });

  it("closes on a mousedown anywhere else", async () => {
    const mounted = await openFlow();
    const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
    await act(async () => shot.dispatchEvent(contextMenu()));
    assert.ok(menu(mounted));
    await act(async () => menu(mounted)!.dispatchEvent(mouse("mousedown", 10, 10)));
    assert.ok(menu(mounted), "a press inside the menu keeps it");
    await act(async () => all(mounted, '.fy-swnode[data-kind="shot"]')[1]!.dispatchEvent(mouse("mousedown", 10, 10)));
    assert.equal(menuOpen(mounted), false,"a press on another node dismisses it");
  });

  it("the toolbar's More button opens the same menu without a pointer, and Delete opens the confirmation", async () => {
    const mounted = await openFlow();
    const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
    const tools = shot.querySelector(".fy-swnode__tools");
    assert.ok(tools, "a node carries its hover toolbar");
    const more = shot.querySelector('button[aria-label^="More actions"]') as HTMLElement | null;
    assert.ok(more, "with a More button in it");
    assert.equal(more.getAttribute("aria-haspopup"), "menu");
    assert.equal(more.getAttribute("aria-expanded"), "false");
    assert.ok(shot.querySelector('.fy-swnode__tool--move[aria-hidden="true"]'), "the drag handle is pointer-only: the card itself already drags");

    await click(more);
    assert.ok(menu(mounted));
    assert.equal(more.getAttribute("aria-expanded"), "true");

    await click(item(mounted, "Delete"));
    assert.equal(menuOpen(mounted), false);
    const dialog = q(mounted, '.fy-swlinkhint[role="alertdialog"]');
    assert.ok(dialog, "Delete opens the same confirmation the Delete key does (R-64)");
    assert.match(dialog.getAttribute("aria-label") ?? "", /^Delete shot \d+\?$/);
  });

  it("Shift+F10 on a focused node opens its menu, and keys on the toolbar are not the node's", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await openFlow();
    const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
    await act(async () => shot.dispatchEvent(key("F10", true)));
    assert.ok(menu(mounted), "the standard context-menu key works too");
    await act(async () => menu(mounted)!.dispatchEvent(key("Escape")));
    await tick();

    const more = shot.querySelector('button[aria-label^="More actions"]') as HTMLElement;
    await act(async () => more.dispatchEvent(key("Enter")));
    assert.equal(sent.some((message) => message.kind === "bench-open-subject"), false, "Enter on a toolbar button does not open the generator");
  });

  it("right-click on the ground offers Add shot and Arrange, and Add shot lands after the last shot", async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest(capture(sent));
    const mounted = await openFlow();
    const canvas = q(mounted, '[data-testid="workspace-flow"]')!;
    await act(async () => canvas.dispatchEvent(contextMenu()));
    assert.deepEqual(items(mounted), ["Add shot", "Arrange"]);
    assert.equal(q(mounted, ".fy-swcanvas__menu-title")?.textContent, "canvas");

    await click(item(mounted, "Add shot"));
    const production = FIXTURE_STATE.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const last = orderedShots(production.scenes.find((candidate) => candidate.id === "sc_04")!).at(-1)!;
    const command = sent.at(-1) as Extract<ClientMessage, { kind: "scene-command" }>;
    assert.deepEqual(command.command, {
      kind: "insert-shot",
      at: { after: last.id },
      shot: { title: "Untitled shot", description: "" },
    });

    // Entry has no menu of its own, so a right-click on it is a right-click on the ground.
    await act(async () => q(mounted, '.fy-swnode[data-kind="entry"]')!.dispatchEvent(contextMenu()));
    assert.equal(q(mounted, ".fy-swcanvas__menu-title")?.textContent, "canvas");
    await click(item(mounted, "Arrange"));
    assert.equal(menuOpen(mounted), false);
  });

  it("board and shot menus carry the optional entries only when the workspace wires them", async () => {
    const opened: string[][] = [];
    const edited: string[] = [];
    const staged: string[] = [];
    let shown = 0;
    const mounted = await mountFlow({
      onViewBoardSheet: (memberShotIds) => opened.push(memberShotIds),
      onEditShot: (shotId) => edited.push(shotId),
      onOpenStage: (shotId) => staged.push(shotId),
      onShowBoards: () => { shown += 1; },
    });
    const board = all(mounted, '.fy-swnode[data-kind="board"]')[0]!;
    await act(async () => board.dispatchEvent(contextMenu()));
    // Staging is per shot and board scope is deferred, so a board of two offers none.
    assert.deepEqual(items(mounted), ["Render board", "View board sheet", "Show boards"]);
    await click(item(mounted, "View board sheet"));
    assert.deepEqual(opened, [["sh_12", "sh_13"]], "the sheet opens for the board's members");

    const clip = all(mounted, '.fy-swnode[data-kind="clip"]')[0]!;
    await act(async () => clip.dispatchEvent(contextMenu()));
    assert.deepEqual(items(mounted), ["Render board", "View board sheet", "Show boards"], "a clip's menu is its board's");
    assert.deepEqual(staged, [], "nothing on a board promises a staging it cannot give");
    await click(item(mounted, "Show boards"));
    assert.equal(shown, 1);

    const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
    await act(async () => shot.dispatchEvent(contextMenu()));
    assert.deepEqual(items(mounted), ["Open in generator", "Stage this shot", "Advanced", "Duplicate", "Delete"]);
    await click(item(mounted, "Advanced"));
    assert.deepEqual(edited, ["sh_12"]);

    const details = shot.querySelector('button[aria-label^="Details of"]') as HTMLElement | null;
    assert.ok(details, "with an editor wired, the toolbar offers details");
    await click(details);
    assert.deepEqual(edited, ["sh_12", "sh_12"]);
    const larger = board.querySelector('button[aria-label$="larger"]') as HTMLElement | null;
    assert.ok(larger, "and a board's toolbar opens the sheet larger");
    await click(larger);
    assert.deepEqual(opened, [["sh_12", "sh_13"], ["sh_12", "sh_13"]]);
  });

  it("without those props the entries and toolbar buttons are absent rather than inert", async () => {
    const mounted = await mountFlow();
    const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
    await act(async () => shot.dispatchEvent(contextMenu()));
    assert.deepEqual(items(mounted), ["Open in generator", "Duplicate", "Delete"]);
    assert.equal(shot.querySelector('button[aria-label^="Details of"]') === null, true);
    const board = all(mounted, '.fy-swnode[data-kind="board"]')[0]!;
    await act(async () => board.dispatchEvent(contextMenu()));
    assert.deepEqual(items(mounted), ["Render board"]);
    assert.equal(board.querySelector('button[aria-label$="larger"]') === null, true);
  });
});

describe("Flow cards follow the prototype (§11.1)", () => {
  it("a shot card is a frame strip beside its name, length, title, camera line and run button", async () => {
    const mounted = await openFlow();
    const production = FIXTURE_STATE.world!.productions.find((candidate) => candidate.meta.id === "saltlight")!;
    const shots = orderedShots(production.scenes.find((candidate) => candidate.id === "sc_04")!);
    for (const node of all(mounted, '.fy-swnode[data-kind="shot"]')) {
      const shot = shots.find((candidate) => candidate.id === node.getAttribute("data-shot-id"))!;
      const strip = node.querySelector(".fy-swnode__strip") as HTMLElement | null;
      assert.ok(strip, "a frame strip on the left");
      const frame = strip.querySelector(".fy-swnode__frame");
      // No frame is a hatched strip, not a missing element.
      assert.equal(strip.getAttribute("data-empty"), frame === null ? "true" : null);
      assert.equal(node.querySelector(".fy-swnode__name")?.textContent, `Shot ${shot.number}`);
      assert.equal(node.querySelector(".fy-swnode__dur")?.textContent, `${(shot.durationSec ?? 4).toFixed(1)}s`);
      assert.equal(node.querySelector(".fy-swnode__title")?.textContent, shot.title);
      assert.ok(node.querySelector(".fy-swnode__foot .fy-swnode__meta"), "the camera line, even when nothing is set");
      const run = node.querySelector(".fy-swnode__run") as HTMLElement | null;
      assert.ok(run);
      assert.equal(run.textContent, frame === null ? "Generate" : "Regenerate", "the run label knows whether a frame exists");
      assert.match(node.getAttribute("aria-label") ?? "", new RegExp(`^Shot ${shot.number}, shot, .*${shot.title}.*, \\d+ in, \\d+ out$`));
    }
    assert.ok(all(mounted, ".fy-swnode__generate").length === 0, "the floating pill above the card is gone");
  });

  it("a board card says its members, its cells and its length against the cap, with Render inside", async () => {
    const rendered: string[][] = [];
    const mounted = await mountFlow({ capSec: 30, onRenderBoard: (memberShotIds) => rendered.push(memberShotIds) });
    const board = all(mounted, '.fy-swnode[data-kind="board"]')[0]!;
    assert.equal(board.querySelector(".fy-swnode__meta")?.textContent, "shots 12–13 · 2 cells");
    assert.match(board.querySelector(".fy-swnode__dur")?.textContent ?? "", /^\d+\.\ds \/ 30s$/);
    const run = board.querySelector(".fy-swnode__run") as HTMLElement | null;
    assert.ok(run);
    assert.equal(run.textContent, "Render");
    await click(run);
    assert.deepEqual(rendered, [["sh_12", "sh_13"]]);
  });

  it("a board card in the workspace says its length against the cap the rows pack with", async () => {
    // The workspace always knows the cap (it packs the rows with it), so the canvas prints both;
    // a caller with no cap gets the bare length, which the direct-render test above pins.
    const mounted = await openFlow();
    const board = all(mounted, '.fy-swnode[data-kind="board"]')[0]!;
    assert.match(board.querySelector(".fy-swnode__dur")?.textContent ?? "", /^\d+\.\ds \/ \d+s$/);
  });

  it("a clip card is a reel with a play badge and its length, and a footer with its run button", async () => {
    const mounted = await openFlow();
    const clip = all(mounted, '.fy-swnode[data-kind="clip"]')[0]!;
    const reel = clip.querySelector(".fy-swnode__reel") as HTMLElement | null;
    assert.ok(reel);
    assert.ok(reel.querySelector(".fy-swnode__frame") ?? reel.querySelector(".fy-swnode__noframes"), "a member frame, or the hatch that says none yet");
    assert.ok(reel.querySelector(".fy-swnode__play svg"), "a play badge");
    assert.match(reel.querySelector(".fy-swnode__corner")?.textContent ?? "", /^\d+\.\ds$/);
    assert.match(clip.querySelector(".fy-swnode__meta")?.textContent ?? "", /^(rendered|not rendered) · \d+\.\ds$/);
    assert.match(clip.querySelector(".fy-swnode__run")?.textContent ?? "", /^(Render clip|Re-render)$/);
  });

  it("a reference card shows the sheet's portrait above its caption", async () => {
    const mounted = await openFlow();
    const ref = all(mounted, '.fy-swnode[data-kind="ref"]').find((node) => node.textContent?.includes("Maren Kest"));
    assert.ok(ref, "the cited character is a reference node");
    const thumb = ref.querySelector('.fy-swnode__thumb[role="img"]') as HTMLElement | null;
    assert.ok(thumb, "with a portrait");
    assert.match(thumb.getAttribute("style") ?? "", /references\/maren-kest\/head-front\.png/);
    assert.equal(thumb.getAttribute("aria-label"), "Maren Kest");
  });
});

describe("Flow canvas controls (§11.4, §11.8)", () => {
  it("the zoom bar draws icons, a divider and Arrange", async () => {
    const mounted = await openFlow();
    const zoomOut = all(mounted, ".fy-swzoom button").find((button) => button.getAttribute("aria-label") === "Zoom out")!;
    const zoomIn = all(mounted, ".fy-swzoom button").find((button) => button.getAttribute("aria-label") === "Zoom in")!;
    assert.ok(zoomOut.querySelector("svg"), "a glyph, not a character");
    assert.ok(zoomIn.querySelector("svg"));
    assert.ok(q(mounted, ".fy-swzoom__divider"));
    const arrange = all(mounted, ".fy-swzoom button").find((button) => button.textContent === "Arrange");
    assert.ok(arrange);
    assert.equal(arrange.getAttribute("title"), "Reset the layout");
    assert.equal(all(mounted, ".fy-swzoom button").some((button) => button.textContent === "Fit"), false);
  });

  it("a dashed wire follows the pointer while a link is being chosen", async () => {
    const mounted = await openFlow();
    const canvas = q(mounted, '[data-testid="workspace-flow"]')!;
    assert.equal(q(mounted, '[data-testid="flow-link-wire"]') === null, true);
    await click(all(mounted, ".fy-swnode__port")[0]!);
    assert.equal(q(mounted, '[data-testid="flow-link-wire"]') === null, true, "nothing to draw until the pointer has moved");
    await act(async () => canvas.dispatchEvent(mouse("mousemove", 640, 300)));
    const wire = q(mounted, '[data-testid="flow-link-wire"]');
    assert.ok(wire, "a wire from the port to the pointer");
    assert.equal(wire.getAttribute("stroke-dasharray"), "3 3");
    assert.match(wire.getAttribute("d") ?? "", /^M[\d.-]+,[\d.-]+ L[\d.-]+,[\d.-]+$/);
    await click(q(mounted, ".fy-swlinkhint button")!);
    assert.equal(q(mounted, '[data-testid="flow-link-wire"]') === null, true, "cancelling takes the wire with it");
  });

  it("ports and sockets are 14px rings centred on the card edges", async () => {
    const mounted = await openFlow();
    const shot = all(mounted, '.fy-swnode[data-kind="shot"]')[0]!;
    const left = Number.parseFloat(shot.style.left);
    const top = Number.parseFloat(shot.style.top);
    const port = all(mounted, ".fy-swnode__port")[0]!;
    assert.equal(Number.parseFloat(port.style.left), left + 232 - 7);
    assert.equal(Number.parseFloat(port.style.top), top + 48 - 7);
    const socket = all(mounted, '.fy-swnode__socket[data-port="in"]')[0]!;
    assert.equal(Number.parseFloat(socket.style.left), left - 7);
  });

  it("the corner hint says right-click, and shots sit at the prototype's pitch", async () => {
    const mounted = await openFlow();
    assert.equal(q(mounted, ".fy-swcanvas__hint")?.textContent, "right-click for actions");
    const shots = all(mounted, '.fy-swnode[data-kind="shot"]');
    assert.equal(Number.parseFloat(shots[1]!.style.top) - Number.parseFloat(shots[0]!.style.top), 118);
  });
});

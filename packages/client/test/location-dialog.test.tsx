import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ClientMessage, ClientState, SceneRecord, WorldBundle } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { LocationDialog } from "../src/screens/scene-workspace/location-dialog.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/** The scene's place (SPEC-044 R-17..R-21): one row of views, and the plate follows the press. */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});

const AT = "2026-09-09T10:00:00.000Z";
const view = (id: string, name: string, file: string) => ({ id, name, file, sourceTakeId: "tk_01J8E0000000000000000000T1", sheetVersion: 2, artDirectionVersion: 3, acceptedAt: AT, status: "active" });

function stateFor(options: { sceneView?: boolean; kit?: false } = {}): ClientState {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  const world = state.world!;
  if (options.kit === false) return state;
  world.referenceKits.push({
    sheetId: "the-vigil", tiles: [], compilations: [], establishingViewId: "v-establishing",
    locationViews: [view("v-establishing", "Establishing view", "views/establishing.png"), view("v-door", "From the door", "views/door.png")],
    looks: options.sceneView ? [{ id: "v-door", file: "views/door.png", kind: "view", prompt: "From the door", acceptedAt: AT, attachedTo: { kind: "scene", productionId: "saltlight", sceneId: "sc_04" } }] : [],
  } as never);
  return state;
}

const open: Array<{ container: HTMLElement; root: Root }> = [];
afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  __setBridgeForTest(null);
});

async function mount(state: ClientState) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => { sent.push(JSON.parse(json) as ClientMessage); } } as unknown as ArkeBridge);
  __setStateForTest(state);
  const world = state.world as WorldBundle;
  const production = world.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  const scene = production.scenes.find((candidate) => candidate.id === "sc_04") as SceneRecord;
  const closes = { count: 0 }, changes = { count: 0 };
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <LocationDialog world={world} production={production} scene={scene} onClose={() => { closes.count += 1; }} onChangeLocation={() => { changes.count += 1; }} />
      </MemoryRouter>,
    );
  });
  open.push({ container, root });
  return { container, sent, closes, changes };
}
const cards = (container: HTMLElement) =>
  [...container.querySelectorAll(".fy-chardialog__card")].map((card) => [card.getAttribute("aria-label"), card.getAttribute("aria-pressed")]);
const click = async (element: Element | null) => act(async () => (element as HTMLElement).click());

describe("the location dialog (SPEC-044 R-18, R-19, R-21)", () => {
  it("shows the place, its facts and the Plate row with the kit's establishing view in use", async () => {
    const { container, sent, changes, closes } = await mount(stateFor());
    assert.equal(container.querySelector(".fy-chardialog")?.getAttribute("aria-label"), "The Vigil in scene 4");
    assert.equal(container.querySelector(".fy-chardialog__facts")?.textContent, "location · sheet v2 · every shot in the scene · night");
    assert.match(container.querySelector(".fy-chardialog__picture img")?.getAttribute("src") ?? "", /views\/establishing\.png/);
    assert.deepEqual(cards(container), [["Establishing view · kit", "true"], ["From the door · view", "false"], ["Add a plate · Location page", null]]);
    await click(container.querySelector('[aria-label="From the door · view"]'));
    assert.deepEqual(sent.at(-1), { kind: "attach-character-look", worldId: FIXTURE_WORLD_ID, sheetId: "the-vigil", lookId: "v-door", scope: { kind: "scene", productionId: "saltlight", sceneId: "sc_04" } });
    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Change location") ?? null);
    assert.equal(changes.count, 1);
    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Done") ?? null);
    assert.equal(closes.count, 1);
    assert.doesNotMatch(container.textContent ?? "", /sha256|sh_\d+/, "no hash or shot id on the dialog");
  });

  it("rings nothing when the place has no kit: only the door stands in the row", async () => {
    const { container } = await mount(stateFor({ kit: false }));
    assert.deepEqual(cards(container), [["Add a plate · Location page", null]]);
  });

  it("rings the view attached to this scene, shows it as the plate, and the establishing view's press detaches it", async () => {
    const { container, sent } = await mount(stateFor({ sceneView: true }));
    assert.match(container.querySelector(".fy-chardialog__picture img")?.getAttribute("src") ?? "", /views\/door\.png/);
    assert.deepEqual(cards(container).slice(0, 2), [["Establishing view · kit", "false"], ["From the door · this scene", "true"]]);
    await click(container.querySelector('[aria-label="Establishing view · kit"]'));
    assert.deepEqual(sent.at(-1), { kind: "attach-character-look", worldId: FIXTURE_WORLD_ID, sheetId: "the-vigil", lookId: "v-door", scope: null });
  });
});

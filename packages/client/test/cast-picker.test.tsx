import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { orderedShots, type ClientState, type SceneRecord, type Sheet, type WorldBundle } from "@arke-studio/contracts";
import { CastPicker, sceneCast, type CastPickerMode } from "../src/screens/scene-workspace/cast-picker.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The picker behind both doors (SPEC-044 R-4): what it offers, in which band, and what a press
 * does. The commands a press turns into are the workspace's, and asserted there.
 */

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

const sheet = (id: string, name: string, extra: Partial<Sheet> = {}): Sheet =>
  ({ id, type: "character", name, version: 2, status: "draft", canonRules: [], links: [], created: "2026-05-02", updated: "2026-05-02", sections: [], ...extra }) as Sheet;

function world(extra: Sheet[] = []): WorldBundle {
  const state = structuredClone(FIXTURE_STATE) as ClientState;
  state.world!.sheets.push(...extra);
  return state.world!;
}
const sceneOf = (bundle: WorldBundle): SceneRecord =>
  bundle.productions.find((production) => production.meta.id === "saltlight")!.scenes.find((candidate) => candidate.id === "sc_04")!;

const open: Array<{ container: HTMLElement; root: Root }> = [];
afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

async function mount(bundle: WorldBundle, mode: CastPickerMode, picks: string[], closes: { count: number }, scene = sceneOf(bundle)) {
  const production = bundle.productions.find((candidate) => candidate.meta.id === "saltlight")!;
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CastPicker world={bundle} production={production} scene={scene} mode={mode} onPick={(id) => picks.push(id)} onClose={() => { closes.count += 1; }} />,
    );
  });
  open.push({ container, root });
  return container;
}
const cards = (container: HTMLElement) =>
  [...container.querySelectorAll(".fy-castpicker__section")].map((section) => [
    section.querySelector(".fy-castpicker__label")?.textContent,
    [...section.querySelectorAll(".fy-castpicker__card")].map((card) => card.getAttribute("aria-label")),
  ]);
const click = async (element: Element | null) => act(async () => (element as HTMLElement).click());

describe("the cast picker (SPEC-044 R-4)", () => {
  it("offers the production's own cast first, then the world's, leaves another production's guests out, and marks who is already here", async () => {
    const bundle = world([
      sheet("odile", "Odile"),
      sheet("ilo", "Ilo", { production: "saltlight" }),
      sheet("tam", "Tam Reyes", { production: "other" }),
    ]);
    const picks: string[] = [], closes = { count: 0 };
    const container = await mount(bundle, "character", picks, closes);
    assert.equal(container.querySelector(".fy-castpicker")?.getAttribute("aria-label"), "Add a character · scene 4");
    assert.deepEqual(cards(container), [
      ["In Saltlight", ["Maren Kest · in the scene", "Ilo"]],
      ["From the world", ["Odile"]],
    ]);
    const maren = container.querySelector('[aria-label="Maren Kest · in the scene"]') as HTMLButtonElement;
    assert.equal(maren.disabled, true);
    assert.equal(maren.querySelector(".fy-castpicker__meta")?.textContent, "in the scene");
    await click(maren);
    assert.deepEqual(picks, [], "a member already here does nothing when pressed");
    await click(container.querySelector('[aria-label="Odile"]'));
    assert.deepEqual(picks, ["odile"]);
    await click(container.querySelector('[aria-label="Close"]'));
    assert.equal(closes.count, 1);
  });

  it("lists locations only behind the place doors, with the scene's own place inert under Change location", async () => {
    const bundle = world([sheet("the-weigh-house", "The Weigh House", { type: "location" })]);
    const picks: string[] = [], closes = { count: 0 };
    const container = await mount(bundle, "change-location", picks, closes);
    assert.equal(container.querySelector(".fy-castpicker")?.getAttribute("aria-label"), "Change location");
    assert.deepEqual(cards(container), [
      ["In Saltlight", ["The Vigil · in the scene"]],
      ["From the world", ["The Weigh House"]],
    ]);
    await click(container.querySelector('[aria-label="The Weigh House"]'));
    assert.deepEqual(picks, ["the-weigh-house"]);
  });

  it("orders the row by first appearance, then by hand, and keeps a member whose shot is gone (R-1, R-5)", () => {
    const bundle = world([sheet("odile", "Odile"), sheet("bray-half-hitch", "Bray Half-Hitch")]);
    const scene = sceneOf(bundle);
    orderedShots(scene)[1]!.description += " @bray-half-hitch on the stair";
    assert.deepEqual(sceneCast(scene, bundle.sheets), ["maren-kest", "bray-half-hitch"], "the first shot cites Maren, the second Bray");
    const withMembers = { ...scene, cast: { odile: { added: "2026-09-09T10:00:00.000Z" }, "maren-kest": { voice: { kind: "sample" as const } }, gone: {} } };
    assert.deepEqual(sceneCast(withMembers, bundle.sheets), ["maren-kest", "bray-half-hitch", "odile", "gone"]);
  });
});

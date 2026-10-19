import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage, WorldBundle } from "@arke-studio/contracts";
import { PlateChip, type PlateCandidate } from "../src/screens/scene-workspace/stage-plate.js";
import { __connectionStatusForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The plate picker (design turn 231f, issue 1896): the world's locations first, every other
 * picture behind Show all pictures, Generate through the location's own flow and Upload through
 * the world's import, each ending on the picture it brought in, and Cancel and Use plate.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
// linkedom's <dialog> has neither method (as generation-dialog.test.tsx says).
Object.assign(dom.HTMLElement.prototype, {
  showModal(this: HTMLDialogElement) { (this as { open: boolean }).open = true; },
  close(this: HTMLDialogElement) { (this as { open: boolean }).open = false; this.dispatchEvent(new dom.window.Event("close")); },
});

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  dom.document.body.replaceChildren();
  __setBridgeForTest(null);
  __connectionStatusForTest("closed");
  __setStateForTest(FIXTURE_STATE);
});

const LINKED = { id: "ar_01J8G0000000000000000000L1", kind: "image" as const, file: "vigil-deck.png", hash: "sha256:1111222233334444", origin: { by: "user" as const }, links: ["the-vigil"], production: "saltlight", created: "2026-10-19T09:00:00.000Z" };
const LOOSE = { ...LINKED, id: "ar_01J8G0000000000000000000L2", file: "loose.png", hash: "sha256:5555666677778888", links: [] };

async function mount(edit: (world: WorldBundle) => void = () => {}) {
  __setStateForTest(FIXTURE_STATE);
  const world = structuredClone(FIXTURE_STATE.world!) as WorldBundle;
  world.artifacts.push(LINKED as never, LOOSE as never);
  edit(world);
  const picked: PlateCandidate[] = [];
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  const render = async (next: WorldBundle) => {
    await act(async () => root!.render(<PlateChip plate={undefined} world={next} productionId="saltlight" locationId="the-vigil" disabled={false} onPick={(candidate) => picked.push(candidate)} />));
  };
  await render(world);
  await act(async () => (container.querySelector('[data-testid="stage-plate-chip"]') as HTMLElement).click());
  return { world, picked, render };
}

const picker = () => dom.document.querySelector<HTMLElement>('[data-testid="stage-plate-picker"]');
const options = (list: string) => [...(picker()?.querySelector(`[aria-label="${list}"]`)?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
const press = async (text: string) => act(async () => [...picker()!.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === text)!.click());
const showAll = async () => {
  const input = picker()!.querySelector<HTMLElement>('input[role="switch"]')!;
  const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"))!;
  await act(async () => (input as unknown as Record<string, { onChange: (event: { target: { checked: boolean } }) => void }>)[key]!.onChange({ target: { checked: true } }));
};
const selected = () => picker()?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.textContent ?? null;
function capture(sent: ClientMessage[]): ArkeBridge {
  return { appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge;
}

it("lists the world's locations first; every other picture waits behind Show all pictures, off by default", async () => {
  await mount();
  const places = options("Locations");
  assert.ok(places.length >= 1);
  assert.ok(places.every((option) => option.textContent?.startsWith("The Vigil")), "only location-linked pictures, by the location's name");
  assert.equal(options("All pictures").length, 0, "Show all pictures is off");
  assert.equal(picker()!.querySelector(".fy-swstage__eyebrow")?.textContent?.includes(String(places.length)), true, "the Locations count");
  await showAll();
  assert.ok(options("All pictures").some((option) => option.title === "loose.png"), "the rest of the shelf, once asked for");
});

it("chooses a pick first and places it with Use plate; Cancel leaves the plate as it was", async () => {
  const { picked } = await mount();
  const tile = options("Locations").find((option) => option.title === "The Vigil")!;
  await act(async () => tile.click());
  assert.equal(picked.length, 0, "a pick is chosen first, not placed");
  await press("Cancel");
  assert.equal(picker(), null);
  assert.equal(picked.length, 0, "Cancel places nothing");
  await act(async () => (dom.document.querySelector('[data-testid="stage-plate-chip"]') as HTMLElement).click());
  await act(async () => options("Locations").find((option) => option.title === "The Vigil")!.click());
  await press("Use plate");
  assert.equal(picked.length, 1);
  assert.equal(picked[0]!.location, "The Vigil");
});

it("Upload ends with the imported picture chosen in the picker", async () => {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(capture(sent));
  __connectionStatusForTest("open");
  const { world, picked, render } = await mount();
  await press("Upload");
  assert.match(picker()!.textContent ?? "", /importing/);
  const landed = structuredClone(world);
  landed.artifacts.push({ ...LOOSE, id: "ar_01J8G0000000000000000000L3", file: "uploaded.png", hash: "sha256:9999aaaabbbbcccc" } as never);
  await render(landed);
  assert.equal(selected(), "uploaded.png", "the new picture is the pick");
  assert.ok(options("All pictures").length > 0, "shown, though it is no location's");
  await press("Use plate");
  assert.deepEqual(picked[0]?.source, { source: "artifact", artifactId: "ar_01J8G0000000000000000000L3", hash: "sha256:9999aaaabbbbcccc" });
});

it("Generate is the location's own picture flow and ends with the new view chosen in the picker", async () => {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(capture(sent));
  __connectionStatusForTest("open");
  const { world, picked, render } = await mount();
  await press("Generate");
  // The shim opens the property, not the attribute, so the open dialog is found by it.
  const dialog = [...dom.document.querySelectorAll<HTMLElement>("dialog")].find((element) => (element as unknown as { open: boolean }).open)!;
  assert.ok(dialog, "the location page's generation dialog");
  await act(async () => [...dialog.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent === "Generate")!.click());
  const request = sent.find((message) => message.kind === "generate-location-view");
  assert.equal(request?.kind === "generate-location-view" ? request.sheetId : null, "the-vigil", "the location's own generation, not a new generator");
  const landed = structuredClone(world);
  landed.referenceTakes = [...(landed.referenceTakes ?? []), { id: "tk_01J8G0000000000000000000G1", kind: "location-view", reference: { sheetId: "the-vigil" }, media: "view.png", mediaHash: "sha256:ddddeeeeffff0000" } as never];
  await render(landed);
  assert.equal(selected(), "The Vigil · new", "the new view is the pick");
  await press("Use plate");
  assert.deepEqual(picked[0]?.source, { source: "world-file", path: "references/the-vigil/takes/tk_01J8G0000000000000000000G1/view.png", hash: "sha256:ddddeeeeffff0000" });
});

import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { SetupComponent } from "@arke-studio/contracts";
import { SetupRemoveControl } from "../src/components/setup-remove-control.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.document, "activeElement", { configurable: true, value: null, writable: true });
dom.HTMLElement.prototype.focus = function () { Object.assign(dom.document, { activeElement: this }); };
const component: SetupComponent = { id: "fixture-model", displayName: "Fixture narrator", purpose: "Narration", sizeMb: 2048,
  installLocation: "PRIVATE_MODEL_LOCATION", state: "present", bytesDone: 0, bytesTotal: 0, bytesPerSecond: null, pauseSupported: false, removable: true };
const dialog = () => document.querySelector('[role="dialog"]')!;
const button = (text: string) => [...dialog().querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent === text)!;

it("reviews consequences before removal; Cancel and Escape send nothing, confirmation sends once", async () => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container), removed: string[] = [];
  try {
    await act(async () => root.render(<SetupRemoveControl component={component} remove={id => removed.push(id)} />));
    const open = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => open.click());
    assert.match(dialog().textContent!, /Remove Fixture narrator\?.*2 GiB.*download it again.*worlds, artwork and recordings are kept/);
    assert.doesNotMatch(dialog().textContent!, /PRIVATE_MODEL_LOCATION/);
    assert.equal(document.activeElement, button("Cancel")); assert.deepEqual(removed, []);
    await act(async () => button("Cancel").click()); assert.equal(dialog(), null); assert.deepEqual(removed, []);
    await act(async () => open.click());
    const escape = new dom.Event("keydown", { bubbles: true, cancelable: true }); Object.assign(escape, { key: "Escape" });
    await act(async () => window.dispatchEvent(escape)); assert.equal(dialog(), null); assert.deepEqual(removed, []);
    await act(async () => open.click()); const confirm = button("Remove");
    await act(async () => { confirm.click(); confirm.click(); });
    assert.deepEqual(removed, [component.id]); assert.equal(dialog(), null);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("a changed installation invalidates the open review until the user reviews it again", async () => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container), removed: string[] = [];
  const render = (value: SetupComponent) => root.render(<SetupRemoveControl component={value} remove={id => removed.push(id)} />);
  try {
    await act(async () => render(component)); await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => render({ ...component, installLocation: "CHANGED_LOCATION" }));
    assert(button("Remove").disabled); assert.match(dialog().textContent!, /Installation details changed/);
    await act(async () => button("Remove").click()); assert.deepEqual(removed, []);
    await act(async () => button("Cancel").click());
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(button("Remove").disabled, false);
    await act(async () => button("Remove").click()); assert.deepEqual(removed, [component.id]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

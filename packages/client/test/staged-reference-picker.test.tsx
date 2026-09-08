import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { StagedReferencePicker } from "../src/components/staged-reference-picker.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("browses another world, labels its thumbnail, ignores stale results and copies the chosen image", async () => {
  const dom = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
    Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {},
    send: (json: string) => sent.push(JSON.parse(json)) } as unknown as ArkeBridge);
  const current = FIXTURE_STATE.worlds[0]!;
  const other = { ...current, worldId: "01J8F3K2QW9VZX4N7M0RTYB61A", slug: "another-world", name: "Another world" };
  __setStateForTest({ ...FIXTURE_STATE, worlds: [current, other] }, { connection: "open" });
  const container = dom.document.getElementById("root")!;
  const root = createRoot(container);
  let closed = false;
  try {
    await act(async () => root.render(<StagedReferencePicker worldId={current.worldId} referenceKey="world-image" model={{ id: "test", provider: "fal", capability: "image", displayName: "Test image", accepts: { referenceImages: 16, referenceRoles: false, startFrame: false, endFrame: false }, limits: { maxPromptChars: 500 }, pricing: { kind: "perImage", microUsdPerImage: 1 } }}
      onClose={() => { closed = true; }} onUpload={() => {}} />));
    assert.equal(sent.length, 0, "local images use the current world projection");
    const first = { kind: "browse-reference-images", requestId: "01J8F3K2QW9VZX4N7M0RTYB61B" } as const;
    const select = container.querySelector("select")!;
    assert.match(select.textContent!, /This world/);
    assert.equal(select.querySelector("optgroup")?.getAttribute("label"), "Other worlds");
    await act(async () => {
      Object.defineProperty(select, "value", { configurable: true, value: other.slug });
      select.dispatchEvent(new dom.Event("change", { bubbles: true }));
    });
    const request = sent.at(-1)!;
    assert.equal(request.kind, "browse-reference-images");
    if (first.kind !== "browse-reference-images" || request.kind !== "browse-reference-images") throw Error("Missing request");
    await act(async () => {
      __applyEventForTest({ type: "reference.images", at: new Date().toISOString(), requestId: first.requestId,
        slug: current.slug, images: [{ file: "stale.png", name: "stale.png", role: "style", group: "Uploads" }] });
      __applyEventForTest({ type: "reference.images", at: new Date().toISOString(), requestId: request.requestId,
        slug: other.slug, images: [{ file: "references/ade/main-photo.png", name: "Ade · Main photo", role: "identity", group: "Cast" }] });
    });
    assert.ok(!container.textContent?.includes("stale.png"));
    const tile = container.querySelector<HTMLButtonElement>('[data-testid="picker-tile"]')!;
    assert.ok(tile);
    assert.equal(tile.disabled, false);
    assert.match(tile.textContent!, /Ade · Main photo/);
    assert.match(tile.textContent!, /identity · from Another world/);
    assert.match(container.querySelector('[aria-label="Image category"]')!.textContent!, /Cast/);
    assert.match(container.querySelector(".fy-refpicker__capacity")!.textContent!, /16/);
    assert.match(tile.querySelector("img")!.getAttribute("src")!, /another-world/);
    await act(async () => tile.click());
    const pick = sent.at(-1)!;
    assert.equal(pick.kind, "pick-staged-reference");
    if (pick.kind !== "pick-staged-reference") throw Error("Missing pick");
    assert.equal(pick.worldId, current.worldId);
    assert.deepEqual(pick.image, { slug: other.slug, path: "references/ade/main-photo.png" });
    assert.equal(closed, true);
  } finally { await act(async () => root.unmount()); }
});

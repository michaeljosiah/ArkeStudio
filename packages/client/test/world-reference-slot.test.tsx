import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { GenerationDialog } from "../src/components/generation-dialog.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { worldImageReferences, type ManifestModel } from "@arke-studio/contracts";

it("the generation slot browses images by category, chooses a face, and still offers upload", async () => {
  const dom = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(dom.HTMLElement.prototype, { showModal() {}, close() {} });
  const world = structuredClone(FIXTURE_STATE.world!);
  world.keyArt = "world-art.png";
  world.referenceKits = [{ sheetId: world.sheets[0]!.id, anchor: "face.png", tiles: [], compilations: [] }];
  world.sheets[0]!.type = "character";
  const model: ManifestModel = { id: "test", provider: "fal", capability: "image", displayName: "Test", accepts: { referenceImages: 4, startFrame: false, endFrame: false }, limits: {}, pricing: { kind: "perImage", microUsdPerImage: 1 } };
  __setStateForTest({ ...FIXTURE_STATE, world });
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host);
  let chosen = "", uploads = 0;
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
    assert.ok(button, label);
    await act(async () => { button.click(); });
  };
  try {
    await act(async () => root.render(<GenerationDialog workflow="main-photo" open onClose={() => {}} title="Generate" prompt="A portrait" onPrompt={() => {}} worldSlug={world.meta.slug} reference={null} onAttachReference={() => { uploads++; }} worldReferences={{ world, model, onChoose: (file) => { chosen = file; } }} choice={{ modelId: model.id }} onChoice={() => {}} submitLabel="Generate" onSubmit={() => {}} />));
    await click("Add a reference image");
    assert.ok(host.querySelector('input[placeholder="Search images"]'));
    await click("Cast");
    const face = worldImageReferences(world).find((source) => source.group === "Cast")!;
    const tile = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(face.name));
    assert.ok(tile, "the cast image is pickable");
    assert.ok(!host.querySelector('img[src*="world-art.png"]'), "the category excludes world art");
    await act(async () => { tile.click(); });
    assert.equal(chosen, face.file);
    await click("Add a reference image");
    await click("Upload");
    assert.equal(uploads, 1);
    assert.ok(!host.querySelector('[data-testid="reference-picker"]'), "the picker returns to the prompt");
  } finally { await act(async () => root.unmount()); __setStateForTest(FIXTURE_STATE); }
});

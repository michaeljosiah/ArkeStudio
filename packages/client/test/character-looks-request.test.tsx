import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage, ClientState, ManifestModel } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * What Explore actually asks for. A mutation sample found the request's shape untested: with the
 * tier's spread inverted, a chosen size was dropped from the frame and every test stayed green.
 * The explorer is opened, a size chosen on the dispatch bar, and the frame read off the wire.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(dom.HTMLElement.prototype, { showModal() { (this as unknown as { open: boolean }).open = true; }, close() { (this as unknown as { open: boolean }).open = false; } });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const open: Root[] = [];
afterEach(async () => {
  for (const root of open.splice(0)) await act(async () => root.unmount());
  dom.document.body.replaceChildren();
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});

// The fixture's manifest has no image model; an identity-carrying one with two sizes is added and
// routed as the default, so the explorer opens on it.
const GPT: ManifestModel = {
  id: "gpt-image-2",
  provider: "openai",
  capability: "image",
  displayName: "GPT Image 2",
  accepts: { referenceImages: 16, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { tiers: { "1K": "1024x1024", "2K": "2048x2048" } },
  pricing: { kind: "perImage", microUsdPerImage: 40_000 },
};
const READY: ClientState = {
  ...FIXTURE_STATE,
  app: {
    ...FIXTURE_STATE.app,
    manifest: { ...FIXTURE_STATE.app.manifest!, models: [...FIXTURE_STATE.app.manifest!.models, GPT] },
    routing: { ...FIXTURE_STATE.app.routing, defaults: { ...FIXTURE_STATE.app.routing.defaults, image: GPT.id } },
    providers: [...FIXTURE_STATE.app.providers.filter((p) => p.id !== "openai"), { id: "openai", configured: true, validation: "valid", probes: [{ capability: "image", available: true }], fault: null }],
  },
};

it("Explore sends the size that was chosen, with the model and the words", async () => {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } } as unknown as ArkeBridge);
  __setStateForTest(READY);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  open.push(root);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/cast/maren-kest/looks`]}>
      <App />
    </MemoryRouter>,
  ));
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  await act(async () => button("Explore")!.click());
  const dialog = container.querySelector<HTMLElement>("dialog.fy-gendialog")!;
  assert.ok(dialog, "the explorer opens");
  const prompt = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  const props = (prompt as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[Object.keys(prompt).find((k) => k.startsWith("__reactProps$"))!]!;
  await act(async () => props.onChange({ target: { value: "a heavier coat, salt-stained" } }));
  const size = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "2K")!;
  assert.ok(size, "the model's sizes are offered");
  await act(async () => size.click());
  assert.equal(size.getAttribute("aria-pressed"), "true");
  const submit = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Explore")!;
  assert.equal(submit.disabled, false, "a main photo and an identity-carrying model: nothing refuses it");
  await act(async () => submit.click());
  const frame = sent.find((message): message is Extract<ClientMessage, { kind: "generate-character-looks" }> => message.kind === "generate-character-looks");
  assert.ok(frame, "one request");
  assert.equal(frame.tier, "2K", "the size that was chosen rides the request");
  assert.equal(frame.modelId, GPT.id);
  assert.equal(frame.prompt, "a heavier coat, salt-stained");
  assert.equal(frame.sheetId, "maren-kest");
});

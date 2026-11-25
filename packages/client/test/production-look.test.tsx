import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { applyLookPreset, type ClientMessage, type ProductionLook } from "@arke-studio/contracts";
import { ProductionLookCard } from "../src/screens/production-look.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

/**
 * The production's look in Production settings (design turn 288a): a preset fills the choices and
 * keeps the words, a choice of the person's own unsets the preset, words are written when the field
 * is left, and the card carries no caption.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null; __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
  dom.document.body.innerHTML = "";
});

async function mount(look: ProductionLook | undefined) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (json: string) => { sent.push(JSON.parse(json)); } } satisfies ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    __setStateForTest(FIXTURE_STATE, { connection: "open" });
    root!.render(<ProductionLookCard look={look} worldId={FIXTURE_WORLD_ID} prodId="the-film" />);
  });
  const looks = () => sent.filter((m): m is Extract<ClientMessage, { kind: "set-production-look" }> => m.kind === "set-production-look").map((m) => m.look);
  return { container, looks };
}

const press = async (container: HTMLElement, text: string, within?: string) => {
  const scope = within ? container.querySelector(`[aria-label="${within}"]`)! : container;
  const button = [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(button, `${text} is present`);
  await act(async () => button.dispatchEvent(new dom.Event("click", { bubbles: true })));
};

describe("the production's look (design turn 288a)", () => {
  it("labels its rows and explains nothing", async () => {
    const { container } = await mount(undefined);
    const rows = [...container.querySelectorAll(".fy-models__what")].map((cell) => cell.textContent);
    assert.deepEqual(rows, ["Preset", "Camera", "Light", "Lens and focus", "Grade", "Cutting", "Sound", "Performance", "Own checks"]);
    assert.equal(container.querySelector(".fy-mono, small, p"), null, "no caption under any control");
  });

  it("a preset fills the choices and keeps the words and the production's own checks", async () => {
    const before: ProductionLook = { light: { words: "purple from above" }, checks: ["Ade's watch on his near wrist"] };
    const { container, looks } = await mount(before);
    await press(container, "Naturalistic drama");
    const written = looks().at(-1)!;
    assert.deepEqual(written, applyLookPreset(before, "naturalistic-drama"));
    assert.equal(written?.light?.words, "purple from above");
    assert.deepEqual(written?.checks, ["Ade's watch on his near wrist"]);
  });

  it("a choice of the person's own unsets the preset and changes only itself", async () => {
    const { container, looks } = await mount(applyLookPreset(undefined, "naturalistic-drama"));
    await press(container, "Shaky", "Camera");
    const written = looks().at(-1)!;
    assert.equal(written?.preset, undefined);
    assert.equal(written?.camera?.kind, "shaky");
    assert.equal(written?.camera?.strength, "gentle", "the rest of the camera stays");
    assert.equal(written?.light?.key, "low", "and the rest of the look");
  });

  it("a press just after leaving a words field keeps the new words: it composes from what was written", async () => {
    // The app's answer arrives after a round trip; composed from the received look, the preset
    // would write the old words back (codex on PR 3302).
    const { container, looks } = await mount({ grade: { words: "35 mm" } });
    const grade = container.querySelector<HTMLInputElement>('input[aria-label="Grade words"]')!;
    grade.value = "35 mm, grain";
    await act(async () => grade.dispatchEvent(new dom.Event("focusout", { bubbles: true })));
    await press(container, "Thriller");
    assert.equal(looks().at(-1)?.grade?.words, "35 mm, grain");
    assert.equal(looks().at(-1)?.preset, "thriller");
  });

  it("shows a saved insert length the list does not hold", async () => {
    const { container } = await mount(applyLookPreset(undefined, "thriller"));
    const inserts = container.querySelector<HTMLSelectElement>('select[aria-label="Inserts"]')!;
    assert.ok([...inserts.querySelectorAll("option")].some((option) => option.textContent === "Inserts 0.8 s"));
  });

  it("writes a part's words when the field is left, and an emptied field drops them", async () => {
    const { container, looks } = await mount({ grade: { words: "35 mm" } });
    const grade = container.querySelector<HTMLInputElement>('input[aria-label="Grade words"]')!;
    grade.value = "35 mm, a little under, grain";
    await act(async () => grade.dispatchEvent(new dom.Event("input", { bubbles: true })));
    assert.equal(looks().length, 0, "nothing on each key");
    await act(async () => grade.dispatchEvent(new dom.Event("focusout", { bubbles: true })));
    assert.equal(looks().at(-1)?.grade?.words, "35 mm, a little under, grain");
  });
});

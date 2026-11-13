import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { deriveCut, deriveSpineCut, type ClientMessage } from "@arke-studio/contracts";
import { CutInspector } from "../src/screens/editor-inspector.js";
import { TrimStrip } from "../src/screens/editor-preview.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
Object.assign(dom.HTMLElement.prototype, { setPointerCapture() {}, releasePointerCapture() {} });
const roots: Root[] = [];
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); __setBridgeForTest(null); });
function setup() {
  const sent: ClientMessage[] = [];
  __setStateForTest(FIXTURE_STATE);
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  return { sent, host, root };
}
async function pointer(element: Element, type: string, clientX: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { button: 0, pointerId: 1, clientX });
  await act(async () => { element.dispatchEvent(event); });
}

describe("review inspection cannot write unsaved Current shot trims (SPEC-053 R-32)", () => {
  it("passes the review-disabled state through the unopened song Inspector's legacy trim control", async () => {
    const { root, host, sent } = setup(), production = structuredClone(FIXTURE_STATE.world!.productions[0]!);
    const shotId = "sh_12";
    production.selections[shotId]!.trimInSec = 1;
    production.spine = { schemaVersion: 1, revision: 1, trackArtifactId: "ar_song", markers: [], updatedAt: "2026-10-11T00:00:00.000Z",
      anchors: { [shotId]: { startSec: 0, endSec: 4, clipAudio: { mode: "mute" } } } };
    const spineCut = deriveSpineCut(production, production.spine, 10);
    const render = async (disabled: boolean) => act(async () => root.render(<CutInspector
      worldId={FIXTURE_STATE.world!.meta.worldId} prodId={production.meta.id} production={production} cut={deriveCut(production)} spineCut={spineCut}
      artifacts={[]} selection={{ kind: "picture", id: shotId }} selectedClip={null} selectedTrack={null} savedPictureOrder={false}
      frameRate={24} commandsDisabled={disabled} onCommands={() => assert.fail("No timeline commands expected")}
      timeline={null} subtitleView={null} onViewSubtitles={() => {}} onTranscribe={null} onFill={() => {}}
      mintClipId={() => "cl_unused"} sourceLength={() => undefined} nameOf={artifact => artifact.file} onScrub={() => {}} />));
    await render(false);
    const more = host.querySelector<HTMLButtonElement>('[aria-label="more trim"]')!;
    assert.ok(more); assert.equal(more.disabled, false);
    await act(async () => more.click());
    assert.equal(sent.length, 1); assert.equal(sent[0]!.kind, "set-trim"); sent.length = 0;
    await render(true);
    assert.equal(more.disabled, true); assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="less trim"]')!.disabled, true);
    const value = host.querySelector(".fy-trim__value")!;
    assert.equal(value.getAttribute("aria-disabled"), "true"); assert.equal(value.getAttribute("role"), null);
    await act(async () => more.click());
    await pointer(value, "pointerdown", 0); await pointer(value, "pointerup", 40);
    assert.deepEqual(sent, [], "both trim paths must leave Current unchanged during review");
  });

  it("refuses a held trim gesture after review opens, even if review closes before pointer release", async () => {
    const { root, host, sent } = setup();
    const render = async (disabled: boolean) => act(async () => root.render(<TrimStrip
      worldId="world" prodId="production" shotId="sh_12" heading="Shot" title="Shot" figures="4s" trim={1}
      ceiling={{ ok: true, ceilingSec: 10 }} disabled={disabled} />));
    await render(false);
    const value = host.querySelector(".fy-trim__value")!;
    await pointer(value, "pointerdown", 0); await pointer(value, "pointermove", 40);
    await render(true); await render(false);
    await pointer(value, "pointerup", 40);
    assert.equal(sent.length, 0, "review cancels authority of the gesture already in hand");
    await pointer(value, "pointerdown", 0); await pointer(value, "pointerup", 40);
    assert.equal(sent.length, 1); assert.equal(sent[0]!.kind, "set-trim", "a genuinely new Current gesture still works");
  });
});

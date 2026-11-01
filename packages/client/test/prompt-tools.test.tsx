import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { orderedShots, type ClientMessage, type PromptTarget, type ShotPromptHistory } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { PromptTools, PromptToolsSetting } from "../src/components/prompt-tools.js";
import { __setStateForTest, __setBridgeForTest, __applyEventForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

let root: Root | undefined;
afterEach(async () => { if (root) { await act(async () => root!.unmount()); root = undefined; } __setBridgeForTest(null); });
const hash = `sha256:${"a".repeat(64)}`, at = "2026-11-01T12:00:00.000Z";
function setup(enabled = false) {
  const dom = parseHTML("<!doctype html><html><body><div id='test'></div></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const state = structuredClone(FIXTURE_STATE), production = state.world!.productions[0]!, scene = production.scenes[0]!;
  const target: PromptTarget = { productionId: production.meta.id, sceneId: scene.id, shotId: orderedShots(scene)[0]!.id, capability: "image" };
  state.app.promptTools = enabled;
  __setStateForTest(state, { connection: "open" });
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ platform: "test", appVersion: "test", connect() {}, subscribe() { return () => {}; }, send(message) { sent.push(JSON.parse(message)); } } as ArkeBridge);
  root = createRoot(dom.document.getElementById("test")!);
  const button = (text: string) => [...dom.document.querySelectorAll("button")].find(b => b.textContent?.includes(text))!;
  const click = (text: string) => act(async () => { button(text).dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  const reply = (result: Parameters<typeof __applyEventForTest>[0] & { type: "prompt-tools.result" }) => act(async () => { __applyEventForTest(result); });
  return { dom, state, scene, target, sent, button, click, reply, worldId: state.world!.meta.worldId };
}
it("keeps controls and reads absent by default and explains the optional setting", async () => {
  const f = setup();
  await act(async () => root!.render(<PromptTools worldId={f.worldId} target={f.target} />));
  assert.equal(f.dom.document.querySelectorAll("button").length, 0); assert.equal(f.sent.length, 0);
  const text = renderToString(<PromptToolsSetting />);
  assert.match(text, /Prompt history and inspection/); assert.match(text, /Off by default/);
  assert.match(text, /saved prompts and scene history are kept/); assert.doesNotMatch(text, /checked=""/);
});
it("reads scoped history, reviews one prompt and sends only the fenced restore command", async () => {
  const f = setup(true);
  await act(async () => root!.render(<PromptTools worldId={f.worldId} target={f.target} />));
  assert.equal(f.sent.length, 0, "opening a shot does not scan history");
  await f.click("History");
  const request = f.sent.at(-1)!; assert.equal(request.kind, "prompt-history-read");
  assert.ok("requestId" in request);
  const history: ShotPromptHistory = { target: f.target, currentVersion: f.scene.version, currentHash: hash,
    assembledBody: "Today's assembly", assembledHash: hash, currentBody: "Current", currentOverride: { text: "Current", capability: "image", sheetVersions: {} }, partial: true,
    entries: [{ version: f.scene.version, hash, prompt: { text: "Current", capability: "image", sheetVersions: {} }, unavailable: false },
      { version: f.scene.version - 1, hash, prompt: { text: "Older words", capability: "image", sheetVersions: { maren: 1 } }, unavailable: false }] };
  await f.reply({ type: "prompt-tools.result", at, worldId: f.worldId, requestId: request.requestId, result: { kind: "history", history } });
  assert.match(f.dom.document.querySelector("dialog")!.textContent!, /Some history is unavailable/);
  await f.click("Review restore"); assert.match(f.dom.document.querySelector("dialog")!.textContent!, /original source versions stay recorded/);
  await f.click("Restore image prompt");
  const restore = f.sent.at(-1)!; assert.equal(restore.kind, "prompt-history-restore"); assert.ok("requestId" in restore);
  if (restore.kind !== "prompt-history-restore") return;
  assert.equal(restore.baseVersion, f.scene.version); assert.equal(restore.sourceVersion, f.scene.version - 1);
  assert.equal(restore.baseHash, hash); assert.equal(restore.sourceHash, hash); assert.equal(restore.assembledHash, hash);
  assert.equal("text" in restore, false, "renderer cannot manufacture historical text or pins");
  await f.reply({ type: "prompt-tools.result", at, worldId: f.worldId, requestId: restore.requestId, result: { kind: "failed", reason: "The scene changed. Read again." } });
  assert.match(f.dom.document.querySelector("dialog")!.textContent!, /scene changed/);
  assert.deepEqual(f.sent.map(m => m.kind), ["prompt-history-read", "prompt-history-restore"]);
  await f.click("Done"); assert.equal(f.dom.document.querySelectorAll("dialog").length, 0);
});
it("invalidates inspection when the draft changes and hides an open sheet when disabled", async () => {
  const f = setup(true);
  const source = { kind: "shot" as const, ...f.target };
  await act(async () => root!.render(<PromptTools worldId={f.worldId} source={source} revision={1} />));
  await f.click("Inspect request"); const request = f.sent.at(-1)!; assert.ok("requestId" in request && request.requestId);
  await f.reply({ type: "prompt-tools.result", at, worldId: f.worldId, requestId: request.requestId, result: { kind: "inspection", inspection: {
    source: "saved-shot", identity: "Shot current", capability: "image", provider: "test", model: "image", prompt: "Compiled body", quantity: 1, controls: [], references: [], notices: [] } } });
  assert.match(f.dom.document.querySelector("dialog")!.textContent!, /Compiled body/);
  const changed = structuredClone(f.state);
  changed.world!.referenceKits[0]!.mainPhoto!.file = "changed-reference.png";
  await act(async () => __setStateForTest(changed, { connection: "open" }));
  assert.doesNotMatch(f.dom.document.querySelector("dialog")!.textContent!, /Compiled body/);
  await f.click("Read again");
  const refresh = f.sent.at(-1)!; assert.ok("requestId" in refresh && refresh.requestId);
  await f.reply({ type: "prompt-tools.result", at, worldId: f.worldId, requestId: refresh.requestId, result: { kind: "inspection", inspection: {
    source: "saved-shot", identity: "Shot current", capability: "image", provider: "test", model: "image", prompt: "Updated compiled body", quantity: 1, controls: [], references: [], notices: [] } } });
  assert.match(f.dom.document.querySelector("dialog")!.textContent!, /Updated compiled body/);
  await act(async () => root!.render(<PromptTools worldId={f.worldId} source={source} revision={2} />));
  assert.doesNotMatch(f.dom.document.querySelector("dialog")!.textContent!, /Compiled body/);
  assert.match(f.dom.document.querySelector("dialog")!.textContent!, /request changed/);
  await act(async () => __applyEventForTest({ type: "prompt-tools.changed", at, enabled: false }));
  assert.equal(f.dom.document.querySelectorAll("dialog").length, 0);
  assert.equal(f.dom.document.querySelectorAll("button").length, 0);
  assert.deepEqual(f.sent.map(m => m.kind), ["prompt-request-inspect", "prompt-request-inspect"]);
});

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ulid, type ClientMessage, type MediaMeasurementResult, type MediaMeasurementSource } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { SourceMeasurement, measurementSubject } from "../src/screens/editor-media-measurement.js";
import { __setStateForTest, __setBridgeForTest, __applyEventForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

let root: Root | undefined;
afterEach(async () => { if (root) { await act(async () => root!.unmount()); root = undefined; } __setBridgeForTest(null); });
const hash = `sha256:${"a".repeat(64)}`, at = "2026-11-01T12:00:00.000Z";
function setup() {
  const dom = parseHTML("<!doctype html><html><body><div id='test'></div></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const state = structuredClone(FIXTURE_STATE), production = state.world!.productions[0]!, worldId = state.world!.meta.worldId;
  const take = production.takes.find(item => item.kind === "clip")!;
  take.mediaHash = hash; production.takeMediaInfo = {};
  __setStateForTest(state, { connection: "open" });
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ platform: "test", appVersion: "test", connect() {}, subscribe() { return () => {}; }, send(message) { sent.push(JSON.parse(message)); } } as ArkeBridge);
  root = createRoot(dom.document.getElementById("test")!);
  let chosen = 0;
  const render = (source: MediaMeasurementSource = { kind: "take", takeId: take.id }) => act(async () => {
    root!.render(<SourceMeasurement worldId={worldId} production={production} artifacts={state.world!.artifacts} source={source} disabled={false} onChooseTake={() => { chosen++; }} />);
  });
  const click = () => act(async () => { dom.document.querySelector("button")!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  const reply = (result: MediaMeasurementResult, id?: string, world = worldId) => act(async () => {
    const last = sent.at(-1)!; assert.ok(last.kind === "measure-production-media");
    __applyEventForTest({ type: "media.measured", at, worldId: world, requestId: id ?? last.requestId, result });
  });
  return { dom, state, production, take, worldId, sent, render, click, reply, chosen: () => chosen };
}
it("does no I/O on selection and hides tools for measured media and still images", async () => {
  const f = setup(); await f.render();
  assert.match(f.dom.document.body.textContent!, /Measure media/); assert.equal(f.sent.length, 0);
  f.production.takeMediaInfo[f.take.id] = { sourceHash: hash, mediaInfo: { durationSec: 12, hasAudio: true }, probedAt: at };
  await f.render(); assert.equal(f.dom.document.querySelectorAll("button").length, 0);
  f.take.kind = "frame"; await f.render(); assert.equal(f.dom.document.querySelectorAll("section").length, 0);
});
it("sends only one scoped local command, ignores unrelated receipts and retries a probe failure", async () => {
  const f = setup(); await f.render(); await f.click(); await f.click();
  assert.equal(f.sent.length, 1); const request = f.sent[0]!; assert.ok(request.kind === "measure-production-media");
  assert.deepEqual(request.source, { kind: "take", takeId: f.take.id }); assert.equal(request.expectedHash, hash);
  assert.equal("path" in request, false); assert.equal(request.productionId, f.production.meta.id);
  await f.reply({ status: "measured", info: { durationSec: 99, hasAudio: true } }, request.requestId, ulid());
  await f.reply({ status: "failed", reason: "not-configured" }, ulid());
  assert.match(f.dom.document.body.textContent!, /Measuring/);
  await f.reply({ status: "failed", reason: "probe-failed" }); assert.match(f.dom.document.body.textContent!, /Try again/);
  await f.click(); assert.equal(f.sent.length, 2);
  await f.reply({ status: "measured", info: { durationSec: 12, hasAudio: true } });
  assert.match(f.dom.document.body.textContent!, /12.0 seconds · audio present/);
  assert.equal(f.dom.document.querySelectorAll("button").length, 0);
  assert.ok(f.sent.every(item => item.kind === "measure-production-media"));
});
it("refuses a changed source and offers the existing take picker without probing again", async () => {
  const f = setup(); await f.render(); await f.click(); await f.reply({ status: "failed", reason: "source-changed" });
  assert.match(f.dom.document.body.textContent!, /Source changed/); await f.click();
  assert.equal(f.chosen(), 1); assert.equal(f.sent.length, 1);
});
it("discards late receipts after source selection or world changes and releases pending requests", async () => {
  const f = setup(); await f.render(); await f.click(); const old = f.sent.at(-1)!; assert.ok(old.kind === "measure-production-media");
  const next = { ...structuredClone(f.take), id: "tk_other" }; f.production.takes.push(next);
  await f.render({ kind: "take", takeId: next.id });
  await f.reply({ status: "measured", info: { durationSec: 99, hasAudio: true } }, old.requestId);
  assert.doesNotMatch(f.dom.document.body.textContent!, /99.0/); await f.click();
  const state = structuredClone(f.state); state.world = null;
  await act(async () => __setStateForTest(state, { connection: "open" }));
  await f.reply({ status: "measured", info: { durationSec: 88, hasAudio: true } });
  assert.equal(f.dom.document.querySelectorAll("section").length, 0);
});
it("resolves segment metadata from its parent and measures an audio artifact by identity", async () => {
  const f = setup(); const child = { ...structuredClone(f.take), id: "tk_segment", segment: { passTakeId: f.take.id, inSec: 2, outSec: 6 } };
  f.production.takes.push(child);
  f.production.takeMediaInfo[f.take.id] = { sourceHash: hash, mediaInfo: { durationSec: 12, hasAudio: true }, probedAt: at };
  assert.equal(measurementSubject(f.production, [], { kind: "take", takeId: child.id })?.info?.durationSec, 12);
  delete f.production.takeMediaInfo[f.take.id]; await f.render({ kind: "take", takeId: child.id }); await f.click();
  await f.reply({ status: "measured", info: { durationSec: 12, hasAudio: true } }); assert.match(f.dom.document.body.textContent!, /4.0 seconds/);
  const artifact = { ...f.state.world!.artifacts[0]!, id: "ar_audio", kind: "audio" as const, mediaInfo: undefined, hash };
  f.state.world!.artifacts.push(artifact); await f.render({ kind: "artifact", artifactId: artifact.id }); await f.click();
  const request = f.sent.at(-1)!; assert.ok(request.kind === "measure-production-media");
  assert.deepEqual(request.source, { kind: "artifact", artifactId: artifact.id });
  await f.reply({ status: "failed", reason: "not-configured" }); assert.match(f.dom.document.body.textContent!, /Media tools unavailable/);
});

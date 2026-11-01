import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { ArkeBridge } from "../src/arke-bridge.js";
import type { ClientMessage, ProductionSpendSummary } from "@arke-studio/contracts";
import { SpendSummary, ProductionSpend } from "../src/components/production-spend.js";
import { __setStateForTest, __setBridgeForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const summary: ProductionSpendSummary = { spentMicroUsd: 13_000_000, unallocatedMicroUsd: 0, coverage: "complete", generated: 7, selected: 2,
  countsPartial: false, localRuns: 1, sources: [{ source: "provider-reported", entries: 5, microUsd: 11_000_000 }, { source: "manifest-derived", entries: 1, microUsd: 2_000_000 },
    { source: "local-zero", entries: 1, microUsd: 0 }, { source: "included-plan", entries: 1, microUsd: 0 }], problems: [] };
const view = (value?: ProductionSpendSummary) => parseHTML(renderToString(<SpendSummary value={value} />)).document;

it("shows lifetime spend and current selected counts without a hit-rate or acceptance total", () => {
  const text = view(summary).textContent ?? view(summary).toString();
  assert.match(text, /\$13.00/); assert.match(text, /7 generated · 2 selected/);
  assert.match(text, /1 local run/); assert.match(text, /1 plan attempt/);
  assert.doesNotMatch(text, /hit.rate|accepted|%/i);
});
it("distinguishes loading, empty, partial and unavailable histories", () => {
  assert.match(view().toString(), /Reading history/);
  const empty = view({ ...summary, spentMicroUsd: 0, generated: 0, selected: 0, coverage: "empty", sources: [], localRuns: 0 }).toString();
  assert.match(empty, /No work yet/); assert.match(empty, /\$0.00/);
  assert.match(view({ ...summary, coverage: "partial" }).toString(), /Known spend on this device/);
  const unavailable = view({ ...summary, coverage: "unavailable", spentMicroUsd: null, problems: ["ledger-unreadable"] }).toString();
  assert.match(unavailable, /Could not read spend history/); assert.doesNotMatch(unavailable, /\$0.00/);
  assert.match(view({ ...summary, countsPartial: true }).toString(), /counts partial/);
});
it("never describes local-only or plan-only work as a zero-dollar billed charge", () => {
  const local = view({ ...summary, spentMicroUsd: 0, sources: [{ source: "local-zero", entries: 1, microUsd: 0 }] }).toString();
  assert.match(local, /Unmetered/); assert.doesNotMatch(local, /\$0.00/);
  const plan = view({ ...summary, spentMicroUsd: 0, localRuns: 0, sources: [{ source: "included-plan", entries: 1, microUsd: 0 }] }).toString();
  assert.match(plan, /Plan-covered/); assert.doesNotMatch(plan, /\$0.00/);
});

let root: Root | undefined;
afterEach(async () => { if (root) { await act(async () => root!.unmount()); root = undefined; } __setBridgeForTest(null); });
it("opens one scoped receipt sheet and refreshes incomplete accounting without generation", async () => {
  const dom = parseHTML("<!doctype html><html><body><div id='test'></div></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ platform: "test", appVersion: "test", connect() {}, subscribe() { return () => {}; }, send(message) { sent.push(JSON.parse(message)); } } as ArkeBridge);
  const state = structuredClone(FIXTURE_STATE), production = state.world!.productions[0]!;
  const scene = production.scenes[0]!;
  state.productionSpend = { worldId: state.world!.meta.worldId, productions: { [production.meta.id]: {
    total: { ...summary, coverage: "partial", unallocatedMicroUsd: 2_400_000 }, scenes: { [scene.id]: summary }, shots: {},
    receipts: [{ jobId: "jb_receipt", kind: "video", sceneId: scene.id, provider: "fal", model: "Video model", outcome: "failed",
      source: "provider-reported", microUsd: 1_200_000, recordedMicroUsd: 1_200_000, shots: [], unallocatedMicroUsd: 1_200_000 }] } } };
  __setStateForTest(state, { connection: "open" });
  root = createRoot(dom.document.getElementById("test")!);
  await act(async () => root!.render(<ProductionSpend production={production} />));
  const button = (text: string) => [...dom.document.querySelectorAll("button")].find(button => button.textContent?.includes(text))!;
  await act(async () => button("Spend details").dispatchEvent(new dom.window.Event("click", { bubbles: true })));
  assert.equal(dom.document.querySelectorAll("dialog").length, 1);
  assert.match(dom.document.querySelector("dialog")!.textContent!, /Failed/);
  assert.match(dom.document.querySelector("dialog")!.textContent!, /\$2.40 cannot be assigned/);
  assert.match(dom.document.querySelector("dialog")!.textContent!, /No video candidate is inferred/);
  await act(async () => button("Read history again").dispatchEvent(new dom.window.Event("click", { bubbles: true })));
  assert.deepEqual(sent.map(message => message.kind), ["production-spend-refresh"]);
  await act(async () => button("Done").dispatchEvent(new dom.window.Event("click", { bubbles: true })));
  assert.equal(dom.document.querySelectorAll("dialog").length, 0);
});

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage, AudiobookWordsState } from "@arke-studio/contracts";
import { AudiobookWordsDialog } from "../src/components/audiobook-words.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import type { ArkeBridge } from "../src/arke-bridge.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1440, innerHeight: 1000 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) });
let root: Root | null = null;
const sent: ClientMessage[] = [], worldId = FIXTURE_STATE.world!.meta.worldId;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = null; dom.document.body.innerHTML = ""; __setBridgeForTest(null); sent.length = 0; });
const base: AudiobookWordsState = { available: true, running: false, done: 0, total: 1, chapters: ["neap"], rows: [
  { chapterId: "neap", chapterTitle: "Neap", key: "p0.0", label: "Block 1", text: "Maren opens the ledger.", artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6HC" },
] };
async function mount() {
  __setStateForTest(FIXTURE_STATE, { connection: "open" });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as ArkeBridge);
  const host = dom.document.createElement("div"); dom.document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<AudiobookWordsDialog worldId={worldId} productionId="the-ledger-of-nights" chapterId="neap" block="p0.0" freshness="current" onClose={() => {}} />));
}
async function answer(state: AudiobookWordsState, requestId?: string) {
  const request = sent.filter(m => m.kind === "audiobook-words").at(-1)!;
  assert.equal(request.kind, "audiobook-words");
  await act(() => __applyEventForTest({ type: "audiobook.words", at: "2026-10-21T18:00:00.000Z", worldId,
    productionId: "the-ledger-of-nights", requestId: requestId ?? request.requestId, state }));
}
const button = (name: string) => [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === name)!;

it("shows match/difference/unavailable separately and sends only an explicit local check", async () => {
  await mount(); assert.equal(sent.length, 1); assert.equal(sent[0]?.kind, "audiobook-words");
  await answer(base);
  assert.match(dom.document.body.textContent!, /1 unchecked/);
  assert.match(dom.document.body.textContent!, /does not check pronunciation or word timing/);
  await act(() => button("Check words").click());
  const check = sent.at(-1)!; assert.equal(check.kind, "audiobook-words");
  if (check.kind !== "audiobook-words") throw new Error("unexpected command");
  assert.equal(check.action, "check"); assert.deepEqual(check.blocks, [{ chapterId: "neap", key: "p0.0" }]);
  await answer({ ...base, running: true, runningRequestId: check.requestId });
  await act(() => button("Stop").click());
  assert.equal((sent.at(-1) as { action: string }).action, "stop");
  await answer({ ...base, running: false, reason: "stopped · completed checks are kept" }, check.requestId);
  assert.match(dom.document.body.textContent!, /stopped · completed checks are kept/);
  assert.ok(sent.every(m => m.kind === "audiobook-words"));
});

it("rejects another request's answer and keeps unknown identity unchecked", async () => {
  await mount();
  await answer({ ...base, reason: "must not appear" }, "01J8F3K2QW9VZX4N7M0RTYB6HD");
  assert.ok(!dom.document.body.textContent!.includes("must not appear"));
  await answer({ ...base, available: false, reason: "local recognizer identity is unavailable" });
  assert.equal(button("Check words").disabled, true);
  assert.match(dom.document.body.textContent!, /1 unchecked/);
  await act(() => button("Book").click());
  const request = sent.at(-1)!; assert.equal(request.kind, "audiobook-words");
  if (request.kind === "audiobook-words") { assert.equal(request.chapters, undefined); assert.equal(request.blocks, undefined); assert.equal(request.action, "read"); }
});

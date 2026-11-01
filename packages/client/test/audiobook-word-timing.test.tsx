import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage } from "@arke-studio/contracts";
import { WordTimingControl } from "../src/components/audiobook-word-timing.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import type { ArkeBridge } from "../src/arke-bridge.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
const sent: ClientMessage[] = [], worldId = FIXTURE_STATE.world!.meta.worldId;
afterEach(async () => { if (root) await act(() => root!.unmount()); root = null; dom.document.body.innerHTML = ""; __setBridgeForTest(null); sent.length = 0; });
it("shows a busy refusal with an available aligner and rereads status on reconnect without queuing work", async () => {
  __setStateForTest(FIXTURE_STATE, { connection: "open" });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as ArkeBridge);
  const host = dom.document.createElement("div"); dom.document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<WordTimingControl worldId={worldId} productionId="the-ledger-of-nights" chapters={["neap"]} enabled onReady={() => {}} usePhrases={() => {}} />));
  const request = sent.at(-1)!; assert(request.kind === "audiobook-word-timing");
  await act(() => __applyEventForTest({ type: "audiobook.word-timing", at: "2026-11-01T10:00:00Z", worldId, productionId: request.productionId, requestId: request.requestId,
    state: { available: true, running: false, done: 0, total: 1, blocks: [{ chapterId: "neap", key: "p0.0", label: "Block 1", ready: false }], reason: "Not started: a Words check is running for this production." } }));
  assert.match(dom.document.body.textContent!, /Not started: a Words check is running/);
  await act(() => __setStateForTest(FIXTURE_STATE, { connection: "closed" }));
  const before = sent.length;
  await act(() => __setStateForTest(FIXTURE_STATE, { connection: "open" }));
  assert.equal(sent.length, before + 1);
  assert(sent.every(message => message.kind === "audiobook-word-timing" && message.action === "read"));
  assert.deepEqual((sent.at(-1) as Extract<ClientMessage, { kind: "audiobook-word-timing" }>).chapters, ["neap"]);
});

it("offers a confirmed local recheck of only the failed block while retaining Review and estimate fallback", async () => {
  __setStateForTest(FIXTURE_STATE, { connection: "open" });
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as ArkeBridge);
  const host = dom.document.createElement("div"); dom.document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<WordTimingControl worldId={worldId} productionId="the-ledger-of-nights" chapters={["neap"]} enabled onReady={() => {}} usePhrases={() => {}} />));
  const request = sent.at(-1)!; assert(request.kind === "audiobook-word-timing");
  await act(() => __applyEventForTest({ type: "audiobook.word-timing", at: "2026-11-01T10:00:00Z", worldId, productionId: request.productionId, requestId: request.requestId,
    state: { available: true, running: false, done: 2, total: 2, blocks: [
      { chapterId: "neap", key: "p0.0", label: "Block 1", ready: false, file: "artifacts/read.wav", reason: "could not match a word" },
      { chapterId: "neap", key: "p1.0", label: "Block 2", ready: true, file: "artifacts/ready.wav" },
    ] } }));
  const find = (label: string) => [...dom.document.querySelectorAll("button")].find(button => button.textContent?.trim() === label)!;
  const click = async (label: string) => { assert.ok(find(label), label); await act(() => find(label).click()); };
  await click("Review blocks");
  assert.match(dom.document.body.textContent!, /picture anchors without validated timing stay estimated/);
  assert.ok(find("Review"));
  await click("Prepare again");
  assert.equal(sent.some(message => message.kind === "audiobook-word-timing" && message.action === "prepare"), false);
  await click("Prepare timings");
  const prepare = sent.at(-1)!; assert(prepare.kind === "audiobook-word-timing" && prepare.action === "prepare");
  assert.deepEqual(prepare.blocks, [{ chapterId: "neap", key: "p0.0" }]);
  assert.deepEqual(prepare.chapters, ["neap"]);
  assert(sent.every(message => message.kind === "audiobook-word-timing"));
});

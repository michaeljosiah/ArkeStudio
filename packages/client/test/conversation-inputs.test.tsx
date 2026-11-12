import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { newId, WorldChatWorkspaceSchema, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import { Composer } from "../src/components/composer.js";
import { useConversationInputs } from "../src/components/conversation-inputs.js";
import { __applyEventForTest, __connectionStatusForTest, __setBridgeForTest, __setStateForTest, useStore } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import type { ArkeBridge } from "../src/arke-bridge.js";

const dom = parseHTML("<!doctype html><html><body></body></html>"), storage = new Map<string, string>();
Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.defineProperty(dom.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, set(value: string) { this.textContent = value; }, configurable: true });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
let root: Root | undefined; const commands: ClientMessage[] = [];
const worldId = FIXTURE_STATE.world!.meta.worldId, id = newId("cv"), runId = newId("run");
const workspace = () => WorldChatWorkspaceSchema.parse({ conversationId: id, status: "open", messages: [], points: [], runStatus: "running", runId });
function TestChat() {
  const { state } = useStore(); const [draft, setDraft] = useState("Keep her motivation.");
  const queue = useConversationInputs(worldId, state!.worldChat!, setDraft);
  return <>{queue.panel}<Composer value={draft} onChange={setDraft} placeholder="Message" busy sendNext={queue.queueing}
    queuePaused={queue.paused} onSubmit={() => queue.sendNext({ text: draft, attachmentIds: [], replyOnly: true, variant: "high" }, draft)} />
    <button data-edit onClick={() => setDraft("A later draft")}>Edit</button></>;
}
async function mount(reset = true) {
  if (reset) __setStateForTest({ ...FIXTURE_STATE, worldChat: workspace() });
  __setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send(raw: string) { commands.push(JSON.parse(raw)); } } as unknown as ArkeBridge);
  __connectionStatusForTest("open");
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<TestChat />));
}
async function click(selector: string) { await act(async () => (document.querySelector(selector) as HTMLButtonElement).click()); }
async function receipt(event: Partial<Extract<DomainEvent, { type: "world-chat.input-result" }>>, requestId: string) {
  await act(async () => __applyEventForTest({ type: "world-chat.input-result", at: new Date().toISOString(), worldId, conversationId: id, requestId, admitted: false, ...event }));
}
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); commands.length = 0; storage.clear(); __setBridgeForTest(null); });

it("keeps a busy composer editable and clears only after a durable receipt", async () => {
  await mount(); assert.equal(document.querySelector(".fy-cx__editor")!.getAttribute("contentEditable"), "true");
  await click('[aria-label="Send next"]');
  const sent = commands.find(command => command.kind === "world-chat-input")!;
  assert.equal(sent.kind, "world-chat-input"); if (sent.kind !== "world-chat-input") return;
  assert.equal(sent.input.replyOnly, true); assert.equal(sent.input.variant, "high"); assert.equal(sent.input.expectedRunId, runId);
  assert.equal(document.querySelector(".fy-cx__editor")!.textContent, "Keep her motivation."); assert.equal(storage.size, 1);
  await receipt({ admitted: true }, sent.input.submissionId);
  assert.equal(document.querySelector(".fy-cx__editor")!.textContent, ""); assert.equal(storage.size, 0);
});

it("retains identity across reload and reconciles without another model submission", async () => {
  await mount(); await click('[aria-label="Send next"]');
  const sent = commands.find(command => command.kind === "world-chat-input")!; if (sent.kind !== "world-chat-input") return;
  await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren();
  await mount(false);
  assert.equal(commands.filter(command => command.kind === "world-chat-input").length, 1);
  assert.ok(commands.some(command => command.kind === "world-chat-input-status" && command.requestId === sent.input.submissionId));
  await receipt({ uncertain: true, detail: "Storage unavailable" }, sent.input.submissionId);
  assert.equal(storage.size, 1, "an unreadable receipt cannot be treated as rejection");
  await click("[data-edit]"); await receipt({ admitted: true }, sent.input.submissionId);
  assert.equal(document.querySelector(".fy-cx__editor")!.textContent, "A later draft", "late receipts cannot erase newer typing");
});

it("a refused submission keeps its draft and confirms absence before releasing its identity", async () => {
  await mount(); await click('[aria-label="Send next"]');
  const sent = commands.find(command => command.kind === "world-chat-input")!; if (sent.kind !== "world-chat-input") return;
  await receipt({ uncertain: true, detail: "The queue is full." }, sent.input.submissionId);
  assert.equal(storage.size, 1);
  assert.ok(commands.some(command => command.kind === "world-chat-input-status"));
  await receipt({ admitted: false }, sent.input.submissionId);
  assert.equal(storage.size, 0); assert.equal(document.querySelector(".fy-cx__editor")!.textContent, "Keep her motivation.");
});

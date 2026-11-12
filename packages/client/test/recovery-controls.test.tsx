import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { emptyRecoveryHistory, type ClientMessage } from "@arke-studio/contracts";
import { RecoveryControls } from "../src/components/recovery-controls.js";
import { __setStateForTest, __setBridgeForTest, __applyEventForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("sends host policy commands, waits for its own flushed receipt and requires confirmation before clearing summaries", async () => {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const state = structuredClone(FIXTURE_STATE), history = emptyRecoveryHistory();
  state.app.recoveryPolicy = { audit: "available", accepting: true, mode: "automatic", targets: [{ key: "a".repeat(64), service: "ollama", stoppedByUser: false, circuitOpen: true, pendingOutcome: true,
    lastOutcome: { action: "restart-managed-runtime", automatic: true, authorizedAt: 1000, settledAt: 2000, outcome: "unknown" } }] };
  state.app.recoveryHistory = { at: Date.now(), audit: "available", incidents: [], activeCount: 0, resolvedCount: 1, limited: false, preferences: history.preferences, overflow: history.overflow };
  __setStateForTest(state, { connection: "open" });
  const sent: ClientMessage[] = []; __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<RecoveryControls />));
    assert(container.querySelector('[aria-label="Latest recovery outcomes"]')); assert.match(container.textContent!, /Outcome unconfirmed/);
    assert.match(container.textContent!, /not current health or completed creative work/);
    const mode = container.querySelector('select[aria-label="Recovery mode"]')!;
    await act(async () => { Object.defineProperty(mode, "value", { configurable: true, value: "suggest-only" }); mode.dispatchEvent(new Event("change", { bubbles: true })); });
    const command = sent[0]!; assert.equal(command.kind, "recovery-set-mode"); assert("requestId" in command);
    assert.match(container.textContent!, /Saving/); assert(mode.hasAttribute("disabled"));
    await act(async () => __applyEventForTest({ type: "recovery.command-result", at: new Date().toISOString(), result: { requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", operation: "recovery-set-mode", status: "saved" } }));
    assert.match(container.textContent!, /Saving/);
    await act(async () => __applyEventForTest({ type: "recovery.command-result", at: new Date().toISOString(), result: { requestId: command.requestId as string, operation: "recovery-set-mode", status: "saved" } }));
    assert.match(container.textContent!, /Saved on this PC/);
    const clear = [...container.querySelectorAll("button")].find(button => button.textContent === "Clear resolved…")!;
    await act(async () => clear.click()); assert.equal(sent.length, 1); assert.match(container.textContent!, /Retry budgets, unconfirmed outcomes, active incidents and creative files are kept/);
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Confirm clear")!.click());
    assert.equal(sent[1]!.kind, "recovery-history-control"); assert.deepEqual("command" in sent[1]! && sent[1].command, { action: "clear-resolved" });
    const meta = document.createElement("meta"); meta.name = "arke-remote"; meta.content = "true"; document.head.append(meta);
    await act(async () => root.render(<RecoveryControls />));
    assert.match(container.textContent!, /Change recovery settings on your PC/);
    assert([...container.querySelectorAll("select")].every(select => select.hasAttribute("disabled")));
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});

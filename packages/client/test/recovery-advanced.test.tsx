import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { RecoveryAdvancedSettingsSchema, type ClientMessage } from "@arke-studio/contracts";
import { RecoveryAdvancedControls } from "../src/components/recovery-advanced.js";
import { __setStateForTest, __setBridgeForTest, __applyEventForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("keeps advanced controls collapsed and saves explicit changes only after a matching receipt", async () => {
  const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const state = structuredClone(FIXTURE_STATE), settings = RecoveryAdvancedSettingsSchema.parse({ checkStorageBeforeSubmission: false, artifactTransfer: { maxFiles: 100 } });
  state.app.recoveryPolicy = { audit: "available", accepting: true, mode: "automatic", targets: [], advanced: settings };
  __setStateForTest(state, { connection: "open" });
  const sent: ClientMessage[] = []; __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json) { sent.push(JSON.parse(json)); } });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const button = (text: string) => [...container.querySelectorAll("button")].find(row => row.textContent === text)!;
  try {
    await act(async () => root.render(<RecoveryAdvancedControls />));
    assert(!container.querySelector("details")!.hasAttribute("open")); assert.equal(sent.length, 0);
    assert.equal((container.querySelector('[aria-label="Files per result"]') as HTMLInputElement).value, "100");
    assert(container.querySelector('[aria-label="Result download timeout (minutes)"]'));
    assert.doesNotMatch(container.textContent!, /FAL/);
    await act(async () => button("Use default values").click()); assert.equal(sent.length, 0);
    await act(async () => button("Save advanced settings").click());
    const command = sent[0]!; assert.equal(command.kind, "recovery-set-advanced");
    assert(command.kind === "recovery-set-advanced"); assert.deepEqual(command.settings, RecoveryAdvancedSettingsSchema.parse({}));
    assert.match(container.textContent!, /Saving/);
    await act(async () => __applyEventForTest({ type: "recovery.command-result", at: new Date().toISOString(), result: { requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", operation: "recovery-set-advanced", status: "saved" } }));
    assert.match(container.textContent!, /Saving/);
    await act(async () => __applyEventForTest({ type: "recovery.command-result", at: new Date().toISOString(), result: { requestId: command.requestId, operation: "recovery-set-advanced", status: "saved" } }));
    assert.match(container.textContent!, /Saved on this PC/);
    const meta = document.createElement("meta"); meta.name = "arke-remote"; meta.content = "true"; document.head.append(meta);
    await act(async () => root.render(<RecoveryAdvancedControls />));
    assert([...container.querySelectorAll("input,button")].every(row => row.hasAttribute("disabled")));
  } finally { await act(async () => root.unmount()); container.remove(); __setBridgeForTest(null); }
});

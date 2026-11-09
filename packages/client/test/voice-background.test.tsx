import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { newId, type ClientMessage, type VoiceBackgroundOperation } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { VoiceBackgroundActivity } from "../src/components/voice-background-activity.js";
import { __setStateForTest, __setBridgeForTest, __connectionStatusForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

test("a retained lookup can be cancelled after voice ends, without cancelling its sibling", async () => {
  const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const sent: ClientMessage[] = [];
  __setStateForTest(structuredClone(FIXTURE_STATE), { connection: "open" }); __connectionStatusForTest("open");
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() { return () => {}; },
    send(raw: string) { sent.push(JSON.parse(raw)); } } as unknown as ArkeBridge);
  const base: VoiceBackgroundOperation = { id: newId("vop"), worldId: FIXTURE_STATE.world!.meta.worldId,
    conversationId: newId("cv"), initiatingRunId: newId("run"), turnId: newId("turn"), model: "cloud/chosen", request: "Check the river canon", status: "running",
    createdAt: "2026-11-09T12:00:00Z", updatedAt: "2026-11-09T12:00:00Z" };
  const other = { ...base, id: newId("vop"), request: "Read the character sheet" };
  const node = window.document.getElementById("root")!, root = createRoot(node as unknown as HTMLElement);
  try {
    await act(async () => root.render(<VoiceBackgroundActivity worldId={base.worldId} conversationId={base.conversationId} operations={[base, other]} />));
    const buttons = node.querySelectorAll("button"); assert.equal(buttons.length, 2);
    await act(async () => buttons[0]!.dispatchEvent(new window.Event("click", { bubbles: true })));
    assert.equal(sent.length, 1); assert.equal(sent[0]?.kind, "cancel-voice-background");
    if (sent[0]?.kind === "cancel-voice-background") { assert.equal(sent[0].operationId, base.id); assert.equal(sent[0].conversationId, base.conversationId); }
    await act(async () => root.render(<VoiceBackgroundActivity worldId={base.worldId} conversationId={base.conversationId} operations={[{ ...base, status: "cancel-requested" }, { ...other, status: "unknown" }]} />));
    assert.match(node.textContent!, /Stopping/); assert.match(node.textContent!, /result unknown/);
    assert.equal(node.querySelectorAll("button").length, 1); assert.equal(node.querySelector("button")!.disabled, true);
  } finally { await act(async () => root.unmount()); }
});

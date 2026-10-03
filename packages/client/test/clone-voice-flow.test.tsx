import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage } from "@arke-studio/contracts";
import { CharacterVoiceScreen } from "../src/screens/character-voice.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { dialogRoot } from "./dialog-root.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
});

it("saving a recording keeps it manageable on Mine without assigning any reader or changing the character's voice", async t => {
  const state = structuredClone(FIXTURE_STATE);
  const sheet = state.world!.sheets[0]!;
  const previousVoice = structuredClone(sheet.voice);
  const worldId = state.world!.meta.worldId;
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {},
    send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } });
  __setStateForTest(state);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const view = dialogRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    __setBridgeForTest(null);
    __setStateForTest(FIXTURE_STATE);
  });
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/w/${worldId}/cast/${sheet.id}/voice?record=1`]}>
      <Routes><Route path="/w/:worldId/cast/:sheetId/voice" element={<CharacterVoiceScreen />} /></Routes>
    </MemoryRouter>,
  ));
  const press = async (id: string) => {
    const button = view.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
    assert.ok(button, id);
    assert.equal(button.disabled, false, `${id} is enabled`);
    await act(async () => button.click());
  };
  const change = async (id: string, target: { value?: string; checked?: boolean }) => {
    const element = view.querySelector(`[data-testid="${id}"]`)!;
    assert.ok(element, id);
    // linkedom does not implement native controlled-input events; call React's bound handler.
    const key = Object.keys(element).find(key => key.startsWith("__reactProps$"))!;
    const props = (element as unknown as Record<string, { onChange(event: { target: typeof target }): void }>)[key]!;
    await act(async () => props.onChange({ target }));
  };
  await press("clone-choose");
  const staged = sent.find(message => message.kind === "stage-voice-clip")!;
  assert.ok(staged.kind === "stage-voice-clip");
  const voiceClips = { [staged.requestId]: { clipId: "clip_01", fileName: "harbour.wav", seconds: 9, reason: null } };
  await act(async () => __setStateForTest(state, { voiceClips }));
  await change("clone-consent", { checked: true });
  await press("clone-next");
  await change("clone-name", { value: "Harbour" });
  await change("clone-description", { value: "Low, dry, warm" });
  await press("clone-save");
  assert.ok(sent.some(message => message.kind === "clone-voice"));
  state.world!.clonedVoices = [{ id: "harbour", name: "Harbour", clip: "voices/harbour.wav", language: "en",
    description: "Low, dry, warm", attributes: ["low", "dry", "warm"], consent: true, created: "2026-09-29T12:00:00Z" }];
  await act(async () => __setStateForTest(state, {
    voiceClips, voiceCloned: { voiceId: "harbour", label: "Harbour", reason: null },
    voiceCandidates: { [sheet.id]: { extracted: [], ranked: [], previewLine: { text: "A line", source: "stock" },
      cloudPreviewMicroUsd: null, previewMicroUsdByVoice: {}, notices: {} } },
  }));
  assert.equal(view.querySelector('[data-testid="clone-voice"]'), null);
  assert.ok(view.querySelector('[data-testid="voice-catalogue"]'), "the chooser survives the recording dialog's close");
  assert.match(view.querySelector('[data-testid="voice-tab-mine"]')!.className, /active/);
  assert.equal(view.querySelector('.fy-voicerow__name')?.textContent, "Harbour");
  assert.equal(view.querySelector('[data-testid="voice-tab-mine"]')?.textContent, "Mine 1");
  assert.ok(view.querySelector('[data-testid="voice-assign"]')?.hasAttribute("disabled"));
  assert.match(view.textContent!, /Connect a cloned-voice reader in Providers/);
  assert.equal(sent.some(message => message.kind === "assign-voice"), false);
  assert.deepEqual(sheet.voice, previousVoice);
  await press("voice-delete");
  assert.equal(sent.some(message => message.kind === "delete-voice"), false, "the first press only asks for confirmation");
  assert.equal(view.querySelector('[data-testid="voice-delete"]')?.textContent, "Delete for good");
  await press("voice-delete");
  const deletes = sent.filter(message => message.kind === "delete-voice");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0]!.worldId, worldId);
  assert.equal(deletes[0]!.voiceId, "harbour");
  assert.equal(sent.some(message => message.kind === "voice-preview" || message.kind === "assign-voice"), false);
});

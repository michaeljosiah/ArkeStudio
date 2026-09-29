import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { VoicePickerDialog } from "../src/components/voice-picker.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest, type ReadingVoice } from "../src/lib/store.js";
import { playbackSnapshot, setAudioFactoryForTest } from "../src/lib/audio.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const voices: ReadingVoice[] = Array.from({ length: 358 }, (_, i) => ({ provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: String(i), label: `Voice ${i}`,
  attributes: ["warm"], facets: { gender: i % 2 ? "male" : "female", accent: "british" }, local: false, canClone: true,
  usedBy: [], preview: { kind: "sample", microUsd: 0 } }));

it("filters a large catalogue, keeps the pending choice outside results, and ignores audio after cancellation", async () => {
  const sent: ClientMessage[] = []; const picked: ReadingVoice[] = [];
  __setBridgeForTest({ send: (json: string) => sent.push(JSON.parse(json)) } as unknown as ArkeBridge);
  __setStateForTest(FIXTURE_STATE);
  let plays = 0;
  setAudioFactoryForTest(() => ({ src: "", currentTime: 0, duration: 10, play: async () => { plays++; }, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} }));
  const host = dom.document.createElement("div"); dom.document.body.append(host);
  const root = createRoot(host);
  const click = async (selector: string) => { const button = host.querySelector<HTMLButtonElement>(selector); assert.ok(button, selector); await act(async () => button.click()); };
  try {
    await act(async () => root.render(<VoicePickerDialog open use="narration" chosenId="0" chosenProvider="elevenlabs" chosenModel="eleven_multilingual_v2" onClose={() => {}} onPick={v => picked.push(v)} />));
    assert.equal(sent.at(-1)?.kind, "voice-catalogue");
    await act(async () => __applyEventForTest({ at: new Date().toISOString(), type: "voice.catalogue", voices }));
    assert.equal(host.querySelectorAll(".fy-voices__row").length, 358);
    await click('[aria-label="Select Voice 357"]');
    const gender = host.querySelector<HTMLSelectElement>('select[aria-label="Gender"]')!;
    await act(async () => {
      Object.defineProperty(gender, "value", { configurable: true, value: "female" });
      gender.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(host.querySelectorAll(".fy-voices__row").length, 179);
    assert.match(host.querySelector(".fy-voices__foot")!.textContent!, /Voice 357.*Outside these results/);
    await click('[aria-label="Play Voice 0 sample"]');
    const preview = sent.findLast(m => m.kind === "catalogue-voice-preview")!;
    assert.equal(preview.kind, "catalogue-voice-preview");
    if (preview.kind !== "catalogue-voice-preview") throw new Error("missing preview");
    await click('[aria-label="Stop Voice 0 sample"]');
    await act(async () => __applyEventForTest({ at: new Date().toISOString(), type: "voice.catalogue-preview", requestId: preview.requestId, status: "ready", file: "a".repeat(64) + ".mp3" } as DomainEvent));
    assert.equal(plays, 0); assert.equal(picked.length, 0);
    await click('[data-testid="voice-use"]'); assert.equal(picked[0]?.voiceId, "357");
    await click('[aria-label="Play Voice 0 sample"]');
    const next = sent.findLast(m => m.kind === "catalogue-voice-preview")!;
    if (next.kind !== "catalogue-voice-preview") throw new Error("missing preview");
    await act(async () => __applyEventForTest({ at: new Date().toISOString(), type: "voice.catalogue-preview", requestId: next.requestId, status: "ready", file: "b".repeat(64) + ".mp3" }));
    assert.equal(plays, 1); assert.match(playbackSnapshot().clip!.url, /voice-preview-media/);
  } finally {
    await act(async () => root.unmount()); host.remove(); __setBridgeForTest(null); setAudioFactoryForTest(null);
  }
  assert.equal(playbackSnapshot().clip, null);
});

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

it("filters Gemini metadata and previews the exact selected model and voice", async () => {
  const { GoogleClient, GEMINI_TTS_MODELS } = await import("../../providers/src/clients/google.js");
  const client = new GoogleClient(async url => Response.json(url.includes("/models")
    ? { models: [{ name: GEMINI_TTS_MODELS[0] }] }
    : { voices: [
      { id: "BritishReader", display_name: "British Reader", type: "prebuilt", language_code: "en-GB", gender: "female", accent: "British", persona: "Warm" },
      { id: "FrenchReader", display_name: "French Reader", type: "prebuilt", language_code: "fr-FR", gender: "male", accent: "Parisian", persona: "Firm" },
    ] }));
  const catalogue = (await client.listVoicesCatalog("fixture-key")).map(v => ({ ...v, usedBy: [], preview: { kind: "generate" as const, microUsd: 5000 } }));
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ send: (json: string) => sent.push(JSON.parse(json)) } as unknown as ArkeBridge);
  __setStateForTest(FIXTURE_STATE);
  const host = dom.document.createElement("div"); dom.document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<VoicePickerDialog open use="narration" chosenId={undefined} onClose={() => {}} onPick={() => {}} />));
    await act(async () => __applyEventForTest({ at: new Date().toISOString(), type: "voice.catalogue", voices: [...voices, ...catalogue] }));
    const choose = async (name: string, value: string) => {
      const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`); assert.ok(select, name);
      assert.ok([...select.options].some(option => option.value === value), `${name}: ${value}`);
      await act(async () => { Object.defineProperty(select, "value", { configurable: true, value }); select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    };
    await choose("Provider", "google"); await choose("Language", "english"); await choose("Gender", "female");
    await choose("Accent", "british"); await choose("Style", "warm");
    assert.equal(host.querySelectorAll(".fy-voices__row").length, 1);
    assert.match(host.querySelector(".fy-voices__name")!.textContent!, /British Reader/);
    assert.equal(sent.every(m => m.kind === "voice-catalogue"), true, "filtering never spends");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Play British Reader sample"]')!.click());
    const preview = sent.at(-1); assert.equal(preview?.kind, "catalogue-voice-preview");
    if (preview?.kind !== "catalogue-voice-preview") throw new Error("missing preview");
    assert.deepEqual([preview.provider, preview.model, preview.voiceId, preview.maxMicroUsd], ["google", GEMINI_TTS_MODELS[0], "BritishReader", 5000]);
  } finally { await act(async () => root.unmount()); host.remove(); __setBridgeForTest(null); }
});

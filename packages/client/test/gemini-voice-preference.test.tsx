import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { SHIPPED_MANIFEST } from "../../providers/src/manifest-data.js";
import type { ClientMessage } from "@arke-studio/contracts";
import { VoicePickerDialog } from "../src/components/voice-picker.js";
import { NarratorDialog } from "../src/screens/audiobook-narrator.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { dialogRoot } from "./dialog-root.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) });
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  dom.document.body.replaceChildren();
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});
const voices = [
  { provider: "elevenlabs", model: "eleven-v3", voiceId: "old", label: "Existing voice", local: false },
  { provider: "google", model: "gemini-3.8-flash-tts", voiceId: "Charon", label: "Charon", local: false },
  { provider: "google", model: "gemini-3.8-flash-lite-tts", voiceId: "Charon", label: "Charon", local: false },
  { provider: "kokoro", model: "kokoro-82m", voiceId: "bm_george", label: "George", local: true },
].map(v => ({ ...v, attributes: [], canClone: false, usedBy: [] }));

async function setup(view: React.ReactNode, disabled: string[] = []) {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ send(json: string) { sent.push(JSON.parse(json)); } } as unknown as ArkeBridge);
  __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, manifest: SHIPPED_MANIFEST, models: { ...FIXTURE_STATE.app.models, disabled } } });
  const element = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () => root.render(<MemoryRouter>{view}</MemoryRouter>));
  await act(async () => __applyEventForTest({ type: "voice.catalogue", at: "2026-09-27T12:00:00Z", voices }));
  return { element: dialogRoot(element), sent };
}

it("routine reads recommend Lite while the selected ElevenLabs voice stays selected", async () => {
  const { element, sent } = await setup(<VoicePickerDialog open use="narration" chosenId="old" chosenProvider="elevenlabs" chosenModel="eleven-v3" onClose={() => {}} onPick={() => {}} />);
  const rows = [...element.querySelectorAll('.fy-voices__row')];
  assert.deepEqual(rows.map(row => row.querySelector(".fy-voices__name")!.textContent), ["Charon", "Charon", "Existing voice", "George"]);
  assert.ok(rows.some(row => /Gemini Flash-Lite · Recommended/.test(row.textContent!)));
  assert.ok(rows.some(row => /Gemini Flash/.test(row.textContent!)));
  assert.match(element.querySelector('.fy-voices__row--on')!.textContent!, /Existing voice/);
  assert.ok(sent.every(m => m.kind === "voice-catalogue"), "opening does not set a narrator or generate audio");
});

for (const book of [false, true]) it(`excludes disabled Gemini rows from ${book ? "book" : "routine"} recommendations without switching the narrator`, async () => {
  const view = book ? <NarratorDialog worldId={FIXTURE_STATE.world!.meta.worldId} productionId="saltlight" narratorLabel="Existing voice"
    appLabel="George" bookNarrator={voices[0]!} trial={null} slug={undefined} data="" onClose={() => {}} />
    : <VoicePickerDialog open use="narration" chosenId="old" chosenProvider="elevenlabs" chosenModel="eleven-v3" onClose={() => {}} onPick={() => {}} />;
  const { sent } = await setup(view, ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]);
  assert.doesNotMatch(dom.document.body.textContent!, /Gemini|Recommended/);
  assert.match(dom.document.querySelector('[aria-selected="true"], .fy-voices__row--on')!.textContent!, /Existing voice/);
  assert.ok(sent.every(m => m.kind === "voice-catalogue"));
});

it("the audiobook picker recommends Flash, shows token-priced rows and preserves a book narrator", async () => {
  const { sent } = await setup(<NarratorDialog worldId={FIXTURE_STATE.world!.meta.worldId} productionId="saltlight" narratorLabel="George"
    appLabel="George" bookNarrator={voices[0]!} trial={null} slug={undefined} data="" onClose={() => {}} />);
  const dialog = dom.document.querySelector('[data-testid="narrator-dialog"]')!;
  const rows = [...dialog.querySelectorAll('[role="option"]')];
  assert.match(rows[0]!.textContent!, /George/);
  assert.match(rows[1]!.textContent!, /Gemini Flash · Recommended/);
  assert.match(rows[1]!.textContent!, /quoted per read/);
  assert.match(rows[1]!.querySelector('.fy-abnarr__price')!.getAttribute("title")!, /text tokens.*audio tokens/);
  assert.match(rows[2]!.textContent!, /Gemini Flash-Lite/);
  assert.match(dialog.querySelector('[aria-selected="true"]')!.textContent!, /Existing voice/);
  assert.ok(!sent.some(m => m.kind === "set-audiobook-narrator" || m.kind === "hear-audiobook-line"));
});

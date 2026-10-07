import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage, ManifestModel } from "@arke-studio/contracts";
import { CharacterVoiceScreen } from "../src/screens/character-voice.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement,
  Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
});

// Eleven v4 as the shipped row declares it: a note rides as a tag of two words at most (#1626).
const V4: ManifestModel = {
  id: "eleven_v4", provider: "elevenlabs", capability: "voice-tts", displayName: "Eleven v4",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: { audioFormat: "mp3", maxPromptChars: 10000 },
  pricing: { kind: "perCharacter", microUsdPerCharacter: 80 },
  cadence: { deliveries: ["measured"], speed: null, pause: "best-effort-audio-tag", emphasis: "best-effort-capitalization", breath: "best-effort-audio-tag",
    outputTimestamps: "none", phrase: "best-effort-tag", tagWords: 2, deliveryMappings: { measured: { settings: { stability: 0.5 } } } },
} as ManifestModel;

const props = (element: Element) => {
  const key = Object.keys(element).find((k) => k.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, { onChange(event: { target: { value: string } }): void; onBlur(): void; onFocus?(): void }>)[key]!;
};

it("Narration is the Voice tab's third use: help asked for, written in place, tried and heard before it is kept, held past the book's narrator's limit (design turn 200)", async (t) => {
  const state = structuredClone(FIXTURE_STATE);
  const world = state.world!;
  const sheet = world.sheets.find((candidate) => candidate.type === "character")!;
  const book = world.productions[0]!;
  book.audiobook = { schemaVersion: 1, reading: "performed", narrator: { provider: "elevenlabs", model: V4.id, voiceId: "rachel", label: "Rachel" } };
  state.app.manifest = { ...state.app.manifest!, models: [...(state.app.manifest?.models ?? []), V4] };
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } });
  __setStateForTest(state);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    __setBridgeForTest(null);
    __setStateForTest(FIXTURE_STATE);
  });
  const render = async () => root.render(
    <MemoryRouter initialEntries={[`/w/${world.meta.worldId}/cast/${sheet.id}/voice?book=${book.meta.id}`]}>
      <Routes><Route path="/w/:worldId/cast/:sheetId/voice" element={<CharacterVoiceScreen />} /></Routes>
    </MemoryRouter>,
  );
  await act(render);
  const row = () => container.querySelector('[data-testid="voice-narration"]')!;
  assert.ok(row(), "the third use row");
  assert.equal(container.querySelectorAll('[data-testid="help-tip"]').length, 3, "a help glyph on each use");
  assert.match(row().textContent ?? "", /Narration.*not set/s);
  assert.match(row().textContent ?? "", /Rachel · Eleven v4 · 2 words/, "heard on the book's narrator, its limit as data");

  // Help, asked for: the line, the example and each narrator's limit, and nothing until asked.
  assert.equal(container.querySelector('[data-testid="help-tip-pop"]'), null);
  const narrationHelp = row().querySelector('[data-testid="help-tip"]')!;
  await act(async () => props(narrationHelp).onFocus!());
  const pop = row().querySelector('[data-testid="help-tip-pop"]')!;
  assert.match(pop.textContent ?? "", /How the narrator plays them when one voice reads the book\./);
  assert.match(pop.textContent ?? "", /e\.g\.low, clipped/);
  assert.match(pop.textContent ?? "", /Eleven v4 · 2 words/);

  // Set: the row becomes a field; past the narrator's limit, one clause says so, and leaving writes it.
  await act(async () => (row().querySelector('[data-testid="voice-narration-change"]') as HTMLButtonElement).click());
  const field = () => row().querySelector('[data-testid="voice-narration-field"]')!;
  await act(async () => props(field()).onChange({ target: { value: "low, clipped, far off" } }));
  assert.equal(row().querySelector('[data-testid="voice-narration-held"]')?.textContent, "Eleven v4 takes 2 words");
  assert.match(row().textContent ?? "", /4 words/);
  // Tried before it is kept: Hear plays what the field holds, and nothing is written yet.
  await act(async () => (row().querySelector(".fy-voiceuse__hear button") as HTMLButtonElement).click());
  const tried = sent.findLast((message) => message.kind === "voice-preview");
  assert.ok(tried && tried.kind === "voice-preview");
  assert.equal(tried.note, "low, clipped, far off");
  assert.equal(sent.some((message) => message.kind === "set-sheet-narration"), false, "trying a note writes nothing");
  await act(async () => props(field()).onBlur());
  const written = sent.findLast((message) => message.kind === "set-sheet-narration");
  assert.ok(written && written.kind === "set-sheet-narration");
  assert.deepEqual({ path: written.path, narration: written.narration }, { path: `characters/${sheet.id}.md`, narration: "low, clipped, far off" });

  // Written and within the limit: shown with Change, and Hear asks for the line as the narrator plays it.
  const next = structuredClone(state);
  next.world!.sheets = next.world!.sheets.map((candidate) => (candidate.id === sheet.id ? { ...candidate, narration: "low, clipped" } : candidate));
  await act(async () => __setStateForTest(next));
  assert.match(row().textContent ?? "", /low, clipped/);
  assert.equal(row().querySelector('[data-testid="voice-narration-held"]'), null);
  assert.equal((row().querySelector('[data-testid="voice-narration-change"]') as HTMLButtonElement).textContent, "Change");
  const hear = row().querySelector("button")!;
  await act(async () => hear.click());
  const preview = sent.findLast((message) => message.kind === "voice-preview");
  assert.ok(preview && preview.kind === "voice-preview", "Hear asks for a preview");
  assert.deepEqual([preview.provider, preview.model, preview.voiceId, preview.note], ["elevenlabs", "eleven_v4", "rachel", "low, clipped"]);
});

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { dismissPlayback, playbackSnapshot, setAudioFactoryForTest } from "../src/lib/audio.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Reading a sheet aloud is narration: the app's narrator reads prose ABOUT the character, so the
 * clip names the narrator, never the character's own voice. There are two clip builders — the
 * effect that plays a read as soon as it lands, and the row's control that replays it — and only
 * the first actually sounded when the second was written, so the player once named a voice that
 * had not read a word. Both are driven here, with a narrator distinct from the character's voice.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const open: Root[] = [];
afterEach(async () => {
  for (const root of open.splice(0)) await act(async () => root.unmount());
  dom.document.body.replaceChildren();
  dismissPlayback();
  setAudioFactoryForTest(null);
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});

it("names the narrator on the clip, both when a read lands and when the row replays it", async () => {
  const dock = { playbackRate: 1, src: "", currentTime: 0, duration: NaN, play: async () => {}, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
  setAudioFactoryForTest(() => dock as never);
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } } as unknown as ArkeBridge);
  // Maren's own voice is "Low tide"; the app's narrator is somebody else.
  __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, narrator: { provider: "kokoro", model: "kokoro-82m", voiceId: "bf_emma", label: "Emma" } } });
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  open.push(root);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/cast/maren-kest`]}>
      <App />
    </MemoryRouter>,
  ));
  const read = () => container.querySelector<HTMLButtonElement>('button[aria-label="Read aloud"]')!;
  assert.ok(read(), "the sheet offers a read");
  await act(async () => read().click());
  const asked = sent.find((message): message is Extract<ClientMessage, { kind: "read-sheet-section" }> => message.kind === "read-sheet-section");
  assert.ok(asked, "the read was asked for");

  // The read lands: the effect plays it at once, and the clip says who read it.
  await act(async () => __applyEventForTest({
    type: "voice.audio", at: "2026-09-12T08:00:00.000Z", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, sheetId: "maren-kest", sheetVersion: 4,
    purpose: "sheet-section", sectionHeading: asked.sectionHeading, provider: "kokoro", model: "kokoro-82m", voiceId: "bf_emma", format: "wav",
    status: "ready", file: ".cache/voice/maren-essence.wav", cached: false, characterCount: 120, estimatedMicroUsd: 0,
  }));
  assert.equal(playbackSnapshot().clip?.sub, "read aloud · Emma", "the landed read names the narrator");
  assert.doesNotMatch(playbackSnapshot().clip?.sub ?? "", /Low tide/, "not the character's own voice");

  // The row replays the same read: the other builder, the same name.
  dismissPlayback();
  assert.equal(playbackSnapshot().clip, null);
  await act(async () => read().click());
  assert.equal(sent.filter((message) => message.kind === "read-sheet-section").length, 1, "a landed read replays rather than being asked for again");
  assert.equal(playbackSnapshot().clip?.sub, "read aloud · Emma");
  assert.match(playbackSnapshot().clip?.title ?? "", /^Maren Kest · /);
});

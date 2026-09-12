import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { parseHTML } from "linkedom";
import { ELEVENLABS_VOICE_MODEL, orderedShots, type ClientMessage, type ClientState } from "@arke-studio/contracts";
import { VoiceLineDialogScreen } from "../src/screens/production.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest, requestVoiceLine } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The voice-line dialog answers its own request and no other. A mutation sample found the guard
 * untested: with `result.requestId !== pending.current` inverted, the dialog ignored its own
 * acceptance and navigated on a stranger's, and every test still passed — the SSR suite never
 * presses Generate. This one does, and then hands the dialog a result it did not ask for.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const open: Root[] = [];
afterEach(async () => {
  for (const root of open.splice(0)) await act(async () => root.unmount());
  dom.document.body.replaceChildren();
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});

const production = FIXTURE_STATE.world!.productions[0]!;
const spoken = production.scenes.flatMap((scene) => orderedShots(scene)).find((shot) => shot.audio?.line && shot.audio.speaker)!;
const base = `/w/${FIXTURE_WORLD_ID}/p/${production.meta.id}`;
// The fixture's speaker has an ElevenLabs voice and its manifest has no voice model at all, so
// Generate would be refused; the model the assignment resolves to is added, and nothing else.
const READY: ClientState = {
  ...FIXTURE_STATE,
  app: {
    ...FIXTURE_STATE.app,
    manifest: {
      ...(FIXTURE_STATE.app.manifest ?? { manifestVersion: 1, generated: "2026-08-25", models: [] }),
      models: [...(FIXTURE_STATE.app.manifest?.models ?? []), {
        id: ELEVENLABS_VOICE_MODEL, provider: "elevenlabs", capability: "voice-tts", displayName: "ElevenLabs",
        accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: { maxPromptChars: 400, audioFormat: "mp3" }, pricing: { kind: "unmetered" },
      }],
    },
  },
};

it("navigates on its own accepted result and ignores one meant for another request", async () => {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({
    appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as ArkeBridge);
  __setStateForTest(READY);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  open.push(root);
  // The dialog alone, with a stub where the Cut would be: the destination is not the subject, and
  // the Cut's editor is more than a test DOM should have to carry to prove a redirect happened.
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`${base}/generate/voice-line?shot=${spoken.id}`]}>
      <Routes>
        <Route path="/w/:worldId/p/:prodId/generate/voice-line" element={<VoiceLineDialogScreen />} />
        <Route path="/w/:worldId/p/:prodId/audio" element={<div data-testid="landed-on-audio" />} />
      </Routes>
    </MemoryRouter>,
  ));
  const dialog = () => container.querySelector('[data-screen="voice-line-dialog"]');
  assert.ok(dialog(), "the dialog is up");
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="voice-line-generate"]')!.click());
  const asked = sent.find((message): message is Extract<ClientMessage, { kind: "voice-line" }> => message.kind === "voice-line");
  assert.ok(asked, "Generate sent the line");

  // Another voice-line request is in flight — a second dialog, another shot — and its answer lands first.
  const stranger = requestVoiceLine({ worldId: FIXTURE_WORLD_ID, productionId: production.meta.id, shotId: spoken.id });
  const accepted = (requestId: string) => ({
    type: "queue.enqueue-result" as const, at: "2026-09-12T08:00:00.000Z", requestId, command: "voice-line" as const, disposition: "accepted" as const,
    requestedCount: 1, acceptedJobIds: [], failures: [],
  });
  await act(async () => __applyEventForTest(accepted(stranger)));
  assert.ok(dialog(), "a result for someone else's request leaves this dialog where it is");
  assert.equal(container.querySelector<HTMLButtonElement>('[data-testid="voice-line-generate"]')!.disabled, true, "still sending its own");

  await act(async () => __applyEventForTest(accepted(asked.requestId)));
  assert.equal(dialog() === null, true, "its own acceptance takes it away");
  assert.ok(container.querySelector('[data-testid="landed-on-audio"]'), "to the audio library");
});

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { JobSchema, designedVoiceTarget, type ClientMessage, type VoiceCandidate, type WorldDesignedVoice } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "../../providers/src/manifest-data.js";
import { DesignVoiceDialog } from "../src/components/design-voice-dialog.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  dom.document.body.innerHTML = "";
  __setBridgeForTest(null); __setStateForTest(FIXTURE_STATE);
});
const voice: WorldDesignedVoice = { kind: "designed", id: "dv_01J8F3K2QW9VZX4N7M0RTYB6HC", revision: 1,
  name: "Quiet storyteller", description: "Warm, patient, British.", language: "en-GB", provider: "google", model: "gemini-3.8-flash-tts",
  remoteId: "voice_fixture", expiresAt: "2099-09-28T00:00:00Z", created: "2026-09-28T00:00:00Z", origin: "generated",
  creationJobId: "jb_01J8F3K2QW9VZX4N7M0RTYB6HC", sample: "voices/dv_01J8F3K2QW9VZX4N7M0RTYB6HC.wav" };
async function setup(candidate = false) {
  const sent: ClientMessage[] = [], used: VoiceCandidate[] = [];
  __setBridgeForTest({ send(json: string) { sent.push(JSON.parse(json)); } } as unknown as ArkeBridge);
  const job = JobSchema.parse({ id: voice.creationJobId, idempotencyKey: "01J8F3K2QW9VZX4N7M0RTYB6HD", worldId: FIXTURE_STATE.world!.meta.worldId,
    provider: "google", model: voice.model, capability: "voice-tts", target: { kind: "voice-design" }, status: "succeeded", estimatedMicroUsd: 151552,
    params: { name: voice.name, text: voice.description, operation: "voice-design" }, providerJobId: voice.remoteId,
    createdAt: voice.created, updatedAt: voice.created, landedFiles: [".cache/voice-design/candidate.wav"] });
  __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, manifest: SHIPPED_MANIFEST, jobs: candidate ? [job] : [] } });
  const element = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(element);
  const root = createRoot(element); roots.push(root);
  await act(async () => root.render(<DesignVoiceDialog worldId={FIXTURE_STATE.world!.meta.worldId} name={voice.name} description={voice.description}
    onUse={value => used.push(value)} onClose={() => {}} />));
  return { sent, used, element };
}
const button = (label: string) => [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(label))!;

it("opening a seeded design is free and one explicit Generate carries the displayed estimate", async () => {
  const { sent } = await setup();
  assert.equal(sent.length, 0);
  assert.match(dom.document.body.textContent!, /not a spending cap/);
  await act(async () => button("Generate one candidate").click());
  const message = sent.find(row => row.kind === "design-voice");
  assert.ok(message);
  assert.equal(message.draft.description, voice.description);
  assert.equal(message.draft.model, "gemini-3.8-flash-tts");
  assert.ok(message.confirmedEstimateMicroUsd > 0);
  assert.equal(sent.length, 1);
});

it("a recovered candidate replays locally; Save and Use are separate choices", async () => {
  const { sent, used } = await setup(true);
  assert.ok(dom.document.querySelector('audio[aria-label="Provider audition"]'));
  assert.equal(sent.length, 0);
  await act(async () => button("Save voice").click());
  const save = sent.find(row => row.kind === "save-designed-voice");
  assert.ok(save);
  assert.equal(save.jobId, voice.creationJobId);
  assert.equal(used.length, 0);
  await act(async () => __applyEventForTest({ type: "voice.designed-saved", at: voice.created, requestId: save.requestId,
    worldId: FIXTURE_STATE.world!.meta.worldId, voice, reason: null }));
  assert.equal(used.length, 0);
  assert.ok(dom.document.querySelector('audio[aria-label="Saved audition"]'));
  await act(async () => button("Use this voice").click());
  assert.equal(used[0]?.voiceId, designedVoiceTarget(voice));
  assert.ok(!sent.some(row => row.kind === "design-voice" || row.kind === "hear-designed-voice"));
});

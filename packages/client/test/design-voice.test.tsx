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

it("From your Google project lists the project's voices by name, and Import saves the one pressed (design turn 204, issue 1635)", async () => {
  const { sent } = await setup();
  assert.equal(sent.length, 0, "nothing is listed before the view is opened");
  await act(async () => button("From your Google project").click());
  const list = sent.find(row => row.kind === "list-designed-voices");
  assert.ok(list, "the view asks for the project's voices when it opens");
  const worldId = FIXTURE_STATE.world!.meta.worldId;
  await act(async () => __applyEventForTest({ type: "voice.designed-listed", at: voice.created, requestId: list.requestId, worldId, reason: null, voices: [
    { remoteId: "voice_e9ki3cpkdhf0", name: "Nigerian Woman 2", language: "und", model: "gemini-3.8-flash-tts", expiresAt: "2099-04-06T00:00:00Z" },
    { remoteId: "voice_fjwyh1zr45jr", name: "Nigerian Woman 1", language: "und", model: "gemini-3.8-flash-tts", expiresAt: "2099-04-06T00:00:00Z" },
  ] }));
  const rows = [...dom.document.querySelectorAll('[data-testid="project-voice"]')];
  assert.deepEqual(rows.map(row => row.querySelector("b")!.textContent), ["Nigerian Woman 2", "Nigerian Woman 1"], "by name, as Google lists them");
  assert.match(rows[0]!.textContent!, /voice_e9ki3cpkdhf0/, "with the ID as data");
  await act(async () => rows[0]!.querySelector("button")!.click());
  const save = sent.find(row => row.kind === "save-designed-voice");
  assert.equal(save?.remoteId, "voice_e9ki3cpkdhf0", "Import verifies and saves the voice pressed, by its ID");
  assert.equal(rows[0]!.querySelector("button")!.textContent, "importing…");
  assert.ok(dom.document.querySelector('input[aria-label="Google voice ID"]'), "the ID stays for a voice not listed");
});

it("a project voice already in the world says so instead of Import", async () => {
  const { sent } = await setup();
  __setStateForTest({ ...FIXTURE_STATE, world: { ...FIXTURE_STATE.world!, designedVoices: [voice] }, app: { ...FIXTURE_STATE.app, manifest: SHIPPED_MANIFEST } });
  await act(async () => button("From your Google project").click());
  const list = sent.find(row => row.kind === "list-designed-voices")!;
  await act(async () => __applyEventForTest({ type: "voice.designed-listed", at: voice.created, requestId: list.requestId, worldId: FIXTURE_STATE.world!.meta.worldId, reason: null,
    voices: [{ remoteId: voice.remoteId, name: voice.name, language: "en-GB", model: voice.model, expiresAt: voice.expiresAt }] }));
  assert.match(dom.document.querySelector('[data-testid="project-voice"]')!.textContent!, /in this world/);
  assert.ok(!sent.some(row => row.kind === "save-designed-voice"));
});

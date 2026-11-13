import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { StudioAssistantCommand } from "@arke-studio/contracts";
import { StudioDictation } from "../src/components/studio-dictation.js";
import type { DictationPhase } from "../src/components/dictation.js";
import { StudioConversationClient } from "../src/lib/studio-assistant.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Element: dom.Element, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported(type: string) { return type === "audio/webm"; }
  state = "inactive"; interval = 0;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  errorListener: (() => void) | null = null;
  addEventListener(type: string, listener: () => void) { if (type === "error") this.errorListener = listener; }
  constructor(readonly stream: MediaStream, readonly options: { mimeType: string }) { Recorder.instances.push(this); }
  start(interval: number) { this.interval = interval; this.state = "recording"; }
  push(blob: Blob) { this.ondataavailable?.({ data: blob }); }
  stop() { this.state = "inactive"; this.onstop?.(); }
}
Object.assign(globalThis, { MediaRecorder: Recorder });
function stream() {
  let stopped = 0;
  const value = { getTracks: () => [{ stop() { stopped++; } }] } as unknown as MediaStream;
  return { value, stopped: () => stopped };
}
async function fixture(getUserMedia: () => Promise<MediaStream>) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia } } });
  __setStateForTest({ ...FIXTURE_STATE, world: null }, { connection: "open", voiceSidecar: { state: "ready", detail: "ready" } });
  Recorder.instances = [];
  const sent: StudioAssistantCommand[] = [], phases: DictationPhase[] = [];
  const client = new StudioConversationClient({ id: randomUUID, send(message) { sent.push(message); return true; } });
  client.setConnected(true); client.open();
  client.receive({ requestId: sent.at(-1)!.requestId, response: { type: "state", state: { audit: "available", accepting: true, busy: false, threads: [], share: null, ephemeralReply: null } } });
  client.draft("Typed words");
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const onPhase = (phase: DictationPhase) => { phases.push(phase); };
  await act(async () => root.render(<StudioDictation client={client} enabled onPhase={onPhase} />));
  return { sent, phases, client, root, container, onPhase, mic: () => container.querySelector<HTMLButtonElement>(".fy-cx__mic")!,
    async cleanup() { await act(async () => root.unmount()); client.dispose(); container.remove(); } };
}
it("records bounded local audio only after a press, transcribes on Stop and inserts an unsent editable draft", async () => {
  const audio = stream(), h = await fixture(async () => audio.value);
  try {
    assert.equal(Recorder.instances.length, 0);
    await act(async () => h.mic().click());
    const recorder = Recorder.instances[0]!;
    assert.equal(recorder.interval, 250); assert.equal(h.phases.at(-1), "listening"); assert(h.container.textContent?.includes("one minute"));
    await act(async () => { recorder.push(new Blob([new Uint8Array([1, 2, 3])])); h.mic().click(); });
    assert(audio.stopped() > 0); assert.equal(h.phases.at(-1), "transcribing");
    const request = h.sent.at(-1)!; assert.deepEqual(request.command, { action: "dictate", audioBase64: "AQID", contentType: "audio/webm" });
    await act(async () => h.client.receive({ requestId: request.requestId, response: { type: "dictation", text: "Spoken words" } }));
    assert.equal(h.phases.at(-1), "idle"); assert.equal(h.client.getSnapshot().draft, "Typed words Spoken words");
    assert.deepEqual(h.sent.map(message => message.command.action), ["watch", "dictate"]);
  } finally { await h.cleanup(); }
});
it("closing during microphone permission stops a late stream without recording or transcribing", async () => {
  const audio = stream(); let permit!: (stream: MediaStream) => void;
  const h = await fixture(() => new Promise(resolve => { permit = resolve; }));
  try {
    await act(async () => h.mic().click()); assert.equal(h.phases.at(-1), "requesting");
    await act(async () => h.root.unmount());
    await act(async () => permit(audio.value));
    assert(audio.stopped() > 0); assert.equal(Recorder.instances.length, 0);
    assert.deepEqual(h.sent.map(message => message.command.action), ["watch"]); assert.equal(h.client.getSnapshot().draft, "Typed words");
  } finally { h.client.dispose(); h.container.remove(); }
});
it("closing or disconnecting a live recording discards it and releases its microphone", async () => {
  const audio = stream(), h = await fixture(async () => audio.value);
  try {
    await act(async () => h.mic().click()); const recorder = Recorder.instances[0]!; recorder.push(new Blob(["PRIVATE_AUDIO"]));
    await act(async () => h.root.render(<StudioDictation client={h.client} enabled={false} onPhase={h.onPhase} />));
    assert(audio.stopped() > 0); assert.equal(recorder.state, "inactive"); assert.equal(h.phases.at(-1), "idle");
    assert.deepEqual(h.sent.map(message => message.command.action), ["watch"]);
  } finally { await h.cleanup(); }
});
it("an oversized recording stops capture and preserves the draft without uploading a partial clip", async () => {
  const audio = stream(), h = await fixture(async () => audio.value);
  try {
    await act(async () => h.mic().click()); const recorder = Recorder.instances[0]!;
    await act(async () => recorder.push(new Blob([new Uint8Array(6_000_001)])));
    assert(audio.stopped() > 0); assert.equal(recorder.state, "inactive"); assert.equal(h.phases.at(-1), "idle");
    assert(h.container.textContent?.includes("too large")); assert.equal(h.client.getSnapshot().draft, "Typed words");
    assert.deepEqual(h.sent.map(message => message.command.action), ["watch"]);
  } finally { await h.cleanup(); }
});
it("the one-minute limit stops and transcribes once through the same private path", async context => {
  const audio = stream(), h = await fixture(async () => audio.value);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await act(async () => h.mic().click()); const recorder = Recorder.instances[0]!; recorder.push(new Blob([new Uint8Array([1, 2, 3])]));
    await act(async () => context.mock.timers.tick(59_999)); assert.equal(recorder.state, "recording");
    await act(async () => context.mock.timers.tick(1)); assert.equal(recorder.state, "inactive"); assert(audio.stopped() > 0);
    assert.equal(h.sent.filter(message => message.command.action === "dictate").length, 1);
    await act(async () => h.client.receive({ requestId: h.sent.at(-1)!.requestId, response: { type: "dictation", text: "A minute of speech" } }));
    assert.equal(h.client.getSnapshot().draft, "Typed words A minute of speech");
  } finally { await h.cleanup(); context.mock.timers.reset(); }
});

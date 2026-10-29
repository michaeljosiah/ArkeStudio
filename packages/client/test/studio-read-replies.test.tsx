import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { StudioAssistantCommand, StudioAssistantSnapshot, StudioAssistantResponse } from "@arke-studio/contracts";
import { StudioConversationClient } from "../src/lib/studio-assistant.js";
import { useStudioReadReplies } from "../src/components/studio-read-replies.js";
import { __setStateForTest } from "../src/lib/store.js";
import { emitForTest, playbackSnapshot, playClip, setAudioFactoryForTest } from "../src/lib/audio.js";
import { resetReadRepliesForTest, setReadReplies } from "../src/lib/reply-reads.js";
import { FIXTURE_STATE } from "./fixture-state.js";

it("reads only newly completed visible Studio replies, one private part at a time, and never steals playback or replays restored history", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const audio = { src: "", currentTime: 0, duration: 1, play: async () => {}, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
  setAudioFactoryForTest(() => audio); resetReadRepliesForTest(); setReadReplies(true);
  __setStateForTest(FIXTURE_STATE, { connection: "open", voiceSidecar: { state: "ready", detail: "Local voice ready" } });
  const threadId = "01J8F3K2QW9VZX4N7M0RTYB6HC", old = "01J8F3K2QW9VZX4N7M0RTYB6HD", fresh = "01J8F3K2QW9VZX4N7M0RTYB6HE";
  const snapshot: StudioAssistantSnapshot = { audit: "available", accepting: true, busy: false, share: null, ephemeralReply: null,
    threads: [{ id: threadId, createdAt: 1, updatedAt: 1, archived: false, pending: null, messages: [{ id: old, role: "arke", text: "Old private reply", at: 1 }] }] };
  const sent: StudioAssistantCommand[] = [], client = new StudioConversationClient({ id: randomUUID, send(message) { sent.push(message); return true; } });
  client.setConnected(true); client.open();
  const deliver = () => client.receive({ requestId: sent.findLast(message => message.command.action === "watch")!.requestId, response: { type: "state", state: structuredClone(snapshot) } });
  deliver(); client.select(threadId);
  function Harness({ visible = true }: { visible?: boolean }) {
    const view = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot), read = useStudioReadReplies(client, view, visible);
    return <><button onClick={() => read.listen(old)}>Listen</button><button onClick={read.stop}>Stop</button><span>{read.reading}</span><p>{read.trouble}</p></>;
  }
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const requests = () => sent.filter(message => message.command.action === "read-reply");
  const respond = (request: StudioAssistantCommand, patch: Partial<Extract<StudioAssistantResponse, { type: "speech" }>> = {}) => client.receive({ requestId: request.requestId,
    response: { type: "speech", part: 0, parts: 2, source: "a".repeat(64), voiceId: "bm_george", format: "wav", audioBase64: Buffer.alloc(60).toString("base64"), ...patch } });
  try {
    await act(async () => root.render(<Harness />)); assert.equal(requests().length, 0, "first visible history is never narrated");
    snapshot.threads[0]!.messages.push({ id: fresh, role: "arke", text: "New private reply", at: 2 });
    await act(async () => deliver()); assert.equal(requests().length, 1);
    const first = requests()[0]!; assert(first.command.action === "read-reply" && first.command.messageId === fresh);
    await act(async () => respond(first)); assert.equal(playbackSnapshot().status, "playing"); assert.equal(requests().length, 1);
    snapshot.threads[0]!.messages.push({ id: "01J8F3K2QW9VZX4N7M0RTYB6HF", role: "arke", text: "A second completed answer", at: 3 });
    await act(async () => deliver()); assert.equal(requests().length, 1, "a new answer cannot race its original speech producer");
    await act(async () => emitForTest("ended")); const next = requests()[1]!;
    assert(next.command.action === "read-reply" && next.command.part === 1 && next.command.source === "a".repeat(64) && next.command.voiceId === "bm_george");
    await act(async () => respond(next, { part: 1 })); assert.equal(requests().length, 2);
    await act(async () => emitForTest("ended")); assert.equal(requests().length, 3);
    const queued = requests()[2]!; assert(queued.command.action === "read-reply" && queued.command.messageId === "01J8F3K2QW9VZX4N7M0RTYB6HF" && queued.command.part === 0);
    await act(async () => respond(queued, { parts: 1 })); await act(async () => emitForTest("ended")); assert.equal(playbackSnapshot().clip, null); assert.equal(requests().length, 3);
    await act(async () => root.render(<Harness visible={false} />));
    snapshot.threads[0]!.messages.push({ id: "01J8F3K2QW9VZX4N7M0RTYB6HG", role: "arke", text: "Reply while conversation history is open", at: 4 });
    await act(async () => deliver()); assert.equal(requests().length, 3);
    await act(async () => root.render(<Harness />)); assert.equal(requests().length, 3, "returning from history is not a newly arrived visible reply");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click()); const changing = requests().at(-1)!;
    const changed = structuredClone(FIXTURE_STATE); changed.app.narrator = { provider: "kokoro", model: "kokoro-82m", voiceId: "af_heart", label: "Heart" };
    await act(async () => __setStateForTest(changed, { connection: "open", voiceSidecar: { state: "ready", detail: "Ready" } }));
    await act(async () => respond(changing)); assert.equal(playbackSnapshot().clip, null, "a changed narrator cancels even before the first part arrives");
    await act(async () => __setStateForTest(FIXTURE_STATE, { connection: "open", voiceSidecar: { state: "ready", detail: "Ready" } }));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click()); const manual = requests().at(-1)!;
    await act(async () => playClip({ id: "gallery", url: "blob:gallery", title: "Gallery audio" }));
    await act(async () => respond(manual)); assert.equal(playbackSnapshot().clip?.id, "gallery");
    assert(sent.some(message => message.command.action === "stop-reply-read" && message.command.readRequestId === manual.requestId));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click()); const closing = requests().at(-1)!;
    await act(async () => client.close()); await act(async () => respond(closing)); assert.equal(playbackSnapshot().clip?.id, "gallery");
    const count = requests().length; await act(async () => { client.open(); deliver(); }); assert.equal(requests().length, count);
    const cloud = structuredClone(FIXTURE_STATE); cloud.app.narrator = { provider: "google", model: "gemini-3.1-flash-tts-preview", voiceId: "Puck", label: "Puck" };
    await act(async () => __setStateForTest(cloud, { connection: "open", voiceSidecar: { state: "ready", detail: "Ready" } }));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click()); assert.equal(requests().length, count, "a cloud narrator cannot silently fall back or receive private Studio text");
  } finally { await act(async () => root.unmount()); client.dispose(); container.remove(); resetReadRepliesForTest(); setAudioFactoryForTest(null); }
});

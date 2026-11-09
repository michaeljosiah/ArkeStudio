import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { FrameSchema, type Frame } from "@arke-studio/contracts";
import { Transport } from "../../src/transport.js";
import { ReadModel } from "../../src/read-model.js";
import { VoiceConversationHost } from "../../src/voice/conversation.js";

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < end, "Expected private wire frame did not arrive"); await new Promise(done => setTimeout(done, 5)); }
}

test("the authenticated file-origin wire admits actual world IDs and keeps voice frames requester-private", async () => {
  const speech = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(speech, "listening");
  const address = speech.address(); assert.ok(address && typeof address === "object");
  const speechToken = randomBytes(32).toString("base64url"), token = randomBytes(32).toString("hex");
  const worldId = "01J8F3K2QW9VZX4N7M0RTYB6HC", conversationId = "cv_01J00000000000000000000000";
  let peer: WebSocket | undefined, bound = 0;
  speech.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer " + speechToken); peer = socket;
    socket.on("message", bytes => { if (JSON.parse(String(bytes)).voice) socket.send(JSON.stringify({ type: "ready" })); });
  });
  const host = new VoiceConversationHost({ endpoint: async () => ({ url: `ws://127.0.0.1:${address.port}/live`, headers: { Authorization: "Bearer " + speechToken } }),
    scope: async command => { assert.equal(command.worldId, worldId); assert.equal(command.conversationId, conversationId); bound++;
      return { current: () => true, signal: new AbortController().signal, voice: "bf_emma", run: async () => ({ status: "completed" }), refresh: async () => {} }; } });
  const transport = new Transport({ auth: { token, allowedOrigins: ["file://"] }, getSnapshot: () => new ReadModel("test").getState(),
    onMessage: (message, requester) => { if (message.kind === "voice-conversation" && requester) host.handle(message, requester); } });
  const port = await transport.start();
  const owner = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "file://" }), other = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "file://" });
  const frames: Frame[] = [], foreign: Frame[] = [], raw: string[] = [];
  owner.on("message", bytes => { raw.push(String(bytes)); frames.push(FrameSchema.parse(JSON.parse(String(bytes)))); });
  other.on("message", bytes => foreign.push(FrameSchema.parse(JSON.parse(String(bytes)))));
  try {
    await Promise.all([once(owner, "open"), once(other, "open")]);
    owner.send(JSON.stringify({ kind: "hello", token })); other.send(JSON.stringify({ kind: "hello", token }));
    await until(() => frames.some(frame => frame.kind === "snapshot") && foreign.some(frame => frame.kind === "snapshot"));
    const session = randomUUID();
    owner.send(JSON.stringify({ kind: "voice-conversation", session, command: { action: "open", worldId, conversationId, silenceMs: 650, cloudConsent: true } }));
    await until(() => frames.some(frame => frame.kind === "voice-conversation" && frame.response.type === "state" && frame.response.state === "listening"));
    peer!.send(JSON.stringify({ type: "audio", audio: "AAA=" }));
    await until(() => frames.some(frame => frame.kind === "voice-conversation" && frame.response.type === "audio"));
    assert.equal(bound, 1); assert.ok(!foreign.some(frame => frame.kind === "voice-conversation"));
    assert.ok(frames.every((frame, index) => !index || frame.seq > frames[index - 1]!.seq));
    assert.ok(raw.every(text => !text.includes(speechToken) && !text.includes(token)));
  } finally {
    owner.terminate(); other.terminate(); await host.stop(); await transport.stop();
    for (const socket of speech.clients) socket.terminate();
    await new Promise<void>(resolve => speech.close(() => resolve()));
  }
});

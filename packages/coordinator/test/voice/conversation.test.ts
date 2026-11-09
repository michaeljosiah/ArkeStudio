import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { VoiceConversationHost } from "../../src/voice/conversation.js";
import type { TransportRequester } from "../../src/transport.js";
import type { VoiceConversationResponse } from "@arke-studio/contracts";

async function until(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 3000;
  while (!predicate()) { if (Date.now() >= until) throw new Error("Expected voice event did not arrive"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test("private live scope streams only to its owning requester and drains interrupted inference", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  let peer: WebSocket | undefined;
  const incoming: Array<Record<string, unknown>> = [];
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer private-host-only");
    peer = socket;
    socket.on("message", bytes => {
      const message = JSON.parse(String(bytes)); incoming.push(message);
      if (message.voice) socket.send(JSON.stringify({ type: "ready" }));
    });
  });
  let current = true, stopped = false;
  const owner = new AbortController(), scope = new AbortController();
  const replies: VoiceConversationResponse[] = [];
  const requester: TransportRequester = { signal: owner.signal, reply: () => false, voice: (_id, reply) => { replies.push(reply); return true; } };
  const stranger: TransportRequester = { signal: new AbortController().signal, reply: () => false, voice: () => { throw new Error("Foreign reply"); } };
  const host = new VoiceConversationHost({ endpoint: async () => ({ url: `ws://127.0.0.1:${address.port}/live`, headers: { Authorization: "Bearer private-host-only" } }),
    scope: async () => ({ signal: scope.signal, current: () => current, voice: "bf_emma", refresh: async () => {},
      run: async (_text, signal, delta) => { delta("I am listening. " + "word ".repeat(600)); await new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true })); return { status: "cancelled" }; } }) });
  const session = randomUUID();
  try {
    host.handle({ kind: "voice-conversation", session, command: { action: "open", worldId: "sample", conversationId: "cv_01J00000000000000000000000", silenceMs: 650, cloudConsent: true } }, requester);
    await until(() => replies.some(reply => reply.type === "state" && reply.state === "listening"));
    host.handle({ kind: "voice-conversation", session, command: { action: "end" } }, stranger);
    peer!.send(JSON.stringify({ type: "turn", turn: randomUUID(), text: "Hello." }));
    await until(() => incoming.some(message => message.type === "delta"));
    host.handle({ kind: "voice-conversation", session, command: { action: "interrupt" } }, requester);
    await until(() => stopped);
    assert.ok(replies.some(reply => reply.type === "interrupted"));
    current = false;
    const before = replies.length;
    peer!.send(JSON.stringify({ type: "audio", audio: "AAA=" }));
    await until(() => peer!.readyState === 3);
    assert.equal(replies.length, before + 1, "A changed scope receives only its terminal state");
    assert.deepEqual(replies.at(-1), { type: "state", state: "ended" });
    assert.ok(incoming.filter(message => message.type === "delta").every(message => String(message.text).length <= 2048));
    await host.stop();
  } finally {
    owner.abort(); await host.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("private speech endpoints cannot redirect audio or capabilities off loopback", async () => {
  const replies: VoiceConversationResponse[] = [];
  const requester: TransportRequester = { signal: new AbortController().signal, reply: () => false, voice: (_id, reply) => { replies.push(reply); return true; } };
  const host = new VoiceConversationHost({ endpoint: async () => ({ url: "ws://example.com/live", headers: { Authorization: "private" } }),
    scope: async () => ({ signal: new AbortController().signal, current: () => true, voice: "bf_emma", refresh: async () => {}, run: async () => ({ status: "completed" }) }) });
  host.handle({ kind: "voice-conversation", session: randomUUID(), command: { action: "open", worldId: "sample", conversationId: "cv_01J00000000000000000000000", silenceMs: 650, cloudConsent: true } }, requester);
  await until(() => replies.some(reply => reply.type === "state" && reply.state === "failed"));
  await host.stop();
});

test("a completed spoken turn acknowledges its durable final text exactly once", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const replies: VoiceConversationResponse[] = [];
  const host = new VoiceConversationHost({ endpoint: async () => ({ url: `ws://127.0.0.1:${address.port}/live`, headers: {} }),
    scope: async () => ({ signal: new AbortController().signal, current: () => true, voice: "bf_emma", refresh: async () => {},
      run: async (_text, _signal, delta) => { delta("Hello."); return { status: "completed", reply: "Hello." }; } }) });
  server.on("connection", socket => socket.on("message", bytes => {
    if (JSON.parse(String(bytes)).voice) {
      socket.send(JSON.stringify({ type: "ready" }));
      socket.send(JSON.stringify({ type: "turn", turn: randomUUID(), text: "Hello." }));
    }
  }));
  const owner = new AbortController();
  try {
    host.handle({ kind: "voice-conversation", session: randomUUID(), command: { action: "open", worldId: "sample", conversationId: "cv_01J00000000000000000000000", silenceMs: 650, cloudConsent: true } },
      { signal: owner.signal, reply: () => false, voice: (_id, reply) => { replies.push(reply); return true; } });
    await until(() => replies.some(reply => reply.type === "text" && reply.role === "studio" && reply.final));
    assert.deepEqual(replies.filter(reply => reply.type === "text" && reply.role === "studio"), [
      { type: "text", role: "studio", text: "Hello.", final: false }, { type: "text", role: "studio", text: "Hello.", final: true },
    ]);
  } finally {
    owner.abort(); await host.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

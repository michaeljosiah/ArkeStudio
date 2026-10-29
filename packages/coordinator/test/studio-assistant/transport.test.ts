import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import WebSocket from "ws";
import { FrameSchema, type Frame, type StudioAssistantResponse } from "@arke-studio/contracts";
import { Transport, type TransportRequester } from "../../src/transport.js";
import { emptyClientState } from "../client-state.js";
import { until } from "../wait.js";

const token = "a".repeat(64), auth = { token, allowedOrigins: ["file://"] };
const privateState: StudioAssistantResponse = { type: "state", state: { audit: "available", accepting: true, busy: false,
  share: null, ephemeralReply: null, threads: [{ id: "01J8F3K2QW9VZX4N7M0RTYB6HC", createdAt: 1, updatedAt: 1, archived: false, pending: null,
    messages: [{ id: "01J8F3K2QW9VZX4N7M0RTYB6HD", role: "user", at: 1, text: "PRIVATE_STUDIO_TRANSCRIPT" }] }] } };
async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "file://" }), frames: Frame[] = [];
  socket.on("message", data => frames.push(FrameSchema.parse(JSON.parse(String(data)))));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const send = (value: unknown) => socket.send(JSON.stringify(value));
  return { socket, frames, send, async hello() { send({ kind: "hello", token }); await until(() => frames.length > 0, "authenticated initial snapshot"); } };
}
it("sends private Studio replies only to the authenticated requester without broadcasting or folding them into snapshots", async () => {
  const common = emptyClientState();
  const transport = new Transport({ auth, getSnapshot: () => common, onMessage(message, requester) {
    if (message.kind === "studio-assistant") assert.equal(requester?.reply(message.requestId, privateState), true);
  } });
  const port = await transport.start(), first = await connect(port), second = await connect(port);
  try {
    await first.hello(); await second.hello();
    const requestId = randomUUID(); first.send({ kind: "studio-assistant", requestId, command: { action: "watch" } });
    await until(() => first.frames.length === 2, "private response");
    transport.broadcast({ at: "2026-10-27T00:00:00Z", type: "health.changed", component: "voice", status: "starting" });
    await until(() => first.frames.length === 3 && second.frames.length === 2, "ordinary events on both sockets");
    assert.equal(first.frames[1]?.kind, "studio-assistant"); assert.deepEqual(first.frames.map(frame => frame.seq), [1, 2, 3]);
    assert.deepEqual(second.frames.map(frame => frame.seq), [1, 2]);
    assert(!JSON.stringify(second.frames).includes("PRIVATE_STUDIO")); assert(!JSON.stringify(common).includes("PRIVATE_STUDIO"));
    transport.broadcastSnapshot(); await until(() => first.frames.length === 4 && second.frames.length === 3, "common refresh");
    assert(!JSON.stringify(first.frames[3]).includes("PRIVATE_STUDIO"));
  } finally { first.socket.close(); second.socket.close(); await transport.stop(); }
});
it("reconciles before a private response and never reuses a closed socket's reply authority on reconnect", async () => {
  let finish!: () => void, requester: TransportRequester | undefined;
  const ready = new Promise<void>(resolve => { finish = resolve; });
  const transport = new Transport({ auth, getSnapshot: emptyClientState, beforeInitialSnapshot: () => ready,
    onMessage(message, context) { if (message.kind === "studio-assistant") { requester = context; context?.reply(message.requestId, privateState); } } });
  const port = await transport.start(), client = await connect(port); let next: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    client.send({ kind: "hello", token }); client.send({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "watch" } });
    assert.equal(requester, undefined); finish(); await until(() => client.frames.length === 2, "snapshot before queued private reply");
    assert.deepEqual(client.frames.map(frame => frame.kind), ["snapshot", "studio-assistant"]);
    const closed = new Promise<void>(resolve => client.socket.once("close", () => resolve())); client.socket.close(); await closed;
    await until(() => requester?.signal.aborted === true, "requester authority revoked");
    next = await connect(port); await next.hello();
    assert.equal(requester!.reply(randomUUID(), privateState), false); assert.deepEqual(next.frames.map(frame => frame.kind), ["snapshot"]);
  } finally { finish(); client.socket.close(); next?.socket.close(); await transport.stop(); }
});
it("revokes private reply authority immediately on a refused reauthentication", async () => {
  let requester: TransportRequester | undefined;
  const logs: string[] = [];
  const transport = new Transport({ auth, getSnapshot: emptyClientState, log: line => logs.push(line),
    onMessage(message, context) { if (message.kind === "studio-assistant") requester = context; } });
  const port = await transport.start(), client = await connect(port);
  try {
    await client.hello(); client.send({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "watch" } });
    await until(() => requester !== undefined, "authenticated requester captured");
    const closed = new Promise<void>(resolve => client.socket.once("close", () => resolve()));
    client.send({ kind: "hello", token: "b".repeat(64) }); await closed;
    assert(requester!.signal.aborted); assert.equal(requester!.reply(randomUUID(), privateState), false);
    assert.equal(client.frames.length, 1); assert(!JSON.stringify(logs).includes("PRIVATE_STUDIO"));
  } finally { client.socket.close(); await transport.stop(); }
});

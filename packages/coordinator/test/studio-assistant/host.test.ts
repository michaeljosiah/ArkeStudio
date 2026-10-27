import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import WebSocket from "ws";
import { FrameSchema, type Frame, type StudioAssistantResponse } from "@arke-studio/contracts";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { StudioAssistantHost } from "../../src/studio-assistant/host.js";
import { StudioAssistantService } from "../../src/studio-assistant/service.js";
import { studioDiagnosticEvidence } from "../../src/studio-assistant/evidence.js";
import type { StudioModelPort } from "../../src/studio-assistant/runner.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until } from "../wait.js";

it("the production owner keeps Studio history across world opens/restarts and replies only to its requesting socket", async () => {
  const { root } = await makeTempRoot(), provider = new FsWorldProvider(root); let sends = 0, nonlocal = false;
  const model: StudioModelPort = { busy: () => false, stop: async () => {}, async run(input, signal, authorize) {
    await authorize({ role: input.role, model: input.model, provider: "synthetic", local: !nonlocal, destination: "c".repeat(64), prompt: input.prompt }, signal);
    sends++; return JSON.stringify({ kind: "reply", text: "PRIVATE_STUDIO_REPLY" });
  } };
  const options = { appRoot: root, provider, adapter: null, storageHealth: null, systemResources: null, recoveryControl: null, recoveryHistory: null,
    changeLogPath: join(root, "logs", "coordinator.jsonl"), appVersion: "studio-test", studioAssistant: { model } };
  let coordinator = createStudioCoordinator(options); const sockets: WebSocket[] = [];
  async function connect(session: { port: number; token: string }) {
    const socket = new WebSocket(`ws://127.0.0.1:${session.port}`), frames: Frame[] = []; sockets.push(socket);
    socket.on("message", data => frames.push(FrameSchema.parse(JSON.parse(String(data))))); await once(socket, "open");
    socket.send(JSON.stringify({ kind: "hello", token: session.token })); await until(() => frames.some(frame => frame.kind === "snapshot"), "owner snapshot");
    async function command(command: unknown): Promise<Extract<Frame, { kind: "studio-assistant" }>> {
      const requestId = randomUUID(); socket.send(JSON.stringify({ kind: "studio-assistant", requestId, command }));
      await until(() => frames.some(frame => frame.kind === "studio-assistant" && frame.requestId === requestId), "private correlated reply");
      return frames.find(frame => frame.kind === "studio-assistant" && frame.requestId === requestId) as Extract<Frame, { kind: "studio-assistant" }>;
    }
    return { socket, frames, command };
  }
  try {
    const session = await coordinator.start(0), first = await connect(session), other = await connect(session);
    const created = (await first.command({ action: "create" })).response; assert(created.type === "result" && created.threadId); const threadId = created.threadId;
    await first.command({ action: "watch" });
    const sent = (await first.command({ action: "send", threadId, text: "PRIVATE_STUDIO_QUESTION", model: "synthetic/model" })).response;
    assert(sent.type === "result" && sent.status === "accepted");
    await until(() => first.frames.some(frame => frame.kind === "studio-assistant" && frame.response.type === "state" && frame.response.state.threads[0]?.messages.at(-1)?.text === "PRIVATE_STUDIO_REPLY"), "durable private response");
    nonlocal = true;
    await first.command({ action: "send", threadId, text: "PRIVATE_CLOUD_QUESTION", model: "synthetic/model" });
    await until(() => first.frames.some(frame => frame.kind === "studio-assistant" && frame.response.type === "state" && frame.response.state.share), "private one-use sharing review");
    const sharing = first.frames.findLast(frame => frame.kind === "studio-assistant" && frame.response.type === "state" && frame.response.state.share);
    assert(sharing?.kind === "studio-assistant" && sharing.response.type === "state" && sharing.response.state.share); const share = sharing.response.state.share;
    assert(share.prompt.includes("PRIVATE_CLOUD_QUESTION")); assert.equal(sends, 1);
    const approval = { action: "approve-cloud", threadId, runId: share.runId, shareId: share.id, digest: share.digest };
    const wrong = (await first.command({ ...approval, digest: "d".repeat(64) })).response; assert(wrong.type === "result" && wrong.status === "refused"); assert.equal(sends, 1);
    const approved = (await first.command(approval)).response; assert(approved.type === "result" && approved.status === "ok");
    await until(() => sends === 2, "one approved nonlocal dispatch");
    const repeated = (await first.command(approval)).response; assert(repeated.type === "result" && repeated.status === "refused"); assert.equal(sends, 2);
    await coordinator.openWorld(WORLD_ID);
    const state = (await first.command({ action: "watch" })).response; assert(state.type === "state");
    assert.equal(state.state.threads[0]?.id, threadId); assert.equal(state.state.threads[0]?.messages[0]?.text, "PRIVATE_STUDIO_QUESTION");
    assert(!JSON.stringify(other.frames).includes("PRIVATE_STUDIO")); assert(!JSON.stringify(coordinator.getState()).includes("PRIVATE_STUDIO"));
    const history = await readFile(join(root, "studio-assistant", "conversations.json"), "utf8"); assert(history.includes("PRIVATE_STUDIO_REPLY"));
    first.socket.close(); other.socket.close(); await coordinator.stop();
    coordinator = createStudioCoordinator({ ...options, provider: new FsWorldProvider(root) });
    const resumed = await connect(await coordinator.start(0)), restored = (await resumed.command({ action: "watch" })).response;
    assert(restored.type === "state"); assert.equal(restored.state.threads[0]?.id, threadId); assert.equal(sends, 2, "Restart never replays a model call");
  } finally { for (const socket of sockets) socket.close(); await coordinator.stop(); await provider.close(); }
});

it("bounds an unconfirmed load, keeps pending admission owned and prevents late work after host stop", async () => {
  let finish!: () => void, saves = 0, sends = 0;
  const load = new Promise<unknown>(resolve => { finish = () => resolve({ version: 1, threads: [] }); });
  const service = new StudioAssistantService({ store: { load: () => load, save: async () => { saves++; } }, shutdownMs: 10,
    model: { busy: () => false, run: async () => { sends++; return ""; }, stop: async () => {} }, evidence: topic => studioDiagnosticEvidence(topic, {}, Date.now()) });
  const host = new StudioAssistantHost(service, 10), replies: StudioAssistantResponse[] = [], control = new AbortController();
  const requester = { signal: control.signal, reply(_id: string, value: StudioAssistantResponse) { replies.push(value); return true; } };
  try {
    const requestId = randomUUID(); await host.handle({ kind: "studio-assistant", requestId, command: { action: "create" } }, requester);
    assert(replies.some(value => value.type === "result" && value.status === "unconfirmed" && value.reason === "timeout"));
    await host.handle({ kind: "studio-assistant", requestId, command: { action: "create" } }, requester);
    assert.equal(replies.at(-1)?.type, "result"); assert.equal(saves, 0);
    await host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "watch" } }, requester);
    await host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "create" } }, requester);
    const held = replies.at(-1); assert(held?.type === "result" && held.reason === "busy");
    await host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "cancel", threadId: "01J8F3K2QW9VZX4N7M0RTYB6HC", runId: "01J8F3K2QW9VZX4N7M0RTYB6HD" } }, requester);
    const cancel = replies.at(-1); assert(cancel?.type === "result" && cancel.reason === "invalid", "Stop/cancel controls do not queue behind an uncertain file operation");
    await host.stop(); finish(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(saves, 0); assert.equal(sends, 0); assert.equal(service.snapshot().accepting, false);
  } finally { finish(); control.abort(); await host.stop(); }
});

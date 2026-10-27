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
  const attachments = [{ id: randomUUID(), name: "PRIVATE_STUDIO_DOCUMENT.txt", text: "PRIVATE_STUDIO_DOCUMENT_CONTENT" }];
  const model: StudioModelPort = { busy: () => false, stop: async () => {}, async run(input, signal, authorize) {
    await authorize({ role: input.role, model: input.model, provider: "synthetic", local: !nonlocal, destination: "c".repeat(64), prompt: input.prompt }, signal);
    assert(input.prompt.includes(attachments[0]!.text)); sends++; return JSON.stringify({ kind: "reply", text: "PRIVATE_STUDIO_REPLY" });
  } };
  let dictations = 0;
  const voice = { localPresets: [], cloudSources: [], sidecar: {
    health: async () => ({ engineStatus: { kokoro: { ready: true } } }), listVoices: async () => [],
    synthesize: async () => { throw Error("Unexpected speech generation"); },
    transcribe: async (audio: Uint8Array, contentType: string) => {
      dictations++; assert.deepEqual([...audio], [1, 2, 3]); assert.equal(contentType, "audio/webm"); return "PRIVATE_DICTATED_WORDS";
    },
  } };
  const options = { appRoot: root, provider, voice, adapter: null, storageHealth: null, systemResources: null, recoveryControl: null, recoveryHistory: null,
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
    const dictated = (await first.command({ action: "dictate", audioBase64: "AQID", contentType: "audio/webm" })).response;
    assert.deepEqual(dictated, { type: "dictation", text: "PRIVATE_DICTATED_WORDS" }); assert.equal(dictations, 1); assert.equal(sends, 0);
    const created = (await first.command({ action: "create" })).response; assert(created.type === "result" && created.threadId); const threadId = created.threadId;
    await first.command({ action: "watch" });
    const sent = (await first.command({ action: "send", threadId, text: "PRIVATE_STUDIO_QUESTION", model: "synthetic/model", attachments })).response;
    assert(sent.type === "result" && sent.status === "accepted");
    await until(() => first.frames.some(frame => frame.kind === "studio-assistant" && frame.response.type === "state" && frame.response.state.threads[0]?.messages.at(-1)?.text === "PRIVATE_STUDIO_REPLY"), "durable private response");
    nonlocal = true;
    await first.command({ action: "send", threadId, text: "PRIVATE_CLOUD_QUESTION", model: "synthetic/model" });
    await until(() => first.frames.some(frame => frame.kind === "studio-assistant" && frame.response.type === "state" && frame.response.state.share), "private one-use sharing review");
    const sharing = first.frames.findLast(frame => frame.kind === "studio-assistant" && frame.response.type === "state" && frame.response.state.share);
    assert(sharing?.kind === "studio-assistant" && sharing.response.type === "state" && sharing.response.state.share); const share = sharing.response.state.share;
    assert(share.prompt.includes("PRIVATE_CLOUD_QUESTION")); assert.equal(sends, 1);
    assert(share.prompt.includes(attachments[0]!.text));
    const approval = { action: "approve-cloud", threadId, runId: share.runId, shareId: share.id, digest: share.digest };
    const wrong = (await first.command({ ...approval, digest: "d".repeat(64) })).response; assert(wrong.type === "result" && wrong.status === "refused"); assert.equal(sends, 1);
    const approved = (await first.command(approval)).response; assert(approved.type === "result" && approved.status === "ok");
    await until(() => sends === 2, "one approved nonlocal dispatch");
    const repeated = (await first.command(approval)).response; assert(repeated.type === "result" && repeated.status === "refused"); assert.equal(sends, 2);
    await coordinator.openWorld(WORLD_ID);
    const state = (await first.command({ action: "watch" })).response; assert(state.type === "state");
    assert.equal(state.state.threads[0]?.id, threadId); assert.equal(state.state.threads[0]?.messages[0]?.text, "PRIVATE_STUDIO_QUESTION");
    assert.deepEqual(state.state.threads[0]?.messages[0]?.attachments, attachments);
    assert(!JSON.stringify(other.frames).includes("PRIVATE_STUDIO")); assert(!JSON.stringify(coordinator.getState()).includes("PRIVATE_STUDIO"));
    assert(!JSON.stringify(other.frames).includes("PRIVATE_DICTATED")); assert(!JSON.stringify(coordinator.getState()).includes("PRIVATE_DICTATED"));
    assert(!JSON.stringify(first.frames.filter(frame => frame.kind !== "studio-assistant")).includes("PRIVATE_DICTATED"));
    const history = await readFile(join(root, "studio-assistant", "conversations.json"), "utf8"); assert(history.includes("PRIVATE_STUDIO_REPLY"));
    assert(history.includes(attachments[0]!.text));
    assert(!(await readFile(join(root, "logs", "coordinator.jsonl"), "utf8")).includes(attachments[0]!.text));
    assert(!history.includes("PRIVATE_DICTATED"), "a transcript is unsent workspace, not canonical conversation history");
    first.socket.close(); other.socket.close(); await coordinator.stop();
    coordinator = createStudioCoordinator({ ...options, provider: new FsWorldProvider(root) });
    const resumed = await connect(await coordinator.start(0)), restored = (await resumed.command({ action: "watch" })).response;
    assert(restored.type === "state"); assert.equal(restored.state.threads[0]?.id, threadId); assert.deepEqual(restored.state.threads[0]?.messages[0]?.attachments, attachments); assert.equal(sends, 2, "Restart never replays a model call");
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

it("private dictation does not load history, persist audio/text, echo native errors or dispatch a model", async () => {
  let loads = 0, saves = 0, sends = 0, transcribes = 0;
  const service = new StudioAssistantService({ store: { load: async () => { loads++; throw Error("Disk unavailable"); }, save: async () => { saves++; } },
    model: { busy: () => false, run: async () => { sends++; return ""; }, stop: async () => {} }, evidence: topic => studioDiagnosticEvidence(topic, {}, Date.now()) });
  const replies: StudioAssistantResponse[] = [], control = new AbortController();
  const requester = { signal: control.signal, reply(_id: string, value: StudioAssistantResponse) { replies.push(value); return true; } };
  const host = new StudioAssistantHost(service, 10, async (audio, contentType) => {
    transcribes++; assert.deepEqual([...audio], [1, 2, 3]); assert.equal(contentType, "audio/webm");
    if (transcribes === 2) throw Error("PRIVATE_PROVIDER_ERROR_AND_AUDIO");
    return transcribes === 3 ? "x".repeat(8001) : "PRIVATE_DICTATION_TEXT";
  });
  const dictate = () => host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "dictate", audioBase64: "AQID", contentType: "audio/webm" } }, requester);
  try {
    await dictate(); assert.deepEqual(replies.at(-1), { type: "dictation", text: "PRIVATE_DICTATION_TEXT" });
    await dictate(); assert(!JSON.stringify(replies).includes("PRIVATE_PROVIDER_ERROR"));
    assert.deepEqual(replies.at(-1), { type: "result", status: "refused", reason: "unavailable", threadId: null, runId: null });
    await dictate(); assert.deepEqual(replies.at(-1), { type: "result", status: "refused", reason: "full", threadId: null, runId: null });
    await host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "dictate", audioBase64: "AR==", contentType: "audio/webm" } }, requester);
    assert.equal(transcribes, 3, "noncanonical base64 cannot reach the sidecar");
    assert.equal(loads, 0); assert.equal(saves, 0); assert.equal(sends, 0);
  } finally { control.abort(); await host.stop(); }
});

it("dictation remains single-flight through requester loss and cannot publish late or start after stop", async () => {
  let finish!: (text: string) => void, calls = 0, observed: AbortSignal | undefined;
  const transcription = new Promise<string>(resolve => { finish = resolve; });
  const service = new StudioAssistantService({ store: { load: async () => ({ version: 1, threads: [] }), save: async () => {} },
    model: { busy: () => false, run: async () => "", stop: async () => {} }, evidence: topic => studioDiagnosticEvidence(topic, {}, Date.now()) });
  const host = new StudioAssistantHost(service, 10, async (_audio, _type, signal) => { calls++; observed = signal; return transcription; });
  const first = new AbortController(), second = new AbortController(), firstReplies: StudioAssistantResponse[] = [], secondReplies: StudioAssistantResponse[] = [];
  const requester = (control: AbortController, replies: StudioAssistantResponse[]) => ({ signal: control.signal, reply(_id: string, response: StudioAssistantResponse) { replies.push(response); return true; } });
  const dictate = (control: AbortController, replies: StudioAssistantResponse[]) => host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "dictate", audioBase64: "AQID", contentType: "audio/webm" } }, requester(control, replies));
  try {
    const work = dictate(first, firstReplies); await until(() => calls === 1, "admitted dictation");
    first.abort(); await work; assert(observed?.aborted);
    await dictate(second, secondReplies); assert.equal(calls, 1); assert.deepEqual(secondReplies.at(-1), { type: "result", status: "refused", reason: "busy", threadId: null, runId: null });
    await host.stop(); finish("PRIVATE_LATE_TRANSCRIPT"); await new Promise(resolve => setImmediate(resolve));
    assert.equal(firstReplies.length, 0); assert(!JSON.stringify(secondReplies).includes("PRIVATE_LATE"));
    await dictate(second, secondReplies); assert.equal(calls, 1);
  } finally { finish(""); first.abort(); second.abort(); await host.stop(); }
});

it("dictation times out after 45 seconds without retrying or publishing a late result", async context => {
  let finish!: (text: string) => void, calls = 0, observed: AbortSignal | undefined;
  const held = new Promise<string>(resolve => { finish = resolve; });
  const service = new StudioAssistantService({ store: { load: async () => ({ version: 1, threads: [] }), save: async () => {} },
    model: { busy: () => false, run: async () => "", stop: async () => {} }, evidence: topic => studioDiagnosticEvidence(topic, {}, Date.now()) });
  const host = new StudioAssistantHost(service, 10, async (_audio, _type, signal) => { calls++; observed = signal; return held; });
  const replies: StudioAssistantResponse[] = [], control = new AbortController();
  const requester = { signal: control.signal, reply(_id: string, response: StudioAssistantResponse) { replies.push(response); return true; } };
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const work = host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "dictate", audioBase64: "AQID", contentType: "audio/webm" } }, requester);
    assert.equal(calls, 1); context.mock.timers.tick(44_999); assert.equal(replies.length, 0);
    context.mock.timers.tick(1); await work; assert(observed?.aborted);
    assert.deepEqual(replies, [{ type: "result", status: "unconfirmed", reason: "timeout", threadId: null, runId: null }]);
    await host.handle({ kind: "studio-assistant", requestId: randomUUID(), command: { action: "dictate", audioBase64: "AQID", contentType: "audio/webm" } }, requester);
    assert.equal(calls, 1); const last = replies.at(-1); assert(last?.type === "result" && last.reason === "busy");
    finish("PRIVATE_LATE_TRANSCRIPT"); await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.length, 2); assert(!JSON.stringify(replies).includes("PRIVATE_LATE"));
  } finally { finish(""); control.abort(); await host.stop(); context.mock.timers.reset(); }
});

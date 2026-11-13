import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import WebSocket from "ws";
import { FrameSchema, type Frame, type StudioAssistantCommand } from "@arke-studio/contracts";
import { VoxaClient, KOKORO_PRESETS, localCandidates, encodePcm16Wav } from "@arke-studio/voice";
import { createStudioCoordinator } from "../../src/application/studio-host.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { tempDir } from "../tmp.js";
import { until, untilAsync } from "../wait.js";

it("the worldless production host reads Studio replies through bounded private local audio without broadcasts, cache files or model replay", { timeout: 45_000 }, async () => {
  const root = await tempDir("studio-private-speech-"), wav = encodePcm16Wav(new Float32Array(24), 24000);
  const tts: Array<{ text: string; voice: string }> = []; let modelCalls = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") { response.end(JSON.stringify({ ok: true, version: "test", protocolVersion: 1, architecture: "x64", engines: ["kokoro", "whisper"], engineStatus: { kokoro: { ready: true }, whisper: { ready: true } } })); return; }
    if (request.url === "/voices") { response.end(JSON.stringify(KOKORO_PRESETS)); return; }
    if (request.url !== "/tts") { response.writeHead(404).end(); return; }
    let body = ""; request.on("data", chunk => { body += String(chunk); if (body.length > 4096) request.destroy(); });
    request.on("end", () => { tts.push(JSON.parse(body)); response.setHeader("content-type", "audio/wav"); response.end(wav); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert(address && typeof address !== "string");
  const voice = new VoxaClient(fetch, `http://127.0.0.1:${address.port}`), provider = new FsWorldProvider(root);
  const coordinator = createStudioCoordinator({ provider, adapter: null, appRoot: root, appVersion: "test", storageHealth: null, systemResources: null,
    changeLogPath: join(root, "changes.jsonl"), voice: { sidecar: voice, localPresets: localCandidates(KOKORO_PRESETS), cloudSources: [] },
    studioAssistant: { model: { busy: () => false, stop: async () => {}, run: async (input, signal, authorize) => {
      await authorize({ ...input, provider: "synthetic", local: true, destination: "a".repeat(64) }, signal); modelCalls++;
      return JSON.stringify({ kind: "reply", text: "PRIVATE_STUDIO_SPEECH_REPLY. ".repeat(40) });
    } } } });
  const sockets: WebSocket[] = [];
  try {
    const session = await coordinator.start();
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${session.port}`), frames: Frame[] = []; sockets.push(socket);
      socket.on("message", data => frames.push(FrameSchema.parse(JSON.parse(String(data))))); await once(socket, "open");
      socket.send(JSON.stringify({ kind: "hello", token: session.token })); await until(() => frames.some(frame => frame.kind === "snapshot"), "private read owner authenticated");
      const command = async (command: StudioAssistantCommand["command"]) => {
        const requestId = randomUUID(); socket.send(JSON.stringify({ kind: "studio-assistant", requestId, command }));
        await until(() => frames.some(frame => frame.kind === "studio-assistant" && frame.requestId === requestId), "private read response");
        const frame = frames.find(frame => frame.kind === "studio-assistant" && frame.requestId === requestId)!; assert(frame.kind === "studio-assistant"); return frame.response;
      };
      return { command, frames };
    };
    const first = await connect(), other = await connect();
    const created = await first.command({ action: "create" }); assert(created.type === "result" && created.threadId); const threadId = created.threadId;
    await first.command({ action: "send", threadId, model: "synthetic/model", text: "PRIVATE_USER_QUESTION" });
    const historyPath = join(root, "studio-assistant", "conversations.json");
    let messageId = "";
    await untilAsync(async () => { const state = await first.command({ action: "watch" }); if (state.type !== "state") return false;
      const last = state.state.threads[0]?.messages.findLast(row => row.role === "arke"); messageId = last?.id ?? ""; return !!messageId; }, "saved reply");
    const before = await readFile(historyPath, "utf8"), audio = await first.command({ action: "read-reply", threadId, messageId, part: 0 });
    assert(audio.type === "speech"); assert.deepEqual(Buffer.from(audio.audioBase64, "base64"), Buffer.from(wav)); assert(audio.parts > 1);
    const next = await first.command({ action: "read-reply", threadId, messageId, part: 1, source: audio.source, voiceId: audio.voiceId }); assert(next.type === "speech");
    assert.equal(tts.length, 2); assert(tts.every(row => row.voice === "bm_george" && row.text.length <= 450 && row.text.includes("PRIVATE_STUDIO_SPEECH_REPLY")));
    assert.equal(modelCalls, 1); assert.equal(coordinator.getState().world, null); assert.equal(coordinator.getState().app.jobs.length, 0);
    assert.equal(await readFile(historyPath, "utf8"), before); assert(!(await readdir(root, { recursive: true })).some(path => /\.(wav|mp3)$/i.test(path)));
    assert(!JSON.stringify(other.frames).includes("PRIVATE_STUDIO_SPEECH_REPLY")); assert(!JSON.stringify(other.frames).includes(audio.audioBase64));
    assert(!JSON.stringify(coordinator.getState()).includes("PRIVATE_STUDIO_SPEECH_REPLY")); assert(!JSON.stringify(coordinator.getState()).includes(audio.audioBase64));
    assert(!first.frames.some(frame => frame.kind === "event" && frame.event.type === "voice.audio"));
  } finally { for (const socket of sockets) socket.close(); await coordinator.stop(); await provider.close(); voice.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

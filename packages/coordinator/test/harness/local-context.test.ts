import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { it } from "node:test";
import WebSocket from "ws";
import { agentForPurpose, FrameSchema, newId, type ClientMessage, type Frame, type WorldChatRun } from "@arke-studio/contracts";
import { ArkeAdapter } from "@arke-studio/adapter-arke";
import { FakeOllama, reply } from "../../../adapter-arke/test/fake-ollama.js";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until } from "../wait.js";

it("Local fits chapter conversation history and sends an oversized ask's ending to the connected client (#1265)", async (t) => {
  const ollama = new FakeOllama();
  ollama.models[0]!.context = 65536;
  await ollama.start();
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  await provider.loadWorld(WORLD_ID);
  const adapter = new ArkeAdapter({ baseUrl: ollama.url });
  const coordinator = new Coordinator({ provider, adapter, appRoot: root, appVersion: "test",
    changeLogPath: join(root, "logs", "changes.jsonl"), authoring: { agentForPurpose }, harnessEngineOverride: "arke" });
  const { port, token } = await coordinator.start(0);
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: Frame[] = [];
  client.on("message", data => frames.push(FrameSchema.parse(JSON.parse(String(data)))));
  t.after(async () => { client.terminate(); await coordinator.stop(); await provider.close(); await ollama.stop(); });
  await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
  client.send(JSON.stringify({ kind: "hello", token, lastSeq: 0 }));
  await until(() => frames.some(frame => frame.kind === "snapshot"), "authenticated snapshot");
  await until(() => coordinator.getState().app.harnessModels.length > 0, "Local catalogue");
  const host = coordinator as unknown as {
    handleClientMessage(message: ClientMessage): Promise<void>;
    refreshWorldSnapshot(worldId: string): Promise<void>;
  };
  await host.handleClientMessage({ kind: "world-chat-create", worldId: WORLD_ID, requestId: randomUUID(),
    title: "Chapter context", entryContext: { kind: "production", productionId: "the-ledger-of-nights" } });
  const conversationId = coordinator.getState().worldChat!.conversationId;
  const send = (text: string) => host.handleClientMessage({ kind: "world-chat-send", worldId: WORLD_ID,
    requestId: randomUUID(), conversationId, text, attachmentIds: [], modelId: "ollama/gemma4:12b",
    subject: { kind: "passage", chapterId: "neap", paragraph: 1, text: "Six, and the tide" } });
  // Reopen a ten-message thread. Each message is within the wire/result bounds, but together
  // they cost more tokens than the character estimate leaves after the real tool schemas.
  const log = new WorldChatStore(conversationDir(worldDir, conversationId));
  const at = new Date().toISOString();
  for (let i = 0; i < 5; i++) {
    const turnId = newId("turn");
    const run: WorldChatRun = { id: newId("run"), turnId, basedOnConversationSeq: i * 2 + 1,
      status: "running", adapter: "arke", harnessCleanup: "not-required", contextDigest: "sha256:" + "a".repeat(64), startedAt: at };
    await log.append({ type: "turn.started", run, message: { id: newId("msg"), turnId, role: "user", createdAt: at, attachmentIds: [],
      text: `Earlier ask ${i}: ` + "harbour; tide; ".repeat(1000) } }, { at });
    await log.append({ type: "turn.completed", run: { ...run, status: "completed", endedAt: at },
      message: { id: newId("msg"), turnId, role: "studio", createdAt: at, attachmentIds: [], text: `Reply ${i}: ` + "harbour; tide; ".repeat(500) },
      receipts: [], candidates: [], groups: [], tombstones: [] }, { at });
  }
  const authoringCalls = () => ollama.chats.filter(chat => ((chat.tools ?? []) as unknown[]).length > 0);
  const before = authoringCalls().length;
  ollama.script.push(reply(JSON.stringify({ reply: "Tightened the passage.", candidateOperations: [], groupOperations: [] })));
  await send("Tighten this passage.");
  assert.equal(authoringCalls().length, before + 1, "the model is reached without a corrective turn");
  assert.equal(coordinator.getState().worldChat!.lastFailure, undefined);
  const request = authoringCalls().at(-1)!;
  const messages = request.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]!.role, "system");
  assert.match(messages.at(-1)!.content, /Tighten this passage/);
  assert.ok(!messages.some(message => message.content.includes("Earlier ask 0:")), "old exchanges were trimmed");
  assert.equal((request.options as { num_ctx: number }).num_ctx, 65536);
  assert.ok((request.tools as unknown[]).length >= 17, "real world query tools were included");

  // A world refresh failing after the turn must not hide the durable ending from the asker.
  t.mock.method(host, "refreshWorldSnapshot", async () => { throw new Error("refresh failed after turn"); });
  const calls = authoringCalls().length;
  await assert.rejects(send("Tighten " + "界".repeat(15900)), /refresh failed after turn/);
  assert.equal(authoringCalls().length, calls, "an oversized current ask is refused before inference");
  await until(() => frames.some(frame => frame.kind === "snapshot" && frame.state.worldChat?.lastFailure?.status === "budget-exceeded"), "client receives budget ending");
  const chat = coordinator.getState().worldChat!;
  assert.equal(chat.lastFailure?.status, "budget-exceeded");
  assert.match(chat.messages.at(-1)!.text, /^Tighten /, "the user's failed ask survives");
});

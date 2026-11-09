import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import {
  agentForPurpose, newId, type ConversationId, type CreateSessionInput,
  type HarnessAdapter, type HarnessEvent, type ModelInfo, type SessionConfigInput,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * A conversation is named once its first turn has ended (issue 2801), and a first turn can end
 * because the app is quitting. The namer must not start then (codex on PR 2861): a fresh model
 * call held shutdown open for its whole naming timeout, and one for a closed world ran to its end.
 */

const AT = "2026-11-09T10:00:00.000Z";
const MODELS: ModelInfo[] = [{ provider: "anthropic", id: "sonnet", displayName: "Sonnet", inputTokenLimit: 200_000 }];

/** Takes the turn and never answers it; records every session asked for. */
class SilentAdapter implements HarnessAdapter {
  readonly id = "deferred-naming-test";
  readonly agents: string[] = [];
  capabilities() { return new Set(["models", "events"] as const); }
  readiness() { return { ready: true }; }
  lifecycleRevision() { return 0; }
  async init() {}
  async dispose() {}
  async listModels() { return MODELS; }
  prepareSession(_input: SessionConfigInput) {}
  abandonSessionPreparation() {}
  async createSession(input: CreateSessionInput): Promise<{ sessionId: string }> {
    this.agents.push(input.agent ?? "");
    return { sessionId: `s${this.agents.length}` };
  }
  async sendMessage() { return { ok: true } as never; }
  async dispatchAsync() { return this.sendMessage(); }
  async interrupt() {}
  streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    const ended = new Promise<IteratorResult<HarnessEvent>>((resolve) =>
      signal?.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true }));
    return { [Symbol.asyncIterator]: () => ({ next: () => ended }) };
  }
}

/** A coordinator mid-way through a first turn that will never be answered. */
async function firstTurnRunning() {
  const { root, worldDir } = await makeTempRoot();
  const conversationId = newId("cv") as ConversationId;
  const log = new WorldChatStore(conversationDir(worldDir, conversationId));
  await log.create(conversationId, AT);
  await log.append({ type: "conversation.created", title: "New conversation", entryContext: { kind: "world" } }, { at: AT });
  await log.drain();

  const adapter = new SilentAdapter();
  const provider = new FsWorldProvider(root);
  const coordinator = new Coordinator({ provider, adapter, appRoot: root, appVersion: "test",
    authoring: { agentForPurpose }, changeLogPath: join(root, "changes.jsonl") });
  await coordinator.start(0);
  await coordinator.openWorld(WORLD_ID);
  const sending = coordinator.dispatch({ kind: "world-chat-send", worldId: WORLD_ID, requestId: "req-naming", conversationId,
    text: "Who keeps the light?", attachmentIds: [] });
  while (!adapter.agents.includes("world-builder")) await new Promise((resolve) => setTimeout(resolve, 10));
  return { adapter, provider, coordinator, sending, namers: () => adapter.agents.filter((agent) => agent === "conversation-namer") };
}

it("a first turn ended by shutdown starts no naming pass (issue 2801)", { timeout: 30_000 }, async () => {
  const h = await firstTurnRunning();
  await h.coordinator.stop();
  await h.sending.catch(() => {});
  assert.deepEqual(h.namers(), []);
});

it("a first turn ended by its world closing starts no naming pass (issue 2801)", { timeout: 30_000 }, async () => {
  const h = await firstTurnRunning();
  try {
    const other = await h.provider.createWorld({ name: "Another world" });
    await h.coordinator.openWorld(other.worldId);
    await h.sending.catch(() => {});
    assert.deepEqual(h.namers(), []);
  } finally { await h.coordinator.stop(); }
});

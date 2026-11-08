import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import {
  agentForPurpose, newId, type ClientMessage, type ConversationId, type CreateSessionInput,
  type HarnessAdapter, type HarnessEvent, type ModelInfo, type SessionConfigInput,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Chat never edits an authored file, so it should not pay for a full world rescan (issue 2780).
 * The dispatch guard, every conversation load and the input queue went through `ownedWrite`,
 * which rescans the whole world after its callback: four or five scans a message, two an open,
 * each several seconds on a large world.
 */

const AT = "2026-11-08T10:00:00.000Z";
const MODELS: ModelInfo[] = [{ provider: "anthropic", id: "sonnet", displayName: "Sonnet", inputTokenLimit: 200_000 }];

/** Answers the turn with a plain reply; the naming pass a first line starts is declined. */
class ReplyingAdapter implements HarnessAdapter {
  readonly id = "chat-rescans-test";
  capabilities() { return new Set(["models", "events"] as const); }
  readiness() { return { ready: true }; }
  lifecycleRevision() { return 0; }
  async init() {}
  async dispose() {}
  async listModels() { return MODELS; }
  prepareSession(_input: SessionConfigInput) {}
  abandonSessionPreparation() {}
  async createSession(input: CreateSessionInput): Promise<{ sessionId: string }> {
    if (input.agent !== "world-builder") throw new Error("Test declines every session but the turn's.");
    return { sessionId: "s1" };
  }
  private replies: Array<() => void> = [];
  // The coordinator's local-GPU wrapper turns the runner's dispatch into this call.
  async sendMessage() { setTimeout(() => this.replies.splice(0).forEach((reply) => reply()), 10); return { ok: true } as never; }
  async dispatchAsync() { return this.sendMessage(); }
  async *streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    while (!signal?.aborted) {
      await new Promise<void>((resolve) => { this.replies.push(resolve); signal?.addEventListener("abort", () => resolve(), { once: true }); });
      if (signal?.aborted) return;
      yield { type: "message.completed", sessionId: "s1", text: JSON.stringify({ reply: "Maren keeps the light.", candidateOperations: [], groupOperations: [] }) } as HarnessEvent;
    }
  }
}

it("opens a conversation without a full world rescan, and spends at most one on a message", async () => {
  const { root, worldDir } = await makeTempRoot();
  const conversationId = newId("cv") as ConversationId;
  const log = new WorldChatStore(conversationDir(worldDir, conversationId));
  await log.create(conversationId, AT);
  await log.append({ type: "conversation.created", title: "Lighthouse talk", entryContext: { kind: "world" } }, { at: AT });
  await log.drain();

  const provider = new FsWorldProvider(root);
  const coordinator = new Coordinator({ provider, adapter: new ReplyingAdapter(), appRoot: root, appVersion: "test",
    authoring: { agentForPurpose }, changeLogPath: join(root, "changes.jsonl") });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  await coordinator.start(0);
  try {
    await coordinator.openWorld(WORLD_ID);
    const store = provider.openStore()!;
    const scans = { n: 0 };
    const live = store as unknown as { rescan: (paths?: string[]) => Promise<void> };
    const rescan = live.rescan.bind(store);
    live.rescan = (paths) => { scans.n++; return rescan(paths); };

    await send({ kind: "world-chat-open", worldId: WORLD_ID, conversationId });
    assert.equal(coordinator.getState().worldChat?.conversationId, conversationId, "the conversation opened");
    const onOpen = scans.n;

    scans.n = 0;
    await send({ kind: "world-chat-send", worldId: WORLD_ID, requestId: "req-rescans", conversationId, text: "Who keeps the light?", attachmentIds: [] });
    // A completed turn carries its run on turn.completed; a failed one on run.finished.
    const finishedRuns = async () => (await log.read()).events.flatMap(({ event }) =>
      event.type === "run.finished" || event.type === "turn.completed" ? [event.run.status] : []);
    for (let waited = 0; (await finishedRuns()).length === 0 && waited < 10_000; waited += 50) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await finishedRuns(), ["completed"], "the turn answered");
    const onMessage = scans.n;
    assert.deepEqual({ onOpen, onMessage: Math.min(onMessage, 1) }, { onOpen: 0, onMessage }, `open cost ${onOpen} full rescans, one message ${onMessage}`);
  } finally {
    await coordinator.stop();
  }
});

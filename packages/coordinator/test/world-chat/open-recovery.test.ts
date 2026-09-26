import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import {
  agentForPurpose, newId, type ClientMessage, type ConversationId, type CreateSessionInput, type DomainEvent,
  type HarnessAdapter, type ModelInfo, type SessionConfigInput,
} from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";
import { until } from "../wait.js";

/**
 * A World Chat turn sent while its world is still opening is a live turn, not a crashed one.
 *
 * Seen on the installed build (2026-09-26): the app launched straight into a chapter, the line
 * was admitted while the world was still opening, and the open's own recovery — which reads
 * every run still marked running as one the last process died in — closed it as "the app closed
 * mid-turn" seven seconds later, while it was checking the world.
 */

const AT = "2026-09-26T03:19:16.000Z";
const MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "sonnet", displayName: "Sonnet", inputTokenLimit: 200_000 },
];

/** A harness that holds the session open until the test lets go, then declines it. */
class HeldAdapter implements HarnessAdapter {
  readonly id = "open-recovery-test";
  created = false;
  private reached!: () => void;
  readonly reachedSession = new Promise<void>((resolve) => { this.reached = resolve; });
  private letGo!: () => void;
  private readonly held = new Promise<void>((resolve) => { this.letGo = resolve; });
  private readonly preparations = new Set<string>();
  capabilities() { return new Set(["models", "events"] as const); }
  readiness() { return { ready: true }; }
  lifecycleRevision() { return 0; }
  async init() {}
  async dispose() {}
  async listModels() { return MODELS; }
  prepareSession(input: SessionConfigInput) { this.preparations.add(input.preparationId!); }
  abandonSessionPreparation(id: string) { this.preparations.delete(id); }
  async createSession(_input: CreateSessionInput): Promise<{ sessionId: string }> {
    this.created = true;
    this.reached();
    await this.held;
    throw new Error("Test released the turn; no generation was started.");
  }
  release() { this.letGo(); }
  async sendMessage(): Promise<never> { throw new Error("unexpected generation"); }
  async dispatchAsync(): Promise<never> { throw new Error("unexpected generation"); }
  async *streamEvents() {}
}

it("a line sent while the world is still opening is not closed by that open's recovery", async () => {
  const { root, worldDir } = await makeTempRoot();
  // A conversation already on disk, as it is when the app launches into a world.
  const conversationId = newId("cv") as ConversationId;
  const log = new WorldChatStore(conversationDir(worldDir, conversationId));
  await log.create(conversationId, AT);
  await log.append({ type: "conversation.created", title: "Chapter talk", entryContext: { kind: "world" } }, { at: AT });
  await log.drain();

  // Nothing is open yet, so this open is the first of the process and runs recovery. It pauses
  // just after the provider has installed the store, which is where the send got in.
  const provider = new FsWorldProvider(root);
  const load = provider.loadWorld.bind(provider);
  let loaded!: () => void;
  const storeInstalled = new Promise<void>((resolve) => { loaded = resolve; });
  let finishOpen!: () => void;
  const openMayFinish = new Promise<void>((resolve) => { finishOpen = resolve; });
  let first = true;
  provider.loadWorld = async (worldId: string) => {
    const bundle = await load(worldId);
    if (first) {
      first = false;
      loaded();
      await openMayFinish;
    }
    return bundle;
  };

  const adapter = new HeldAdapter();
  const events: DomainEvent[] = [];
  const coordinator = new Coordinator({
    provider, adapter, appRoot: root, appVersion: "test", authoring: { agentForPurpose },
    changeLogPath: join(root, "changes.jsonl"), observeEvent: (event) => events.push(event),
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  await coordinator.start(0);
  const runs = async () => {
    const { events: logged } = await log.read();
    return {
      started: logged.flatMap(({ event }) => event.type === "turn.started" ? [event.run] : []),
      finished: logged.flatMap(({ event }) => event.type === "run.finished" ? [event.run] : []),
    };
  };

  try {
    const opening = coordinator.openWorld(WORLD_ID);
    await storeInstalled;
    assert.equal(provider.openStore()?.worldId, WORLD_ID, "the store is installed before the open has finished");

    const sending = send({
      kind: "world-chat-send", worldId: WORLD_ID, requestId: "req-while-opening", conversationId,
      text: "What does chapter two need?", attachmentIds: [],
    });
    // Observed here so a failed assertion below reports itself, not the world closing under it.
    sending.catch(() => {});
    // Give the turn every chance to get going before the open finishes. Nothing below depends
    // on how long this is: it only decides whether an unfixed build would have got that far.
    await Promise.race([adapter.reachedSession, new Promise((resolve) => setTimeout(resolve, 250))]);
    const startedWhileOpening = adapter.created;
    finishOpen();
    await opening;
    assert.ok(events.some((event) => event.type === "world.opened" && event.worldId === WORLD_ID));

    await until(() => adapter.created, "the turn reaching the harness");
    const during = await runs();
    assert.deepEqual(during.finished.map((run) => run.status), [], "the open's recovery did not end the live turn");
    assert.equal(during.started.length, 1, "the line became a turn, still running once the world has opened");
    assert.equal(startedWhileOpening, false, "the line waited for the world to finish opening");
    const answer = events.find((event) => event.type === "world-chat.send-result" && event.requestId === "req-while-opening");
    assert.equal((answer as { admitted?: boolean } | undefined)?.admitted, true, "the line was taken");

    adapter.release();
    await sending;
    const after = await runs();
    assert.equal(after.finished.length, 1, "the turn ended once");
    assert.equal(after.finished[0]!.id, after.started[0]!.id);
    assert.notEqual(after.finished[0]!.status, "interrupted");
    assert.notEqual(after.finished[0]!.safeDetail, "the app closed mid-turn");
  } finally {
    finishOpen();
    adapter.release();
    await coordinator.stop();
    await provider.close();
  }
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { newId, type ClientMessage, type ConversationId, type DomainEvent, type WorldChatContext, type WorldChatStoredEvent } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { WorldChatStore, conversationDir } from "../../src/world-chat/store.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

/**
 * Every chat reads Arke's replies (design turn 183): the read names a conversation and a
 * message, and the coordinator reads the words from that conversation's own log — World Chat,
 * a production's thread, production setup alike. Nothing the client sends is spoken, so an id
 * that is not one of Arke's replies in that conversation is refused before any synthesis.
 */

const CLOCK = "2026-10-02T12:00:00.000Z";

function wav(): Uint8Array {
  const out = Buffer.alloc(44 + 16);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(24_000, 24);
  out.writeUInt32LE(48_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(16, 40);
  return new Uint8Array(out);
}

async function harness() {
  const { root, worldDir } = await makeTempRoot();
  const provider = new FsWorldProvider(root, { clock: () => CLOCK });
  await provider.loadWorld(WORLD_ID);
  const events: DomainEvent[] = [];
  const spoken: string[] = [];
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    observeEvent: (event) => events.push(event),
    voice: {
      sidecar: {
        health: async () => ({ engineStatus: { kokoro: { ready: true } } }),
        listVoices: async () => [{ id: "bm_george", label: "George", attributes: [] }],
        synthesize: async (input: { voiceId: string; text: string }) => {
          spoken.push(input.text);
          return wav();
        },
        transcribe: async () => ({ text: "" }),
      } as never,
      localPresets: [],
      cloudSources: [],
    },
  });
  const send = (message: ClientMessage) =>
    (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
  return { provider, worldDir, events, spoken, send };
}

/** A conversation with these exchanges, written as the runner writes them; the ids it used. */
async function conversation(worldDir: string, entryContext: WorldChatContext, exchanges: readonly [string, string][]) {
  const id = newId("cv") as ConversationId;
  const log = new WorldChatStore(conversationDir(worldDir, id));
  await log.create(id, CLOCK);
  await log.append({ type: "conversation.created", title: "Thread", entryContext }, { at: CLOCK });
  const ids: { user: string; studio: string }[] = [];
  for (const [said, replied] of exchanges) {
    const turnId = newId("turn");
    const run = {
      id: newId("run"), turnId, basedOnConversationSeq: 0, status: "running" as const, adapter: "opencode",
      harnessCleanup: "not-required" as const, contextDigest: `sha256:${"a".repeat(64)}`, startedAt: CLOCK,
    };
    const user = newId("msg");
    const studio = newId("msg");
    await log.append({ type: "turn.started", message: { id: user, turnId, role: "user", text: said, attachmentIds: [], createdAt: CLOCK }, run } as WorldChatStoredEvent, { at: CLOCK });
    await log.append({
      type: "turn.completed",
      message: { id: studio, turnId, role: "studio", text: replied, attachmentIds: [], createdAt: CLOCK },
      run: { ...run, status: "completed", endedAt: CLOCK },
      receipts: [], candidates: [], groups: [], tombstones: [],
    } as WorldChatStoredEvent, { at: CLOCK });
    ids.push({ user, studio });
  }
  return { id, ids };
}

function reads(events: DomainEvent[]) {
  return events.filter((event) => event.type === "voice.audio") as Extract<DomainEvent, { type: "voice.audio" }>[];
}

const read = (conversationId: string, messageId: string, requestId: string): ClientMessage => ({
  kind: "read-prose", worldId: WORLD_ID, requestId, source: { of: "reply", conversationId: conversationId as ConversationId, messageId: messageId as never },
});

describe("reading Arke's reply from its conversation's log", () => {
  it("reads a production thread's reply by id, even one paged out of the window a screen opens on", async () => {
    const h = await harness();
    try {
      // Sixty exchanges: the first reply is well outside the fifty-message window.
      const exchanges = Array.from({ length: 60 }, (_, i) => [`Question ${i}`, `Answer number ${i} about the tide.`] as [string, string]);
      const thread = await conversation(h.worldDir, { kind: "production", productionId: "saltlight" }, exchanges);
      await h.send(read(thread.id, thread.ids[0]!.studio, "01J8F3K2QW9VZX4N7M0RTYB7A1"));
      const result = reads(h.events).at(-1)!;
      assert.equal(result.status, "ready", result.error ?? "");
      assert.equal(result.sectionHeading, "Arke");
      assert.deepEqual(h.spoken, ["Answer number 0 about the tide."]);
    } finally {
      await h.provider.close();
    }
  });

  it("reads a production setup's reply from the setup's own log", async () => {
    const h = await harness();
    try {
      const setupId = newId("cv") as ConversationId;
      const log = new WorldChatStore(conversationDir(h.worldDir, setupId));
      await log.create(setupId, CLOCK);
      await log.append({ type: "conversation.created", title: "New production", entryContext: { kind: "production-setup", setupId } }, { at: CLOCK });
      const turnId = newId("turn");
      const run = { id: newId("run"), turnId, basedOnConversationSeq: 0, status: "running" as const, adapter: "opencode",
        harnessCleanup: "not-required" as const, contextDigest: `sha256:${"a".repeat(64)}`, startedAt: CLOCK };
      const reply = newId("msg");
      await log.append({ type: "turn.started", message: { id: newId("msg"), turnId, role: "user", text: "A heist.", attachmentIds: [], createdAt: CLOCK }, run } as WorldChatStoredEvent, { at: CLOCK });
      await log.append({ type: "turn.completed", message: { id: reply, turnId, role: "studio", text: "A heist on the lighthouse, then.", attachmentIds: [], createdAt: CLOCK },
        run: { ...run, status: "completed", endedAt: CLOCK }, receipts: [], candidates: [], groups: [], tombstones: [] } as WorldChatStoredEvent, { at: CLOCK });
      await h.send(read(setupId, reply, "01J8F3K2QW9VZX4N7M0RTYB7A2"));
      assert.equal(reads(h.events).at(-1)!.status, "ready");
      assert.deepEqual(h.spoken, ["A heist on the lighthouse, then."]);
    } finally {
      await h.provider.close();
    }
  });

  it("refuses the author's own line, a forged id, another conversation's reply and an unknown conversation", async () => {
    const h = await harness();
    try {
      const world = await conversation(h.worldDir, { kind: "world" }, [["Who keeps the light?", "Maren does, most nights."]]);
      const other = await conversation(h.worldDir, { kind: "production", productionId: "saltlight" }, [["And the bell?", "Nobody, since the storm."]]);
      const cases: [string, string, RegExp][] = [
        [world.id, world.ids[0]!.user, /Only Arke's replies/],
        [world.id, newId("msg"), /no longer in this conversation/],
        [world.id, other.ids[0]!.studio, /no longer in this conversation/],
        [newId("cv"), world.ids[0]!.studio, /not in this world/],
      ];
      for (const [index, [conversationId, messageId, refusal]] of cases.entries()) {
        h.events.length = 0;
        await h.send(read(conversationId, messageId, `01J8F3K2QW9VZX4N7M0RTYB7B${index}`));
        const result = reads(h.events).at(-1)!;
        assert.equal(result.status, "failed");
        assert.match(result.error!, refusal);
      }
      assert.deepEqual(h.spoken, [], "nothing was spoken for any of them");
    } finally {
      await h.provider.close();
    }
  });
});

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, ulid, type ClientMessage, type DomainEvent } from "@arke-studio/contracts";
import {
  ConversationActionLifecycle,
  type ConversationActionAuthorityAdapter,
} from "../../src/arke-actions/lifecycle.js";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempRoot, WORLD_ID } from "../world/helpers.js";

const AT = "2026-09-04T12:00:00.000Z";

describe("conversation action coordinator handler", () => {
  it("assigns the local actor and emits the correlated durable decision result", async () => {
    const made = await makeTempRoot();
    const provider = new FsWorldProvider(made.root, { clock: () => AT });
    closeOnCleanup(() => provider.close());
    await provider.loadWorld(WORLD_ID);
    const conversationId = newId("cv");
    const log = new WorldChatStore(conversationDir(made.worldDir, conversationId));
    await log.create(conversationId, AT);
    await log.append(
      { type: "conversation.created", title: "Coordinator action", entryContext: { kind: "world" } },
      { at: AT },
    );
    let executions = 0;
    const authority: ConversationActionAuthorityAdapter = {
      actionKind: "rename-world",
      prepare: async ({ intent }) => ({
        authority: { kind: "world-store", id: `world:${intent.worldId}` },
        authorityRevision: 1,
        shown: {
          title: "Rename the world",
          consequence: "Changes the world label.",
          affectedTargets: [{ kind: "world", id: WORLD_ID }],
          ripples: [],
          permissionReason: "authored-change",
          body: {
            family: "authored-diff",
            fields: [{ label: "Name", before: "Old", after: "New" }],
            conflicts: [],
            openChoices: [],
          },
        },
      }),
      validate: async () => ({ ok: true }),
      execute: async () => {
        executions++;
        return {
          status: "completed",
          receipt: { kind: "world-version", id: WORLD_ID, summary: "World renamed at version 2." },
        };
      },
    };
    const lifecycle = new ConversationActionLifecycle({
      worldPath: made.worldDir,
      worldId: WORLD_ID,
      adapters: [authority],
      now: () => AT,
    });
    const action = await lifecycle.prepare({
      conversationId,
      turnId: newId("turn"),
      worldId: WORLD_ID,
      actionKind: "rename-world",
      targets: [{ kind: "world", id: WORLD_ID }],
      payload: { kind: "rename-world", worldId: WORLD_ID, name: "New" },
      baseObservations: [
        { requirement: "world-metadata", target: WORLD_ID, revisionOrDigest: "v1", complete: true },
      ],
      createdAt: AT,
    });
    const events: DomainEvent[] = [];
    const coordinator = new Coordinator({
      provider,
      adapter: null,
      conversationActionAdapters: [authority],
      changeLogPath: join(made.root, "logs", "changes.jsonl"),
      appVersion: "test",
      observeEvent: (event) => events.push(event),
    });
    const send = (message: ClientMessage) =>
      (coordinator as unknown as { handleClientMessage(message: ClientMessage): Promise<void> }).handleClientMessage(message);
    await send({
      kind: "conversation-action-decide",
      worldId: WORLD_ID,
      conversationId,
      actionId: action.actionId,
      expectedConversationSeq: 3,
      expectedStatus: "pending",
      decision: "approve",
      requestId: ulid(),
    });

    const result = events.find((event) => event.type === "conversation-action.decision-result");
    assert.equal(result?.type === "conversation-action.decision-result" && result.status, "completed");
    assert.equal(result?.type === "conversation-action.decision-result" && result.decision, "approve");
    assert.equal(executions, 1);
    await provider.close();
  });
});

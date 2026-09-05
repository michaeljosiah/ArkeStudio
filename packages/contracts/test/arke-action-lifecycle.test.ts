import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ClientMessageSchema,
  ConversationActionBindingSchema,
  DomainEventSchema,
  ConversationActionIdSchema,
  DecideConversationActionSchema,
  WorldChatStoredEventSchema,
  WorldChatWorkspaceSchema,
  newId,
  ulid,
} from "../src/index.js";

const WORLD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const AT = "2026-09-04T12:00:00.000Z";

describe("conversation action contracts", () => {
  it("uses a distinct act_ identity", () => {
    const id = newId("act");
    assert.equal(ConversationActionIdSchema.parse(id), id);
    assert.equal(ConversationActionIdSchema.safeParse(newId("pr")).success, false);
  });

  it("accepts exactly the decision fields and no renderer actor", () => {
    const frame = {
      kind: "conversation-action-decide",
      worldId: WORLD_ID,
      conversationId: newId("cv"),
      actionId: newId("act"),
      expectedConversationSeq: 4,
      expectedStatus: "pending",
      decision: "approve",
      requestId: ulid(),
    } as const;
    assert.deepEqual(DecideConversationActionSchema.parse(frame), frame);
    assert.deepEqual(ClientMessageSchema.parse(frame), frame);
    assert.equal(DecideConversationActionSchema.safeParse({ ...frame, actorId: "renderer" }).success, false);
    assert.equal(DecideConversationActionSchema.safeParse({ ...frame, expectedStatus: "approved" }).success, false);
    assert.equal(
      DomainEventSchema.safeParse({
        at: AT,
        type: "conversation-action.decision-result",
        worldId: frame.worldId,
        conversationId: frame.conversationId,
        actionId: frame.actionId,
        requestId: frame.requestId,
        disposition: "recorded",
        decision: "approve",
        status: "completed",
        deduplicated: false,
      }).success,
      true,
    );
    assert.equal(
      DomainEventSchema.safeParse({
        at: AT,
        type: "conversation-action.decision-result",
        worldId: frame.worldId,
        conversationId: frame.conversationId,
        actionId: frame.actionId,
        requestId: frame.requestId,
        disposition: "recorded",
        deduplicated: false,
        payload: {},
      }).success,
      false,
    );
  });

  it("binds the immutable shown body to its registered family and authority", () => {
    const binding = {
      actionId: newId("act"),
      conversationId: newId("cv"),
      turnId: newId("turn"),
      worldId: WORLD_ID,
      actorId: "local-user",
      scope: "world",
      actionKind: "rename-world",
      authorityKind: "world-store",
      cardFamily: "authored-diff",
      targets: [{ kind: "world", id: WORLD_ID }],
      payloadDigest: `sha256:${"a".repeat(64)}`,
      baseObservations: [
        { requirement: "world-metadata", target: WORLD_ID, revisionOrDigest: "v1", complete: true },
      ],
      dependencies: [],
      createdAt: AT,
      authority: { kind: "world-store", id: `world:${WORLD_ID}` },
      authorityRevision: 1,
      previewDigest: `sha256:${"b".repeat(64)}`,
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
      status: "pending",
      preparedAt: AT,
    } as const;
    assert.equal(ConversationActionBindingSchema.safeParse(binding).success, true);
    assert.equal(
      ConversationActionBindingSchema.safeParse({ ...binding, authority: { kind: "bible", id: "bible" } }).success,
      false,
    );
    assert.equal(
      ConversationActionBindingSchema.safeParse({ ...binding, authority: { kind: "world-store", id: "C:\\world.json" } }).success,
      false,
    );
    assert.equal(
      ConversationActionBindingSchema.safeParse({
        ...binding,
        shown: { ...binding.shown, body: { family: "host-action", action: "Choose", effect: "Opens a picker" } },
      }).success,
      false,
    );
  });

  it("keeps pre-action turn records and workspace projections readable", () => {
    const turnId = newId("turn");
    const oldTurn = {
      type: "turn.completed",
      message: { id: newId("msg"), turnId, role: "studio", text: "Done", attachmentIds: [], createdAt: AT },
      run: {
        id: newId("run"),
        turnId,
        basedOnConversationSeq: 0,
        status: "completed",
        adapter: "opencode",
        harnessCleanup: "not-required",
        contextDigest: `sha256:${"c".repeat(64)}`,
        startedAt: AT,
        endedAt: AT,
      },
      receipts: [],
      candidates: [],
      groups: [],
      tombstones: [],
    };
    assert.equal(WorldChatStoredEventSchema.safeParse(oldTurn).success, true);
    const workspace = WorldChatWorkspaceSchema.parse({
      conversationId: newId("cv"),
      status: "open",
      messages: [],
      points: [],
    });
    assert.deepEqual(workspace.actions, []);
  });
});

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  LOCAL_ACTOR_ID,
  newId,
  ulid,
  type ConversationActionCard,
  type ConversationId,
  type DecideConversationAction,
} from "@arke-studio/contracts";
import {
  ConversationActionLifecycle,
  conversationActionDigest,
  recoverConversationActions,
  type ConversationActionAuthorityAdapter,
  type PrepareConversationActionInput,
} from "../../src/arke-actions/lifecycle.js";
import { readConversationActionTombstones } from "../../src/arke-actions/tombstones.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { WorldChatService } from "../../src/world-chat/service.js";
import { conversationDir, conversationsDir, WorldChatStore } from "../../src/world-chat/store.js";
import { renameWithRetry } from "../../src/world/atomic.js";
import { tempDir } from "../tmp.js";

const WORLD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_WORLD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const AT = "2026-09-04T12:00:00.000Z";
const NOW = () => AT;

function shown() {
  return {
    title: "Rename the world",
    consequence: "Changes the world label from Old to New.",
    affectedTargets: [{ kind: "world", id: WORLD_ID }],
    ripples: [],
    permissionReason: "authored-change" as const,
    body: {
      family: "authored-diff" as const,
      fields: [{ label: "Name", before: "Old", after: "New" }],
      conflicts: [],
      openChoices: [],
    },
  };
}

function adapter(state: { executions: number; stale?: boolean }): ConversationActionAuthorityAdapter {
  return {
    actionKind: "rename-world",
    prepare: async ({ intent }) => ({
      authority: { kind: "world-store", id: `world:${intent.worldId}` },
      authorityRevision: 1,
      shown: shown(),
    }),
    recoverPreparation: async (intent) => ({
      authority: { kind: "world-store", id: `world:${intent.worldId}` },
      authorityRevision: 1,
      shown: shown(),
    }),
    validate: async () =>
      state.stale
        ? { ok: false, reason: "stale", detail: "The world name changed after this card was prepared." }
        : { ok: true },
    execute: async (action) => {
      state.executions++;
      return {
        status: "completed",
        receipt: { kind: "world-version", id: action.worldId, summary: "World renamed at version 2." },
      };
    },
    reconcile: async () => null,
  };
}

async function conversation(worldPath: string, title = "Actions"): Promise<ConversationId> {
  const conversationId = newId("cv") as ConversationId;
  const store = new WorldChatStore(conversationDir(worldPath, conversationId));
  await store.create(conversationId, AT);
  await store.append({ type: "conversation.created", title, entryContext: { kind: "world" } }, { at: AT });
  return conversationId;
}

async function loaded(worldPath: string, conversationId: ConversationId) {
  const store = new WorldChatStore(conversationDir(worldPath, conversationId));
  const meta = (await store.readMeta())!;
  return foldConversation(meta.id, meta.createdAt, (await store.read()).events).view;
}

function preparationInput(
  conversationId: ConversationId,
  patch: Partial<PrepareConversationActionInput> = {},
): PrepareConversationActionInput {
  return {
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
    ...patch,
  };
}

async function prepare(
  lifecycle: ConversationActionLifecycle,
  conversationId: ConversationId,
  dependencies: string[] = [],
): Promise<ConversationActionCard> {
  return lifecycle.prepare(preparationInput(conversationId, { dependencies }));
}

function decision(
  action: ConversationActionCard,
  seq: number,
  patch: Partial<DecideConversationAction> = {},
): DecideConversationAction {
  return {
    kind: "conversation-action-decide",
    worldId: WORLD_ID,
    conversationId: action.conversationId,
    actionId: action.actionId,
    expectedConversationSeq: seq,
    expectedStatus: "pending",
    decision: "approve",
    requestId: ulid(),
    ...patch,
  };
}

describe("conversation action folding and decisions", () => {
  it("folds an immutable pending card beside its turn", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const view = await loaded(worldPath, conversationId);

    assert.equal(action.actorId, LOCAL_ACTOR_ID);
    assert.equal(view.actions.length, 1);
    assert.equal(view.actions[0]!.status, "pending");
    assert.deepEqual(view.actions[0]!.availableDecisions, ["approve", "deny"]);
    assert.equal(view.deletionBlock, "pending-actions");
  });

  it("settles renderer-owned work exactly once after approval reaches awaiting-host", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    let completions = 0;
    const authority: ConversationActionAuthorityAdapter = {
      ...adapter({ executions: 0 }),
      execute: async () => ({ status: "awaiting-host", detail: "Waiting for the renderer." }),
      completeHost: async (action, payload) => {
        completions++;
        assert.deepEqual(payload, { result: "renderer-output" });
        return {
          status: "completed",
          receipt: { kind: "renderer-result", id: action.actionId, summary: "The renderer finished." },
        };
      },
    };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const approved = await lifecycle.decide(decision(action, (await loaded(worldPath, conversationId)).seq));
    assert.equal(approved.status, "awaiting-host");

    assert.equal(await lifecycle.completeHostAction({
      conversationId,
      actionId: action.actionId,
      payload: { result: "renderer-output" },
    }), true);
    assert.equal(await lifecycle.completeHostAction({
      conversationId,
      actionId: action.actionId,
      payload: { result: "renderer-output" },
    }), false);
    assert.equal(completions, 1);
    assert.equal((await loaded(worldPath, conversationId)).actions[0]!.status, "completed");
  });

  it("invokes preparation once when duplicate action IDs arrive concurrently", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const actionId = newId("act");
    const authority = adapter({ executions: 0 });
    const prepareAuthority = authority.prepare!;
    let preparations = 0;
    const counting: ConversationActionAuthorityAdapter = {
      ...authority,
      prepare: async (input) => {
        preparations++;
        return prepareAuthority(input);
      },
    };
    const left = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [counting], now: NOW });
    const right = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [counting], now: NOW });
    const input = preparationInput(conversationId, { actionId, turnId: newId("turn") });

    const [first, duplicate] = await Promise.all([left.prepare(input), right.prepare(input)]);

    assert.equal(first.actionId, duplicate.actionId);
    assert.equal(preparations, 1);
    const events = (await new WorldChatStore(conversationDir(worldPath, conversationId)).read()).events;
    assert.equal(events.filter((event) => event.event.type === "action.prepare-intent").length, 1);
    assert.equal(events.filter((event) => event.event.type === "action.prepared").length, 1);
  });

  it("does not reuse an action ID owned by another conversation's open intent", async () => {
    const worldPath = await tempDir("arke-actions-");
    const ownerId = await conversation(worldPath);
    const otherId = await conversation(worldPath, "Other");
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const actionId = newId("act");
    const intent = lifecycle.createIntent(preparationInput(ownerId, { actionId }));
    await new WorldChatStore(conversationDir(worldPath, ownerId)).append(
      { type: "action.prepare-intent", intent },
      { at: AT },
    );

    await assert.rejects(
      () => lifecycle.prepare(preparationInput(otherId, { actionId })),
      /already belongs to a different conversation/,
    );
    assert.equal((await loaded(worldPath, otherId)).actions.length, 0);
  });

  it("does not reuse an action ID while its deleted conversation awaits tombstoning", async () => {
    const worldPath = await tempDir("arke-actions-");
    const ownerId = await conversation(worldPath);
    const otherId = await conversation(worldPath, "Other");
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const action = await prepare(lifecycle, ownerId);
    const deletedRoot = join(conversationsDir(worldPath), ".deleted");
    const staged = join(deletedRoot, `${ownerId}-delete-race`);
    await mkdir(deletedRoot, { recursive: true });
    await renameWithRetry(conversationDir(worldPath, ownerId), staged);

    await assert.rejects(
      () => lifecycle.prepare(preparationInput(otherId, { actionId: action.actionId })),
      /already belongs to a different conversation/,
    );
  });

  it("does not prepare an intent that differs from its durable record", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const intent = lifecycle.createIntent({
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
    await new WorldChatStore(conversationDir(worldPath, conversationId)).append(
      { type: "action.prepare-intent", intent },
      { at: AT },
    );

    await assert.rejects(
      () => lifecycle.bindIntent(
        { ...intent, targets: [{ kind: "world", id: OTHER_WORLD_ID }] },
        { kind: "rename-world", worldId: WORLD_ID, name: "New" },
      ),
      /differs from its durable record/,
    );
    assert.equal((await loaded(worldPath, conversationId)).actions.length, 0);
  });

  it("keeps the first immutable binding when a conflicting duplicate is replayed", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const store = new WorldChatStore(conversationDir(worldPath, conversationId));
    const prepared = (await store.read()).events.find((envelope) => envelope.event.type === "action.prepared");
    assert.ok(prepared?.event.type === "action.prepared");
    const changedShown = { ...prepared.event.binding.shown, title: "A different immutable preview" };
    await store.append(
      {
        type: "action.prepared",
        binding: {
          ...prepared.event.binding,
          shown: changedShown,
          previewDigest: conversationActionDigest(changedShown),
        },
      },
      { at: AT },
    );

    const meta = (await store.readMeta())!;
    const folded = foldConversation(meta.id, meta.createdAt, (await store.read()).events);
    assert.equal(folded.view.actions[0]!.shown.title, action.shown.title);
    assert.match(folded.problems.at(-1)!.detail, /prepared twice with different immutable content/);
  });

  it("fails unknown and cyclic dependencies before preparing an authority", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const base = adapter({ executions: 0 });
    let preparations = 0;
    let recoveries = 0;
    const authority: ConversationActionAuthorityAdapter = {
      ...base,
      prepare: async (input) => {
        preparations++;
        return base.prepare!(input);
      },
      recoverPreparation: async (intent) => {
        recoveries++;
        return base.recoverPreparation!(intent);
      },
    };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW });

    await assert.rejects(
      () => lifecycle.prepare(preparationInput(conversationId, { dependencies: [newId("act")] })),
      /is not in this conversation/,
    );
    assert.equal(preparations, 0);

    const firstId = newId("act");
    const secondId = newId("act");
    const turnId = newId("turn");
    const first = lifecycle.createIntent(preparationInput(conversationId, {
      actionId: firstId,
      turnId,
      dependencies: [secondId],
    }));
    const second = lifecycle.createIntent(preparationInput(conversationId, {
      actionId: secondId,
      turnId,
      dependencies: [firstId],
    }));
    await new WorldChatStore(conversationDir(worldPath, conversationId)).append(
      {
        type: "turn.completed",
        message: { id: newId("msg"), turnId, role: "studio", text: "Two requests.", attachmentIds: [], createdAt: AT },
        run: {
          id: newId("run"),
          turnId,
          basedOnConversationSeq: 1,
          status: "completed",
          adapter: "test",
          harnessCleanup: "not-required",
          contextDigest: `sha256:${"d".repeat(64)}`,
          startedAt: AT,
          endedAt: AT,
        },
        receipts: [],
        candidates: [],
        groups: [],
        tombstones: [],
        actionPrepareIntents: [first, second],
      },
      { at: AT },
    );

    const recovered = await lifecycle.recoverConversation(conversationId);
    assert.equal(recovered.failed, 2);
    assert.equal(recoveries, 0);
    assert.equal((await loaded(worldPath, conversationId)).deletionBlock, null);
  });

  it("refuses stale decisions and invalid status transitions during replay", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const store = new WorldChatStore(conversationDir(worldPath, conversationId));
    const seq = (await loaded(worldPath, conversationId)).seq;
    await store.append(
      {
        type: "action.decision-recorded",
        actionId: action.actionId,
        decision: {
          requestId: ulid(),
          decision: "approve",
          actorId: LOCAL_ACTOR_ID,
          expectedConversationSeq: seq - 1,
          expectedStatus: "pending",
          decidedAt: AT,
        },
      },
      { at: AT },
    );
    await store.append(
      {
        type: "action.status-changed",
        actionId: action.actionId,
        expectedStatus: "pending",
        status: "running",
      },
      { at: AT },
    );

    const meta = (await store.readMeta())!;
    const folded = foldConversation(meta.id, meta.createdAt, (await store.read()).events);
    assert.equal(folded.view.actions[0]!.status, "pending");
    assert.equal(folded.problems.length, 2);
  });

  it("records approval and executes the authority once across a duplicate request", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const state = { executions: 0 };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter(state)], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const frame = decision(action, (await loaded(worldPath, conversationId)).seq);

    const first = await lifecycle.decide(frame);
    const duplicate = await lifecycle.decide(frame);
    const conflict = await lifecycle.decide({ ...frame, expectedConversationSeq: frame.expectedConversationSeq + 1 });

    assert.equal(first.disposition, "recorded");
    assert.equal(first.status, "completed");
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.status, "completed");
    assert.equal(conflict.reason, "request-conflict");
    assert.equal(state.executions, 1);
    const seq = (await loaded(worldPath, conversationId)).seq;
    assert.equal((await lifecycle.recordStatus(conversationId, action.actionId, "completed", {
      authority: action.authority,
      authorityRevision: action.authorityRevision,
      receipt: { kind: "world-version", id: action.worldId, summary: "World renamed at version 2." },
    })).status, "completed");
    assert.equal((await loaded(worldPath, conversationId)).seq, seq, "a repeated provider result appends nothing");
  });

  it("writes the terminal receipt where an approved authority moved the world", async () => {
    const root = await tempDir("arke-actions-move-");
    const active = join(root, "active");
    const archived = join(root, "archived");
    await mkdir(active);
    const conversationId = await conversation(active);
    let worldPath = active;
    const authority = adapter({ executions: 0 });
    const moving: ConversationActionAuthorityAdapter = {
      ...authority,
      execute: async (action) => {
        await renameWithRetry(active, archived);
        worldPath = archived;
        return authority.execute(action);
      },
    };
    const lifecycle = new ConversationActionLifecycle({
      worldPath: () => worldPath,
      worldId: WORLD_ID,
      adapters: [moving],
      now: NOW,
    });
    const action = await prepare(lifecycle, conversationId);

    const result = await lifecycle.decide(decision(action, (await loaded(active, conversationId)).seq));

    assert.equal(result.status, "completed");
    assert.equal((await loaded(archived, conversationId)).actions[0]!.status, "completed");
  });

  it("records one valid outcome when provider callbacks race", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const store = new WorldChatStore(conversationDir(worldPath, conversationId));
    const seq = (await loaded(worldPath, conversationId)).seq;
    await store.append(
      {
        type: "action.decision-recorded",
        actionId: action.actionId,
        decision: {
          requestId: ulid(),
          decision: "approve",
          actorId: LOCAL_ACTOR_ID,
          expectedConversationSeq: seq,
          expectedStatus: "pending",
          decidedAt: AT,
        },
      },
      { at: AT },
    );

    const [first, duplicate] = await Promise.all([
      lifecycle.recordStatus(conversationId, action.actionId, "completed", {
        authority: action.authority,
        authorityRevision: action.authorityRevision,
        receipt: { kind: "world-version", id: action.worldId, summary: "World renamed at version 2." },
      }),
      lifecycle.recordStatus(conversationId, action.actionId, "completed", {
        authority: action.authority,
        authorityRevision: action.authorityRevision,
        receipt: { kind: "world-version", id: action.worldId, summary: "World renamed at version 2." },
      }),
    ]);
    const events = (await store.read()).events;
    const meta = (await store.readMeta())!;
    const folded = foldConversation(meta.id, meta.createdAt, events);
    assert.equal(first.status, "completed");
    assert.equal(duplicate.status, "completed");
    assert.equal(events.filter((event) => event.event.type === "action.status-changed").length, 1);
    assert.equal(folded.problems.length, 0);
  });

  it("denies without invoking the target authority", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const state = { executions: 0 };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter(state)], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const result = await lifecycle.decide(
      decision(action, (await loaded(worldPath, conversationId)).seq, { decision: "deny" }),
    );

    assert.equal(result.status, "denied");
    assert.equal(state.executions, 0);
  });

  it("records denial before cleanup and retries interrupted cleanup on restart", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    let attempts = 0;
    const authority: ConversationActionAuthorityAdapter = {
      ...adapter({ executions: 0 }),
      deny: async () => {
        attempts++;
        assert.equal((await loaded(worldPath, conversationId)).actions[0]!.status, "denied");
        if (attempts === 1) throw new Error("interrupted cleanup");
      },
    };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW });
    const action = await prepare(lifecycle, conversationId);

    const result = await lifecycle.decide(
      decision(action, (await loaded(worldPath, conversationId)).seq, { decision: "deny" }),
    );
    assert.equal(result.disposition, "recorded");
    assert.equal(result.status, "denied");
    assert.equal(attempts, 1);

    await new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW })
      .recoverConversation(conversationId);
    assert.equal(attempts, 2);
    assert.equal((await loaded(worldPath, conversationId)).actions[0]!.status, "denied");
  });

  it("refuses wrong world, conversation, sequence, and status", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const otherConversationId = await conversation(worldPath, "Other");
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const seq = (await loaded(worldPath, conversationId)).seq;

    assert.equal((await lifecycle.decide(decision(action, seq, { worldId: OTHER_WORLD_ID }))).reason, "wrong-world");
    assert.equal(
      (await lifecycle.decide(decision(action, (await loaded(worldPath, otherConversationId)).seq, { conversationId: otherConversationId }))).reason,
      "wrong-conversation",
    );
    assert.equal((await lifecycle.decide(decision(action, seq - 1))).reason, "sequence-mismatch");
    assert.equal((await lifecycle.decide(decision(action, seq, { expectedStatus: "stale" }))).reason, "status-mismatch");
  });

  it("marks materially moved input stale and does not execute", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const state = { executions: 0, stale: true };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter(state)], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const result = await lifecycle.decide(decision(action, (await loaded(worldPath, conversationId)).seq));

    assert.equal(result.reason, "stale");
    assert.equal(result.status, "stale");
    assert.equal((await loaded(worldPath, conversationId)).actions[0]!.status, "stale");
    assert.equal(state.executions, 0);
  });

  it("preserves approval and records an authority failure", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const state = { executions: 0 };
    const failing: ConversationActionAuthorityAdapter = {
      ...adapter(state),
      execute: async () => {
        state.executions++;
        throw new Error("private authority detail");
      },
    };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [failing], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const result = await lifecycle.decide(decision(action, (await loaded(worldPath, conversationId)).seq));
    const failed = (await loaded(worldPath, conversationId)).actions[0]!;

    assert.equal(result.status, "failed");
    assert.equal(failed.decision?.decision, "approve");
    assert.equal(failed.status, "failed");
    assert.equal(state.executions, 1);
  });

  it("records an authority that becomes stale under its execution lock", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const authority: ConversationActionAuthorityAdapter = {
      ...adapter({ executions: 0 }),
      execute: async () => ({ status: "stale", detail: "The locked source changed." }),
    };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW });
    const action = await prepare(lifecycle, conversationId);

    const result = await lifecycle.decide(decision(action, (await loaded(worldPath, conversationId)).seq));

    assert.equal(result.status, "stale");
    assert.equal((await loaded(worldPath, conversationId)).actions[0]!.status, "stale");
  });

  it("blocks approval until dependencies complete", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const prerequisite = await prepare(lifecycle, conversationId);
    const dependent = await prepare(lifecycle, conversationId, [prerequisite.actionId]);
    const view = await loaded(worldPath, conversationId);

    assert.deepEqual(view.actions.find((one) => one.actionId === dependent.actionId)!.availableDecisions, ["deny"]);
    assert.equal((await lifecycle.decide(decision(dependent, view.seq))).reason, "dependency-blocked");
  });

  it("records explicit supersession and undo links", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const original = await prepare(lifecycle, conversationId);
    const replacement = await prepare(lifecycle, conversationId);

    await lifecycle.supersede(conversationId, original.actionId, replacement.actionId, "Prepared from newer world state.");
    await lifecycle.decide(decision(replacement, (await loaded(worldPath, conversationId)).seq));
    await lifecycle.linkUndo(conversationId, replacement.actionId, { kind: "world-version", id: "version:1" });

    const actions = (await loaded(worldPath, conversationId)).actions;
    assert.equal(actions.find((one) => one.actionId === original.actionId)?.status, "superseded");
    assert.equal(actions.find((one) => one.actionId === original.actionId)?.supersededBy, replacement.actionId);
    assert.equal(actions.find((one) => one.actionId === replacement.actionId)?.undo?.id, "version:1");
  });

  it("links an authority-projected inverse when execution completes", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const authority: ConversationActionAuthorityAdapter = {
      ...adapter({ executions: 0 }),
      undo: () => ({ kind: "world-version", id: "version:1" }),
    };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW });
    const action = await prepare(lifecycle, conversationId);

    await lifecycle.decide(decision(action, (await loaded(worldPath, conversationId)).seq));

    const completed = (await loaded(worldPath, conversationId)).actions[0]!;
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.undo, { kind: "world-version", id: "version:1", linkedAt: AT });
  });
});

describe("conversation action recovery and deletion", () => {
  it("orders deletion against a concurrent preparation intent", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const service = new WorldChatService(worldPath, NOW);

    const [deletion, preparation] = await Promise.allSettled([
      service.delete(conversationId, "delete-race"),
      lifecycle.prepare(preparationInput(conversationId)),
    ]);

    assert.notEqual(
      deletion.status,
      preparation.status,
      `exactly one operation crosses the durable intent boundary: ${JSON.stringify({ deletion, preparation })}`,
    );
    const meta = await new WorldChatStore(conversationDir(worldPath, conversationId)).readMeta();
    if (preparation.status === "fulfilled") {
      assert.equal(meta?.id, conversationId);
      assert.equal(deletion.status, "rejected");
      assert.equal((deletion as PromiseRejectedResult).reason.reason, "pending-actions");
    } else {
      assert.equal(meta, null);
      assert.equal(deletion.status, "fulfilled");
    }
  });

  it("recovers a durable prepare intent whose authority already exists", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const recovering = adapter({ executions: 0 });
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [recovering], now: NOW });
    const intent = lifecycle.createIntent({
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
    const turnId = intent.turnId;
    await new WorldChatStore(conversationDir(worldPath, conversationId)).append(
      {
        type: "turn.completed",
        message: { id: newId("msg"), turnId, role: "studio", text: "I prepared it.", attachmentIds: [], createdAt: AT },
        run: {
          id: newId("run"),
          turnId,
          basedOnConversationSeq: 1,
          status: "completed",
          adapter: "test",
          harnessCleanup: "not-required",
          contextDigest: `sha256:${"d".repeat(64)}`,
          startedAt: AT,
          endedAt: AT,
        },
        receipts: [],
        candidates: [],
        groups: [],
        tombstones: [],
        actionPrepareIntents: [intent],
      },
      { at: AT },
    );
    const beforeBinding = await loaded(worldPath, conversationId);
    assert.equal(beforeBinding.messages[0]!.text, "I prepared it.", "the reply and intent landed together");
    assert.equal(beforeBinding.actions.length, 0, "an intent alone is not a card");
    assert.equal(beforeBinding.deletionBlock, "pending-actions");

    const recovered = await recoverConversationActions({ worldPath, worldId: WORLD_ID, adapters: [recovering], now: NOW });
    assert.equal(recovered.prepared, 1);
    const view = await loaded(worldPath, conversationId);
    assert.equal(view.messages[0]!.text, "I prepared it.");
    assert.equal(view.actions[0]!.status, "pending");
    assert.equal((await recoverConversationActions({ worldPath, worldId: WORLD_ID, adapters: [recovering], now: NOW })).prepared, 0);
  });

  it("does not create an authority for an intent detached from its reply turn", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    let recoveries = 0;
    const base = adapter({ executions: 0 });
    const authority: ConversationActionAuthorityAdapter = {
      ...base,
      recoverPreparation: async (intent) => {
        recoveries++;
        return base.recoverPreparation!(intent);
      },
    };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW });
    const intent = lifecycle.createIntent(preparationInput(conversationId));
    const otherTurnId = newId("turn");
    const store = new WorldChatStore(conversationDir(worldPath, conversationId));
    await store.append(
      {
        type: "turn.completed",
        message: { id: newId("msg"), turnId: otherTurnId, role: "studio", text: "Detached.", attachmentIds: [], createdAt: AT },
        run: {
          id: newId("run"),
          turnId: otherTurnId,
          basedOnConversationSeq: 1,
          status: "completed",
          adapter: "test",
          harnessCleanup: "not-required",
          contextDigest: `sha256:${"d".repeat(64)}`,
          startedAt: AT,
          endedAt: AT,
        },
        receipts: [],
        candidates: [],
        groups: [],
        tombstones: [],
        actionPrepareIntents: [intent],
      },
      { at: AT },
    );

    const recovered = await lifecycle.recoverConversation(conversationId);
    const meta = (await store.readMeta())!;
    const folded = foldConversation(meta.id, meta.createdAt, (await store.read()).events);
    assert.deepEqual(recovered, { prepared: 0, reconciled: 0, failed: 0 });
    assert.equal(recoveries, 0);
    assert.match(folded.problems.at(-1)!.detail, /different turn from the reply/);
    assert.equal(folded.view.actions.length, 0);
  });

  it("resumes one approved action idempotently across concurrent restart recovery", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const state = { executions: 0 };
    const authority = adapter(state);
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const store = new WorldChatStore(conversationDir(worldPath, conversationId));
    const seq = (await loaded(worldPath, conversationId)).seq;
    await store.append(
      {
        type: "action.decision-recorded",
        actionId: action.actionId,
        decision: {
          requestId: ulid(),
          decision: "approve",
          actorId: LOCAL_ACTOR_ID,
          expectedConversationSeq: seq,
          expectedStatus: "pending",
          decidedAt: AT,
        },
      },
      { at: AT },
    );

    const firstPass = await Promise.all([
      recoverConversationActions({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW }),
      recoverConversationActions({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW }),
    ]);
    const secondPass = await recoverConversationActions({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW });
    assert.equal(firstPass.reduce((sum, result) => sum + result.reconciled, 0), 1);
    assert.equal(secondPass.reconciled, 0);
    assert.equal(state.executions, 1);
    assert.equal((await loaded(worldPath, conversationId)).actions[0]!.status, "completed");
  });

  it("keeps a pending card pending when its adapter is unavailable after restart", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    await prepare(lifecycle, conversationId);

    const recovered = await recoverConversationActions({ worldPath, worldId: WORLD_ID, now: NOW });

    assert.equal(recovered.failed, 0);
    assert.equal((await loaded(worldPath, conversationId)).actions[0]!.status, "pending");
  });

  it("reconciles a pending binding without executing it", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const state = { executions: 0 };
    let reconciliations = 0;
    const authority: ConversationActionAuthorityAdapter = {
      ...adapter(state),
      reconcile: async () => {
        reconciliations++;
        return null;
      },
    };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW });
    await prepare(lifecycle, conversationId);

    const recovered = await lifecycle.recoverConversation(conversationId);

    assert.deepEqual(recovered, { prepared: 0, reconciled: 0, failed: 0 });
    assert.equal(reconciliations, 1);
    assert.equal(state.executions, 0);
    assert.equal((await loaded(worldPath, conversationId)).actions[0]!.status, "pending");
  });

  it("blocks deletion while pending and retains only the final action tombstone", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [adapter({ executions: 0 })], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    const service = new WorldChatService(worldPath, NOW);
    await assert.rejects(() => service.delete(conversationId, "delete-1"));

    await lifecycle.decide(
      decision(action, (await loaded(worldPath, conversationId)).seq, { decision: "deny" }),
    );
    await service.delete(conversationId, "delete-1");
    const tombstones = await readConversationActionTombstones(worldPath);
    assert.deepEqual(tombstones, [
      {
        actionId: action.actionId,
        actorId: LOCAL_ACTOR_ID,
        actionKind: "rename-world",
        status: "denied",
        decision: "deny",
        decidedAt: AT,
        authority: action.authority,
        payloadDigest: action.payloadDigest,
        previewDigest: action.previewDigest,
      },
    ]);
    assert.equal(JSON.stringify(tombstones).includes("Old"), false, "the shown card body is not retained");

    const otherConversationId = await conversation(worldPath, "Other");
    await assert.rejects(
      () => lifecycle.prepare(preparationInput(otherConversationId, { actionId: action.actionId })),
      /belongs to a deleted conversation/,
    );
  });
});

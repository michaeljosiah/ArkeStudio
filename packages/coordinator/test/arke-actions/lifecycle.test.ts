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
  type ConversationActionFailure,
  type PrepareConversationActionInput,
} from "../../src/arke-actions/lifecycle.js";
import { readConversationActionTombstones } from "../../src/arke-actions/tombstones.js";
import { assembleContext } from "../../src/world-chat/context.js";
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

/** An authority's own refusal, as the world-chat adapters' `describeRefusal` reads the real ones. */
class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}
const PINNED = "Shot 1 is anchored to the track — move or clear the anchor first.";
const refusalReader = (authority: ConversationActionAuthorityAdapter): ConversationActionAuthorityAdapter => ({
  ...authority,
  refusal: (error) => error instanceof Refused ? error.message : null,
});

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
  it("refuses forged group approvals for host cards and executes duplicate eligible decisions once", async () => {
    const worldPath = await tempDir("arke-group-actions-");
    const conversationId = await conversation(worldPath);
    const counter = { executions: 0 };
    const native: ConversationActionAuthorityAdapter = {
      ...adapter(counter), actionKind: "world-chat-artifact-import",
      prepare: async ({ intent }) => ({ authority: { kind: "artifact-store", id: intent.actionId }, authorityRevision: 1,
        shown: { ...shown(), permissionReason: "host-file-access", body: { family: "host-action", action: "Import", effect: "Choose files on the PC" } } }),
    };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [native, adapter(counter)], now: NOW });
    const host = await lifecycle.prepare(preparationInput(conversationId, { actionKind: native.actionKind,
      payload: { kind: native.actionKind, worldId: WORLD_ID, action: { kind: "artifact-import", source: "files", checkReceiptIds: [newId("check")] } },
      baseObservations: [{ requirement: "artifacts", target: WORLD_ID, revisionOrDigest: "v1", complete: true }],
    }));
    assert.equal((await lifecycle.decide(decision(host, (await loaded(worldPath, conversationId)).seq, { groupApprovalTurnId: host.turnId }))).reason, "validation-refused");
    assert.equal(counter.executions, 0);
    const safe = await prepare(lifecycle, conversationId);
    const request = decision(safe, (await loaded(worldPath, conversationId)).seq, { groupApprovalTurnId: safe.turnId });
    assert.equal((await lifecycle.decide(request)).status, "completed");
    assert.equal((await lifecycle.decide(request)).deduplicated, true);
    assert.equal(counter.executions, 1);
    assert.equal((await loaded(worldPath, conversationId)).actions.find(action => action.actionId === host.actionId)?.status, "pending");
  });
  it("remote decisions refuse native pickers before approval or replay while desktop approval and remote denial remain available", async () => {
    for (const source of ["files", "folder"] as const) {
      const worldPath = await tempDir("arke-remote-actions-");
      const conversationId = await conversation(worldPath);
      const counter = { executions: 0 };
      const native: ConversationActionAuthorityAdapter = {
        ...adapter(counter), actionKind: "world-chat-artifact-import",
        prepare: async ({ intent }) => ({ authority: { kind: "artifact-store", id: intent.actionId }, authorityRevision: 1,
          shown: { ...shown(), permissionReason: "host-file-access", body: { family: "host-action", action: "Import", effect: "Choose files on the PC" } } }),
      };
      const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [native, adapter(counter)], now: NOW });
      const create = () => lifecycle.prepare(preparationInput(conversationId, { actionKind: native.actionKind,
        payload: { kind: native.actionKind, worldId: WORLD_ID, action: { kind: "artifact-import", source, checkReceiptIds: [newId("check")] } },
        baseObservations: [{ requirement: "artifacts", target: WORLD_ID, revisionOrDigest: "v1", complete: true }],
      }));
      const action = await create();
      const request = decision(action, (await loaded(worldPath, conversationId)).seq);
      const blocked = await lifecycle.decide({ ...request, hostActions: "refuse" });
      assert.equal(blocked.reason, "host-only"); assert.equal(counter.executions, 0);
      assert.equal((await loaded(worldPath, conversationId)).actions[0]!.status, "pending");
      assert.equal((await lifecycle.decide(request)).status, "completed"); assert.equal(counter.executions, 1);
      assert.equal((await lifecycle.decide({ ...request, hostActions: "refuse" })).reason, "host-only", "replay checks before resuming an existing decision");
      assert.equal(counter.executions, 1);
      const denied = await create();
      assert.equal((await lifecycle.decide(decision(denied, (await loaded(worldPath, conversationId)).seq, { decision: "deny", hostActions: "refuse" }))).status, "denied");
      const authored = await prepare(lifecycle, conversationId);
      assert.equal((await lifecycle.decide(decision(authored, (await loaded(worldPath, conversationId)).seq, { hostActions: "refuse" }))).status, "completed");
    }
  });
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

  it("folds a host completion that became stale and still permits denial", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const authority: ConversationActionAuthorityAdapter = {
      ...adapter({ executions: 0 }),
      execute: async () => ({ status: "awaiting-host" }),
      completeHost: async () => ({ status: "stale", detail: "The Stage changed while recording." }),
    };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW });
    const action = await prepare(lifecycle, conversationId);
    await lifecycle.decide(decision(action, (await loaded(worldPath, conversationId)).seq));
    await lifecycle.completeHostAction({ conversationId, actionId: action.actionId, payload: {} });
    const view = await loaded(worldPath, conversationId);
    assert.equal(view.actions[0]!.status, "stale");
    assert.deepEqual(view.actions[0]!.availableDecisions, ["deny"]);
    assert.equal(view.actions[0]!.statusDetail, "The Stage changed while recording.");
    assert.equal((await lifecycle.decide(decision(action, view.seq, { expectedStatus: "stale", decision: "deny" }))).status, "denied");
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
    const reported: ConversationActionFailure[] = [];
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [failing], now: NOW,
      onUnexpectedFailure: (failure) => reported.push(failure) });
    const action = await prepare(lifecycle, conversationId);
    const result = await lifecycle.decide(decision(action, (await loaded(worldPath, conversationId)).seq));
    const failed = (await loaded(worldPath, conversationId)).actions[0]!;

    assert.equal(result.status, "failed");
    assert.equal(failed.decision?.decision, "approve");
    assert.equal(failed.status, "failed");
    assert.equal(state.executions, 1);
    // An unexpected error's words are for the log, never the card (issue 3135).
    assert.equal(failed.statusDetail, "The authority failed while executing the approved action.");
    assert.deepEqual(reported, [{ conversationId, actionId: action.actionId, actionKind: "rename-world", phase: "execute",
      cause: "Error: private authority detail" }]);
  });

  // The card that removed a scene's four pinned shots said only "The authority failed while
  // executing the approved action", and Arke, asked why, could not see the reason either.
  it("shows an authority's refusal on the failed card in its own words (issue 3135)", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const reported: ConversationActionFailure[] = [];
    const refusing: ConversationActionAuthorityAdapter = { ...refusalReader(adapter({ executions: 0 })),
      execute: async () => { throw new Refused(PINNED); } };
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [refusing], now: NOW,
      onUnexpectedFailure: (failure) => reported.push(failure) });
    const action = await prepare(lifecycle, conversationId);

    assert.equal((await lifecycle.decide(decision(action, (await loaded(worldPath, conversationId)).seq))).status, "failed");
    const failed = (await loaded(worldPath, conversationId)).actions[0]!;
    assert.equal(failed.statusDetail, PINNED);
    assert.equal(failed.decision?.decision, "approve", "the approval is kept beside the failure");
    assert.deepEqual(reported, [], "a refusal is the authority working, not a fault to log");
    // The same words reach Arke's next turn, beside the status that used to be all it was told.
    const outcomes = assembleContext({ candidates: [], messages: [], tombstones: [], currentUserMessage: "Why did that fail?",
      currentUserMessageId: newId("msg"), actions: [failed] }).actionReceipts;
    assert.deepEqual(JSON.parse(outcomes), { actionId: action.actionId, kind: "rename-world", targets: [{ kind: "world", id: WORLD_ID }],
      status: "failed", authority: failed.authority, reason: PINNED });
    const tight = assembleContext({ candidates: [], messages: [], tombstones: [], currentUserMessage: "Why?", currentUserMessageId: newId("msg"),
      actions: [{ ...failed, statusDetail: "x".repeat(900) }], budgetChars: 5_000 }).actionReceipts;
    assert.equal((JSON.parse(tight) as { status: string; reason?: string }).status, "failed", "a long reason never costs the record that it failed");
  });

  it("says the generic line when the authority cannot read what it threw", async () => {
    for (const refusal of [undefined, () => null, () => "   ", () => { throw new Error("the reader failed"); }]) {
      const worldPath = await tempDir("arke-actions-");
      const conversationId = await conversation(worldPath);
      const reported: ConversationActionFailure[] = [];
      const failing: ConversationActionAuthorityAdapter = { ...adapter({ executions: 0 }), ...(refusal ? { refusal } : {}),
        execute: async () => { throw new Refused(PINNED); } };
      const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [failing], now: NOW,
        onUnexpectedFailure: (failure) => reported.push(failure) });
      const action = await prepare(lifecycle, conversationId);

      await lifecycle.decide(decision(action, (await loaded(worldPath, conversationId)).seq));

      assert.equal((await loaded(worldPath, conversationId)).actions[0]!.statusDetail, "The authority failed while executing the approved action.");
      assert.deepEqual(reported.map((failure) => failure.cause), [`Refused: ${PINNED}`]);
    }
  });

  it("records the failure when the log it is reported to cannot be written", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const failing: ConversationActionAuthorityAdapter = { ...adapter({ executions: 0 }), execute: async () => { throw new Error("x".repeat(2_000)); } };
    const causes: string[] = [];
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [failing], now: NOW,
      onUnexpectedFailure: (failure) => { causes.push(failure.cause); throw new Error("the log is unwritable"); } });
    const action = await prepare(lifecycle, conversationId);

    assert.equal((await lifecycle.decide(decision(action, (await loaded(worldPath, conversationId)).seq))).status, "failed");
    assert.equal(causes[0]!.length, 500, "the cause is bounded");
  });

  it("keeps a host completion's refusal, and reports a host fault with the line it always said", async () => {
    for (const [thrown, shown, causes] of [
      [new Refused("The scene moved while the Stage was recording."), "The scene moved while the Stage was recording.", []],
      [new TypeError("renderer payload was undefined"), "The host could not finish the approved action.", ["TypeError: renderer payload was undefined"]],
    ] as const) {
      const worldPath = await tempDir("arke-actions-");
      const conversationId = await conversation(worldPath);
      const reported: ConversationActionFailure[] = [];
      const authority: ConversationActionAuthorityAdapter = { ...refusalReader(adapter({ executions: 0 })),
        execute: async () => ({ status: "awaiting-host" }), completeHost: async () => { throw thrown; } };
      const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW,
        onUnexpectedFailure: (failure) => reported.push(failure) });
      const action = await prepare(lifecycle, conversationId);
      await lifecycle.decide(decision(action, (await loaded(worldPath, conversationId)).seq));

      await lifecycle.completeHostAction({ conversationId, actionId: action.actionId, payload: {} });

      const failed = (await loaded(worldPath, conversationId)).actions[0]!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.statusDetail, shown);
      assert.deepEqual(reported.map((failure) => [failure.phase, failure.cause]), causes.map((cause) => ["host", cause]));
    }
  });

  it("settles a stale card's authority after the stale status is durable, and retries it on restart (issue 3104)", async () => {
    const worldPath = await tempDir("arke-actions-");
    const conversationId = await conversation(worldPath);
    const settled: string[] = [];
    let fail = true;
    const authority = (state: { executions: number; stale?: boolean }): ConversationActionAuthorityAdapter => ({
      ...adapter(state),
      execute: async () => ({ status: "stale", detail: "The locked source changed." }),
      settleStale: async (action) => {
        assert.equal((await loaded(worldPath, conversationId)).actions.find((one) => one.actionId === action.actionId)!.status, "stale");
        settled.push(action.actionId);
        if (fail) { fail = false; throw new Error("interrupted cleanup"); }
      },
    });
    const lifecycle = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority({ executions: 0, stale: true })], now: NOW });

    const refused = await prepare(lifecycle, conversationId);
    assert.equal((await lifecycle.decide(decision(refused, (await loaded(worldPath, conversationId)).seq))).status, "stale");
    assert.deepEqual(settled, [refused.actionId], "a decision that finds the card stale settles it");

    const moved = new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority({ executions: 0 })], now: NOW });
    const executed = await prepare(moved, conversationId);
    assert.equal((await moved.decide(decision(executed, (await loaded(worldPath, conversationId)).seq))).status, "stale");
    assert.deepEqual(settled, [refused.actionId, executed.actionId], "so does an execution that comes back stale");

    settled.length = 0;
    await moved.recoverConversation(conversationId);
    assert.deepEqual(new Set(settled), new Set([refused.actionId, executed.actionId]), "and a restart settles each again");
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

  // An approval a crash left unexecuted is resumed at the next open. What it then says is the
  // refusal when there is one, and otherwise still that it could not be resumed (issue 3135).
  it("says why a resumed approval was refused, and that it could not be resumed when the fault is unexpected", async () => {
    for (const [thrown, shown, causes] of [
      [new Refused(PINNED), PINNED, []],
      [new Error("private authority detail"), "The approved action could not be resumed after restart.", ["Error: private authority detail"]],
    ] as const) {
      const worldPath = await tempDir("arke-actions-");
      const conversationId = await conversation(worldPath);
      const authority: ConversationActionAuthorityAdapter = { ...refusalReader(adapter({ executions: 0 })), execute: async () => { throw thrown; } };
      const action = await prepare(new ConversationActionLifecycle({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW }), conversationId);
      await new WorldChatStore(conversationDir(worldPath, conversationId)).append(
        {
          type: "action.decision-recorded",
          actionId: action.actionId,
          decision: {
            requestId: ulid(),
            decision: "approve",
            actorId: LOCAL_ACTOR_ID,
            expectedConversationSeq: (await loaded(worldPath, conversationId)).seq,
            expectedStatus: "pending",
            decidedAt: AT,
          },
        },
        { at: AT },
      );
      const reported: ConversationActionFailure[] = [];

      await recoverConversationActions({ worldPath, worldId: WORLD_ID, adapters: [authority], now: NOW,
        onUnexpectedFailure: (failure) => reported.push(failure) });

      const failed = (await loaded(worldPath, conversationId)).actions[0]!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.statusDetail, shown);
      assert.deepEqual(reported.map((failure) => [failure.phase, failure.cause]), causes.map((cause) => ["resume", cause]));
    }
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

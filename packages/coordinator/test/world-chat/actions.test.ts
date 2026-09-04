import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newId,
  orderedTrackClips,
  ulid,
  type CandidateGroup,
  type CandidateId,
  type ConversationActionCard,
  type ConversationId,
  type MessageId,
  type WorldChangeCandidate,
  type WorldChatContext,
  type WorldChatCheckReceipt,
} from "@arke-studio/contracts";
import { ConversationActionLifecycle } from "../../src/arke-actions/lifecycle.js";
import { acceptDecided, ProposalManager } from "../../src/gate/proposals.js";
import { readEditorRequest } from "../../src/productions/editor-requests.js";
import { sceneVersionFor } from "../../src/productions/scene-edits.js";
import { applyTurnBibleEdits, readBible } from "../../src/world/bible.js";
import { WorldStore } from "../../src/world/store.js";
import { prepareWorldChatActions, worldChatActionAdapters, type WorldChatActionTurn } from "../../src/world-chat/actions.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";
import { assembleStory } from "../productions/assemble.js";
import { bibleFence, timelineFence } from "../../src/world-chat/target-reads.js";

const AT = "2026-09-04T12:00:00.000Z";
const NOW = () => AT;
const PRODUCTION = "saltlight";

async function setup(entryContext: WorldChatContext = { kind: "world" }) {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: NOW });
  closeOnCleanup(() => store.close());
  const gate = new ProposalManager(store);
  const conversationId = newId("cv") as ConversationId;
  const log = new WorldChatStore(conversationDir(dir, conversationId));
  await log.create(conversationId, AT);
  await log.append({ type: "conversation.created", title: "Actions", entryContext }, { at: AT });
  const lifecycle = new ConversationActionLifecycle({
    worldPath: dir,
    worldId: store.worldId,
    adapters: worldChatActionAdapters(store, gate, NOW),
    now: NOW,
  });
  return { store, gate, conversationId, log, lifecycle, entryContext };
}

async function loaded(log: WorldChatStore) {
  const meta = (await log.readMeta())!;
  return foldConversation(meta.id, meta.createdAt, (await log.read()).events).view;
}

async function appendTurn(
  log: WorldChatStore,
  turn: WorldChatActionTurn,
  prepared: ReturnType<typeof prepareWorldChatActions>,
): Promise<void> {
  await log.append(
    {
      type: "turn.completed",
      message: {
        id: newId("msg") as MessageId,
        turnId: turn.turnId,
        role: "studio",
        text: "I prepared that for review.",
        attachmentIds: [],
        createdAt: AT,
      },
      run: {
        id: newId("run"),
        turnId: turn.turnId,
        basedOnConversationSeq: 1,
        status: "completed",
        adapter: "test",
        harnessCleanup: "not-required",
        contextDigest: `sha256:${"a".repeat(64)}`,
        startedAt: AT,
        endedAt: AT,
      },
      receipts: [],
      candidates: [...turn.candidates],
      groups: [...turn.groups],
      tombstones: [],
      actionPrepareIntents: prepared.map((action) => action.intent),
    },
    { at: AT },
  );
}

async function bindAll(
  lifecycle: ConversationActionLifecycle,
  prepared: ReturnType<typeof prepareWorldChatActions>,
): Promise<void> {
  for (const action of prepared) await lifecycle.bindIntent(action.intent, action.payload);
}

async function decide(
  lifecycle: ConversationActionLifecycle,
  log: WorldChatStore,
  action: ConversationActionCard,
  decision: "approve" | "deny" = "approve",
) {
  return lifecycle.decide({
    kind: "conversation-action-decide",
    worldId: action.worldId,
    conversationId: action.conversationId,
    actionId: action.actionId,
    expectedConversationSeq: (await loaded(log)).seq,
    expectedStatus: "pending",
    decision,
    requestId: ulid(),
  });
}

function turn(
  conversationId: ConversationId,
  entryContext: WorldChatContext,
  over: Partial<WorldChatActionTurn> = {},
): WorldChatActionTurn {
  return {
    conversationId,
    turnId: newId("turn"),
    entryContext,
    existingCandidates: [],
    existingGroups: [],
    candidates: [],
    groups: [],
    bibleEdits: [],
    bibleBaseVersion: 1,
    sceneEdits: [],
    sceneBaseVersion: null,
    editorRequests: [],
    at: AT,
    ...over,
  };
}

function candidate(
  conversationId: ConversationId,
  title: string,
  over: Partial<WorldChangeCandidate> = {},
): WorldChangeCandidate {
  return {
    id: newId("cand") as CandidateId,
    conversationId,
    revision: 1,
    status: "live",
    settledness: "settled",
    classification: "canon.create",
    subject: { kind: "new", label: title },
    title,
    rationale: "The author settled it.",
    sourceMessageIds: [],
    evidence: [
      {
        kind: "message",
        messageId: newId("msg") as MessageId,
        quote: "make it so",
        start: 0,
        end: 10,
        purpose: "intent",
      },
    ],
    checks: {
      state: "complete",
      basedOnCanonRevision: 42,
      required: ["canon-search"],
      completed: ["canon-search"],
      consulted: [],
      likelyDuplicates: [],
      possibleAmendments: [],
      contradictionCandidates: [],
      explanation: "No overlap was found.",
    },
    createdAt: AT,
    updatedAt: AT,
    draft: { type: "lore", title, statement: `${title} is true.`, links: [] },
    ...over,
  } as WorldChangeCandidate;
}

describe("World Chat authority adapters", () => {
  it("requires a coordinator-issued complete timeline receipt when a live run prepares an editor request", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const w = await setup(context);
    const timeline = await assembleStory(w.store, PRODUCTION);
    const clips = orderedTrackClips(timeline.tracks[0]!);
    const request = { summary: "Move the second shot earlier", commands: [{ kind: "move-adjacent" as const, clipId: clips[1]!.id, direction: "earlier" as const }] };
    const withoutRead = turn(w.conversationId, context, { editorRequests: [request], receipts: [] });
    assert.throws(
      () => prepareWorldChatActions(w.store, w.lifecycle, withoutRead),
      /complete current timeline read/,
    );

    const production = w.store.getBundle().productions.find((entry) => entry.meta.id === PRODUCTION)!;
    const receipt: WorldChatCheckReceipt = {
      id: newId("check"),
      runId: newId("run"),
      tool: "target-read",
      status: "complete",
      consulted: [],
      target: { requirement: "timeline", id: PRODUCTION },
      observedRevisionOrDigest: timelineFence(production),
      complete: true,
      nextCursor: null,
      at: AT,
    };
    const [prepared] = prepareWorldChatActions(w.store, w.lifecycle, { ...withoutRead, receipts: [receipt] });
    assert.equal(prepared!.intent.baseObservations[0]!.receiptId, receipt.id);
  });

  it("requires the exact current Bible receipt for a whole-document replacement", async () => {
    const w = await setup();
    const liveTurn = turn(w.conversationId, w.entryContext, {
      bibleBaseVersion: w.store.getBundle().bible.version,
      bibleEdits: [{ op: "replace-document", text: "# Rewritten Bible" }],
      receipts: [],
    });
    assert.throws(
      () => prepareWorldChatActions(w.store, w.lifecycle, liveTurn),
      /complete current Bible read/,
    );

    const receipt: WorldChatCheckReceipt = {
      id: newId("check"),
      runId: newId("run"),
      tool: "target-read",
      status: "complete",
      consulted: [],
      target: { requirement: "bible", id: "bible" },
      observedRevisionOrDigest: `v${w.store.getBundle().bible.version}:sha256:${"0".repeat(64)}`,
      complete: true,
      nextCursor: null,
      at: AT,
    };
    assert.throws(
      () => prepareWorldChatActions(w.store, w.lifecycle, { ...liveTurn, receipts: [receipt] }),
      /complete current Bible read/,
    );

    receipt.observedRevisionOrDigest = bibleFence(w.store.getBundle());
    const [prepared] = prepareWorldChatActions(w.store, w.lifecycle, { ...liveTurn, receipts: [receipt] });
    assert.equal(prepared!.intent.baseObservations[0]!.receiptId, receipt.id);
  });

  it("recovers an existing proposal authority without staging a duplicate", async () => {
    const w = await setup();
    const point = candidate(w.conversationId, "The western bell rings under water");
    const oneTurn = turn(w.conversationId, w.entryContext, { candidates: [point] });
    const [prepared] = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    assert.ok(prepared);
    await appendTurn(w.log, oneTurn, [prepared]);

    const proposalAdapter = worldChatActionAdapters(w.store, w.gate, NOW)
      .find((adapter) => adapter.actionKind === "world-chat-proposal")!;
    const before = (await w.gate.listOpen()).length;
    const authority = await proposalAdapter.prepare!({ intent: prepared.intent, payload: prepared.payload });
    assert.equal((await w.gate.listOpen()).length, before + 1);
    await w.log.append(
      { type: "save.intent-recorded", requestId: prepared.intent.actionId, candidateIds: [point.id] },
      { at: AT },
    );
    assert.equal((await loaded(w.log)).deletionBlock, "wrap-up-in-flight");

    const result = await w.lifecycle.recoverConversation(w.conversationId);
    assert.equal(result.prepared, 1);
    assert.equal((await w.gate.listOpen()).length, before + 1);
    assert.equal((await loaded(w.log)).actions[0]!.authority.id, authority.authority.id);
    assert.notEqual((await loaded(w.log)).deletionBlock, "wrap-up-in-flight");
  });

  it("recovers an existing editor request without staging a duplicate", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const w = await setup(context);
    const timeline = await assembleStory(w.store, PRODUCTION);
    const clips = orderedTrackClips(timeline.tracks[0]!);
    const oneTurn = turn(w.conversationId, context, {
      editorRequests: [{ summary: "Move the second shot earlier", commands: [{ kind: "move-adjacent", clipId: clips[1]!.id, direction: "earlier" }] }],
    });
    const [prepared] = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    assert.ok(prepared);
    await appendTurn(w.log, oneTurn, [prepared]);

    const editorAdapter = worldChatActionAdapters(w.store, w.gate, NOW)
      .find((adapter) => adapter.actionKind === "world-chat-editor-request")!;
    const authority = await editorAdapter.prepare!({ intent: prepared.intent, payload: prepared.payload });
    assert.equal(w.store.getBundle().productions.find((one) => one.meta.id === PRODUCTION)!.editorRequests.length, 1);

    const result = await w.lifecycle.recoverConversation(w.conversationId);
    assert.equal(result.prepared, 1);
    assert.equal(w.store.getBundle().productions.find((one) => one.meta.id === PRODUCTION)!.editorRequests.length, 1);
    assert.equal((await loaded(w.log)).actions[0]!.authority.id, authority.authority.id);
  });

  it("reconciles a proposal accepted before its card outcome was recorded", async () => {
    const w = await setup();
    const point = candidate(w.conversationId, "The western bell rings under water");
    const oneTurn = turn(w.conversationId, w.entryContext, { candidates: [point] });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    const action = (await loaded(w.log)).actions[0]!;
    const outcome = await acceptDecided(w.gate, action.authority.id);
    assert.ok(outcome.status === "accepted" || outcome.status === "no-op");

    const recovered = await w.lifecycle.recoverConversation(w.conversationId);
    assert.equal(recovered.reconciled, 1);
    assert.equal((await loaded(w.log)).actions[0]!.status, "completed");
    assert.equal((await loaded(w.log)).candidates.find((one) => one.id === point.id)!.status, "accepted");
  });

  it("binds an atomic candidate group to one existing ProposalManager authority", async () => {
    const w = await setup();
    const groupId = newId("grp");
    const first = candidate(w.conversationId, "The west bell rings under water", { groupId });
    const second = candidate(w.conversationId, "The east bell answers through stone", { groupId });
    const group: CandidateGroup = {
      id: groupId,
      conversationId: w.conversationId,
      revision: 1,
      status: "live",
      title: "The answering bells",
      rationale: "Neither rule stands without the other.",
      members: [first, second].map((one) => ({ candidateId: one.id, revision: one.revision })),
      atomic: true,
    };
    const oneTurn = turn(w.conversationId, w.entryContext, { candidates: [first, second], groups: [group] });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);

    assert.equal(prepared.length, 1, "the group is one permission decision");
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    const action = (await loaded(w.log)).actions[0]!;
    const proposal = await w.gate.readManifest(action.authority.id);
    assert.equal(action.authority.kind, "proposal-manager");
    assert.equal(proposal.worldChatOrigins?.length, 2);
    assert.deepEqual(new Set(proposal.worldChatOrigins?.map((origin) => origin.candidateId)), new Set([first.id, second.id]));
    assert.equal(
      (await w.gate.listOpen()).filter((one) => one.id === proposal.id).length,
      1,
      "the card projects the proposal instead of copying it",
    );

    const result = await decide(w.lifecycle, w.log, action);
    assert.equal(result.status, "completed");
    const accepted = (await loaded(w.log)).candidates.filter((one) => [first.id, second.id].includes(one.id));
    assert.ok(accepted.every((one) => one.status === "accepted"));
  });

  it("does not write a Bible edit until approval and refuses it after the base moves", async () => {
    const w = await setup();
    if (!(await readBible(w.store.dir)).present) {
      await applyTurnBibleEdits(w.store, [{ op: "set-section", heading: "Opening", text: "Seed." }], {
        source: "test",
        baseVersion: 1,
      });
    }
    const before = await readBible(w.store.dir);
    const oneTurn = turn(w.conversationId, w.entryContext, {
      bibleBaseVersion: before.version,
      bibleEdits: [{ op: "set-section", heading: "Opening", text: "Only approval writes this." }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    assert.deepEqual(await readBible(w.store.dir), before, "preparation wrote only the card authority");
    const action = (await loaded(w.log)).actions[0]!;
    assert.equal(action.shown.body.family, "authored-diff");
    if (action.shown.body.family === "authored-diff") {
      assert.equal(action.shown.body.fields[0]!.before, "Seed.");
      assert.equal(action.shown.body.fields[0]!.after, "Only approval writes this.");
    }
    await applyTurnBibleEdits(w.store, [{ op: "set-section", heading: "Concurrent", text: "Moved." }], {
      source: "test",
      baseVersion: before.version,
    });

    const result = await decide(w.lifecycle, w.log, action);
    assert.equal(result.reason, "stale");
    assert.equal((await loaded(w.log)).actions[0]!.status, "stale");
    assert.equal((await readBible(w.store.dir)).text.includes("Only approval writes this."), false);
  });

  it("writes a scene rename only after its card is approved", async () => {
    const context = { kind: "scene" as const, productionId: PRODUCTION, sceneId: "sc_02" };
    const w = await setup(context);
    const production = w.store.getBundle().productions.find((one) => one.meta.id === PRODUCTION)!;
    const scene = production.scenes.find((one) => one.id === context.sceneId)!;
    const oneTurn = turn(w.conversationId, context, {
      sceneBaseVersion: sceneVersionFor(w.store, context),
      sceneEdits: [{ kind: "rename", title: "A Carded Scene" }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    assert.equal(
      w.store.getBundle().productions.find((one) => one.meta.id === PRODUCTION)!.scenes.find((one) => one.id === context.sceneId)!.title,
      scene.title,
    );
    const result = await decide(w.lifecycle, w.log, (await loaded(w.log)).actions[0]!);
    assert.equal(result.status, "completed");
    assert.equal(
      w.store.getBundle().productions.find((one) => one.meta.id === PRODUCTION)!.scenes.find((one) => one.id === context.sceneId)!.title,
      "A Carded Scene",
    );
  });

  it("stages one editor authority after the turn and applies it only after approval", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const w = await setup(context);
    const timeline = await assembleStory(w.store, PRODUCTION);
    const clips = orderedTrackClips(timeline.tracks[0]!);
    const oneTurn = turn(w.conversationId, context, {
      editorRequests: [{ summary: "Move the second shot earlier", commands: [{ kind: "move-adjacent", clipId: clips[1]!.id, direction: "earlier" }] }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    assert.equal(w.store.getBundle().productions.find((one) => one.meta.id === PRODUCTION)!.editorRequests.length, 0);

    await bindAll(w.lifecycle, prepared);
    const action = (await loaded(w.log)).actions[0]!;
    const request = await readEditorRequest(w.store, PRODUCTION, action.authority.id);
    assert.equal(request?.actionId, action.actionId);
    assert.equal(request?.status, "pending");
    const preparedTimeline = w.store.getBundle().productions.find((one) => one.meta.id === PRODUCTION)!.timeline;
    assert.equal(
      preparedTimeline?.status === "ready" ? preparedTimeline.timeline.revision : null,
      timeline.revision,
    );

    const result = await decide(w.lifecycle, w.log, action);
    assert.equal(result.status, "completed");
    assert.equal((await readEditorRequest(w.store, PRODUCTION, action.authority.id))?.status, "accepted");
  });
});

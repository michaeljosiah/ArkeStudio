import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  newId,
  ModelWorldChatActionSchema,
  orderedShots,
  orderedTrackClips,
  stageShot,
  ulid,
  type CandidateGroup,
  type CandidateId,
  type ArkeReadRequirement,
  type ConversationActionCard,
  type ConversationId,
  type Job,
  type MessageId,
  type WorldChangeCandidate,
  type WorldChatContext,
  type WorldChatCheckReceipt,
  type WorldChatProductionTakeGenerationAction,
} from "@arke-studio/contracts";
import { ConversationActionLifecycle } from "../../src/arke-actions/lifecycle.js";
import { acceptDecided, ProposalManager } from "../../src/gate/proposals.js";
import { readEditorRequest } from "../../src/productions/editor-requests.js";
import { createEpisode, createProduction } from "../../src/productions/ops.js";
import { applySceneCommand } from "../../src/productions/scene-commands.js";
import { recordTakesFromJob } from "../../src/takes/arrival.js";
import { recordUploadedShotFrameTake } from "../../src/takes/drawn-frame.js";
import { applySceneEdits, sceneVersionFor } from "../../src/productions/scene-edits.js";
import { encodePng, solidImage } from "../../src/references/png.js";
import { readKeyArtBrief } from "../../src/references/key-art-references.js";
import { applyTurnBibleEdits, readBible } from "../../src/world/bible.js";
import { WorldStore } from "../../src/world/store.js";
import {
  prepareWorldChatActions,
  worldChatActionAdapters,
  type WorldChatActionAdapterDeps,
  type WorldChatActionTurn,
} from "../../src/world-chat/actions.js";
import { foldConversation } from "../../src/world-chat/fold.js";
import { stageWorldChatProductionAuthoredAction } from "../../src/world-chat/production-authoring.js";
import { conversationDir, WorldChatStore } from "../../src/world-chat/store.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";
import { assembleStory } from "../productions/assemble.js";
import {
  artDirectionFence,
  artifactsFence,
  bibleFence,
  canonFence,
  chaptersFence,
  episodesFence,
  productionMetadataFence,
  productionsFence,
  referencesFence,
  routingFence,
  sceneFence,
  sceneScriptFence,
  scenesFence,
  seasonFence,
  seriesFence,
  sheetsFence,
  storyFence,
  takesFence,
  timelineFence,
  voicesFence,
  worldMetadataFence,
  exportsFence,
  jobsFence,
  type ArkeExportReadRecord,
} from "../../src/world-chat/target-reads.js";

const AT = "2026-09-04T12:00:00.000Z";
const NOW = () => AT;
const PRODUCTION = "saltlight";

async function setup(
  entryContext: WorldChatContext = { kind: "world" },
  actionDeps: WorldChatActionAdapterDeps = {},
) {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: NOW });
  closeOnCleanup(() => store.close());
  const gate = new ProposalManager(store);
  const conversationId = newId("cv") as ConversationId;
  const log = new WorldChatStore(conversationDir(dir, conversationId));
  await log.create(conversationId, AT);
  await log.append({ type: "conversation.created", title: "Actions", entryContext }, { at: AT });
  const adapters = worldChatActionAdapters(store, gate, NOW, actionDeps);
  const lifecycle = new ConversationActionLifecycle({
    worldPath: dir,
    worldId: store.worldId,
    adapters,
    now: NOW,
  });
  return { store, gate, conversationId, log, lifecycle, adapters, entryContext, actionDeps };
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
    actions: [],
    at: AT,
    ...over,
  };
}

function currentReceipt(
  store: WorldStore,
  requirement: ArkeReadRequirement,
  target?: string,
  exportRecords: readonly ArkeExportReadRecord[] = [],
): WorldChatCheckReceipt {
  const bundle = store.getBundle();
  const fence = requirement === "world-metadata"
    ? worldMetadataFence(bundle)
    : requirement === "canon"
      ? canonFence(bundle)
      : requirement === "sheets"
        ? sheetsFence(bundle)
        : requirement === "art-direction"
          ? artDirectionFence(bundle)
          : requirement === "references"
            ? referencesFence(bundle)
            : requirement === "artifacts"
              ? artifactsFence(bundle)
              : requirement === "voices"
                ? voicesFence(bundle)
              : requirement === "takes"
                ? takesFence(bundle.productions.find((candidate) => candidate.meta.id === target))
                : requirement === "series"
                  ? seriesFence(bundle)
                  : requirement === "story"
                    ? storyFence(bundle.productions.find((candidate) => candidate.meta.id === target))
                    : requirement === "seasons"
                      ? seasonFence(bundle.productions.find((candidate) => candidate.meta.id === target))
                      : requirement === "episodes"
                        ? episodesFence(bundle.productions.find((candidate) => candidate.meta.id === target))
                        : requirement === "chapters"
                          ? chaptersFence(bundle.productions.find((candidate) => candidate.meta.id === target))
                          : requirement === "scenes"
                            ? (() => {
                                const [productionId, sceneId, suffix] = (target ?? "").split(":");
                                const production = bundle.productions.find((candidate) => candidate.meta.id === productionId);
                                return sceneId
                                  ? suffix === "script"
                                    ? sceneScriptFence(production, sceneId)
                                    : sceneFence(production, sceneId)
                                  : scenesFence(production);
                              })()
                            : requirement === "timeline"
                              ? timelineFence(
                                  bundle.productions.find((candidate) => candidate.meta.id === target),
                                  bundle.artifacts,
                                )
                              : requirement === "routing"
                                ? routingFence(bundle.productions.find((candidate) => candidate.meta.id === target))
                                : requirement === "exports"
                                  ? exportsFence(exportRecords, store.worldId, target === store.worldId ? undefined : target)
                                  : requirement === "jobs"
                                    ? jobsFence([], store.worldId, target && target !== store.worldId ? target : undefined)
                : target && target !== store.worldId
                  ? productionMetadataFence(bundle, target)
                  : productionsFence(bundle);
  const targetId = target ?? (requirement === "art-direction" ? "art-direction" : store.worldId);
  return {
    id: newId("check"),
    runId: newId("run"),
    tool: "target-read",
    status: "complete",
    consulted: [],
    target: { requirement, id: targetId },
    observedRevisionOrDigest: fence,
    complete: true,
    nextCursor: null,
    at: AT,
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
  it("reserves default episode order after accepted and pending creations", async () => {
    const w = await setup();
    const productionId = await createProduction(w.store, { title: "Ordered season", medium: "video", productionKind: "microdrama", seriesTitle: "Ordered series" });
    const first = await createEpisode(w.store, { productionId, title: "First" });
    assert.ok(first.episodeId);
    const proposals = [];
    for (const [title, order] of [["Second", 5], ["Third", undefined], ["Fourth", undefined]] as const) {
      proposals.push(await stageWorldChatProductionAuthoredAction(w.store, w.gate, {
        actionId: newId("act"), conversationId: w.conversationId,
      }, {
        kind: "world-chat-production-episode",
        worldId: w.store.worldId,
        action: { kind: "production-episode", productionId, change: { operation: "create", title, scenes: [], ...(order === undefined ? {} : { order }) }, checkReceiptIds: [] },
      }));
    }
    for (const proposal of proposals.reverse()) assert.equal((await w.gate.accept(proposal.id)).status, "accepted");
    const episodes = w.store.getBundle().productions.find((production) => production.meta.id === productionId)!.episodes;
    assert.deepEqual(episodes.map((episode) => episode.order).sort((a, b) => a - b), [1, 5, 6, 7]);
  });

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
      observedRevisionOrDigest: timelineFence(production, w.store.getBundle().artifacts),
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
    await assert.rejects(readFile(join(w.store.dir, ".history/bible/prepared", `${action.actionId}.json`)), { code: "ENOENT" });
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

  it("updates authored world metadata only after its card is approved", async () => {
    const w = await setup();
    const metadata = currentReceipt(w.store, "world-metadata");
    const artDirection = currentReceipt(w.store, "art-direction");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [metadata, artDirection],
      actions: [{
        kind: "world-metadata",
        changes: { logline: "The drowned city answers at slack water.", tone: null },
        checkReceiptIds: [metadata.id, artDirection.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    assert.notEqual(w.store.getBundle().meta.logline, "The drowned city answers at slack water.");
    const action = (await loaded(w.log)).actions[0]!;
    assert.equal(action.shown.body.family, "authored-diff");
    if (action.shown.body.family === "authored-diff") {
      assert.deepEqual(action.shown.body.fields.map((field) => field.label), ["Logline", "Tone"]);
    }

    const result = await decide(w.lifecycle, w.log, action);
    assert.equal(result.status, "completed");
    assert.equal(w.store.getBundle().meta.logline, "The drowned city answers at slack water.");
    assert.equal(w.store.getBundle().meta.tone, undefined);
  });

  it("does not prepare or commit an unchanged metadata action", async () => {
    const w = await setup();
    const metadata = currentReceipt(w.store, "world-metadata");
    const artDirection = currentReceipt(w.store, "art-direction");
    const before = w.store.getBundle().meta;
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [metadata, artDirection],
      actions: [{
        kind: "world-metadata",
        changes: { name: before.name },
        checkReceiptIds: [metadata.id, artDirection.id],
      }],
    });
    const [prepared] = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, [prepared!]);

    await assert.rejects(() => w.lifecycle.bindIntent(prepared!.intent, prepared!.payload));
    assert.deepEqual(w.store.getBundle().meta, before);
    assert.equal((await loaded(w.log)).actions.length, 0);
  });

  it("requires the art-direction read used to derive metadata consequences", async () => {
    const w = await setup();
    const metadata = currentReceipt(w.store, "world-metadata");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [metadata],
      actions: [{
        kind: "world-metadata",
        changes: { tone: "storm-lit" },
        checkReceiptIds: [metadata.id],
      }],
    });

    assert.throws(
      () => prepareWorldChatActions(w.store, w.lifecycle, oneTurn),
      /requires a complete current art-direction read/,
    );
  });

  it("fences a direct metadata commit inside the store queue", async () => {
    const w = await setup();
    const metadata = currentReceipt(w.store, "world-metadata");
    const artDirection = currentReceipt(w.store, "art-direction");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [metadata, artDirection],
      actions: [{
        kind: "world-metadata",
        changes: { tone: "storm-lit" },
        checkReceiptIds: [metadata.id, artDirection.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    const action = (await loaded(w.log)).actions[0]!;

    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = w.store.ownedWrite(async () => {
      entered();
      await held;
    });
    await started;
    const concurrent = w.store.updateWorldMetadata({ genre: "changed in front of the approval" }, "test");
    const adapter = worldChatActionAdapters(w.store, w.gate, NOW)
      .find((candidate) => candidate.actionKind === "world-chat-world-metadata")!;
    const executing = adapter.execute(action);
    release();
    await blocker;
    await concurrent;
    const result = await executing;

    assert.equal(result.status, "stale");
    assert.notEqual(w.store.getBundle().meta.tone, "storm-lit");
  });

  it("stages and accepts a Canon amendment through ProposalManager", async () => {
    const w = await setup();
    const canon = currentReceipt(w.store, "canon");
    const sheets = currentReceipt(w.store, "sheets");
    const before = w.store.getBundle().canon.find((entry) => entry.id === "CANON-001")!.body;
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [canon, sheets],
      actions: [{
        kind: "canon",
        change: { operation: "amend", entryId: "CANON-001", changes: { statement: "The bells answer only at slack water." } },
        checkReceiptIds: [canon.id, sheets.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    assert.equal(w.store.getBundle().canon.find((entry) => entry.id === "CANON-001")!.body, before);
    const action = (await loaded(w.log)).actions[0]!;
    assert.equal(action.authority.kind, "proposal-manager");
    const proposal = await w.gate.readManifest(action.authority.id);
    assert.deepEqual(proposal.decision, {
      mode: "attended",
      owner: { kind: "world-chat", conversationId: w.conversationId },
    });
    const result = await decide(w.lifecycle, w.log, action);
    assert.equal(result.status, "completed");
    assert.equal(
      w.store.getBundle().canon.find((entry) => entry.id === "CANON-001")!.body,
      "The bells answer only at slack water.",
    );
  });

  it("does not duplicate a retired sheet into another retired record", async () => {
    const w = await setup();
    await w.store.retire("locations/the-vigil.md", "test");
    const sheets = currentReceipt(w.store, "sheets");
    const canon = currentReceipt(w.store, "canon");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [sheets, canon],
      actions: [{
        kind: "sheet",
        change: { operation: "duplicate", sheetType: "location", sheetId: "the-vigil", newName: "The Vigil Copy" },
        checkReceiptIds: [sheets.id, canon.id],
      }],
    });
    const [prepared] = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, [prepared!]);

    await assert.rejects(() => w.lifecycle.bindIntent(prepared!.intent, prepared!.payload));
    assert.equal(
      (await w.gate.listOpen()).some((proposal) => proposal.source === `world-chat-action:${prepared!.intent.actionId}`),
      false,
    );
    assert.equal(w.store.getBundle().sheets.some((sheet) => sheet.id === "the-vigil-copy"), false);
  });

  it("fences all Canon inputs inside proposal acceptance", async (t) => {
    const w = await setup();
    const canon = currentReceipt(w.store, "canon");
    const sheets = currentReceipt(w.store, "sheets");
    const before = w.store.getBundle().canon.find((entry) => entry.id === "CANON-001")!.body;
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [canon, sheets],
      actions: [{
        kind: "canon",
        change: { operation: "amend", entryId: "CANON-001", changes: { statement: "This must not land." } },
        checkReceiptIds: [canon.id, sheets.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    const action = (await loaded(w.log)).actions[0]!;

    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocker = w.store.ownedWrite(async () => {
      entered();
      await held;
    });
    await started;
    // retire reads the file before joining the write queue. Wait for admission so disk speed
    // cannot reverse the intended ordering between that edit and proposal acceptance.
    let queued!: () => void;
    const retirementQueued = new Promise<void>((resolve) => { queued = resolve; });
    const commit = w.store.commit.bind(w.store);
    t.mock.method(w.store, "commit", (...args: Parameters<typeof commit>) => {
      const result = commit(...args);
      if (args[0].kind === "retire") queued();
      return result;
    });
    const concurrent = w.store.retire("locations/the-vigil.md", "test");
    await retirementQueued;
    const adapter = worldChatActionAdapters(w.store, w.gate, NOW)
      .find((candidate) => candidate.actionKind === "world-chat-canon")!;
    const executing = adapter.execute(action);
    release();
    await blocker;
    await concurrent;
    const result = await executing;

    assert.equal(result.status, "stale");
    assert.equal(w.store.getBundle().canon.find((entry) => entry.id === "CANON-001")!.body, before);
    assert.equal(
      (await w.gate.listOpen()).some((proposal) => proposal.id === action.authority.id),
      false,
      "a stale card cannot leave a separately approvable proposal behind",
    );
  });

  it("refuses rather than auto-confirming proposal consequences that changed after review", async () => {
    const w = await setup();
    const art = currentReceipt(w.store, "art-direction");
    const before = w.store.getBundle().artDirection.description;
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [art],
      actions: [{
        kind: "art-direction",
        changes: { description: "Painterly salt-air naturalism." },
        checkReceiptIds: [art.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    const action = (await loaded(w.log)).actions[0]!;
    await writeFile(
      join(w.store.dir, ".proposals", action.authority.id, "ripple.json"),
      `${JSON.stringify({ computedAt: AT, governing: false, items: [] }, null, 2)}\n`,
    );

    const result = await decide(w.lifecycle, w.log, action);

    assert.equal(result.status, "stale");
    assert.equal(w.store.getBundle().artDirection.description, before);
    assert.equal((await w.gate.listOpen()).some((proposal) => proposal.id === action.authority.id), false);
  });

  it("names retirement consequences and retires without deleting history", async () => {
    const w = await setup();
    const sheets = currentReceipt(w.store, "sheets");
    const canon = currentReceipt(w.store, "canon");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [sheets, canon],
      actions: [{
        kind: "sheet-retire",
        sheetType: "location",
        sheetId: "the-vigil",
        checkReceiptIds: [sheets.id, canon.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    const action = (await loaded(w.log)).actions[0]!;
    assert.equal(action.shown.body.family, "destructive");
    if (action.shown.body.family === "destructive") {
      assert.equal(action.shown.body.undoAvailable, true);
      assert.ok(action.shown.body.retained.some((item) => /history/i.test(item)));
      assert.ok(action.shown.body.dependentChanges.length > 0);
    }
    assert.notEqual(w.store.getBundle().sheets.find((sheet) => sheet.id === "the-vigil")!.retired, true);
    const result = await decide(w.lifecycle, w.log, action);
    assert.equal(result.status, "completed");
    assert.equal(w.store.getBundle().sheets.find((sheet) => sheet.id === "the-vigil")!.retired, true);
    const completed = (await loaded(w.log)).actions[0]!;
    assert.deepEqual(
      completed.undo && { kind: completed.undo.kind, id: completed.undo.id },
      { kind: "sheet-version", id: `location:the-vigil:v${action.authorityRevision}` },
    );
  });

  it("lands a key-art-only change and restores embedded art-direction history", async () => {
    const w = await setup();
    await mkdir(join(w.store.dir, "build"), { recursive: true });
    await writeFile(
      join(w.store.dir, "build", "build.json"),
      `${JSON.stringify({ blueprint: { keyArt: { subject: "Legacy founding brief", characters: [] } } }, null, 2)}\n`,
    );
    assert.equal((await readKeyArtBrief(w.store.dir))?.subject, "Legacy founding brief");

    const art = currentReceipt(w.store, "art-direction");
    const intentTurn = turn(w.conversationId, w.entryContext, {
      receipts: [art],
      actions: [{
        kind: "art-direction",
        changes: { keyArtIntent: { subject: "Maren beneath the bells", characters: ["Maren Kest"] } },
        checkReceiptIds: [art.id],
      }],
    });
    const preparedIntent = prepareWorldChatActions(w.store, w.lifecycle, intentTurn);
    await appendTurn(w.log, intentTurn, preparedIntent);
    await bindAll(w.lifecycle, preparedIntent);
    const intentResult = await decide(w.lifecycle, w.log, (await loaded(w.log)).actions[0]!);
    assert.equal(intentResult.status, "completed");
    assert.equal(w.store.getBundle().artDirection.keyArtIntent?.subject, "Maren beneath the bells");
    assert.equal((await readKeyArtBrief(w.store.dir))?.subject, "Maren beneath the bells");

    const clearArt = currentReceipt(w.store, "art-direction");
    const clearTurn = turn(w.conversationId, w.entryContext, {
      receipts: [clearArt],
      actions: [{ kind: "art-direction", changes: { keyArtIntent: null }, checkReceiptIds: [clearArt.id] }],
    });
    const preparedClear = prepareWorldChatActions(w.store, w.lifecycle, clearTurn);
    await appendTurn(w.log, clearTurn, preparedClear);
    await bindAll(w.lifecycle, preparedClear);
    const clearResult = await decide(w.lifecycle, w.log, (await loaded(w.log)).actions.at(-1)!);
    assert.equal(clearResult.status, "completed");
    assert.equal(w.store.getBundle().artDirection.keyArtIntent, null);
    assert.equal(await readKeyArtBrief(w.store.dir), null, "an explicit clear must not revive the founding brief");

    const restoredArt = currentReceipt(w.store, "art-direction");
    const restoreTurn = turn(w.conversationId, w.entryContext, {
      receipts: [restoredArt],
      actions: [{ kind: "art-direction-restore", version: 2, checkReceiptIds: [restoredArt.id] }],
    });
    const preparedRestore = prepareWorldChatActions(w.store, w.lifecycle, restoreTurn);
    await appendTurn(w.log, restoreTurn, preparedRestore);
    await bindAll(w.lifecycle, preparedRestore);
    const restoreAction = (await loaded(w.log)).actions.at(-1)!;
    assert.equal(restoreAction.shown.body.family, "authored-diff");
    const restoreResult = await decide(w.lifecycle, w.log, restoreAction);
    assert.equal(restoreResult.status, "completed");
    assert.equal(w.store.getBundle().artDirection.description, "Cold-water realism");
    assert.ok(w.store.getBundle().artDirection.version > 5);
  });

  it("keeps a host-picked artifact path out of the card, receipt, and conversation log", async () => {
    let selected = "";
    let pickerCalls = 0;
    const w = await setup({ kind: "world" }, {
      pickFiles: async () => {
        pickerCalls += 1;
        return [selected];
      },
    });
    await mkdir(join(w.store.dir, ".staging"), { recursive: true });
    selected = join(w.store.dir, ".staging", "private-host-artifact.txt");
    await writeFile(selected, "The bells answer at slack water.");
    const artifacts = currentReceipt(w.store, "artifacts");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [artifacts],
      actions: [{
        kind: "artifact-import",
        source: "files",
        links: ["CANON-001"],
        checkReceiptIds: [artifacts.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    const action = (await loaded(w.log)).actions[0]!;
    assert.equal(pickerCalls, 0, "preparation must not open a host picker");
    assert.equal(action.shown.body.family, "host-action");
    assert.equal(JSON.stringify(action).includes("private-host-artifact.txt"), false);
    const result = await decide(w.lifecycle, w.log, action);
    assert.equal(result.status, "completed");
    assert.equal(pickerCalls, 1);
    assert.ok(w.store.getBundle().artifacts.some((artifact) => artifact.links.includes("CANON-001")));
    assert.equal(
      (await readFile(join(w.store.dir, ".conversations", w.conversationId, "events.jsonl"), "utf8"))
        .includes("private-host-artifact.txt"),
      false,
    );
  });

  it("completes a cancelled native chooser without changing its target", async () => {
    let pickerCalls = 0;
    const w = await setup({ kind: "world" }, {
      pickFiles: async () => {
        pickerCalls += 1;
        return [];
      },
    });
    const before = w.store.getBundle().artifacts.length;
    const artifacts = currentReceipt(w.store, "artifacts");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [artifacts],
      actions: [{ kind: "artifact-import", source: "files", links: [], checkReceiptIds: [artifacts.id] }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    const action = (await loaded(w.log)).actions.at(-1)!;
    assert.equal(pickerCalls, 0);
    assert.equal((await decide(w.lifecycle, w.log, action)).status, "cancelled");
    assert.equal(pickerCalls, 1);
    assert.equal(w.store.getBundle().artifacts.length, before);
  });

  it("defers pending reference image import to a path-free host action", async () => {
    let imports = 0;
    const w = await setup({ kind: "world" }, {
      importReferenceImage: async (target) => {
        imports += 1;
        assert.deepEqual(target, { surface: "staged-reference", key: "main-photo--maren-kest" });
        return { status: "completed", id: "staged-reference:main-photo--maren-kest" };
      },
    });
    const references = currentReceipt(w.store, "references");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [references],
      actions: [{
        kind: "reference-image-import",
        target: { surface: "staged-reference", key: "main-photo--maren-kest" },
        checkReceiptIds: [references.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    const action = (await loaded(w.log)).actions[0]!;
    assert.equal(action.shown.body.family, "host-action");
    assert.equal(imports, 0);
    assert.equal(JSON.stringify(action).includes("sourcePath"), false);
    assert.equal((await decide(w.lifecycle, w.log, action)).status, "completed");
    assert.equal(imports, 1);
  });

  it("selects pending key art through a separate typed result-use action", async () => {
    let selected = 0;
    const w = await setup({ kind: "world" }, {
      useWorldImage: async (candidateIndex) => {
        selected = candidateIndex;
        return true;
      },
    });
    await w.store.gateOp(async () => {
      const dir = join(w.store.dir, "incoming", "world-image");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "candidate.png"), "candidate");
    });
    const references = currentReceipt(w.store, "references");
    const metadata = currentReceipt(w.store, "world-metadata");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [references, metadata],
      actions: [{
        kind: "reference-world-image-result-use",
        candidateIndex: 1,
        checkReceiptIds: [references.id, metadata.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    const action = (await loaded(w.log)).actions[0]!;
    assert.equal(action.shown.body.family, "take-review");
    assert.equal(selected, 0);
    assert.equal((await decide(w.lifecycle, w.log, action)).status, "completed");
    assert.equal(selected, 1);
  });

  it("uses the master-look authority and separately discards a staged reference", async () => {
    let selected = 0;
    let discarded = "";
    const w = await setup({ kind: "world" }, {
      useMasterLook: async (candidateIndex) => {
        selected = candidateIndex;
        return true;
      },
      discardReferenceImage: async (target) => {
        discarded = target.surface === "staged-reference" ? target.key : target.surface;
        return true;
      },
    });
    await w.store.gateOp(async () => {
      const master = join(w.store.dir, "incoming", "master-look");
      const staged = join(w.store.dir, "incoming", "staged-refs", "master-look");
      await mkdir(master, { recursive: true });
      await mkdir(staged, { recursive: true });
      await writeFile(join(master, "candidate.png"), "candidate");
      await writeFile(join(staged, "reference.png"), "reference");
    });
    const references = currentReceipt(w.store, "references");
    const art = currentReceipt(w.store, "art-direction");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [references, art],
      actions: [
        {
          kind: "reference-master-look-result-use",
          candidateIndex: 1,
          checkReceiptIds: [references.id, art.id],
        },
        {
          kind: "reference-image-discard",
          target: { surface: "staged-reference", key: "master-look" },
          checkReceiptIds: [references.id],
        },
      ],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    const actions = (await loaded(w.log)).actions;
    assert.equal(actions[0]!.authority.kind, "proposal-manager");
    assert.equal(actions[0]!.shown.body.family, "take-review");
    assert.equal(actions[1]!.shown.body.family, "destructive");
    assert.equal((await decide(w.lifecycle, w.log, actions[0]!)).status, "completed");
    assert.equal((await decide(w.lifecycle, w.log, actions[1]!)).status, "completed");
    assert.equal(selected, 1);
    assert.equal(discarded, "master-look");
  });

  it("cards voice cloning as a separate consented host gesture without reading a recording", async () => {
    let pickerCalls = 0;
    const w = await setup({ kind: "world" }, {
      pickFiles: async () => {
        pickerCalls += 1;
        return ["C:\\private\\speaker-recording.wav"];
      },
    });
    const sheets = currentReceipt(w.store, "sheets");
    const voices = currentReceipt(w.store, "voices");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [sheets, voices],
      actions: [{
        kind: "voice-clone",
        name: "Consented Speaker",
        description: "Low and measured",
        recordingGesture: "required",
        checkReceiptIds: [sheets.id, voices.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    const action = (await loaded(w.log)).actions[0]!;
    assert.equal(action.shown.body.family, "host-action");
    assert.match(action.shown.consequence, /biometric-like identity data/i);
    assert.match(action.shown.consequence, /informed consent/i);
    assert.equal(JSON.stringify(action).includes("speaker-recording.wav"), false);
    assert.equal(pickerCalls, 0);
  });

  it("shows generation intent but blocks approval until the coordinator owns a durable quote", async () => {
    const w = await setup();
    const sheets = currentReceipt(w.store, "sheets");
    const art = currentReceipt(w.store, "art-direction");
    const references = currentReceipt(w.store, "references");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [sheets, art, references],
      actions: [{
        kind: "reference-generation",
        request: {
          operation: "main-photo",
          sheetId: "maren-kest",
          prompt: "Salt-lit portrait",
          count: 2,
          identityReferenceIds: [],
        },
        checkReceiptIds: [sheets.id, art.id, references.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    const action = (await loaded(w.log)).actions[0]!;
    assert.equal(action.shown.body.family, "generation");
    assert.match(action.approvalBlockedReason ?? "", /quote/i);
    const result = await decide(w.lifecycle, w.log, action);
    assert.equal(result.disposition, "refused");
    assert.equal(result.reason, "adapter-unavailable");
    assert.equal((await loaded(w.log)).actions[0]!.status, "pending");
  });

  it("creates exactly the precomputed production plan only after approval", async () => {
    const w = await setup();
    const productions = currentReceipt(w.store, "production-metadata");
    const series = currentReceipt(w.store, "series");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [productions, series],
      actions: [{
        kind: "production-create",
        production: {
          title: "Bell Watch Season One",
          medium: "video",
          productionKind: "microdrama",
          seriesTitle: "Bell Watch",
          frameRate: 25,
          defaults: { episodeCount: 8 },
        },
        checkReceiptIds: [productions.id, series.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    assert.equal(prepared[0]!.payload.kind, "world-chat-production-create");
    const payload = prepared[0]!.payload;
    if (payload.kind !== "world-chat-production-create") assert.fail("expected a production creation");
    assert.equal(payload.plan.production.id, "bell-watch-season-one");
    assert.equal(payload.plan.initialSeason?.defaults?.episodeCount, 8);
    assert.equal(payload.plan.series.operation, "create");
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    assert.equal(w.store.getBundle().productions.some((production) => production.meta.id === payload.plan.production.id), false);
    const card = (await loaded(w.log)).actions[0]!;
    assert.equal(card.shown.body.family, "command");
    assert.match(JSON.stringify(card.shown), /bell-watch-season-one/);

    const result = await decide(w.lifecycle, w.log, card);
    assert.equal(result.status, "completed");
    const production = w.store.getBundle().productions.find((candidate) => candidate.meta.id === payload.plan.production.id)!;
    assert.equal(production.meta.frameRate, 25);
    assert.equal(production.season?.defaults?.episodeCount, 8);
    assert.deepEqual(w.store.getBundle().series.find((candidate) => candidate.id === "bell-watch")?.seasons, [production.meta.id]);
  });

  it("refuses a prepared production creation after its world fences move instead of replanning", async () => {
    const w = await setup();
    const productions = currentReceipt(w.store, "production-metadata");
    const series = currentReceipt(w.store, "series");
    const oneTurn = turn(w.conversationId, w.entryContext, {
      receipts: [productions, series],
      actions: [{
        kind: "production-create",
        production: { title: "Fixed Identity", medium: "video" },
        checkReceiptIds: [productions.id, series.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    const payload = prepared[0]!.payload;
    if (payload.kind !== "world-chat-production-create") assert.fail("expected a production creation");
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    const card = (await loaded(w.log)).actions[0]!;

    await createProduction(w.store, { title: "Concurrent Production", medium: "video" });
    const result = await decide(w.lifecycle, w.log, card);
    assert.equal(result.reason, "stale");
    assert.equal(w.store.getBundle().productions.some((production) => production.meta.id === payload.plan.production.id), false);
  });

  it("stages production overview authorship through ProposalManager", async () => {
    const w = await setup();
    const episode = await createEpisode(w.store, { productionId: PRODUCTION, title: "Bell Watch" });
    const context = { kind: "episode" as const, productionId: PRODUCTION, episodeId: episode.episodeId };
    const story = currentReceipt(w.store, "story", PRODUCTION);
    const before = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!.story?.logline;
    const openBefore = (await w.gate.listOpen()).length;
    const oneTurn = turn(w.conversationId, context, {
      receipts: [story],
      actions: [{
        kind: "production-overview",
        productionId: PRODUCTION,
        changes: { logline: "The drowned bell rings one night early." },
        checkReceiptIds: [story.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    assert.equal(w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!.story?.logline, before);
    const card = (await loaded(w.log)).actions[0]!;
    assert.equal(card.authority.kind, "proposal-manager");
    assert.equal((await w.gate.listOpen()).length, openBefore + 1);
    assert.equal((await decide(w.lifecycle, w.log, card)).status, "completed");
    assert.equal(
      w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!.story?.logline,
      "The drowned bell rings one night early.",
    );
  });

  it("requires the exact complete scene script and refuses reminted unchanged block ids", async () => {
    const w = await setup();
    const production = w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    const scene = production.scenes[0]!;
    const sceneFile = production.sceneFiles[scene.id]!;
    const path = join(w.store.dir, "productions", PRODUCTION, "scenes", `${sceneFile}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.script = { blocks: [{ id: "blk_opening", kind: "action", text: "Maren opens the ledger." }] };
    await w.store.ownedWrite(() => writeFile(path, `${JSON.stringify(record, null, 2)}\n`));
    const current = w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!
      .scenes.find((candidate) => candidate.id === scene.id)!;
    const context = { kind: "scene" as const, productionId: PRODUCTION, sceneId: current.id };
    const wrong = currentReceipt(w.store, "scenes", PRODUCTION);
    const reminted = current.script!.blocks.map((block, index) =>
      index === 0 ? { ...block, id: "blk_reminted" } : block);
    const action = {
      kind: "production-scene" as const,
      productionId: PRODUCTION,
      change: { operation: "replace-script" as const, sceneId: current.id, blocks: reminted },
      checkReceiptIds: [wrong.id],
    };
    assert.throws(
      () => prepareWorldChatActions(w.store, w.lifecycle, turn(w.conversationId, context, {
        receipts: [wrong],
        actions: [action],
      })),
      /complete current scenes read.*script/i,
    );

    const script = currentReceipt(w.store, "scenes", `${PRODUCTION}:${current.id}:script`);
    const oneTurn = turn(w.conversationId, context, {
      receipts: [script],
      actions: [{ ...action, checkReceiptIds: [script.id] }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await assert.rejects(bindAll(w.lifecycle, prepared), /could not prepare/i);
    assert.deepEqual(
      w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!
        .scenes.find((candidate) => candidate.id === current.id)!.script!.blocks,
      current.script!.blocks,
    );
  });

  it("refuses a production frame-rate card after a timeline exists", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const w = await setup(context);
    await assembleStory(w.store, PRODUCTION);
    const metadata = currentReceipt(w.store, "production-metadata", PRODUCTION);
    const series = currentReceipt(w.store, "series");
    const timeline = currentReceipt(w.store, "timeline", PRODUCTION);
    const oneTurn = turn(w.conversationId, context, {
      receipts: [metadata, series, timeline],
      actions: [{
        kind: "production-metadata",
        productionId: PRODUCTION,
        changes: { frameRate: 25 },
        checkReceiptIds: [metadata.id, series.id, timeline.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await assert.rejects(bindAll(w.lifecycle, prepared), /could not prepare/i);
    assert.equal(
      w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!.meta.frameRate,
      undefined,
    );
  });

  it("updates production metadata atomically after approval", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const w = await setup(context);
    const metadata = currentReceipt(w.store, "production-metadata", PRODUCTION);
    const series = currentReceipt(w.store, "series");
    const timeline = currentReceipt(w.store, "timeline", PRODUCTION);
    const oneTurn = turn(w.conversationId, context, {
      receipts: [metadata, series, timeline],
      actions: [{
        kind: "production-metadata",
        productionId: PRODUCTION,
        changes: { title: "Saltlight: Bell Watch", aspect: "2:1", frameRate: 25 },
        checkReceiptIds: [metadata.id, series.id, timeline.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    assert.notEqual(
      w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!.meta.title,
      "Saltlight: Bell Watch",
    );

    const card = (await loaded(w.log)).actions[0]!;
    assert.equal(card.shown.body.family, "authored-diff");
    assert.equal((await decide(w.lifecycle, w.log, card)).status, "completed");
    const production = w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    assert.equal(production.meta.title, "Saltlight: Bell Watch");
    assert.equal(production.meta.aspect, "2:1");
    assert.equal(production.meta.frameRate, 25);
  });

  it("restores a scene snapshot through the existing version authority", async () => {
    const w = await setup();
    const production = w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    const scene = production.scenes[0]!;
    const originalTitle = scene.title;
    await applySceneEdits(w.store, {
      entryContext: { kind: "scene", productionId: PRODUCTION, sceneId: scene.id },
      edits: [{ kind: "rename", title: "Changed before restore" }],
      baseVersion: scene.version,
    });
    const context = { kind: "scene" as const, productionId: PRODUCTION, sceneId: scene.id };
    const current = currentReceipt(w.store, "scenes", `${PRODUCTION}:${scene.id}`);
    const oneTurn = turn(w.conversationId, context, {
      receipts: [current],
      actions: [{
        kind: "production-scene-restore",
        productionId: PRODUCTION,
        sceneId: scene.id,
        version: scene.version,
        checkReceiptIds: [current.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    const card = (await loaded(w.log)).actions[0]!;
    assert.match(card.shown.title, /restore/i);
    assert.equal((await decide(w.lifecycle, w.log, card)).status, "completed");
    const restored = w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!
      .scenes.find((candidate) => candidate.id === scene.id)!;
    assert.equal(restored.title, originalTitle);
    assert.equal(restored.version, scene.version + 2);
  });

  it("scopes production style to Production Chat and writes it only after approval", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const w = await setup(context);
    const production = currentReceipt(w.store, "production-metadata", PRODUCTION);
    const art = currentReceipt(w.store, "art-direction");
    const oneTurn = turn(w.conversationId, context, {
      receipts: [production, art],
      actions: [{
        kind: "production-style",
        productionId: PRODUCTION,
        style: "Bleached salt print",
        checkReceiptIds: [production.id, art.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    assert.notEqual(
      w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!.meta.styleOverride,
      "Bleached salt print",
    );

    const result = await decide(w.lifecycle, w.log, (await loaded(w.log)).actions[0]!);
    assert.equal(result.status, "completed");
    assert.equal(
      w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!.meta.styleOverride,
      "Bleached salt print",
    );

    assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, turn(w.conversationId, context, {
      receipts: [currentReceipt(w.store, "production-metadata", PRODUCTION), currentReceipt(w.store, "art-direction")],
      actions: [{
        kind: "production-style",
        productionId: "another-production",
        style: "Wrong scope",
        checkReceiptIds: [],
      }],
    })), /another production's style/i);
  });

  it("keeps another production's guest out of Production Chat resource actions", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const w = await setup(context);
    const path = join(w.store.dir, "characters", "maren-kest.md");
    const raw = await readFile(path, "utf8");
    await w.store.ownedWrite(() => writeFile(path, raw.replace("type: character\n", "type: character\nproduction: another-production\n")));
    const sheets = currentReceipt(w.store, "sheets");
    const voices = currentReceipt(w.store, "voices");
    assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, turn(w.conversationId, context, {
      receipts: [sheets, voices],
      actions: [{
        kind: "voice-assignment",
        sheetType: "character",
        sheetId: "maren-kest",
        voice: null,
        checkReceiptIds: [sheets.id, voices.id],
      }],
    })), /another production's cast or references/i);
  });

  it("reviews an immutable voice clip through the production take authority", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const w = await setup(context);
    const takeId = "tk_01J8F0000000000000000000V1";
    const landed = `productions/${PRODUCTION}/incoming/voice-review/voice.wav`;
    await mkdir(join(w.store.dir, "productions", PRODUCTION, "incoming", "voice-review"), { recursive: true });
    await writeFile(join(w.store.dir, landed), "voice-bytes");
    const job: Job = {
      id: "jb_01J8F0000000000000000000V1",
      idempotencyKey: "01J8F1000000000000000000V1",
      worldId: w.store.worldId,
      productionId: PRODUCTION,
      target: { kind: "voice-line", id: "sh_12", coversShots: ["sh_12"] },
      capability: "voice-tts",
      provider: "local",
      model: "studio-voice",
      params: { text: "The bells answer.", voiceId: "vale" },
      estimatedMicroUsd: 0,
      status: "succeeded",
      providerJobId: null,
      attempt: 1,
      landing: { dir: `productions/${PRODUCTION}/incoming/voice-review` },
      landedFiles: [landed],
      error: null,
      createdAt: AT,
      updatedAt: AT,
    };
    assert.equal((await recordTakesFromJob(w.store, job, 0))[0]?.id, takeId);

    const takes = currentReceipt(w.store, "takes", PRODUCTION);
    const sheets = currentReceipt(w.store, "sheets");
    const oneTurn = turn(w.conversationId, context, {
      receipts: [takes, sheets],
      actions: [{
        kind: "voice-clip-review",
        productionId: PRODUCTION,
        takeId,
        review: { decision: "accept", shotId: "sh_12" },
        checkReceiptIds: [takes.id, sheets.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    const action = (await loaded(w.log)).actions[0]!;
    assert.equal(action.shown.body.family, "take-review");
    assert.equal(
      w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!.reviews.some((review) => review.takeId === takeId),
      false,
    );
    const result = await decide(w.lifecycle, w.log, action);
    assert.equal(result.status, "completed");
    const production = w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    assert.equal(production.reviews.find((review) => review.takeId === takeId)?.decision, "accept");
    assert.equal(production.selections["sh_12"]?.acceptedTakeId, takeId);
  });

  it("applies one semantic scene command only after approval", async () => {
    const context = { kind: "scene" as const, productionId: PRODUCTION, sceneId: "sc_04" };
    const w = await setup(context);
    const before = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!
      .scenes.find((scene) => scene.id === context.sceneId)!;
    const receipt = currentReceipt(w.store, "scenes", `${PRODUCTION}:${context.sceneId}`);
    const description = "Maren hears the submerged bell answer from below.";
    const oneTurn = turn(w.conversationId, context, {
      receipts: [receipt],
      actions: [{
        kind: "production-scene-command",
        productionId: PRODUCTION,
        sceneId: context.sceneId,
        command: { kind: "edit-shot", shotId: "sh_12", change: { description } },
        checkReceiptIds: [receipt.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    assert.notEqual(orderedShots(before)[0]!.description, description);
    const card = (await loaded(w.log)).actions[0]!;
    assert.equal(card.shown.body.family, "command");
    assert.equal((await decide(w.lifecycle, w.log, card)).status, "completed");
    const after = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!
      .scenes.find((scene) => scene.id === context.sceneId)!;
    assert.equal(orderedShots(after)[0]!.description, description);
    assert.equal(after.version, before.version + 1);
  });

  for (const status of ["authorized", "active"] as const) {
    it(`refuses a chat-driven shot deletion while its scene has an ${status} plan`, async () => {
      const context = { kind: "scene" as const, productionId: PRODUCTION, sceneId: "sc_04" };
      let active = false;
      let probed = false;
      const w = await setup(context, { activePlans: async (productionId) => {
        assert.equal(productionId, PRODUCTION);
        probed = true;
        return active ? [{ planId: "plan-live", sceneId: context.sceneId, status }] : [];
      } });
      const before = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!
        .scenes.find((scene) => scene.id === context.sceneId)!;
      const receipt = currentReceipt(w.store, "scenes", `${PRODUCTION}:${context.sceneId}`);
      const oneTurn = turn(w.conversationId, context, {
        receipts: [receipt],
        actions: [{ kind: "production-scene-command", productionId: PRODUCTION, sceneId: context.sceneId,
          command: { kind: "delete-shot", shotId: "sh_13" }, checkReceiptIds: [receipt.id] }],
      });
      const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn, w.actionDeps);
      await appendTurn(w.log, oneTurn, prepared);
      await bindAll(w.lifecycle, prepared);
      active = true;
      const card = (await loaded(w.log)).actions[0]!;
      assert.equal((await decide(w.lifecycle, w.log, card)).status, "failed");
      assert.ok(probed, "the command probes live plans after approval");
      const after = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!
        .scenes.find((scene) => scene.id === context.sceneId)!;
      assert.deepEqual(after, before);
    });
  }

  it("compiles and exports boards through separate approved authorities", async () => {
    const context = { kind: "scene" as const, productionId: PRODUCTION, sceneId: "sc_04" };
    const w = await setup(context);
    const prepareBoard = (kind: "production-board-compile" | "production-board-export") => {
      const receipts = [
        currentReceipt(w.store, "scenes", `${PRODUCTION}:${context.sceneId}`),
        currentReceipt(w.store, "takes", PRODUCTION),
        currentReceipt(w.store, "artifacts"),
      ];
      const oneTurn = turn(w.conversationId, context, {
        receipts,
        actions: [{
          kind,
          productionId: PRODUCTION,
          sceneId: context.sceneId,
          checkReceiptIds: receipts.map((receipt) => receipt.id),
        }],
      });
      return { oneTurn, prepared: prepareWorldChatActions(w.store, w.lifecycle, oneTurn) };
    };

    const compiled = prepareBoard("production-board-compile");
    await appendTurn(w.log, compiled.oneTurn, compiled.prepared);
    await bindAll(w.lifecycle, compiled.prepared);
    const compileCard = (await loaded(w.log)).actions[0]!;
    assert.equal((await decide(w.lifecycle, w.log, compileCard)).status, "completed");
    const compiledScene = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!
      .scenes.find((scene) => scene.id === context.sceneId)!;
    assert.equal(compiledScene.board?.compiledAt, AT);

    const artifactCount = w.store.getBundle().artifacts.length;
    const exported = prepareBoard("production-board-export");
    await appendTurn(w.log, exported.oneTurn, exported.prepared);
    await bindAll(w.lifecycle, exported.prepared);
    const exportCard = (await loaded(w.log)).actions.at(-1)!;
    assert.equal(exportCard.shown.body.family, "host-action");
    assert.equal((await decide(w.lifecycle, w.log, exportCard)).status, "completed");
    const artifacts = w.store.getBundle().artifacts;
    assert.equal(artifacts.length, artifactCount + 1);
    assert.ok(artifacts.some((artifact) => artifact.kind === "board" && artifact.created === AT));
  });

  it("imports an immutable take without selecting it and opens generation in Bench without dispatch", async () => {
    const context = { kind: "scene" as const, productionId: PRODUCTION, sceneId: "sc_04" };
    let imported = 0;
    let opened: WorldChatProductionTakeGenerationAction["action"] | null = null;
    let actionStore: WorldStore;
    const w = await setup(context, {
      importProductionTake: async (action, mutation) => {
        imported += 1;
        const takeId = `tk_${mutation.requestId.slice(4)}` as const;
        const take = await recordUploadedShotFrameTake(
          actionStore,
          action.productionId,
          action.shotId,
          "approved-import.png",
          encodePng(solidImage(4, 4, [20, 40, 60, 255])),
          { takeId, ...mutation },
        );
        return { status: "completed", id: take.id };
      },
      openProductionTakeGeneration: async (action, mutation) => {
        assert.equal(mutation.precondition(), null);
        opened = action;
        return { status: "completed", id: `sess_${mutation.requestId.slice(4)}` };
      },
    });
    actionStore = w.store;
    const selectedBefore = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!
      .selections["sh_12"]?.acceptedTakeId;
    const importReceipts = [
      currentReceipt(w.store, "scenes", `${PRODUCTION}:${context.sceneId}`),
      currentReceipt(w.store, "takes", PRODUCTION),
    ];
    const importTurn = turn(w.conversationId, context, {
      receipts: importReceipts,
      actions: [{
        kind: "production-take-import",
        productionId: PRODUCTION,
        sceneId: context.sceneId,
        shotId: "sh_12",
        checkReceiptIds: importReceipts.map((receipt) => receipt.id),
      }],
    });
    const importPrepared = prepareWorldChatActions(w.store, w.lifecycle, importTurn);
    await appendTurn(w.log, importTurn, importPrepared);
    await bindAll(w.lifecycle, importPrepared);
    const importCard = (await loaded(w.log)).actions[0]!;
    assert.equal(imported, 0);
    assert.equal(JSON.stringify(importCard).includes("approved-import.png"), false);
    assert.equal((await decide(w.lifecycle, w.log, importCard)).status, "completed");
    const importedTakeId = `tk_${importCard.actionId.slice(4)}`;
    const afterImport = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!;
    assert.equal(imported, 1);
    assert.ok(afterImport.takes.some((take) => take.id === importedTakeId));
    assert.equal(afterImport.selections["sh_12"]?.acceptedTakeId, selectedBefore);

    const generationReceipts = [
      currentReceipt(w.store, "scenes", `${PRODUCTION}:${context.sceneId}`),
      currentReceipt(w.store, "takes", PRODUCTION),
    ];
    const generationTurn = turn(w.conversationId, context, {
      receipts: generationReceipts,
      actions: [{
        kind: "production-take-generation",
        productionId: PRODUCTION,
        sceneId: context.sceneId,
        target: { kind: "shot", shotId: "sh_12" },
        mode: "video",
        retakeOf: importedTakeId,
        instruction: "Keep the bell reflection stable.",
        checkReceiptIds: generationReceipts.map((receipt) => receipt.id),
      }],
    });
    const generationPrepared = prepareWorldChatActions(w.store, w.lifecycle, generationTurn);
    await appendTurn(w.log, generationTurn, generationPrepared);
    await bindAll(w.lifecycle, generationPrepared);
    const generationCard = (await loaded(w.log)).actions.at(-1)!;
    assert.equal(generationCard.shown.body.family, "generation");
    assert.equal(opened, null);
    assert.equal((await decide(w.lifecycle, w.log, generationCard)).status, "completed");
    assert.deepEqual(opened, generationTurn.actions[0]);
    assert.equal(w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!
      .selections["sh_12"]?.acceptedTakeId, selectedBefore);
  });

  it("shows rich take evidence, records cited rejection, and trims only the selected take", async () => {
    const context = { kind: "scene" as const, productionId: PRODUCTION, sceneId: "sc_04" };
    const w = await setup(context);
    const takeId = "tk_01J8C0000000000000000000C3";
    const selectedBefore = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!
      .selections["sh_12"]?.acceptedTakeId;
    const reviewReceipt = currentReceipt(w.store, "takes", PRODUCTION);
    const reviewTurn = turn(w.conversationId, context, {
      receipts: [reviewReceipt],
      actions: [{
        kind: "production-take-review",
        productionId: PRODUCTION,
        takeId,
        review: {
          decision: "reject",
          shotId: "sh_12",
          citation: { sheet: "maren-kest", field: "appearance", note: "The coat drifted." },
        },
        checkReceiptIds: [reviewReceipt.id],
      }],
    });
    const reviewPrepared = prepareWorldChatActions(w.store, w.lifecycle, reviewTurn);
    await appendTurn(w.log, reviewTurn, reviewPrepared);
    await bindAll(w.lifecycle, reviewPrepared);
    const reviewCard = (await loaded(w.log)).actions[0]!;
    assert.equal(reviewCard.shown.body.family, "take-review");
    if (reviewCard.shown.body.family === "take-review") {
      assert.match(reviewCard.shown.body.mediaPath ?? "", /clip\.mp4$/);
      assert.equal(reviewCard.shown.body.currentSelection, selectedBefore);
      assert.equal(reviewCard.shown.body.rejectionCitation?.field, "appearance");
      assert.ok((reviewCard.shown.body.reviewHistory ?? []).length > 0);
    }
    assert.equal((await decide(w.lifecycle, w.log, reviewCard)).status, "completed");
    const afterReview = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!;
    assert.equal(afterReview.reviews.at(-1)?.citation?.note, "The coat drifted.");
    assert.equal(afterReview.selections["sh_12"]?.acceptedTakeId, selectedBefore);

    const trimReceipt = currentReceipt(w.store, "takes", PRODUCTION);
    const trimTurn = turn(w.conversationId, context, {
      receipts: [trimReceipt],
      actions: [{
        kind: "production-take-trim",
        productionId: PRODUCTION,
        shotId: "sh_12",
        takeId: selectedBefore!,
        trimInSec: 0.5,
        checkReceiptIds: [trimReceipt.id],
      }],
    });
    const trimPrepared = prepareWorldChatActions(w.store, w.lifecycle, trimTurn);
    await appendTurn(w.log, trimTurn, trimPrepared);
    await bindAll(w.lifecycle, trimPrepared);
    const trimCard = (await loaded(w.log)).actions.at(-1)!;
    assert.equal((await decide(w.lifecycle, w.log, trimCard)).status, "completed");
    const selection = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!
      .selections["sh_12"]!;
    assert.equal(selection.acceptedTakeId, selectedBefore);
    assert.equal(selection.trimInSec, 0.5);
  });

  it("keeps an approved Stage action awaiting the renderer, then files its correlated playblast", async () => {
    const context = { kind: "scene" as const, productionId: PRODUCTION, sceneId: "sc_04" };
    const w = await setup(context);
    const production = w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    const scene = production.scenes.find((candidate) => candidate.id === context.sceneId)!;
    const sceneFile = production.sceneFiles[scene.id]!;
    const shot = orderedShots(scene).find((candidate) => candidate.id === "sh_12")!;
    const staging = stageShot(shot, { cast: ["maren-kest"], sets: ["The Vigil"], durationSec: 4 });
    await applySceneCommand(w.store, {
      productionId: PRODUCTION,
      sceneFile,
      sceneId: scene.id,
      baseVersion: scene.version,
      command: {
        kind: "edit-stage",
        shotId: shot.id,
        staging: {
          cast: staging.cast,
          sets: staging.sets,
          keys: staging.keys,
          rig: staging.rig,
          seed: staging.seed,
          rigIntensity: staging.rigIntensity,
        },
      },
    });
    const stagedProduction = w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    const stagedScene = stagedProduction.scenes.find((candidate) => candidate.id === context.sceneId)!;
    const stagedShot = orderedShots(stagedScene).find((candidate) => candidate.id === "sh_12")!;
    const receipt = currentReceipt(w.store, "scenes", `${PRODUCTION}:${context.sceneId}`);
    const oneTurn = turn(w.conversationId, context, {
      receipts: [receipt],
      actions: [{
        kind: "production-stage-playblast",
        productionId: PRODUCTION,
        sceneId: context.sceneId,
        shotId: stagedShot.id,
        checkReceiptIds: [receipt.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    const card = (await loaded(w.log)).actions[0]!;
    assert.equal((await decide(w.lifecycle, w.log, card)).status, "awaiting-host");

    const hostDir = join(w.store.dir, ".staging", "private-stage-spool");
    await mkdir(hostDir, { recursive: true });
    const sourcePath = join(hostDir, "private-playblast.mp4");
    const openingFrameSourcePath = join(hostDir, "private-opening-frame.png");
    await writeFile(sourcePath, new Uint8Array([
      0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
      0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76,
      0, 0, 0, 9, 0x6d, 0x64, 0x61, 0x74, 0,
    ]));
    await writeFile(openingFrameSourcePath, encodePng(solidImage(16, 9, [20, 40, 60, 255])));
    const payload = {
      kind: "conversation-action-stage-playblast-complete" as const,
      worldId: w.store.worldId,
      conversationId: w.conversationId,
      actionId: card.actionId,
      status: "completed" as const,
      productionId: PRODUCTION,
      sceneFile,
      sceneId: stagedScene.id,
      baseVersion: stagedScene.version,
      shotId: stagedShot.id,
      stagingVersion: stagedShot.staging!.version,
      durationSec: stagedShot.durationSec ?? 4,
      aspect: "16:9",
      sourcePath,
      openingFrameSourcePath,
    };
    const adapter = w.adapters.find((candidate) => candidate.actionKind === card.actionKind)!;
    assert.equal((await adapter.completeHost!(card, payload)).status, "completed");
    assert.equal((await loaded(w.log)).actions[0]!.status, "awaiting-host", "the host outcome append was interrupted");

    const completed = await w.lifecycle.completeHostAction({
      conversationId: w.conversationId,
      actionId: card.actionId,
      payload,
    });

    assert.equal(completed, true);
    const settled = (await loaded(w.log)).actions[0]!;
    assert.equal(settled.status, "completed");
    assert.equal(settled.receipt?.kind, "stage-playblast");
    const filedProduction = w.store.getBundle().productions.find((candidate) => candidate.meta.id === PRODUCTION)!;
    const filedShot = orderedShots(filedProduction.scenes.find((candidate) => candidate.id === context.sceneId)!)
      .find((candidate) => candidate.id === stagedShot.id)!;
    assert.ok(filedShot.staging?.playblast);
    const events = await readFile(join(w.store.dir, ".conversations", w.conversationId, "events.jsonl"), "utf8");
    assert.equal(events.includes("private-playblast.mp4"), false);
    assert.equal(events.includes("private-opening-frame.png"), false);
  });

  it("applies one semantic routing command only after approval", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const w = await setup(context);
    const routing = currentReceipt(w.store, "routing", PRODUCTION);
    const scenes = currentReceipt(w.store, "scenes", PRODUCTION);
    const before = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!.routing;
    const oneTurn = turn(w.conversationId, context, {
      receipts: [routing, scenes],
      actions: [{
        kind: "production-routing",
        productionId: PRODUCTION,
        command: { operation: "set-start", sceneId: "sc_04" },
        checkReceiptIds: [routing.id, scenes.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn, w.actionDeps);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    assert.deepEqual(
      w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!.routing,
      before,
    );
    const card = (await loaded(w.log)).actions.at(-1)!;
    assert.equal(card.authority.kind, "routing");
    assert.equal(card.shown.body.family, "command");
    assert.equal((await decide(w.lifecycle, w.log, card)).status, "completed");
    const after = w.store.getBundle().productions.find((production) => production.meta.id === PRODUCTION)!.routing!;
    assert.equal(after.start, "sc_04");
    assert.equal(after.version, (before?.version ?? 0) + 1);
  });

  it("shows complete local export effects and returns only a semantic receipt", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const exportRecords: ArkeExportReadRecord[] = [];
    let starts = 0;
    const w = await setup(context, {
      getExports: () => exportRecords,
      startProductionExport: async (_action, card) => {
        starts += 1;
        return {
          status: "completed",
          receipt: { kind: "production-export", id: card.authority.id, summary: "The local production export completed." },
        };
      },
    });
    const timeline = currentReceipt(w.store, "timeline", PRODUCTION);
    const episodes = currentReceipt(w.store, "episodes", PRODUCTION);
    const exports = currentReceipt(w.store, "exports", PRODUCTION, exportRecords);
    const oneTurn = turn(w.conversationId, context, {
      receipts: [timeline, episodes, exports],
      actions: [{
        kind: "production-cut-export",
        productionId: PRODUCTION,
        scope: { kind: "production" },
        preset: "review-cut",
        checkReceiptIds: [timeline.id, episodes.id, exports.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn, w.actionDeps);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);

    const card = (await loaded(w.log)).actions.at(-1)!;
    const shown = JSON.stringify(card.shown);
    assert.equal(card.shown.body.family, "host-action");
    assert.match(shown, /Scope:/);
    assert.match(shown, /Preset:/);
    assert.match(shown, /Outputs:/);
    assert.match(shown, /Overwrite\/destructive effects:/);
    assert.match(shown, /Privacy\/network:/);
    assert.match(shown, /Cancellation:/);
    const exportAdapter = worldChatActionAdapters(w.store, w.gate, NOW, w.actionDeps)
      .find((adapter) => adapter.actionKind === "world-chat-production-cut-export")!;
    assert.equal(
      (await exportAdapter.reconcile?.({ ...card, status: "running" }))?.status,
      "failed",
      "a restart cannot leave a lost local encode running forever",
    );
    assert.equal(starts, 0);
    assert.equal((await decide(w.lifecycle, w.log, card)).status, "completed");
    assert.equal(starts, 1);
    const settled = (await loaded(w.log)).actions.at(-1)!;
    assert.equal(settled.receipt?.id, card.authority.id);
    assert.equal(JSON.stringify(settled).includes("C:\\private"), false);
  });

  it("keeps partial multi-card delivery outcomes independent without claiming rollback", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const exportRecords: ArkeExportReadRecord[] = [];
    const w = await setup(context, {
      getExports: () => exportRecords,
      startProductionExport: async (action, card) => action.preset === "review-cut"
        ? {
            status: "completed",
            receipt: { kind: "production-export", id: card.authority.id, summary: "The review cut completed." },
          }
        : { status: "failed", detail: "The master export failed." },
    });
    const timeline = currentReceipt(w.store, "timeline", PRODUCTION);
    const episodes = currentReceipt(w.store, "episodes", PRODUCTION);
    const exports = currentReceipt(w.store, "exports", PRODUCTION, exportRecords);
    const oneTurn = turn(w.conversationId, context, {
      receipts: [timeline, episodes, exports],
      actions: (["review-cut", "master"] as const).map((preset) => ({
        kind: "production-cut-export" as const,
        productionId: PRODUCTION,
        scope: { kind: "production" as const },
        preset,
        checkReceiptIds: [timeline.id, episodes.id, exports.id],
      })),
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn, w.actionDeps);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    const cards = (await loaded(w.log)).actions;

    assert.equal((await decide(w.lifecycle, w.log, cards[0]!)).status, "completed");
    assert.equal((await decide(w.lifecycle, w.log, cards[1]!)).status, "failed");
    const settled = (await loaded(w.log)).actions;
    assert.deepEqual(settled.map((card) => card.status), ["completed", "failed"]);
    assert.equal(settled[0]!.receipt?.kind, "production-export");
    assert.equal(settled[1]!.statusDetail, "The master export failed.");
  });

  it("cancels only a running export selected from the complete export read", async () => {
    const context = { kind: "production" as const, productionId: PRODUCTION };
    const exportId = `ex_${ulid()}`;
    const exportRecords: ArkeExportReadRecord[] = [{
      id: exportId,
      worldId: "placeholder",
      productionId: PRODUCTION,
      status: "running",
      percent: 40,
      output: null,
      error: null,
    }];
    let cancelled = "";
    const w = await setup(context, {
      getExports: () => exportRecords,
      cancelExport: (id) => {
        cancelled = id;
        return true;
      },
    });
    exportRecords[0] = { ...exportRecords[0]!, worldId: w.store.worldId };
    const exports = currentReceipt(w.store, "exports", PRODUCTION, exportRecords);
    const oneTurn = turn(w.conversationId, context, {
      receipts: [exports],
      actions: [{
        kind: "production-export-cancel",
        productionId: PRODUCTION,
        exportId,
        checkReceiptIds: [exports.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn, w.actionDeps);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    const card = (await loaded(w.log)).actions.at(-1)!;
    assert.equal(cancelled, "");
    assert.equal((await decide(w.lifecycle, w.log, card)).status, "completed");
    assert.equal(cancelled, exportId);
  });

  it("rejects host destinations in model-authored export actions", () => {
    assert.throws(() => ModelWorldChatActionSchema.parse({
      kind: "production-cut-export",
      productionId: PRODUCTION,
      scope: { kind: "production" },
      preset: "master",
      destinationPath: "C:\\private\\delivery.mp4",
      checkReceiptIds: [newId("check")],
    }));
  });

  it("binds a durable Bench quote before dispatch", async () => {
    let dispatched = 0;
    const w = await setup({ kind: "world" }, {
      getJobs: () => [],
      quoteBenchGeneration: async () => ({
        authorityRevision: 7,
        body: {
          family: "generation",
          medium: "image",
          purpose: "Bench exploration",
          prompt: "Salt-stained ledger studies",
          exclusions: ["No lettering"],
          references: [],
          provider: "fal",
          model: "flux",
          options: [{ label: "aspect", value: "16:9" }],
          quantity: 2,
          output: "Immutable Bench takes",
          dimensions: "16:9",
          privacy: ["The brief is sent to the provider."],
          cost: "$0.0200 estimated; actual cost may differ",
          quoteDigest: `sha256:${"b".repeat(64)}`,
          quoteExpiresAt: "2026-09-04T12:15:00.000Z",
          estimatedMicroUsd: 20_000,
          currency: "USD",
          estimateMayVary: true,
          deterministicInputs: ["Bench revision 7"],
          cancellationSupported: true,
        },
      }),
      dispatchBenchGeneration: async () => {
        dispatched += 1;
        return { status: "queued", detail: "2 Bench items reserved and queued." };
      },
    });
    const receipt = currentReceipt(w.store, "jobs");
    const oneTurn = turn(w.conversationId, { kind: "world" }, {
      receipts: [receipt],
      actions: [{
        kind: "bench-generation",
        sessionId: `sess_${"0".repeat(26)}`,
        composer: {
          mode: "image",
          provider: "fal",
          model: "flux",
          params: { kind: "image", aspect: "16:9", count: 2 },
          brief: "Salt-stained ledger studies",
        },
        checkReceiptIds: [receipt.id],
      }],
    });
    const prepared = prepareWorldChatActions(w.store, w.lifecycle, oneTurn, w.actionDeps);
    await appendTurn(w.log, oneTurn, prepared);
    await bindAll(w.lifecycle, prepared);
    const card = (await loaded(w.log)).actions.at(-1)!;
    assert.equal(dispatched, 0);
    assert.equal(card.shown.body.family, "generation");
    if (card.shown.body.family !== "generation") return;
    assert.equal(card.shown.body.quoteDigest, `sha256:${"b".repeat(64)}`);
    assert.equal(card.shown.body.estimateMayVary, true);
    assert.equal((await decide(w.lifecycle, w.log, card)).status, "queued");
    assert.equal(dispatched, 1);
  });
});

/**
 * A passage revision is held to the passage that was selected (turn 128, codex round three): the
 * selection travels on the turn as a structured subject, and an action that comes back aimed
 * elsewhere is refused before anything is staged.
 */
describe("a passage revision is held to the selected passage (turn 128)", () => {
  const context = { kind: "production" as const, productionId: "the-ledger-of-nights" };
  const subject = { kind: "passage" as const, chapterId: "neap", paragraph: 2, text: "Maren has the 1820 volume open on the rail desk" };
  const revision = (chapterId: string, find: string, paragraph?: number) => ({
    kind: "production-chapter" as const,
    productionId: "the-ledger-of-nights",
    change: { operation: "edit" as const, chapterId, changes: { passage: { find, with: "x", ...(paragraph === undefined ? {} : { paragraph }) } } },
    checkReceiptIds: [],
  });

  it("refuses another chapter, another paragraph, and words outside the selection, by name", async () => {
    const w = await setup(context);
    const held = (action: ReturnType<typeof revision>) =>
      prepareWorldChatActions(w.store, w.lifecycle, turn(w.conversationId, context, { actions: [action], subject }));
    assert.throws(() => held(revision("the-same-ink", "the 1820 volume")), /This ask was about a passage in chapter neap; the revision names the-same-ink/);
    assert.throws(() => held(revision("neap", "the 1820 volume", 3)), /This ask was about paragraph 2 of chapter neap; the revision names paragraph 3/);
    assert.throws(() => held(revision("neap", "the rail desk under her coat", 2)), /not within the words this ask was about/);
    // Within the selection, with whitespace folded, the subject holds; the missing read receipt
    // is the next refusal, which is the proof the passage check came first.
    assert.throws(() => held(revision("neap", "the  1820\nvolume", 2)), (err: unknown) => !/This ask was about|not within the words/.test(String(err)));
  });

  it("holds nothing when nothing was selected, or when the action is not a passage", async () => {
    const w = await setup(context);
    const bare = turn(w.conversationId, context, { actions: [revision("the-same-ink", "anything")] });
    assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, bare), (err: unknown) => !/This ask was about|not within the words/.test(String(err)), "only the read is missing");
    const whole = turn(w.conversationId, context, {
      actions: [{ kind: "production-chapter", productionId: "the-ledger-of-nights", change: { operation: "edit", chapterId: "the-same-ink", changes: { body: "Whole." } }, checkReceiptIds: [] }],
      subject,
    });
    assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, whole), (err: unknown) => !/This ask was about|not within the words/.test(String(err)), "a body is not held to a passage");
  });

  it("a reply-only ask stages nothing, whatever the model returned (codex, round four)", async () => {
    const w = await setup(context);
    const asked = turn(w.conversationId, context, { actions: [revision("neap", "the 1820 volume", 2)], subject, replyOnly: true });
    assert.throws(() => prepareWorldChatActions(w.store, w.lifecycle, asked), /This ask was for a reply only; nothing is staged from it/);
    const quiet = turn(w.conversationId, context, { actions: [], replyOnly: true });
    assert.deepEqual(prepareWorldChatActions(w.store, w.lifecycle, quiet), [], "a reply with no action is the promise kept");
  });
});

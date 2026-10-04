import { orderedShots, resolveCast, type ConversationActionCard, type HumanDecisionCard, type HumanDecisionControl,
  type Job, type StageReview, type WorldBundle, type WorldChatLoaded } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { pendingCharacterSampleReviews } from "../audio/character-sample.js";
import { readPlanRecords } from "../productions/plans.js";
import { keptStageReviewIds, listStageReviews } from "../productions/stage-review.js";
import { stageConstructionHandoff } from "./actions.js";

/** Projections bind existing authorities. Reading a card cannot authorize work (SPEC-051 R-19). */
export async function projectHumanDecisions(store: WorldStore, loaded: WorldChatLoaded, bundle: WorldBundle, jobs: readonly Job[]):
  Promise<{ cards: HumanDecisionCard[]; problems: string[]; stageReviews: StageReview[] }> {
  const cards: HumanDecisionCard[] = [], problems: string[] = [];
  const add = (id: string, title: string, reason: string, control: HumanDecisionControl, action?: ConversationActionCard,
    status: HumanDecisionCard["status"] = "pending", detail?: string) => {
    cards.push({ id, worldId: store.worldId, conversationId: loaded.id, title, status,
      ...(action ? { actionId: action.actionId, turnId: action.turnId } : {}), ...(detail ? { detail } : {}),
      body: { family: "human-decision", reason, control } });
  };
  const actionById = new Map(loaded.actions.map(action => [action.actionId, action]));
  const contextProduction = loaded.entryContext && "productionId" in loaded.entryContext ? loaded.entryContext.productionId : null;
  const scopedProductions = new Set([...(contextProduction ? [contextProduction] : []),
    ...loaded.actions.flatMap(action => action.productionId ? [action.productionId] : [])]);
  for (const productionId of scopedProductions) {
    const production = bundle.productions.find(value => value.meta.id === productionId);
    if (!production) continue;
    for (const { plan, state } of readPlanRecords(store, productionId, jobs)) {
      const action = loaded.actions.find(value => value.actionKind === "world-chat-production-scene-dispatch" && `pl_${value.actionId.slice(4)}` === plan.planId);
      if (!action || !["approved", "queued", "running", "completed"].includes(action.status) ||
        (state.next.kind !== "await-continue" && state.next.kind !== "await-reconfirm")) continue;
      add(`plan:${plan.planId}:${state.next.passIndex}:${state.next.kind}`, "Scene plan needs your decision",
        "Only you can authorize the next pass", { kind: "plan", productionId, planId: plan.planId,
          passIndex: state.next.passIndex, gate: state.next.kind === "await-continue" ? "continue" : "reconfirm",
          capMicroUsd: state.capMicroUsd, estimatedMicroUsd: state.passes[state.next.passIndex]?.estimatedMicroUsd ?? 0 }, action);
    }
    for (const request of production.editorRequests.filter(value => value.conversationId === loaded.id && value.status === "pending")) {
      const action = request.actionId ? actionById.get(request.actionId) : undefined;
      const blocked = action?.status === "pending" && !action.availableDecisions.includes("approve");
      add(`editor:${request.id}`, request.summary.slice(0, 200) || "Editor request", "Only you can accept this timeline edit",
        { kind: "editor-request", productionId, requestId: request.id }, action, blocked ? "blocked" : "pending", blocked ? action.blockedReason : undefined);
    }
  }
  for (const staged of bundle.proposals) {
    const action = loaded.actions.find(value => value.authority.kind === "proposal-manager" && value.authority.id === staged.proposal.id);
    if (!action && !(staged.proposal.worldChatOrigins ?? []).some(origin => origin.conversationId === loaded.id)) continue;
    const blocked = action?.status === "pending" && !action.availableDecisions.includes("approve");
    add(`proposal:${staged.proposal.id}`, "Review the authored proposal", "Only you can accept or discard this proposal",
      { kind: "proposal", proposalId: staged.proposal.id }, action, blocked ? "blocked" : "pending", blocked ? action.blockedReason : undefined);
  }
  for (const artifact of bundle.artifacts.filter(value => (value.extraction?.pending.length ?? 0) > 0)) {
    const action = loaded.actions.find(value => value.targets.some(target => target.kind === "artifact" && target.id === artifact.id));
    if (!action && (!artifact.production || artifact.production !== contextProduction)) continue;
    add(`extraction:${artifact.id}`, `Facts from ${artifact.file}`.slice(0, 200), "Only you can decide which extracted facts to keep",
      { kind: "extraction", artifactId: artifact.id }, action);
  }
  const voice = await pendingCharacterSampleReviews(store);
  problems.push(...voice.problems);
  const characters = new Set(bundle.productions.filter(value => scopedProductions.has(value.meta.id)).flatMap(production =>
    production.scenes.flatMap(scene => [...Object.keys(scene.cast ?? {}),
      ...orderedShots(scene).flatMap(shot => shot.audio?.kind === "dialogue" ? [shot.audio.speaker] : []),
      ...resolveCast(orderedShots(scene).map(shot => shot.description).join("\n"), bundle.sheets).cast.map(value => value.sheet.id)])));
  for (const review of voice.reviews) {
    const action = loaded.actions.find(value => value.targets.some(target => target.kind === "sheet" && target.id === review.sheetId));
    if (!action && !characters.has(review.sheetId)) continue;
    add(`voice:${review.operationId}`, "Review the character's voice sample", "Only you can confirm the voice rights",
      { kind: "voice-sample", review }, action);
  }
  let reviews: StageReview[] = [];
  try { reviews = await listStageReviews(store); }
  catch { problems.push("Stage review drafts could not be read. Reopen the world before Keep."); }
  const stageReviews: StageReview[] = [];
  const kept = await keptStageReviewIds(store);
  for (const review of reviews.filter(value => value.status === "pending")) {
    if (kept.has(review.id)) continue;
    stageReviews.push(review);
    if (review.conversationId !== loaded.id) continue;
    const scene = bundle.productions.find(value => value.meta.id === review.productionId)?.scenes.find(value => value.id === review.sceneId);
    const blocked = !scene || scene.version !== review.baseVersion || !orderedShots(scene).some(shot => shot.id === review.shotId);
    add(`stage-review:${review.id}`, "Review the constructed Stage draft", "Only you can Keep this Stage draft",
      { kind: "stage-review", review }, actionById.get(review.actionId), blocked ? "blocked" : "pending",
      blocked ? "The source scene changed. Discard this draft and rebuild before Keep." : undefined);
  }
  for (const action of loaded.actions.filter(value => value.status === "awaiting-host" && value.productionId)) {
    if (action.actionKind === "world-chat-production-stage-construct") {
      const input = await stageConstructionHandoff(store, action);
      if (input) add(`stage-host:${action.actionId}`, "Construct and inspect the Stage", "Only your renderer can inspect the Stage",
        { kind: "stage-host", productionId: input.productionId, sceneId: input.sceneId, shotId: input.shotId,
          instruction: input.instruction, preserve: input.preserve, actionId: action.actionId, mode: "construct" }, action);
    } else if (action.actionKind === "world-chat-production-stage-playblast") {
      const shotId = action.targets.find(value => value.kind === "shot")?.id;
      const prefix = `${action.productionId}:`;
      const sceneId = action.targets.find(value => value.kind === "scene")?.id ??
        action.baseObservations.find(value => value.requirement === "scenes" && value.target.startsWith(prefix))?.target.slice(prefix.length);
      if (shotId && sceneId) add(`stage-host:${action.actionId}`, "Record the Stage playblast", "Only your renderer can record the Stage",
        { kind: "stage-host", productionId: action.productionId!, sceneId, shotId, actionId: action.actionId, mode: "playblast" }, action);
    }
  }
  return { cards, problems: [...new Set(problems)], stageReviews };
}

import { newId, orderedShots, type ConversationActionCard, type Job, type PrepareConversationTakeReview } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { ConversationActionLifecycle } from "../arke-actions/lifecycle.js";
import { WorldChatService } from "../world-chat/service.js";
import { takesFence } from "../world-chat/target-reads.js";

/** Only these domain refusals are safe to publish; filesystem diagnostics stay on the host. */
export class ConversationTakeReviewRefusal extends Error {}

const preparations = new WeakMap<WorldStore, Map<string, { target: string; work: Promise<ConversationActionCard> }>>();

/** SPEC-051 R-56: a human Select gesture creates the existing fenced review authority. */
export async function prepareConversationTakeReview(store: WorldStore, lifecycle: ConversationActionLifecycle,
  input: PrepareConversationTakeReview, ports: {
    project(card: ConversationActionCard): Promise<ConversationActionCard>;
    jobs(): readonly Job[];
  }) {
  if (input.worldId !== store.worldId) throw new ConversationTakeReviewRefusal("The result belongs to another world.");
  let active = preparations.get(store);
  if (!active) { active = new Map(); preparations.set(store, active); }
  const key = `${input.conversationId}:${input.requestId}`;
  const target = `${input.sourceActionId}:${input.takeId}:${input.shotId}`;
  const pending = active.get(key);
  if (pending) {
    if (pending.target !== target) throw new ConversationTakeReviewRefusal("The request already prepared another review.");
    return pending.work;
  }
  const work = prepare();
  active.set(key, { target, work });
  try { return await work; } finally { if (active.get(key)?.work === work) active.delete(key); }

  async function prepare(): Promise<ConversationActionCard> {
    const loaded = await new WorldChatService(store.dir).load(input.conversationId);
    if (!loaded) throw new ConversationTakeReviewRefusal("The conversation is unavailable.");
    const actionId = `act_${input.requestId}`;
    const existing = loaded.actions.find(card => card.actionId === actionId);
    if (existing) {
      if (existing.actionKind !== "world-chat-production-take-review" || !existing.shown.affectedTargets.some(t => t.kind === "take" && t.id === input.takeId) ||
          !existing.shown.affectedTargets.some(t => t.kind === "shot" && t.id === input.shotId) ||
          !existing.shown.affectedTargets.some(t => t.kind === "source-action" && t.id === input.sourceActionId)) throw new ConversationTakeReviewRefusal("The request already prepared another review.");
      return existing;
    }
    if (loaded.seq !== input.expectedConversationSeq) throw new ConversationTakeReviewRefusal("The conversation changed; select the result again.");
    const source = loaded.actions.find(card => card.actionId === input.sourceActionId);
    if (!source || source.worldId !== store.worldId || source.shown.body.family !== "generation" || !source.productionId ||
        !["approved", "queued", "running", "completed", "failed", "cancelled"].includes(source.status)) throw new ConversationTakeReviewRefusal("The approved generation is unavailable.");
    const production = store.getBundle().productions.find(p => p.meta.id === source.productionId);
    const take = production?.takes.find(t => t.id === input.takeId);
    const shot = production?.scenes.flatMap(scene => orderedShots(scene)).find(s => s.id === input.shotId);
    if (!production || !take?.jobId || !shot || !take.coversShots.includes(shot.id) || !["frame", "clip", "still"].includes(take.kind)) throw new ConversationTakeReviewRefusal("The result is unavailable for that shot.");
    const projected = await ports.project(source);
    const job = ports.jobs().find(job => job.id === take.jobId && job.worldId === store.worldId && job.productionId === production.meta.id);
    const proven = job && projected.generationWork?.jobKeys.includes(job.idempotencyKey) && job.status === "succeeded" &&
      (!job.finalization || job.finalization.status === "complete");
    if (!proven && !source.receipt?.generation?.results.some(result => result.id === take.id && result.status === "completed")) throw new ConversationTakeReviewRefusal("The take belongs to another generation.");
    const payload = { kind: "world-chat-production-take-review", worldId: store.worldId, action: {
      kind: "production-take-review", productionId: production.meta.id, takeId: take.id,
      review: { decision: "accept", shotId: shot.id }, checkReceiptIds: [newId("check")],
    } };
    return lifecycle.prepare({ worldId: store.worldId, conversationId: input.conversationId, turnId: source.turnId,
      productionId: production.meta.id, actionId, actionKind: payload.kind, payload,
      targets: [{ kind: "take", id: take.id }, { kind: "shot", id: shot.id }, { kind: "source-action", id: source.actionId }],
      // This human command reads the owning authority directly. It claims no model-served receipt.
      baseObservations: [{ requirement: "takes", target: production.meta.id, revisionOrDigest: takesFence(production), complete: true }],
      createdAt: store.now() });
  }
}

import { conversationActionDigest } from "../../src/arke-actions/digest.js";
import { ConversationActionBindingSchema, LOCAL_ACTOR_ID, newId } from "@arke-studio/contracts";

export function receiptBinding(conversationId: string, worldId: string) {
  const actionId = newId("act");
  const targets = [{ kind: "production", id: "saltlight" }];
  const binding = ConversationActionBindingSchema.parse({ actionId, conversationId, turnId: newId("turn"), worldId,
    productionId: "saltlight", actorId: LOCAL_ACTOR_ID, scope: "production", actionKind: "world-chat-production-take-generation",
    authorityKind: "job-queue", cardFamily: "generation", targets, payloadDigest: `sha256:${"a".repeat(64)}`,
    baseObservations: [], dependencies: [], createdAt: "2026-10-04T00:00:00.000Z",
    authority: { kind: "job-queue", id: newId("jb") }, authorityRevision: 0, previewDigest: `sha256:${"b".repeat(64)}`,
    shown: { title: "Generate a take", consequence: "Generate a candidate.", affectedTargets: targets, ripples: [],
      permissionReason: "spend-and-compute", body: { family: "generation", medium: "image", purpose: "A frame", prompt: "Private prompt",
        references: [], provider: "fal", model: "image", quantity: 1, output: "Candidate take", cost: "$0.001", estimatedMicroUsd: 1000 } },
    status: "pending", preparedAt: "2026-10-04T00:00:00.000Z" });
  binding.previewDigest = conversationActionDigest(binding.shown);
  return binding;
}

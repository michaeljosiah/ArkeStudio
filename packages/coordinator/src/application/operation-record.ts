import { z } from "zod";
import { JobSchema, ProposalSchema, RippleItemSchema, RipplePreviewSchema } from "@arke-studio/contracts";
import type { EngineOperation } from "./contracts.js";
import { engineHash } from "./operations.js";

const text = z.string().min(1).refine(value => value.trim().length > 0);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const context = z.object({ actorId: text, scopeId: text, executorId: text, subjectId: text }).strict();
const resource = z.object({ worldId: text, proposalId: text.optional(), sheetId: text.optional(), artifactId: text.optional() }).strict();
const envelope = z.object({ key: hash, fingerprint: hash, context, resource,
  action: z.enum(["propose", "accept", "discard", "generate"]), status: z.enum(["started", "completed"]), result: z.unknown().optional() }).strict();
const commit = z.object({ commitId: text, canonRevision: z.number().int().nonnegative(), allocatedCanonIds: z.array(text),
  versions: z.record(z.number().int().nonnegative()), hashes: z.record(z.string().regex(/^sha256:[a-f0-9]{64}$/)).optional() }).strict();
const acceptance = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), result: commit, ripples: z.array(RippleItemSchema) }).strict(),
  z.object({ status: z.literal("no-op") }).strict(),
  z.object({ status: z.literal("stale"), stalePaths: z.array(text), detail: text.optional() }).strict(),
  z.object({ status: z.literal("needs-reconfirm"), authoritative: RipplePreviewSchema, signature: text }).strict(),
  z.object({ status: z.literal("pending-review") }).strict(),
  z.object({ status: z.literal("unresolved-conflicts"), count: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal("open-choices"), count: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal("target-retired"), paths: z.array(text) }).strict(),
  z.object({ status: z.literal("draft-unresolved"), records: z.array(text) }).strict(),
  z.object({ status: z.literal("invalid"), problems: z.array(z.object({ path: z.string(), message: text }).strict()) }).strict(),
]);
const receipt = z.object({ operationKey: hash, revision: text, value: z.unknown() }).strict();
const proposal = z.object({ proposal: ProposalSchema, slug: text, path: text, scope: z.string() }).strict();
const admission = z.object({ operationKey: hash, reservation: text, jobIds: z.array(text),
  failures: z.array(z.object({ index: z.number().int().nonnegative(), reason: text }).strict()), needsReconciliation: z.boolean() }).strict();
const deliveredJob = JobSchema.extend({ deliveredArtifacts: z.array(z.object({ id: text, sha256: hash }).strict()).min(1) });
const settlement = z.object({ operationKey: hash, reservation: text, jobs: z.array(deliveredJob) }).strict();

/** Validate durable data before replay can reach a mutation, output policy or financial adapter. */
export function parseOperationRecord(value: unknown): EngineOperation {
  const row = envelope.parse(value);
  if ((["accept", "discard"].includes(row.action) && !row.resource.proposalId) ||
    (row.action === "generate" && !row.resource.sheetId)) throw new Error("Invalid engine operation resource.");
  if (row.status === "started" && row.result === undefined) return row;
  if (row.action === "generate") {
    if (row.status === "completed" && admission.safeParse(row.result).success) {
      const result = admission.parse(row.result);
      if (result.operationKey !== row.key) throw new Error("Invalid engine admission identity.");
      return row;
    }
    const result = settlement.parse(row.result);
    if (row.key !== engineHash([result.operationKey, "settlement"]) ||
      row.fingerprint !== engineHash([result.operationKey, result.reservation])) throw new Error("Invalid engine settlement identity.");
    for (const job of result.jobs) {
      const owner = z.object({ key: hash, reservation: text, context }).passthrough().parse(job.params.engineOperation);
      if (job.status !== "succeeded" || job.worldId !== row.resource.worldId || owner.key !== result.operationKey ||
        owner.reservation !== result.reservation || owner.context.actorId !== row.context.actorId ||
        owner.context.scopeId !== row.context.scopeId || owner.context.subjectId !== row.context.subjectId ||
        job.landedFiles?.length !== job.deliveredArtifacts.length ||
        job.deliveredArtifacts.some(artifact => !job.landedFiles?.includes(artifact.id))) {
        throw new Error("Invalid engine settlement output.");
      }
    }
    return row;
  }
  if (row.status !== "completed") throw new Error("Unexpected started engine result.");
  const result = receipt.parse(row.result);
  if (result.operationKey !== row.key) throw new Error("Invalid engine receipt identity.");
  if (row.action === "propose") proposal.parse(result.value);
  else if (row.action === "accept") acceptance.parse(result.value);
  else z.object({ status: z.literal("discarded") }).strict().parse(result.value);
  return row;
}

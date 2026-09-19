import { MAX_IMAGE_PREVIEWS, describeError, ulid, type Job } from "@arke-studio/contracts";
import type { EngineContext, EngineDeliveredJob, EngineMutation, EngineQueue, EngineResource, EngineWorldRepository, IllustrationInput, IllustrationOutcome } from "./contracts.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { readStoryMediaSource } from "./story-media.js";
import { WorldSessionService } from "./world-sessions.js";
import { engineHash, EngineOperations } from "./operations.js";

export class IllustrationApplicationService {
  constructor(private readonly worlds: EngineWorldRepository, private readonly operations: EngineOperations,
    private readonly queue: EngineQueue) {}

  async generate(context: EngineContext, worldId: string, input: IllustrationInput & EngineMutation): Promise<IllustrationOutcome> {
    context = structuredClone(context);
    input = structuredClone(input);
    const resource = { worldId, sheetId: input.sheetId };
    return this.generateFor(context, resource, input, async key => {
      if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_IMAGE_PREVIEWS) {
        throw new Error(`Request between one and ${MAX_IMAGE_PREVIEWS} illustrations.`);
      }
      return this.worlds.use(worldId, session =>
        session.illustrations({ ...input, generationKey: key }, input.expectedRevision));
    });
  }

  /** Shared admission/recovery path; preparation owns the canonical source and frozen provider input. */
  async generateFor(context: EngineContext, resource: EngineResource, input: EngineMutation,
    prepare: (key: string) => Promise<EnqueueInput[]>): Promise<IllustrationOutcome> {
    const worldId = resource.worldId;
    return this.operations.run(context, "generate", resource, input.operationId, input, async key => {
      const inputs = await prepare(key);
      if (!inputs.length) throw new Error("No media requests were prepared.");
      const reservation = await this.operations.policy.reserve(context, key, inputs);
      const jobs: Job[] = [];
      // A partial/uncertain enqueue retains the reservation and operation for reconciliation.
      // Releasing it here could fund another request while the first provider is already working.
      for (const [index, request] of inputs.entries()) {
        try {
          await this.operations.policy.authorise(context, "generate", resource);
          if (resource.mediaKind) await readStoryMediaSource(this.worlds, this.operations.policy, context, resource);
        } catch (error) {
          // No enqueue has run when the first request loses its source or authority. Release
          // that known-unused hold; a partial batch still needs its original reservation.
          if (jobs.length === 0) {
            await this.operations.policy.release(context, key, reservation);
            throw error;
          }
          return {operationKey: key, reservation, jobIds: jobs.map(job => job.id), needsReconciliation: true,
            failures: inputs.slice(index).map((_, offset) => ({index: index + offset, reason: describeError(error)}))};
        }
        try {
          jobs.push(await this.queue.enqueue({ ...request, idempotencyKey: ulid(),
            params: { ...request.params, engineOperation: { key, requestIndex: index, reservation, context, resource } } }));
        } catch (error) {
          // The queue may have journalled the failing call before its acknowledgement was lost.
          // Preserve all known admissions; an incomplete batch is never a wholly rejected one.
          const admitted = new Map(jobs.map(job => [job.id, job]));
          for (const job of this.queue.jobs()) {
            if (job.worldId === worldId && (job.params.engineOperation as { key?: string } | undefined)?.key === key) {
              admitted.set(job.id, job);
            }
          }
          const confirmed = new Set([...admitted.values()].map(job =>
            (job.params.engineOperation as { requestIndex?: number }).requestIndex));
          return { operationKey: key, reservation, jobIds: [...admitted.keys()], needsReconciliation: true,
            failures: inputs.map((_, requestIndex) => requestIndex).filter(requestIndex => !confirmed.has(requestIndex))
              .map(requestIndex => ({ index: requestIndex,
                reason: requestIndex === index ? describeError(error)
                  : "This request was not queued. Check the admitted jobs before trying again." })) };
        }
      }
      return { operationKey: key, reservation, jobIds: jobs.map(job => job.id), failures: [], needsReconciliation: false };
    }, result => ({ ...result, needsReconciliation: true }));
  }

  /** Reconcile terminal work from durable queue state, never from a browser's success flag. */
  async reconcile(context: EngineContext, worldId: string, operationId: string) {
    context = structuredClone(context);
    const key = this.operations.key(context, { worldId }, operationId);
    await this.operations.policy.authorise(context, "generate", { worldId });
    const operation = await this.operations.store.read(key);
    if (!operation || operation.action !== "generate") throw new Error("Generation operation not found.");
    if (operation.context.subjectId !== context.subjectId || operation.context.actorId !== context.actorId ||
      operation.context.scopeId !== context.scopeId) throw new Error("The operation belongs to a different caller or subject.");
    // A world-level permission is insufficient for a request originally limited to one sheet.
    await this.operations.policy.authorise(context, "generate", operation.resource);
    const jobs = this.queue.jobs().filter(job => {
      const owner = job.params.engineOperation as { key?: string } | undefined;
      return job.worldId === worldId && owner?.key === key;
    });
    // Missing evidence is not running work. Interrupted admissions and removed queue rows
    // need a host recovery decision before any reservation can be settled or released.
    if (operation.status !== "completed") return { status: "needs-reconciliation" as const, operationKey: key };
    const result = operation.result as IllustrationOutcome;
    if (result.needsReconciliation) return { status: "needs-reconciliation" as const, operationKey: key };
    const settlementKey = engineHash([key, "settlement"]);
    const previousSettlement = await this.operations.store.read(settlementKey);
    // A recorded financial decision survives source edits. Current content checks below
    // still withhold stale bytes, but must not prevent resuming its idempotent settlement.
    if (!previousSettlement && operation.resource.mediaKind && jobs.some(job => job.status === "succeeded"))
      await readStoryMediaSource(this.worlds, this.operations.policy, context, operation.resource);
    if (!previousSettlement && (jobs.length === 0 || jobs.length !== result.jobIds.length ||
      jobs.some(job => !result.jobIds.includes(job.id)))) {
      return { status: "needs-reconciliation" as const, operationKey: key };
    }
    if (!previousSettlement && jobs.some(job => !["succeeded", "failed", "cancelled"].includes(job.status))) {
      return { status: "pending" as const, operationKey: key };
    }
    const permitted: EngineDeliveredJob[] = [];
    const media = new WorldSessionService(this.worlds, this.operations.policy, this.queue);
    for (const job of jobs) {
      if (job.status !== "succeeded" || !result.jobIds.includes(job.id)) continue;
      try {
        if (!job.landedFiles?.length) throw new Error("Successful job has no landed artifacts.");
        const deliveredArtifacts = [];
        for (const id of job.landedFiles) {
          const artifact = await media.media(context, worldId, id, operation.resource.sheetId);
          deliveredArtifacts.push({ id, sha256: artifact.sha256 });
        }
        permitted.push({ ...structuredClone(job), deliveredArtifacts });
      } catch {
        // A refusal and an unavailable check both withhold delivery. The host's idempotent
        // settlement policy decides how to treat held output; the engine never treats it as allowed.
      }
    }
    // Persist the financial decision before making an idempotent external call. A crash or a
    // later policy change must never turn an already released reservation into a charge.
    if (!previousSettlement && permitted.length < jobs.filter(job => job.status === "succeeded").length) {
      return { status: "held" as const, operationKey: key };
    }
    const fingerprint = engineHash([key, result.reservation]);
    const claim = await this.operations.store.begin({ key: settlementKey, fingerprint,
      context, resource: operation.resource, action: "generate", status: "started",
      result: { operationKey: key, reservation: result.reservation, jobs: permitted } });
    if (claim.operation.fingerprint !== fingerprint) throw new Error("Settlement identity changed.");
    const decision = claim.operation.result as { reservation: string; jobs: EngineDeliveredJob[] };
    if (claim.operation.status !== "completed") {
      if (decision.jobs.length === 0) await this.operations.policy.release(context, key, decision.reservation);
      else await this.operations.policy.settle(context, key, decision.reservation, decision.jobs);
      await this.operations.store.complete(settlementKey, fingerprint, decision);
    }
    return { status: "settled" as const, operationKey: key, jobIds: decision.jobs.map(job => job.id),
      deliverableJobIds: permitted.map(job => job.id) };
  }
}

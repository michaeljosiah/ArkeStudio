import { MAX_IMAGE_PREVIEWS, describeError, ulid, type Job } from "@arke-studio/contracts";
import type { EngineContext, EngineMutation, EngineQueue, EngineWorldRepository, IllustrationInput, IllustrationOutcome } from "./contracts.js";
import { engineHash, EngineOperations } from "./operations.js";

export class IllustrationApplicationService {
  constructor(private readonly worlds: EngineWorldRepository, private readonly operations: EngineOperations,
    private readonly queue: EngineQueue) {}

  async generate(context: EngineContext, worldId: string, input: IllustrationInput & EngineMutation): Promise<IllustrationOutcome> {
    context = structuredClone(context);
    input = structuredClone(input);
    const resource = { worldId, sheetId: input.sheetId };
    return this.operations.run(context, "generate", resource, input.operationId, input, async key => {
      if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_IMAGE_PREVIEWS) {
        throw new Error(`Request between one and ${MAX_IMAGE_PREVIEWS} illustrations.`);
      }
      const inputs = await this.worlds.use(worldId, async session => {
        if (input.expectedRevision !== undefined && (await session.snapshot()).revision !== input.expectedRevision) {
          throw new Error("The world changed before generation was prepared.");
        }
        return session.illustrations({ ...input, generationKey: key });
      });
      const reservation = await this.operations.policy.reserve(context, key, inputs);
      const jobs: Job[] = [];
      // A partial/uncertain enqueue retains the reservation and operation for reconciliation.
      // Releasing it here could fund another request while the first provider is already working.
      for (const [index, request] of inputs.entries()) {
        try {
          await this.operations.policy.authorise(context, "generate", resource);
          jobs.push(await this.queue.enqueue({ ...request, idempotencyKey: ulid(),
            params: { ...request.params, engineOperation: { key, requestIndex: index, reservation, context } } }));
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
    });
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
    if (jobs.length === 0 || jobs.some(job => !["succeeded", "failed", "cancelled"].includes(job.status))) {
      return { status: "pending" as const, operationKey: key };
    }
    // Do not settle an interrupted batch as a complete batch. A host must first reconcile the
    // started operation against queue/provider evidence; it cannot invent the missing requests.
    if (operation.status !== "completed") return { status: "needs-reconciliation" as const, operationKey: key };
    const result = operation.result as IllustrationOutcome;
    if (result.needsReconciliation) return { status: "needs-reconciliation" as const, operationKey: key };
    if (jobs.length !== result.jobIds.length || jobs.some(job => !result.jobIds.includes(job.id))) {
      throw new Error("Generation recovery does not match the durable batch.");
    }
    const settlementKey = engineHash([key, "settlement"]);
    const previousSettlement = await this.operations.store.read(settlementKey);
    const permitted: Job[] = [];
    for (const job of jobs) {
      if (job.status !== "succeeded") continue;
      try {
        await this.operations.policy.deliver(context, { worldId, sheetId: operation.resource.sheetId },
          { kind: "job", id: job.id, sha256: engineHash(job) });
        permitted.push(job);
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
      result: { reservation: result.reservation, jobs: permitted } });
    if (claim.operation.fingerprint !== fingerprint) throw new Error("Settlement identity changed.");
    const decision = claim.operation.result as { reservation: string; jobs: Job[] };
    if (claim.operation.status !== "completed") {
      if (decision.jobs.length === 0) await this.operations.policy.release(context, key, decision.reservation);
      else await this.operations.policy.settle(context, key, decision.reservation, decision.jobs);
      await this.operations.store.complete(settlementKey, fingerprint, decision);
    }
    return { status: "settled" as const, operationKey: key, jobIds: permitted.map(job => job.id) };
  }
}

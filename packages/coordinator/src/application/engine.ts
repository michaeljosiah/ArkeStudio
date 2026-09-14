import type { EngineContext, EngineOperationStore, EnginePolicy, EngineQueue, EngineWorldRepository } from "./contracts.js";
import { EngineOperations } from "./operations.js";
import { WorldSessionService } from "./world-sessions.js";
import { ProposalApplicationService } from "./proposals.js";
import { IllustrationApplicationService } from "./generation.js";
import { ProseApplicationService } from "./prose.js";

export interface EngineOptions {
  worlds: EngineWorldRepository;
  operations: EngineOperationStore;
  policy: EnginePolicy;
  queue: EngineQueue;
}

/** No default host policy: only the Studio composition opts into sole-author behaviour. */
export function createEngine(options: EngineOptions) {
  const operations = new EngineOperations(options.operations, options.policy);
  let closing = false;
  let closed: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  function tracked<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args) => {
      if (closing) throw new Error("The engine is stopping.");
      const promise = fn(...args);
      active.add(promise);
      try { return await promise; } finally { active.delete(promise); }
    };
  }
  const worlds = new WorldSessionService(options.worlds, options.policy);
  const proposals = new ProposalApplicationService(options.worlds, operations);
  const illustrations = new IllustrationApplicationService(options.worlds, operations, options.queue);
  const prose = new ProseApplicationService(options.worlds, operations);
  return {
    prose: { createProduction: tracked(prose.createProduction.bind(prose)), createChapter: tracked(prose.createChapter.bind(prose)),
      readChapter: tracked(prose.readChapter.bind(prose)), saveChapter: tracked(prose.saveChapter.bind(prose)) },
    worlds: { read: tracked(worlds.read.bind(worlds)), media: tracked(worlds.media.bind(worlds)) },
    proposals: { propose: tracked(proposals.propose.bind(proposals)), accept: tracked(proposals.accept.bind(proposals)),
      discard: tracked(proposals.discard.bind(proposals)) },
    illustrations: { generate: tracked(illustrations.generate.bind(illustrations)), reconcile: tracked(illustrations.reconcile.bind(illustrations)) },
    operation: tracked(async (context: EngineContext, worldId: string, operationId: string) => {
      const key = operations.key(context, { worldId }, operationId);
      await options.policy.authorise(context, "read", { worldId });
      const record = await options.operations.read(key);
      if (record && (record.context.subjectId !== context.subjectId || record.context.actorId !== context.actorId ||
        record.context.scopeId !== context.scopeId)) throw new Error("The operation belongs to a different caller or subject.");
      if (record) await options.policy.authorise(context, "read", record.resource);
      // Progress does not expose raw proposal contents or provider job data.
      return record ? { operationKey: key, status: record.status, action: record.action } : null;
    }),
    close() {
      closing = true;
      return closed ??= (async () => {
        await Promise.allSettled(active);
        try { await operations.close(); }
        finally { await options.worlds.close(); }
      })().catch(error => {
        // Admission stays closed, but a transient drain/cleanup failure may be retried.
        closed = undefined;
        throw error;
      });
    },
  };
}

export type { EngineContext };
export * from "./contracts.js";
export { EngineOperationUncertainError, engineHash } from "./operations.js";

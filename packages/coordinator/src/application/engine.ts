import type { EngineContext, EngineOperationStore, EnginePolicy, EngineQueue, EngineWorldRepository } from "./contracts.js";
import { EngineOperations } from "./operations.js";
import { WorldSessionService } from "./world-sessions.js";
import { ProposalApplicationService } from "./proposals.js";
import { IllustrationApplicationService } from "./generation.js";

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
  return {
    worlds: { read: tracked(worlds.read.bind(worlds)), media: tracked(worlds.media.bind(worlds)) },
    proposals: { propose: tracked(proposals.propose.bind(proposals)), accept: tracked(proposals.accept.bind(proposals)),
      discard: tracked(proposals.discard.bind(proposals)) },
    illustrations: { generate: tracked(illustrations.generate.bind(illustrations)), reconcile: tracked(illustrations.reconcile.bind(illustrations)) },
    operation: tracked(async (context: EngineContext, worldId: string, operationId: string) => {
      const key = operations.key(context, { worldId }, operationId);
      await options.policy.authorise(context, "read", { worldId });
      const record = await options.operations.read(key);
      // Progress does not expose raw proposal contents or provider job data.
      return record ? { operationKey: key, status: record.status, action: record.action } : null;
    }),
    close() {
      closing = true;
      return closed ??= (async () => {
        await Promise.allSettled(active);
        await operations.close();
        await options.worlds.close();
      })();
    },
  };
}

export type { EngineContext };
export * from "./contracts.js";
export { EngineOperationUncertainError, engineHash } from "./operations.js";
export { WorldSessionService } from "./world-sessions.js";
export { ProposalApplicationService } from "./proposals.js";
export { IllustrationApplicationService } from "./generation.js";
